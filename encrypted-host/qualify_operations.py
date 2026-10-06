#!/usr/bin/env python3
"""Disposable real TLS proxy checks; no public DNS or live service changes."""
import http.client
import json
import pathlib
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import operations


def qualify(root, mode):
    label = mode
    cloudflare = mode.startswith('cloudflare-')
    tunnel = mode.startswith('tunnel-') or cloudflare
    mode = mode.removeprefix('tunnel-').removeprefix('cloudflare-')
    name = 'cbf-https-qual-' + secrets.token_hex(5)
    peers = [] if mode == 'closed' else ['friend.example']
    identity = 'home.test' if mode == 'self' else 'identity.test'
    config = operations.proxy_config('https://home.test', identity, peers, tunnel, cloudflare)
    for hostname in ['home.test', 'identity.test']:
        config = config.replace('https://' + hostname + ' {', 'https://' + hostname + ' {\n    tls /fixture/cert.pem /fixture/key.pem')
    config = config.replace('synapse:8008', '127.0.0.1:8008')
    config += '\nhttp://:8008 {\n    respond `{"forwarded":"{header.X-Forwarded-For}","uri":"{uri}","method":"{method}","authorization":"{header.Authorization}"}`\n}\n'
    (root / 'Caddyfile').write_text(config)
    try:
        subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true', '-v', str(root) + ':/fixture:ro',
                        operations.CADDY, 'caddy', 'validate', '--config', '/fixture/Caddyfile', '--adapter', 'caddyfile'], check=True)
        subprocess.run(['docker', 'run', '-d', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true', '--name', name, '-p', '127.0.0.1::' + ('8080' if tunnel else '443'), '-v', str(root) + ':/fixture:ro',
                        operations.CADDY, 'caddy', 'run', '--config', '/fixture/Caddyfile', '--adapter', 'caddyfile'], check=True, capture_output=True)
        port = int(subprocess.check_output(['docker', 'port', name, '8080/tcp' if tunnel else '443/tcp'], text=True).strip().rsplit(':', 1)[1])
        context = ssl.create_default_context(cafile=str(root / 'cert.pem'))
        def fetch(path, hostname='home.test', method='GET'):
            connection = (http.client.HTTPConnection(hostname, port, timeout=5) if tunnel
                          else http.client.HTTPSConnection(hostname, port, context=context, timeout=5))
            # Connect to the owned loopback listener while preserving real SNI,
            # hostname verification and Host. No machine DNS/CA mutation.
            connection._create_connection = lambda *a, **kw: socket.create_connection(('127.0.0.1', port), timeout=5)
            try:
                connection.request(method, path, headers={'X-Forwarded-For': '198.51.100.123', 'Authorization': 'Bearer synthetic', 'CF-Connecting-IP': '203.0.113.99'})
                response = connection.getresponse()
                return response.status, response.read(), dict(response.getheaders())
            finally: connection.close()
        for _ in range(30):
            try:
                if fetch('/')[0] == 404: break
            except OSError: time.sleep(.2)
        checks = 0
        allowed = ['/_matrix/client/versions', '/_matrix/client/v1/media/download/a/b', '/_matrix/media/v3/download/a/b']
        forbidden = ['/', '/admin.json', '/_synapse/admin/v1/users', '/_matrix/client/../_synapse/admin/v1/users', '/_matrix/client/%2e%2e/../_synapse/admin/v1/users']
        forbidden.extend('/_matrix/client/' + version + '/admin/whois/user' for version in ['api/v1', 'v1', 'r0', 'v3', 'unstable'])
        forbidden.extend(['/_matrix/client/v3/%61dmin/whois/user', '/api/v1/admin/whois/user'])
        federation = ['/_matrix/federation/v1/version', '/_matrix/key/v2/server']
        (allowed if peers else forbidden).extend(federation)
        for path in allowed:
            code, body, _ = fetch(path)
            assert code == 200, (mode, path, code)
            assert json.loads(body)['forwarded'] not in ('198.51.100.123', '203.0.113.99')
            checks += 1
        for path in forbidden:
            assert fetch(path)[0] == 404, (mode, path)
            checks += 1
        encoded = '/_matrix/federation/v1/send/a%2Fb?x=a%2Fb&x=two' if peers else '/_matrix/client/v3/rooms/a%2Fb?x=a%2Fb&x=two'
        code, body, _ = fetch(encoded, method='PUT')
        payload = json.loads(body)
        assert code == 200 and payload['uri'] == encoded and payload['method'] == 'PUT' and payload['authorization'] == 'Bearer synthetic'
        checks += 1
        if peers:
            code, body, headers = fetch('/.well-known/matrix/server', identity)
            assert code == 200 and json.loads(body) == {'m.server': 'home.test:443'}
            assert headers.get('Content-Type') == 'application/json' and headers.get('Cache-Control') == 'public, max-age=300'
            checks += 1
            for path in ['/.well-known/matrix/server/extra', '/_synapse/admin/v1/users', '/Caddyfile']:
                assert fetch(path, identity)[0] == 404
                checks += 1
            if mode == 'delegated':
                assert fetch('/_matrix/client/versions', identity)[0] == 404
                assert fetch('/.well-known/matrix/server')[0] == 404
                checks += 2
        else:
            assert fetch('/.well-known/matrix/server')[0] == 404
            checks += 1
        if cloudflare:
            # Inside the container this socket peer is genuinely loopback;
            # outside fetches above prove Docker bridge peers cannot spoof it.
            for visitor, expected in [('203.0.113.7', '203.0.113.7'), ('2001:db8::7', '2001:db8::7'),
                                      ('not-an-ip', '127.0.0.1'), ('999.999.999.999', '127.0.0.1'),
                                      ('203.0.113.7, 203.0.113.8', '127.0.0.1'), ('', '127.0.0.1')]:
                args = ['docker', 'exec', name, 'wget', '-qO-', '--header', 'Host: home.test',
                        '--header', 'X-Forwarded-For: 198.51.100.123']
                if visitor: args += ['--header', 'CF-Connecting-IP: ' + visitor]
                args += ['http://127.0.0.1:8080/_matrix/client/versions']
                payload = json.loads(subprocess.check_output(args, text=True))
                assert payload['forwarded'] == expected, (visitor, payload)
                checks += 1
        print('PASS:', label, checks, 'actual ' + ('loopback HTTP origin' if tunnel else 'TLS') + ' checks; path/query/method/auth preserved, admin denied, spoofed forwarded IP replaced')
    finally:
        subprocess.run(['docker', 'rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    with tempfile.TemporaryDirectory(prefix='cbf-https-qual-') as tmp:
        root = pathlib.Path(tmp)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=home.test', '-addext', 'subjectAltName=DNS:home.test,DNS:identity.test',
                        '-keyout', str(root / 'key.pem'), '-out', str(root / 'cert.pem')],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for mode in ['closed', 'self', 'delegated', 'tunnel-closed', 'tunnel-self', 'tunnel-delegated', 'cloudflare-closed']:
            mode_root = root / mode; mode_root.mkdir()
            for filename in ['cert.pem', 'key.pem']: shutil.copy2(root / filename, mode_root / filename)
            qualify(mode_root, mode)

if __name__ == '__main__': main()
