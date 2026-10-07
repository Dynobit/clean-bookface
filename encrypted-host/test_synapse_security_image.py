import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import build_synapse_security_image as builder


class OwnedSynapseTests(unittest.TestCase):
    def test_official_alias_refused_before_docker(self):
        with patch.object(builder, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'distinct'):
                builder.build(pathlib.Path('/tmp/wheels'), pathlib.Path('/tmp/receipt'), 'ghcr.io/element-hq/synapse:1.162.0')
            run.assert_not_called()

    def test_corrupt_wheel_refused_before_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            lock = json.loads((builder.ROOT / 'security-images/synapse-wheels.json').read_text())
            first = lock['packages'][0]
            (root / first['filename']).write_bytes(b'corrupt')
            with patch.object(builder, 'run', return_value='[{"Architecture":"arm64","Os":"linux"}]'), patch.object(builder, 'identity', return_value={}), patch.object(builder.subprocess, 'run') as build:
                with self.assertRaisesRegex(ValueError, 'hash/size mismatch'):
                    builder.build(root, root / 'receipt.json', 'clean-bookface-synapse-security:test')
                build.assert_not_called()

    def test_existing_receipt_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            receipt = root / 'receipt.json'
            receipt.write_text('preserved')
            with patch.object(builder, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'overwrite'):
                    builder.build(root, receipt, 'clean-bookface-synapse-security:test')
                run.assert_not_called()
            self.assertEqual(receipt.read_text(), 'preserved')


class BuildBindingTests(unittest.TestCase):
    def exercise(self, corrupt_copy=False, mutate_sources=False, mismatched_metadata=False):
        import hashlib
        import shutil
        from contextlib import ExitStack
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            repo = root / 'repo'
            source = repo / 'encrypted-host'
            recipes = source / 'security-images'
            recipes.mkdir(parents=True)
            inputs = root / 'inputs'; inputs.mkdir()
            image_id = 'sha256:' + 'b' * 64
            config_id = 'sha256:' + 'c' * 64
            base = 'example/base:1@sha256:' + 'a' * 64
            data = b'original input'
            name = 'library-1-py3-none-any.whl'
            (inputs / name).write_bytes(data)
            package = {'package':'library','version':'1','filename':name,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()}
            lock = {'ownership':'project-derived-not-official','platform':'linux/arm64','base':base,'packages':[package]}
            (recipes / 'synapse-wheels.json').write_text(json.dumps(lock))
            (recipes / 'synapse.Dockerfile').write_text('FROM ' + base + '\n')
            (recipes / 'synapse-requirements.txt').write_text('library==1 --hash=sha256:'+package['sha256']+'\n')
            snapshot_fields = {'synapse.Dockerfile': 'recipeSha256', 'synapse-wheels.json': 'manifestSha256', 'synapse-requirements.txt': 'requirementsSha256'}
            snapshots = {name: (recipes / name).read_bytes() for name in snapshot_fields}
            def mutate_originals(marker):
                if mutate_sources:
                    for name in snapshots: (recipes / name).write_bytes(marker)
            calls = []
            def docker(*args):
                calls.append(args)
                if args[:2] == ('image','inspect'):
                    mutate_originals(b'changed before context creation')
                    return json.dumps([{'Architecture':'arm64','Os':'linux','Config':{},'Id': image_id if args[2] == image_id else base, 'RepoDigests':[]}])
                return 'same-binary-hash  /usr/bin/caddy'
            def build(args, **kwargs):
                context = pathlib.Path(args[-1])
                self.assertEqual((context / 'Dockerfile').read_bytes(), snapshots['synapse.Dockerfile'])
                self.assertEqual((context / 'requirements.txt').read_bytes(), snapshots['synapse-requirements.txt'])
                self.assertIn('BASE='+base, args)
                mutate_originals(b'changed during build')
                pathlib.Path(args[args.index('--iidfile')+1]).write_text(config_id)
                pathlib.Path(args[args.index('--metadata-file')+1]).write_text(json.dumps({'containerimage.digest':image_id,'containerimage.config.digest':image_id if mismatched_metadata else config_id}))
            copy = shutil.copyfile
            def copy_input(src, dst):
                result = copy(src, dst)
                if corrupt_copy and pathlib.Path(src) == inputs / name:
                    pathlib.Path(dst).write_bytes(b'replaced while copying')
                return result
            with ExitStack() as stack:
                stack.enter_context(patch.object(builder,'ROOT',source))
                stack.enter_context(patch.object(builder,'run',side_effect=docker))
                stack.enter_context(patch.object(builder.shutil,'copyfile',side_effect=copy_input))
                build_mock = stack.enter_context(patch.object(builder.subprocess,'run',side_effect=build))
                stack.enter_context(patch.object(builder,'identity',return_value={'unchanged':True}))
                if corrupt_copy:
                    with self.assertRaisesRegex(ValueError,'Copied package hash mismatch'):
                        builder.build(inputs,root/'receipt.json','clean-bookface-synapse-security:test')
                    build_mock.assert_not_called()
                elif mismatched_metadata:
                    with self.assertRaisesRegex(ValueError,'metadata does not bind'):
                        builder.build(inputs,root/'receipt.json','clean-bookface-synapse-security:test')
                    self.assertFalse((root/'receipt.json').exists())
                else:
                    builder.build(inputs,root/'receipt.json','clean-bookface-synapse-security:test')
                    self.assertIn(('image','inspect',image_id),calls)
                    self.assertNotIn(('image','inspect','clean-bookface-synapse-security:test'),calls)
                    self.assertTrue(all('clean-bookface-synapse-security:test' not in call for call in calls))
                    receipt = json.loads((root/'receipt.json').read_text())
                    self.assertEqual(receipt['imageId'],image_id)
                    self.assertEqual(receipt['packages'],[package])
                    self.assertEqual(receipt['actualBuildBase'],base)
                    for name, field in snapshot_fields.items():
                        self.assertEqual(receipt[field], hashlib.sha256(snapshots[name]).hexdigest())
    def test_mismatched_build_metadata_refused(self):
        self.exercise(mismatched_metadata=True)
    def test_source_mutations_cannot_change_context_or_receipt(self):
        self.exercise(mutate_sources=True)
    def test_changed_copy_refused_before_docker_build(self):
        self.exercise(corrupt_copy=True)
    def test_output_checks_bind_to_iid_not_reusable_tag(self):
        self.exercise()


if __name__ == '__main__': unittest.main()
