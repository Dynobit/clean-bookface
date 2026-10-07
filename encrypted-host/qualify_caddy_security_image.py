#!/usr/bin/env python3
"""Qualify a local owned Caddy image without changing production image pins."""
import argparse
import hashlib
import http.client
import json
import pathlib
import secrets
import socket
import ssl
import subprocess
import tempfile
import time
import operations
import qualify_operations


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def qualify(image):
    if not image.startswith('sha256:') or len(image) != 71:
        raise ValueError('Use the built image ID, not a mutable tag')
    base = operations.CADDY
    assert docker('run', '--rm', '--network', 'none', base, 'caddy', 'list-modules') == docker('run', '--rm', '--network', 'none', image, 'caddy', 'list-modules')
    operations.CADDY = image
    qualify_operations.main()
    qualify_storage(image)


def qualify_storage(image):
    name = 'cbf-caddy-security-' + secrets.token_hex(5)
    volumes = [name + '-data', name + '-config']
    with tempfile.TemporaryDirectory(prefix='cbf-caddy-storage-') as tmp:
        root = pathlib.Path(tmp)
        (root / 'Caddyfile').write_text('{\n admin off\n skip_install_trust\n}\nhttps://home.test {\n tls internal\n respond "synthetic TLS storage check"\n}\n')
        try:
            for volume in volumes:
                docker('volume', 'create', volume)
            def start():
                docker('run', '-d', '--name', name, '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE',
                       '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--pids-limit', '128',
                       '--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
                       '-p', '127.0.0.1::443', '-v', str(root / 'Caddyfile') + ':/etc/caddy/Caddyfile:ro',
                       '-v', volumes[0] + ':/data', '-v', volumes[1] + ':/config', image)
                info = json.loads(docker('inspect', name))[0]
                cfg = info['HostConfig']
                assert cfg['CapDrop'] == ['ALL'] and [cap.removeprefix('CAP_') for cap in cfg['CapAdd']] == ['NET_BIND_SERVICE']
                assert 'no-new-privileges:true' in cfg['SecurityOpt']
                assert cfg['Memory'] == 256 * 1024 * 1024 and cfg['PidsLimit'] == 128
                assert cfg['LogConfig']['Config'] == {'max-file': '2', 'max-size': '1m'}
                assert all(p['HostIp'] == '127.0.0.1' for ps in cfg['PortBindings'].values() for p in ps)
                for _ in range(40):
                    result = subprocess.run(['docker', 'exec', name, 'test', '-f', '/data/caddy/pki/authorities/local/root.crt'], capture_output=True)
                    if result.returncode == 0: break
                    time.sleep(.1)
                else: raise AssertionError('Internal certificate was not stored')
                docker('cp', name + ':/data/caddy/pki/authorities/local/root.crt', str(root / 'ca.pem'))
                port = int(docker('port', name, '443/tcp').rsplit(':', 1)[1])
                def fetch(context):
                    conn = http.client.HTTPSConnection('home.test', port, context=context, timeout=5)
                    conn._create_connection = lambda *a, **kw: socket.create_connection(('127.0.0.1', port), timeout=5)
                    try:
                        conn.request('GET', '/')
                        response = conn.getresponse()
                        assert response.status == 200 and response.read() == b'synthetic TLS storage check'
                        return hashlib.sha256(conn.sock.getpeercert(binary_form=True)).hexdigest()
                    finally: conn.close()
                try: fetch(ssl.create_default_context())
                except ssl.SSLCertVerificationError: pass
                else: raise AssertionError('Untrusted private CA unexpectedly accepted')
                return fetch(ssl.create_default_context(cafile=str(root / 'ca.pem'))), hashlib.sha256((root / 'ca.pem').read_bytes()).hexdigest()
            before = start()
            docker('rm', '-f', name)
            after = start()
            assert before == after, 'Stored certificate/CA changed across container replacement'
            print('PASS: unchanged modules; containment readback; trusted TLS; untrusted CA refusal; certificate/CA persistence across replacement')
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
            for volume in volumes: subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    qualify(parser.parse_args().image)
