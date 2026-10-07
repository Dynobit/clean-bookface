#!/usr/bin/env python3
"""Offline, locked Restic source build; never deploys or changes official pins.

Supply the official source/toolchain archives and APKs named by the two manifests
outside this checkout. --prepare-vendor runs only on Linux ARM64: it authenticates
Go modules using proxy.golang.org and sum.golang.org, then produces the exact
locked vendor tree. Build mode verifies all inputs and disables Docker networking.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import build_security_image as layer

ROOT = pathlib.Path(__file__).resolve().parent
FILES = ROOT / 'security-images'


def tree_digest(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError('Vendor tree contains a link or special file')
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode() + b'\0' + bytes.fromhex(layer.digest(path)))
    return digest.hexdigest()


def outside(path):
    resolved = path.resolve()
    if resolved == ROOT.parent or ROOT.parent in resolved.parents:
        raise ValueError('Inputs, vendor and receipts must remain outside checkout')
    return resolved


def verified(path, expected):
    if path.is_symlink() or not path.is_file() or layer.digest(path) != expected:
        raise ValueError('Locked input hash mismatch: ' + path.name)


def extract(archive, destination):
    with tarfile.open(archive) as stream:
        for member in stream.getmembers():
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise ValueError('Archive contains a link or special file')
        stream.extractall(destination, filter='data')


def lock_and_inputs(inputs):
    inputs = outside(inputs)
    source_bytes = (FILES / 'restic-source.json').read_bytes()
    package_bytes = (FILES / 'restic-packages.json').read_bytes()
    lock, packages = json.loads(source_bytes), json.loads(package_bytes)
    lock['_manifest_sha256'] = hashlib.sha256(source_bytes).hexdigest()
    packages['_manifest_sha256'] = hashlib.sha256(package_bytes).hexdigest()
    if lock['ownership'] != 'project-derived-not-official' or lock['platform'] != 'linux/arm64' or lock['base'] != packages['base']:
        raise ValueError('Invalid owned build identity')
    for kind in ['source', 'toolchain']:
        verified(inputs / lock[kind]['filename'], lock[kind]['sha256'])
    for name, digest in lock['modules'].items():
        verified(FILES / ('restic-source.' + name), digest)
    return lock, packages


def source_tree(inputs, destination, lock):
    destination.mkdir(parents=True, exist_ok=True)
    staged_archive = destination / 'upstream.tar.gz'
    layer.copy_verified(inputs / lock['source']['filename'], staged_archive, lock['source']['sha256'])
    extract(staged_archive, destination)
    staged_archive.unlink()
    source = destination / ('restic-' + lock['source']['version'])
    if (source / 'VERSION').read_text().strip() != lock['source']['version']:
        raise ValueError('Unexpected upstream source version')
    for name in ['go.mod', 'go.sum']:
        layer.copy_verified(FILES / ('restic-source.' + name), source / name, lock['modules'][name])
    return source


def prepare(inputs, vendor):
    """Online input preparation, separate from network-disabled compilation."""
    lock, _ = lock_and_inputs(inputs)
    vendor = outside(vendor)
    if vendor.exists():
        raise ValueError('Refusing to overwrite vendor input')
    if platform.system() != 'Linux' or platform.machine() not in ['aarch64', 'arm64']:
        raise ValueError('Input preparation requires native Linux ARM64 for the locked toolchain')
    with tempfile.TemporaryDirectory(prefix='cbf-restic-prepare-') as directory:
        root = pathlib.Path(directory)
        source = source_tree(inputs, root, lock)
        staged_go = root / 'toolchain.tar.gz'
        layer.copy_verified(inputs / lock['toolchain']['filename'], staged_go, lock['toolchain']['sha256'])
        extract(staged_go, root)
        env = dict(os.environ, GOTOOLCHAIN='local', GOENV='off', GOPROXY='https://proxy.golang.org', GOSUMDB='sum.golang.org',
                   GOPRIVATE='', GONOSUMDB='', GONOPROXY='', GOINSECURE='', GOWORK='off', GOMODCACHE=str(root/'gopath/pkg/mod'), GOPATH=str(root/'gopath'), GOCACHE=str(root/'gocache'), GOFLAGS='')
        go = str(root/'go/bin/go')
        for args in [('mod', 'download'), ('mod', 'verify'), ('mod', 'vendor')]:
            subprocess.run([go, *args], cwd=source, env=env, check=True)
        for name, digest in lock['modules'].items():
            verified(source/name, digest)
        if tree_digest(source/'vendor') != lock['vendorTreeSha256']:
            raise ValueError('Resolved vendor tree differs from reviewed lock')
        shutil.copytree(source/'vendor', vendor)
    print('Authenticated module vendor tree prepared; no image built')


def build(inputs, vendor, receipt, tag):
    lock, packages = lock_and_inputs(inputs)
    vendor, receipt = outside(vendor), outside(receipt)
    if receipt.exists():
        raise ValueError('Refusing to overwrite build receipt')
    if not re.fullmatch(r'clean-bookface-restic-source-security:[a-z0-9][a-z0-9_.-]{0,63}', tag):
        raise ValueError('Use the distinct project-owned source-security tag')
    if tree_digest(vendor) != lock['vendorTreeSha256']:
        raise ValueError('Vendor content differs from reviewed module lock')
    recipe = FILES/'restic-source.Dockerfile'
    recipe_bytes = recipe.read_bytes()
    source_lock_sha = lock['_manifest_sha256']
    package_lock_sha = packages['_manifest_sha256']
    froms = [line.split()[1] for line in recipe_bytes.decode().splitlines() if line.startswith('FROM ')]
    if froms != [lock['base'], lock['base']]:
        raise ValueError('Recipe base mismatch')
    before = json.loads(layer.run('image', 'inspect', lock['base']))[0]
    if before['Os'] != 'linux' or before['Architecture'] != 'arm64':
        raise ValueError('Cached base must be exact Linux ARM64')
    with tempfile.TemporaryDirectory(prefix='cbf-restic-build-') as directory:
        context = pathlib.Path(directory)
        source = source_tree(inputs, context/'upstream', lock)
        shutil.copytree(vendor, source/'vendor')
        if tree_digest(source/'vendor') != lock['vendorTreeSha256']:
            raise ValueError('Staged vendor tree differs from reviewed lock')
        shutil.move(source, context/'source')
        shutil.rmtree(context/'upstream')
        layer.copy_verified(inputs/lock['toolchain']['filename'], context/lock['toolchain']['filename'], lock['toolchain']['sha256'])
        for package in packages['packages']:
            name = package['package'] + '-' + package['version'] + '.apk'
            layer.copy_verified(inputs/name, context/name, package['sha256'])
        (context/'Dockerfile').write_bytes(recipe_bytes)
        iidfile = context/'built-image-id'
        metadatafile = context/'build-metadata.json'
        subprocess.run(['docker', 'build', '--platform=linux/arm64', '--network=none', '--pull=false', '--provenance=false', '--iidfile', str(iidfile), '--metadata-file', str(metadatafile), '-t', tag, str(context)], check=True)
        image_refs = layer.built_image_id(iidfile, metadatafile)
    after = layer.inspect_built_image(image_refs)
    image_id = after['Id']
    for key in ['Entrypoint', 'Cmd', 'User', 'WorkingDir']:
        if before['Config'].get(key) != after['Config'].get(key):
            raise ValueError('Changed runtime configuration: ' + key)
    if after['Os'] != 'linux' or after['Architecture'] != 'arm64':
        raise ValueError('Unexpected output platform')
    if after['Config'].get('Labels', {}).get('org.cleanbookface.ownership') != lock['ownership']:
        raise ValueError('Missing explicit project-owned image label')
    version = layer.run('run', '--pull', 'never', '--rm', '--network', 'none', image_id, 'version')
    if not version.startswith('restic ' + lock['version'] + ' compiled with ' + lock['toolchain']['version'] + ' on linux/arm64'):
        raise ValueError('Unexpected rebuilt version: ' + version)
    binary = layer.run('run', '--pull', 'never', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', image_id, '/usr/bin/restic').split()[0]
    result = {'schema':1, 'ownership':lock['ownership'], 'platform':lock['platform'], 'base':lock['base'], 'imageId':after['Id'],
              'repoDigests':after['RepoDigests'], 'buildManifestDigest':image_refs[0], 'buildConfigDigest':image_refs[1], 'tag':tag, 'version':version, 'resticBinarySha256':binary,
              'sourceCommit':lock['source']['commit'], 'sourceLockSha256':source_lock_sha,
              'recipeSha256':hashlib.sha256(recipe_bytes).hexdigest(), 'packageManifestSha256':package_lock_sha,
              'vendorTreeSha256':lock['vendorTreeSha256'], 'qualification':'build-only; vulnerability scan, upstream tests and backup/restore/SFTP still required'}
    receipt.parent.mkdir(parents=True, exist_ok=True)
    with receipt.open('x') as stream:
        json.dump(result, stream, indent=2);stream.write('\n')
    receipt.chmod(0o600)
    print(json.dumps({'imageId':after['Id'], 'ownership':lock['ownership'], 'deployed':False}))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=pathlib.Path, required=True)
    parser.add_argument('--vendor', type=pathlib.Path, required=True)
    parser.add_argument('--prepare-vendor', action='store_true')
    parser.add_argument('--receipt', type=pathlib.Path)
    parser.add_argument('--tag')
    args=parser.parse_args()
    if args.prepare_vendor:
        prepare(args.inputs, args.vendor)
    else:
        if not args.receipt or not args.tag:parser.error('Build requires --receipt and --tag')
        build(args.inputs, args.vendor, args.receipt, args.tag)
