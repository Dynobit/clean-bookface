#!/usr/bin/env python3
"""Build a project-owned ARM64 restic security layer; never deploy or alter pins.

Packages must be supplied outside the checkout. Download the exact official URLs
in security-images/restic-packages.json; transport may vary, trust must not.
"""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def build(packages, receipt, tag):
    if not re.fullmatch(r'clean-bookface-restic-security:[a-z0-9][a-z0-9_.-]{0,63}', tag):
        raise ValueError('Use a distinct clean-bookface-restic-security:<version> owned tag')
    for path in [packages, receipt]:
        resolved = path.resolve()
        if resolved == ROOT.parent or ROOT.parent in resolved.parents:
            raise ValueError('Package inputs and receipt must remain outside checkout')
    if receipt.exists():
        raise ValueError('Refusing to overwrite an existing qualification receipt')
    manifest_path = ROOT / 'security-images/restic-packages.json'
    recipe = ROOT / 'security-images/restic.Dockerfile'
    lock = json.loads(manifest_path.read_text())
    if lock['ownership'] != 'project-derived-not-official' or lock['platform'] != 'linux/arm64':
        raise ValueError('Unsupported ownership or platform')
    base = lock['base']
    if recipe.read_text().splitlines()[0] != 'FROM ' + base:
        raise ValueError('Recipe base does not match package manifest')
    base_info = json.loads(run('image', 'inspect', base))[0]
    if base_info['Architecture'] != 'arm64' or base_info['Os'] != 'linux':
        raise ValueError('Expected cached exact ARM64 base')
    with tempfile.TemporaryDirectory(prefix='cbf-owned-restic-') as directory:
        context = pathlib.Path(directory)
        for package in lock['packages']:
            name = package['package'] + '-' + package['version'] + '.apk'
            if '/' in name or not re.fullmatch(r'[a-f0-9]{64}', package['sha256']):
                raise ValueError('Invalid package lock')
            source = packages / name
            if source.is_symlink() or digest(source) != package['sha256']:
                raise ValueError('Package hash mismatch: ' + name)
            shutil.copyfile(source, context / name)
        shutil.copyfile(recipe, context / 'Dockerfile')
        subprocess.run(['docker', 'build', '--platform=linux/arm64', '--network=none',
                        '--pull=false', '--provenance=false', '-t', tag, str(context)], check=True)
    info = json.loads(run('image', 'inspect', tag))[0]
    if info['Architecture'] != 'arm64' or info['Os'] != 'linux':
        raise ValueError('Unexpected output platform')
    for key in ['Entrypoint', 'Cmd', 'User', 'WorkingDir']:
        if info['Config'].get(key) != base_info['Config'].get(key):
            raise ValueError('Changed runtime configuration: ' + key)
    def binary_hash(image):
        return run('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', image, '/usr/bin/restic').split()[0]
    before = binary_hash(base)
    after = binary_hash(tag)
    if before != after:
        raise ValueError('Restic binary changed')
    result = {'schema': 1, 'ownership': lock['ownership'], 'base': base,
              'platform': lock['platform'], 'tag': tag, 'imageId': info['Id'],
              'repoDigests': info['RepoDigests'], 'recipeSha256': digest(recipe),
              'packageManifestSha256': digest(manifest_path), 'packages': lock['packages'],
              'resticBinarySha256': before, 'qualification': 'build-only; scan and restore still required'}
    receipt.parent.mkdir(parents=True, exist_ok=True)
    with receipt.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    receipt.chmod(0o600)
    print(json.dumps({'ownership': result['ownership'], 'imageId': result['imageId'],
                      'resticBinaryUnchanged': True, 'deployed': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages', type=pathlib.Path, required=True)
    parser.add_argument('--receipt', type=pathlib.Path, required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    build(args.packages, args.receipt, args.tag)
