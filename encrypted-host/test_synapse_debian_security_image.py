import hashlib
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import build_synapse_debian_security_image as builder


class DebianBuilderTests(unittest.TestCase):
    def test_official_tag_refused_without_docker(self):
        with patch.object(builder,'run') as docker:
            with self.assertRaisesRegex(ValueError,'distinct'):
                builder.build(pathlib.Path('/tmp/p'),pathlib.Path('/tmp/parent'),pathlib.Path('/tmp/out'),'ghcr.io/element-hq/synapse:1')
            docker.assert_not_called()

    def test_corrupt_metadata_refused_before_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            wheel_bytes=(builder.ROOT/'security-images/synapse-wheels.json').read_bytes()
            wheels=json.loads(wheel_bytes)
            lock=json.loads((builder.ROOT/'security-images/synapse-debian.json').read_bytes())
            parent={'ownership':'project-derived-not-official','platform':'linux/arm64','packages':wheels['packages'],
                    'officialSourceReference':wheels['base'],'manifestSha256':hashlib.sha256(wheel_bytes).hexdigest(),
                    'imageId':'sha256:'+'a'*64,'tag':'clean-bookface-synapse-security:test','identity':{'unchanged':True}}
            (root/'parent.json').write_text(json.dumps(parent))
            (root/lock['metadata'][0]['filename']).write_bytes(b'corrupt signed metadata')
            def docker(*args):
                if args[:2]==('image','inspect'): return '[{"Architecture":"arm64","Os":"linux"}]'
                return 'example\t1'
            with patch.object(builder,'run',side_effect=docker),patch.object(builder,'identity',return_value=parent['identity']),patch.object(builder,'python_versions',return_value={p['package']:p['version'] for p in wheels['packages']}),patch.object(builder.subprocess,'run') as build:
                with self.assertRaisesRegex(ValueError,'Copied input hash/size mismatch'):
                    builder.build(root,root/'parent.json',root/'out.json','clean-bookface-synapse-debian-security:test')
                build.assert_not_called()
                self.assertFalse((root/'out.json').exists())

    def test_unrelated_parent_receipt_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'parent.json').write_text('{}')
            with patch.object(builder,'run') as docker:
                with self.assertRaisesRegex(ValueError,'reviewed Python layer'):
                    builder.build(root,root/'parent.json',root/'out.json','clean-bookface-synapse-debian-security:test')
                docker.assert_not_called()


class ParentAndExpiryTests(unittest.TestCase):
    def exercise(self, stale_parent=False):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);source=root/'source';recipes=source/'security-images';recipes.mkdir(parents=True)
            inputs=root/'inputs';inputs.mkdir()
            wheels={'packages':[{'package':'cryptography','version':'50.0.2'}],'base':'official/source:1@sha256:'+'a'*64}
            wheel_bytes=json.dumps(wheels).encode();(recipes/'synapse-wheels.json').write_bytes(wheel_bytes)
            content=b'synthetic signature fixture'
            (inputs/'InRelease').write_bytes(content)
            lock={'platform':'linux/arm64','suite':'trixie-security','metadata':[{'filename':'InRelease','repositoryPath':'dists/trixie-security/InRelease','sha256':hashlib.sha256(content).hexdigest()}],'packages':[{'package':'example','version':'2','filename':'example.deb','repositoryPath':'pool/example.deb','sha256':hashlib.sha256(content).hexdigest()}]}
            (inputs/'example.deb').write_bytes(content)
            (recipes/'synapse-debian.json').write_text(json.dumps(lock))
            (recipes/'synapse-debian.Dockerfile').write_text('ARG BASE\nFROM ${BASE}\nRUN apt-get update && apt-get install example=2\n')
            parent={'ownership':'project-derived-not-official','platform':'linux/arm64','packages':wheels['packages'],'officialSourceReference':wheels['base'],'manifestSha256':hashlib.sha256(wheel_bytes).hexdigest(),'imageId':'sha256:'+'b'*64,'tag':'clean-bookface-synapse-security:test','identity':{'unchanged':True}}
            (root/'parent.json').write_text(json.dumps(parent))
            image_id='sha256:'+'d'*64
            def docker(*args):
                if args[:2]==('image','inspect'):return json.dumps([{'Architecture':'arm64','Os':'linux','Config':{},'Id':args[2]}])
                if args[-2:]==('-m','pip'):return ''
                return 'example\t2' if image_id in args else 'example\t1'
            validation=[]
            def warm_cached_build(args,**kwargs):
                # Model a previously cached successful RUN and metadata that has
                # since expired. A cache hit bypasses the verifier; executing
                # the RUN again invokes APT and must propagate its refusal.
                if '--no-cache' in args:
                    validation.append('expired signed metadata rejected')
                    raise subprocess.CalledProcessError(100,args,stderr='Release file expired')
                pathlib.Path(args[args.index('--iidfile')+1]).write_text('sha256:'+'c'*64)
                pathlib.Path(args[args.index('--metadata-file')+1]).write_text(json.dumps({'containerimage.config.digest':'sha256:'+'c'*64,'containerimage.digest':image_id}))
            with patch.object(builder,'ROOT',source),patch.object(builder,'run',side_effect=docker),patch.object(builder,'identity',return_value=parent['identity']),patch.object(builder,'python_versions',return_value={'cryptography':'46.0.7' if stale_parent else '50.0.2'}),patch.object(builder.subprocess,'run',side_effect=warm_cached_build) as build:
                if stale_parent:
                    with self.assertRaisesRegex(ValueError,'Parent installed Python packages'):
                        builder.build(inputs,root/'parent.json',root/'result.json','clean-bookface-synapse-debian-security:test')
                    build.assert_not_called()
                else:
                    with self.assertRaises(subprocess.CalledProcessError):
                        builder.build(inputs,root/'parent.json',root/'result.json','clean-bookface-synapse-debian-security:test')
                    self.assertEqual(validation,['expired signed metadata rejected'])
                self.assertFalse((root/'result.json').exists())
    def test_warm_cache_cannot_admit_expired_metadata(self):self.exercise()
    def test_matching_identity_with_stale_python_packages_refused(self):self.exercise(stale_parent=True)


if __name__=='__main__':unittest.main()
