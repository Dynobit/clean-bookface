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


if __name__ == '__main__':
    unittest.main()
