import io
import pathlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import build_restic_source_image as build


class SourceInputTests(unittest.TestCase):
    def test_vendor_digest_binds_paths_and_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'a').write_bytes(b'one');first=build.tree_digest(root)
            (root/'a').rename(root/'b');self.assertNotEqual(first,build.tree_digest(root))
            (root/'b').rename(root/'a');(root/'a').write_bytes(b'two');self.assertNotEqual(first,build.tree_digest(root))
    def test_vendor_symlink_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'a').write_bytes(b'one');(root/'link').symlink_to(root/'a')
            with self.assertRaisesRegex(ValueError,'link'):build.tree_digest(root)
    def test_tampered_input_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'input';path.write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError,'hash mismatch'):build.verified(path,'0'*64)
    def test_input_symlink_refused_even_matching_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'file').write_bytes(b'ok');(root/'link').symlink_to(root/'file')
            with self.assertRaisesRegex(ValueError,'hash mismatch'):build.verified(root/'link',build.layer.digest(root/'file'))
    def test_archive_escape_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);archive=root/'bad.tar'
            with tarfile.open(archive,'w') as stream:
                item=tarfile.TarInfo('../escape');item.size=1;stream.addfile(item,io.BytesIO(b'x'))
            with self.assertRaises(tarfile.FilterError):build.extract(archive,root/'out')
            self.assertFalse((root/'escape').exists())
    def test_archive_link_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);archive=root/'bad.tar'
            with tarfile.open(archive,'w') as stream:
                item=tarfile.TarInfo('link');item.type=tarfile.SYMTYPE;item.linkname='/etc/passwd';stream.addfile(item)
            with self.assertRaisesRegex(ValueError,'link'):build.extract(archive,root/'out')
    def test_checkout_artifact_refused(self):
        with self.assertRaisesRegex(ValueError,'outside checkout'):build.outside(build.ROOT/'receipt.json')


class SourceRaceTests(unittest.TestCase):
    def setup_inputs(self, root):
        import json
        vendor=root/'vendor';vendor.mkdir();(vendor/'module.go').write_bytes(b'approved')
        inputs=root/'inputs';inputs.mkdir();(inputs/'go.tar.gz').write_bytes(b'compiler')
        lock=json.loads((build.FILES/'restic-source.json').read_text());lock['_manifest_sha256']='a'*64
        lock['vendorTreeSha256']=build.tree_digest(vendor);lock['toolchain']['filename']='go.tar.gz';lock['toolchain']['sha256']=build.layer.digest(inputs/'go.tar.gz')
        return inputs,vendor,lock,{'packages':[],'_manifest_sha256':'b'*64}
    def source(self, inputs, destination, lock):
        path=destination/'restic';path.mkdir(parents=True);return path
    def test_replaced_vendor_refused_before_docker_build(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);inputs,vendor,lock,packages=self.setup_inputs(root)
            original=build.shutil.copytree
            def changed(src,dst):
                (src/'module.go').write_bytes(b'replaced');return original(src,dst)
            with patch.object(build,'lock_and_inputs',return_value=(lock,packages)),patch.object(build,'source_tree',side_effect=self.source),patch.object(build.layer,'run',return_value=json.dumps([{'Os':'linux','Architecture':'arm64'}])),patch.object(build.shutil,'copytree',side_effect=changed),patch.object(build.subprocess,'run') as docker:
                with self.assertRaisesRegex(ValueError,'Staged vendor'):build.build(inputs,vendor,root/'receipt','clean-bookface-restic-source-security:race')
                docker.assert_not_called()
    def test_source_image_receipt_uses_iid_after_retag(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);inputs,vendor,lock,packages=self.setup_inputs(root);output='sha256:'+('c'*64);tag='clean-bookface-restic-source-security:race'
            def docker(args,**kwargs):
                pathlib.Path(args[args.index('--iidfile')+1]).write_text('sha256:'+'e'*64)
                pathlib.Path(args[args.index('--metadata-file')+1]).write_text(json.dumps({'containerimage.config.digest':'sha256:'+'e'*64,'containerimage.digest':output}))
            def run(*args):
                if args[:2]==('image','inspect'):
                    self.assertIn(args[2],[lock['base'],output]);return json.dumps([{'Id':output,'Os':'linux','Architecture':'arm64','Config':{'Labels':{'org.cleanbookface.ownership':lock['ownership']}},'RepoDigests':[]}])
                self.assertIn(output,args);self.assertNotIn(tag,args)
                if args[-1]=='version':return 'restic '+lock['version']+' compiled with '+lock['toolchain']['version']+' on linux/arm64'
                return 'd'*64+'  /usr/bin/restic'
            with patch.object(build,'lock_and_inputs',return_value=(lock,packages)),patch.object(build,'source_tree',side_effect=self.source),patch.object(build.layer,'run',side_effect=run),patch.object(build.subprocess,'run',side_effect=docker):
                build.build(inputs,vendor,root/'receipt',tag)
            self.assertEqual(json.loads((root/'receipt').read_text())['imageId'],output)


class SftpRefusalTests(unittest.TestCase):
    def test_only_explicit_failed_host_key_diagnostics_accepted(self):
        import qualify_sftp
        from types import SimpleNamespace
        for message in ['Host key verification failed', 'REMOTE HOST IDENTIFICATION HAS CHANGED!']:
            self.assertTrue(qualify_sftp.host_key_refused(SimpleNamespace(returncode=1, stderr=message)))
            self.assertFalse(qualify_sftp.host_key_refused(SimpleNamespace(returncode=0, stderr=message)))
        self.assertFalse(qualify_sftp.host_key_refused(SimpleNamespace(returncode=1, stderr='unexpected EOF')))


if __name__=='__main__':unittest.main()
