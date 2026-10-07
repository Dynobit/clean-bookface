#!/usr/bin/env python3
"""Build a signed, offline Trixie security layer over an owned Synapse Python image."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
from build_synapse_security_image import ROOT, digest, identity, run


def python_versions(image, packages):
    script = 'import importlib.metadata,json,sys; print(json.dumps({name:importlib.metadata.version(name) for name in json.loads(sys.argv[1])}))'
    return json.loads(run('run','--rm','--network','none','--entrypoint','python',image,'-c',script,json.dumps(packages)))


def build(packages, parent_receipt, receipt, tag):
    if not re.fullmatch(r'clean-bookface-synapse-debian-security:[a-z0-9][a-z0-9_.-]{0,63}', tag):
        raise ValueError('Use a distinct clean-bookface-synapse-debian-security tag')
    for path in [packages, parent_receipt, receipt]:
        if path.resolve() == ROOT.parent or ROOT.parent in path.resolve().parents:
            raise ValueError('Inputs and receipts must remain outside checkout')
    if receipt.exists(): raise ValueError('Refusing to overwrite receipt')
    parent_bytes = parent_receipt.read_bytes()
    parent = json.loads(parent_bytes)
    lock_bytes = (ROOT/'security-images/synapse-debian.json').read_bytes()
    recipe_bytes = (ROOT/'security-images/synapse-debian.Dockerfile').read_bytes()
    wheel_bytes = (ROOT/'security-images/synapse-wheels.json').read_bytes()
    lock = json.loads(lock_bytes)
    wheels = json.loads(wheel_bytes)
    if (parent.get('ownership') != 'project-derived-not-official' or parent.get('platform') != 'linux/arm64'
            or parent.get('packages') != wheels['packages'] or parent.get('officialSourceReference') != wheels['base']
            or parent.get('manifestSha256') != hashlib.sha256(wheel_bytes).hexdigest()):
        raise ValueError('Parent receipt does not bind the reviewed Python layer')
    if lock.get('platform') != 'linux/arm64' or lock.get('suite') != 'trixie-security':
        raise ValueError('Only locked ARM64 Trixie security packages supported')
    base = parent['imageId']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', base): raise ValueError('Immutable parent image required')
    info = json.loads(run('image','inspect',base))[0]
    if info['Architecture'] != 'arm64' or info['Os'] != 'linux': raise ValueError('ARM64 Linux required')
    if not re.fullmatch(r'clean-bookface-synapse-security:[a-z0-9][a-z0-9_.-]{0,63}', parent.get('tag','')):
        raise ValueError('Unexpected parent owned image reference')
    build_base = parent['tag'] + '@' + base
    before = identity(base)
    if before != parent['identity']: raise ValueError('Parent runtime identity differs from receipt')
    expected_python = {p['package']:p['version'] for p in wheels['packages']}
    if python_versions(base,list(expected_python)) != expected_python:
        raise ValueError('Parent installed Python packages differ from reviewed wheel lock')
    def installed(image):
        return dict(line.split('\t',1) for line in run('run','--rm','--network','none','--entrypoint','dpkg-query',image,'-W','-f=${Package}\t${Version}\n').splitlines())
    before_packages = installed(base)
    targets = {p['package']:p['version'] for p in lock['packages']}
    for name, version in targets.items():
        if (name+'='+version).encode() not in recipe_bytes: raise ValueError('Recipe differs from package lock')
    with tempfile.TemporaryDirectory(prefix='cbf-synapse-debian-') as directory:
        context = pathlib.Path(directory)
        for item in lock['metadata'] + lock['packages']:
            relative = pathlib.PurePosixPath(item['repositoryPath'])
            if relative.is_absolute() or '..' in relative.parts or pathlib.Path(item['filename']).name != item['filename']:
                raise ValueError('Invalid package path')
            source = packages/item['filename']
            if source.is_symlink(): raise ValueError('Symlink input refused')
            target = context/'repository'/str(relative)
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(source,target)
            if digest(target) != item['sha256'] or ('size' in item and target.stat().st_size != item['size']):
                raise ValueError('Copied input hash/size mismatch')
        (context/'Dockerfile').write_bytes(recipe_bytes)
        (context/'security.sources').write_text('Types: deb\nURIs: file:/tmp/security-repository\nSuites: trixie-security\nComponents: main\nArchitectures: arm64\nSigned-By: /usr/share/keyrings/debian-archive-keyring.pgp\n')
        subprocess.run(['docker','build','--no-cache','--platform=linux/arm64','--network=none','--pull=false','--provenance=false',
                        '--iidfile',str(context/'iid'),'--metadata-file',str(context/'metadata.json'),
                        '--build-arg','BASE='+build_base,'-t',tag,str(context)],check=True)
        config_id = (context/'iid').read_text().strip()
        metadata = json.loads((context/'metadata.json').read_bytes())
        image_id = metadata.get('containerimage.digest','')
        if (not re.fullmatch(r'sha256:[a-f0-9]{64}',config_id) or metadata.get('containerimage.config.digest') != config_id
                or not re.fullmatch(r'sha256:[a-f0-9]{64}',image_id)):
            raise ValueError('Build metadata does not bind manifest to configuration')
    output = json.loads(run('image','inspect',image_id))[0]
    if output['Architecture'] != info['Architecture'] or output['Os'] != info['Os']: raise ValueError('Changed platform')
    if output['Config'] != info['Config']: raise ValueError('Changed runtime configuration')
    if identity(image_id) != before: raise ValueError('Changed Synapse/Python/entrypoint')
    if python_versions(image_id,list(expected_python)) != expected_python:
        raise ValueError('Output Python packages differ from reviewed wheel lock')
    after_packages = installed(image_id)
    changed = {p:v for p,v in after_packages.items() if before_packages.get(p) != v}
    if changed != targets or set(before_packages) != set(after_packages):
        raise ValueError('Unexpected Debian package changes')
    run('run','--rm','--network','none','--entrypoint','python',image_id,'-m','pip','check')
    result={'schema':1,'ownership':'project-derived-not-official','platform':'linux/arm64','baseImageId':base,
            'imageId':output['Id'],'buildManifestDigest':image_id,'buildConfigDigest':config_id,'tag':tag,
            'parentReceiptSha256':hashlib.sha256(parent_bytes).hexdigest(),'manifestSha256':hashlib.sha256(lock_bytes).hexdigest(),
            'recipeSha256':hashlib.sha256(recipe_bytes).hexdigest(),'identity':before,'packages':lock['packages'],
            'pythonPackages':expected_python,'signedMetadata':lock['metadata'],'changedDebianPackages':changed,'qualification':'build-only; exact scan and runtime qualification required','deployed':False}
    receipt.parent.mkdir(parents=True,exist_ok=True)
    with receipt.open('x') as stream: json.dump(result,stream,indent=2);stream.write('\n')
    receipt.chmod(0o600)
    print(json.dumps({'imageId':output['Id'],'changedPackages':changed,'deployed':False}))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages',type=pathlib.Path,required=True)
    parser.add_argument('--parent-receipt',type=pathlib.Path,required=True)
    parser.add_argument('--receipt',type=pathlib.Path,required=True)
    parser.add_argument('--tag',required=True)
    args=parser.parse_args()
    build(args.packages,args.parent_receipt,args.receipt,args.tag)
