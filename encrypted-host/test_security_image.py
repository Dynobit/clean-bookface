import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import build_security_image as builder


class OwnedImageTests(unittest.TestCase):
    def test_official_alias_refused_before_docker(self):
        with patch.object(builder, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'distinct'):
                builder.build(pathlib.Path('/tmp/packages'), pathlib.Path('/tmp/receipt'), 'restic/restic:0.19.1')
            run.assert_not_called()

    def test_corrupt_package_refused_before_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            lock = json.loads((builder.ROOT / 'security-images/restic-packages.json').read_text())
            first = lock['packages'][0]
            (root / (first['package'] + '-' + first['version'] + '.apk')).write_bytes(b'corrupt')
            with patch.object(builder, 'run', return_value='[{"Architecture":"arm64","Os":"linux"}]'), patch.object(builder.subprocess, 'run') as build:
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    builder.build(root, root / 'receipt.json', 'clean-bookface-restic-security:test')
                build.assert_not_called()


class RaceTests(unittest.TestCase):
    def test_source_replaced_during_copy_fails_staged_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);source=root/'input';target=root/'staged';source.write_bytes(b'approved');expected=builder.digest(source)
            original=builder.shutil.copyfile
            def swap(src,dst):
                src.write_bytes(b'replaced-after-validation');return original(src,dst)
            with patch.object(builder.shutil,'copyfile',side_effect=swap):
                with self.assertRaisesRegex(ValueError,'Staged input hash mismatch'):builder.copy_verified(source,target,expected)
    def test_layer_uses_iid_despite_concurrent_retag(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);recipes=root/'security-images';recipes.mkdir();packages=root/'packages';packages.mkdir();(packages/'a-1.apk').write_bytes(b'package')
            base='official@sha256:'+('a'*64);output='sha256:'+('b'*64);base_id='sha256:'+('c'*64)
            (recipes/'restic-packages.json').write_text(json.dumps({'ownership':'project-derived-not-official','platform':'linux/arm64','base':base,'packages':[{'package':'a','version':'1','sha256':builder.digest(packages/'a-1.apk')}]}));(recipes/'restic.Dockerfile').write_text('FROM '+base+'\n')
            def run(*args):
                if args[:2]==('image','inspect'):
                    self.assertIn(args[2],[base,output]);return json.dumps([{'Id':base_id if args[2]==base else output,'Architecture':'arm64','Os':'linux','Config':{},'RepoDigests':[]}])
                self.assertIn(args[-2],[base_id,output]);return 'd'*64+'  /usr/bin/restic'
            def docker_build(args,**kwargs):
                pathlib.Path(args[args.index('--iidfile')+1]).write_text('sha256:'+'e'*64)
                pathlib.Path(args[args.index('--metadata-file')+1]).write_text(json.dumps({'containerimage.config.digest':'sha256:'+'e'*64,'containerimage.digest':output}))
            with patch.object(builder,'ROOT',root),patch.object(builder,'run',side_effect=run),patch.object(builder.subprocess,'run',side_effect=docker_build):
                # Artifacts must be outside mocked checkout root.parent.
                with tempfile.TemporaryDirectory() as output_dir:
                    with patch.object(pathlib.Path,'resolve',lambda p:p):
                        # Keep ROOT parent distinct from inputs without weakening build code.
                        nested=root/'recipe';nested.mkdir();builder_root=nested/'encrypted-host';builder_root.mkdir();builder.shutil.copytree(recipes,builder_root/'security-images')
                        with patch.object(builder,'ROOT',builder_root):builder.build(packages,pathlib.Path(output_dir)/'receipt.json','clean-bookface-restic-security:race')


class MetadataTests(unittest.TestCase):
    def test_unbound_build_metadata_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'iid').write_text('sha256:'+'a'*64);(root/'metadata').write_text(json.dumps({'containerimage.config.digest':'sha256:'+'b'*64,'containerimage.digest':'sha256:'+'c'*64}))
            with self.assertRaisesRegex(ValueError,'does not bind'):builder.built_image_id(root/'iid',root/'metadata')


class ImageStoreTests(unittest.TestCase):
    def test_containerd_uses_manifest_reference(self):
        refs=('sha256:'+'a'*64,'sha256:'+'b'*64)
        with patch.object(builder,'run',return_value=json.dumps([{'Id':refs[0]}])) as run:
            self.assertEqual(builder.inspect_built_image(refs)['Id'],refs[0]);run.assert_called_once_with('image','inspect',refs[0])
    def test_classic_falls_back_only_to_bound_config(self):
        refs=('sha256:'+'a'*64,'sha256:'+'b'*64)
        with patch.object(builder,'run',side_effect=[builder.subprocess.CalledProcessError(1,['docker']),json.dumps([{'Id':refs[1]}])]) as run:
            self.assertEqual(builder.inspect_built_image(refs)['Id'],refs[1]);self.assertEqual([c.args[-1] for c in run.call_args_list],list(refs))
    def test_unexpected_lookup_identity_refused(self):
        with patch.object(builder,'run',return_value='[{"Id":"wrong"}]'):
            with self.assertRaisesRegex(ValueError,'not bound'):builder.inspect_built_image(('sha256:'+'a'*64,'sha256:'+'b'*64))


if __name__ == '__main__':
    unittest.main()
