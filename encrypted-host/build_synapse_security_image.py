#!/usr/bin/env python3
"""Build an offline owned Synapse Python security layer; never deploy or edit pins."""
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


def identity(image):
    script = '''import hashlib,json,pathlib,sys,synapse
root=pathlib.Path(synapse.__file__).parent
h=hashlib.sha256()
for p in sorted(root.rglob('*')):
 if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc':
  h.update(str(p.relative_to(root)).encode()+b'\\0'+p.read_bytes())
print(json.dumps({'synapseVersion':synapse.__version__,'synapseTreeSha256':h.hexdigest(),'pythonSha256':hashlib.sha256(pathlib.Path(sys.executable).read_bytes()).hexdigest(),'entrypointSha256':hashlib.sha256(pathlib.Path('/start.py').read_bytes()).hexdigest()}))'''
    return json.loads(run('run', '--rm', '--network', 'none', '--entrypoint', 'python', image, '-c', script))


def build(wheels, receipt, tag, local_imported_base=False):
    if not re.fullmatch(r'clean-bookface-synapse-security:[a-z0-9][a-z0-9_.-]{0,63}', tag):
        raise ValueError('Use a distinct clean-bookface-synapse-security:<version> tag')
    for path in [wheels, receipt]:
        if path.resolve() == ROOT.parent or ROOT.parent in path.resolve().parents:
            raise ValueError('Inputs and receipt must remain outside checkout')
    if receipt.exists(): raise ValueError('Refusing to overwrite receipt')
    manifest = ROOT / 'security-images/synapse-wheels.json'
    requirements = ROOT / 'security-images/synapse-requirements.txt'
    recipe = ROOT / 'security-images/synapse.Dockerfile'
    manifest_bytes = manifest.read_bytes()
    recipe_bytes = recipe.read_bytes()
    requirements_bytes = requirements.read_bytes()
    lock = json.loads(manifest_bytes)
    if lock['ownership'] != 'project-derived-not-official' or lock['platform'] != 'linux/arm64':
        raise ValueError('Unexpected ownership/platform')
    base = lock['localImportedBase'] if local_imported_base else lock['base']
    if not re.fullmatch(r'[^\s]+:[^\s@]+@sha256:[a-f0-9]{64}', base):
        raise ValueError('Immutable base required')
    expected = ''.join(p['package']+'=='+p['version']+' --hash=sha256:'+p['sha256']+'\n' for p in lock['packages'])
    if requirements_bytes != expected.encode(): raise ValueError('Requirements differ from wheel lock')
    info = json.loads(run('image', 'inspect', base))[0]
    if info['Architecture'] != 'arm64' or info['Os'] != 'linux': raise ValueError('ARM64 base required')
    before = identity(base)
    with tempfile.TemporaryDirectory(prefix='cbf-owned-synapse-') as directory:
        context = pathlib.Path(directory)
        for package in lock['packages']:
            name = package['filename']
            if pathlib.Path(name).name != name or not name.endswith('.whl'): raise ValueError('Invalid wheel filename')
            source = wheels / name
            if source.is_symlink() or source.stat().st_size != package['size'] or digest(source) != package['sha256']:
                raise ValueError('Wheel hash/size mismatch: '+name)
            shutil.copyfile(source, context / name)
            if digest(context / name) != package['sha256']:
                raise ValueError('Copied package hash mismatch: ' + name)
        (context / 'requirements.txt').write_bytes(requirements_bytes)
        (context / 'Dockerfile').write_bytes(recipe_bytes)
        subprocess.run(['docker','build','--platform=linux/arm64','--network=none','--pull=false',
                        '--provenance=false','--iidfile',str(context / 'image-id'),'--metadata-file',str(context / 'build-metadata.json'),'--build-arg','BASE='+base,'-t',tag,str(context)],check=True)
        config_id = (context / 'image-id').read_text().strip()
        metadata = json.loads((context / 'build-metadata.json').read_bytes())
        image_id = metadata.get('containerimage.digest', '')
        if (not re.fullmatch(r'sha256:[a-f0-9]{64}', config_id)
                or metadata.get('containerimage.config.digest') != config_id
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id)):
            raise ValueError('Build metadata does not bind the image manifest to iidfile')
    output = json.loads(run('image', 'inspect', image_id))[0]
    for key in ['Architecture','Os']:
        if output[key] != info[key]: raise ValueError('Changed platform')
    for key in ['Entrypoint','Cmd','User','WorkingDir','Env','ExposedPorts','Volumes','StopSignal','Healthcheck']:
        if output['Config'].get(key) != info['Config'].get(key): raise ValueError('Changed runtime configuration: '+key)
    if identity(output['Id']) != before: raise ValueError('Synapse source, entrypoint or Python executable changed')
    run('run','--rm','--network','none','--entrypoint','python',output['Id'],'-m','pip','check')
    result={'schema':1,'ownership':lock['ownership'],'officialSourceReference':lock['base'],'actualBuildBase':base,
            'localImportedBase':local_imported_base,'baseImageId':info['Id'],'imageId':output['Id'],
            'buildManifestDigest':image_id,'buildConfigDigest':config_id,
            'platform':lock['platform'],'tag':tag,'identity':before,'packages':lock['packages'],
            'recipeSha256':hashlib.sha256(recipe_bytes).hexdigest(),'manifestSha256':hashlib.sha256(manifest_bytes).hexdigest(),'requirementsSha256':hashlib.sha256(requirements_bytes).hexdigest(),
            'qualification':'build-only; advisory scan and host/browser/recovery qualification required','deployed':False}
    receipt.parent.mkdir(parents=True,exist_ok=True)
    with receipt.open('x') as stream: json.dump(result,stream,indent=2); stream.write('\n')
    receipt.chmod(0o600)
    print(json.dumps({'imageId':output['Id'],'localImportedBase':local_imported_base,'deployed':False}))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wheels',type=pathlib.Path,required=True)
    parser.add_argument('--receipt',type=pathlib.Path,required=True)
    parser.add_argument('--tag',required=True)
    parser.add_argument('--local-imported-base',action='store_true',help='Disposable local qualification only; retain imported identity in receipt')
    args=parser.parse_args()
    build(args.wheels,args.receipt,args.tag,args.local_imported_base)
