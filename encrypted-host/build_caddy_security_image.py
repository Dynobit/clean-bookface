#!/usr/bin/env python3
"""Build a project-owned ARM64 caddy security layer; never deploy or alter pins.

Packages must be supplied outside the checkout. Download the exact official URLs
in security-images/caddy-packages.json; transport may vary, trust must not.
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
    if not re.fullmatch(r'clean-bookface-caddy-security:[a-z0-9][a-z0-9_.-]{0,63}', tag):
        raise ValueError('Use a distinct clean-bookface-caddy-security:<version> owned tag')
    for path in [packages, receipt]:
        resolved = path.resolve()
        if resolved == ROOT.parent or ROOT.parent in resolved.parents:
            raise ValueError('Package inputs and receipt must remain outside checkout')
    if receipt.exists():
        raise ValueError('Refusing to overwrite an existing qualification receipt')
    manifest_path = ROOT / 'security-images/caddy-packages.json'
    recipe = ROOT / 'security-images/caddy.Dockerfile'
    manifest_bytes = manifest_path.read_bytes()
    recipe_bytes = recipe.read_bytes()
    lock = json.loads(manifest_bytes)
    if lock['ownership'] != 'project-derived-not-official' or lock['platform'] != 'linux/arm64':
        raise ValueError('Unsupported ownership or platform')
    base = lock['base']
    if recipe_bytes.decode().splitlines()[0] != 'FROM ' + base:
        raise ValueError('Recipe base does not match package manifest')
    base_info = json.loads(run('image', 'inspect', base))[0]
    if base_info['Architecture'] != 'arm64' or base_info['Os'] != 'linux':
        raise ValueError('Expected cached exact ARM64 base')
    with tempfile.TemporaryDirectory(prefix='cbf-owned-caddy-') as directory:
        context = pathlib.Path(directory)
        for package in lock['packages']:
            name = package['package'] + '-' + package['version'] + '.apk'
            if '/' in name or not re.fullmatch(r'[a-f0-9]{64}', package['sha256']):
                raise ValueError('Invalid package lock')
            source = packages / name
            if source.is_symlink() or digest(source) != package['sha256']:
                raise ValueError('Package hash mismatch: ' + name)
            shutil.copyfile(source, context / name)
            if digest(context / name) != package['sha256']:
                raise ValueError('Copied package hash mismatch: ' + name)
        (context / 'Dockerfile').write_bytes(recipe_bytes)
        subprocess.run(['docker', 'build', '--platform=linux/arm64', '--network=none',
                        '--pull=false', '--provenance=false', '--iidfile', str(context / 'image-id'), '--metadata-file', str(context / 'build-metadata.json'), '-t', tag, str(context)], check=True)
        config_id = (context / 'image-id').read_text().strip()
        metadata = json.loads((context / 'build-metadata.json').read_bytes())
        image_id = metadata.get('containerimage.digest', '')
        if (not re.fullmatch(r'sha256:[a-f0-9]{64}', config_id)
                or metadata.get('containerimage.config.digest') != config_id
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id)):
            raise ValueError('Build metadata does not bind the image manifest to iidfile')
    info = json.loads(run('image', 'inspect', image_id))[0]
    if info['Architecture'] != 'arm64' or info['Os'] != 'linux':
        raise ValueError('Unexpected output platform')
    for key in ['Entrypoint', 'Cmd', 'User', 'WorkingDir', 'Env', 'ExposedPorts', 'Volumes', 'StopSignal', 'Healthcheck']:
        if info['Config'].get(key) != base_info['Config'].get(key):
            raise ValueError('Changed runtime configuration: ' + key)
    def binary_hash(image):
        return run('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', image, '/usr/bin/caddy').split()[0]
    before = binary_hash(base)
    after = binary_hash(image_id)
    if before != after:
        raise ValueError('Caddy binary changed')
    result = {'schema': 1, 'ownership': lock['ownership'], 'base': base,
              'platform': lock['platform'], 'tag': tag, 'imageId': info['Id'],
              'buildManifestDigest': image_id, 'buildConfigDigest': config_id,
              'repoDigests': info['RepoDigests'], 'recipeSha256': hashlib.sha256(recipe_bytes).hexdigest(),
              'packageManifestSha256': hashlib.sha256(manifest_bytes).hexdigest(), 'packages': lock['packages'],
              'caddyBinarySha256': before, 'qualification': 'build-only; scan and proxy/TLS qualification still required'}
    receipt.parent.mkdir(parents=True, exist_ok=True)
    with receipt.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    receipt.chmod(0o600)
    print(json.dumps({'ownership': result['ownership'], 'imageId': result['imageId'],
                      'caddyBinaryUnchanged': True, 'deployed': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages', type=pathlib.Path, required=True)
    parser.add_argument('--receipt', type=pathlib.Path, required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    build(args.packages, args.receipt, args.tag)
