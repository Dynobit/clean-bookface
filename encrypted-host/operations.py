#!/usr/bin/env python3
"""Private host operations: HTTPS preparation, invitations and scheduled recovery."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time
from urllib.parse import urlencode, urlsplit
import host
import recovery

CADDY = 'caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b'


def origin(value):
    if any(ord(char) < 33 or ord(char) == 127 for char in value):
        raise ValueError('Origin must not contain whitespace or control characters')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.port not in (None, 443)
            or not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*', parsed.hostname)):
        raise ValueError('Use an HTTPS DNS origin without path, credentials or nonstandard port')
    return 'https://' + parsed.hostname


def atomic(path, value):
    temporary = path.with_suffix(path.suffix + '.new')
    host.write(temporary, value)
    temporary.replace(path)


def load(runtime):
    runtime = recovery.outside_source(runtime)
    state = json.loads((runtime / 'state.json').read_text())
    if not re.fullmatch(r'cbf-e2ee-[a-f0-9]{10}', state['project']):
        raise ValueError('Not a managed home')
    state['runtime'] = runtime
    return state


def proxy_config(home, server_name=None, peers=(), tunnel_origin=False, cloudflare_visitor_ip=False):
    if cloudflare_visitor_ip and not tunnel_origin:
        raise ValueError('Cloudflare visitor IP requires explicit loopback tunnel transport')
    home = origin(home)
    peers = sorted(set(host.federation_peer(peer) for peer in peers))
    paths = '/_matrix/client/* /_matrix/media/*'
    identity = None
    discovery = ''
    if peers:
        if not server_name:
            raise ValueError('Federation HTTPS requires the permanent server identity')
        identity = origin('https://' + host.federation_peer(server_name))
        paths += ' /_matrix/federation/* /_matrix/key/*'
        delegation = json.dumps({'m.server': urlsplit(home).hostname + ':443'}, separators=(',', ':'))
        discovery = ('    handle /.well-known/matrix/server {\n'
                     '        header Content-Type application/json\n'
                     '        header Cache-Control "public, max-age=300"\n'
                     '        respond `' + delegation + '` 200\n'
                     '    }\n')
    site = '''%s {
%s    @client_admin path_regexp client_admin ^/_matrix/client/(?:api/)?[^/]+/admin(?:/|$)
    handle @client_admin {
        respond "Not found" 404
    }
    @matrix path %s
    handle @matrix {
        request_body {
            max_size 26MB
        }
        reverse_proxy synapse:8008 {
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto https
            header_up X-Forwarded-Host {host}
        }
    }
    handle {
        respond "Not found" 404
    }
}
''' % (home, discovery if identity == home else '', paths)
    if identity and identity != home:
        site += identity + ' {\n' + discovery + '    handle {\n        respond "Not found" 404\n    }\n}\n'
    if tunnel_origin:
        site = site.replace(home + ' {', 'http://' + urlsplit(home).hostname + ':8080 {')
        if identity and identity != home:
            site = site.replace(identity + ' {', 'http://' + urlsplit(identity).hostname + ':8080 {')
    globals_config = '{\n    admin off\n'
    if cloudflare_visitor_ip:
        # Native client_ip parsing validates IP syntax. A list or other malformed
        # header must not select a forwarded identity; use the socket peer instead.
        globals_config += ('    servers {\n        trusted_proxies static 127.0.0.1/32 ::1/128\n'
                           '        client_ip_headers CF-Connecting-IP\n    }\n')
        site = site.replace('    @matrix path',
                            '    @valid_cf header_regexp CF-Connecting-IP ^[0-9A-Fa-f:.]+$\n    @matrix path')
        site = site.replace('        reverse_proxy synapse:8008 {',
                            '        route {\n            vars visitor_ip {remote_host}\n'
                            '            vars @valid_cf visitor_ip {client_ip}\n'
                            '            reverse_proxy synapse:8008 {')
        site = site.replace('header_up X-Forwarded-For {remote_host}', 'header_up X-Forwarded-For {vars.visitor_ip}')
        site = site.replace('header_up X-Forwarded-Host {host}\n        }',
                            'header_up X-Forwarded-Host {host}\n            }\n        }')
    return globals_config + '}\n' + site


def prepare_https(state, client, tunnel_proxy_port=None, cloudflare_visitor_ip=False):
    if state['mode'] != 'production':
        raise ValueError('HTTPS preparation requires production mode')
    runtime = state['runtime']
    public = json.loads((runtime / 'client-config.json').read_text())
    home = origin(public['homeserverUrl'])
    client = origin(client)
    if home == client:
        raise ValueError('Client must be delivered from a separate trusted origin')
    peers = sorted(set(host.federation_peer(peer) for peer in state.get('federationPeers', [])))
    config = json.loads((runtime / 'synapse/homeserver.yaml').read_text())
    if (sorted(config.get('federation_domain_whitelist', [])) != peers
            or sorted(public.get('federationPeers', [])) != peers
            or public['serverName'] != config['server_name']):
        raise ValueError('Runtime, client and Synapse federation identity/policy differ; refuse proxy exposure')
    resources = {name for listener in config['listeners'] for resource in listener.get('resources', []) for name in resource.get('names', [])}
    if ('federation' in resources) != bool(peers):
        raise ValueError('Synapse federation listener differs from the explicit peer policy')
    if peers and client == origin('https://' + public['serverName']):
        raise ValueError('Client origin must also be independent of the federation identity host')
    if tunnel_proxy_port is not None:
        if not 1024 <= tunnel_proxy_port <= 65535:
            raise ValueError('Tunnel origin requires an unprivileged loopback port from 1024 to 65535')
        # Preparation is repeatable; Compose owns collision handling at start.
    if cloudflare_visitor_ip and tunnel_proxy_port is None:
        raise ValueError('Cloudflare visitor IP requires --tunnel-proxy-port')
    spec = json.loads((runtime / 'compose.json').read_text())
    caddy = proxy_config(home, public['serverName'], peers, tunnel_proxy_port is not None, cloudflare_visitor_ip)
    if cloudflare_visitor_ip:
        upstream = urlsplit(state['url'])
        if upstream.scheme != 'http' or upstream.hostname != '127.0.0.1' or not upstream.port:
            raise ValueError('Cloudflare transport requires a loopback Synapse upstream')
        if upstream.port == tunnel_proxy_port:
            raise ValueError('Proxy and Synapse must use separate ports')
        # Host networking preserves the actual loopback peer; a Docker bridge
        # would replace it with its gateway and collapse all visitors again.
        caddy = caddy.replace(':8080 {', ':' + str(tunnel_proxy_port) + ' {\n    bind 127.0.0.1')
        caddy = caddy.replace('synapse:8008', '127.0.0.1:' + str(upstream.port))
    host.write(runtime / 'Caddyfile', caddy)
    spec['services']['https'] = {
        'image': CADDY, 'restart': 'unless-stopped',
        'ports': [f'127.0.0.1:{tunnel_proxy_port}:8080'] if tunnel_proxy_port is not None else ['80:80', '443:443'],
        'volumes': [str(runtime / 'Caddyfile') + ':/etc/caddy/Caddyfile:ro', 'https_data:/data', 'https_config:/config'],
        'networks': ['client'], 'depends_on': ['synapse'], 'cap_drop': ['ALL'],
        'cap_add': ['NET_BIND_SERVICE'], 'security_opt': ['no-new-privileges:true'], 'mem_limit': '256m'}
    if cloudflare_visitor_ip:
        spec['services']['https'].pop('ports')
        spec['services']['https'].pop('networks')
        spec['services']['https']['network_mode'] = 'host'
    spec['volumes'].update(https_data={}, https_config={})
    atomic(runtime / 'compose.json', spec)
    atomic(runtime / 'hosting.json', {'home': home, 'client': client, 'serverName': public['serverName'], 'federationPeers': peers,
                                          'transport': 'tunnel-origin' if tunnel_proxy_port is not None else 'automatic-https',
                                          'tunnelProxyPort': tunnel_proxy_port, 'cloudflareVisitorIp': cloudflare_visitor_ip})


def invitation(state, client=None):
    runtime = state['runtime']
    home = json.loads((runtime / 'client-config.json').read_text())['homeserverUrl']
    client = origin(client or json.loads((runtime / 'hosting.json').read_text())['client'])
    if client == home.rstrip('/'):
        raise ValueError('Client and storage host must use separate origins')
    value = host.invite(state)
    value['url'] = client + '/#' + urlencode({'home': home, 'invite': value['token']})
    host.write(runtime / 'invitation.json', value)
    host.write(runtime / 'invitation-link.txt', value['url'] + '\n')


def storage_args(config):
    result = []
    allowed = {'repository', 'password_file', 'sftp_host', 'sftp_user', 'sftp_path', 'sftp_port', 'ssh_directory'}
    if set(config) - allowed:
        raise ValueError('Unknown backup configuration field')
    for key, value in config.items():
        if value is not None:
            result.extend(['--' + key.replace('_', '-'), str(value)])
    return result


def configure_backup(state, args):
    recovery.validate_storage(args)
    config = {key: str(value.resolve()) if isinstance(value, pathlib.Path) else value
              for key in ('repository', 'password_file', 'sftp_host', 'sftp_user', 'sftp_path', 'sftp_port', 'ssh_directory')
              if (value := getattr(args, key)) is not None}
    atomic(state['runtime'] / 'backup-config.json', config)


def config_digest(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def run_backup(state):
    runtime = state['runtime']
    config = json.loads((runtime / 'backup-config.json').read_text())
    # Separate scheduler lock; recovery itself retains the service-operation lock.
    with recovery.operation_lock(runtime / 'scheduled-backup'):
        start = time.time()
        record_path = runtime / 'backup-health.json'
        previous = json.loads(record_path.read_text()) if record_path.exists() else {}
        record = {**previous, 'lastAttempt': start, 'status': 'running'}
        atomic(record_path, record)
        with (runtime / 'backup-last.log').open('w') as output:
            try:
                subprocess.run([sys.executable, str(host.ROOT / 'recovery.py'), 'backup', '--runtime', str(runtime),
                                *storage_args(config)], check=True, stdout=output, stderr=subprocess.STDOUT)
            except BaseException:
                atomic(record_path, {**record, 'status': 'failed', 'durationSeconds': time.time() - start})
                raise
        # recovery exits successfully only after full restic data verification and primary resume.
        atomic(record_path, {**record, 'status': 'verified', 'lastSuccess': time.time(),
                             'snapshotStarted': start, 'configSha256': config_digest(config), 'durationSeconds': time.time() - start})


def health(state, maximum_age=90000):
    path = state['runtime'] / 'backup-health.json'
    record = json.loads(path.read_text()) if path.exists() else {'status': 'never-run'}
    config_path = state['runtime'] / 'backup-config.json'
    current_digest = config_digest(json.loads(config_path.read_text())) if config_path.exists() else None
    bound = current_digest is not None and record.get('configSha256') == current_digest
    age = time.time() - record['snapshotStarted'] if 'snapshotStarted' in record else None
    return {**record, 'configurationMatches': bound, 'backupAgeSeconds': None if age is None else round(age),
            'healthy': bound and record.get('status') == 'verified' and age is not None and 0 <= age <= maximum_age}


def unit_quote(value):
    # systemd expands percent and dollar even in quoted arguments.
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def schedule(state):
    runtime = state['runtime']
    json.loads((runtime / 'backup-config.json').read_text())
    if any('\n' in str(p) or '\r' in str(p) for p in (runtime, host.ROOT, sys.executable)):
        raise ValueError('Paths must not contain newlines')
    name = state['project'] + '-backup'
    command = ' '.join(map(unit_quote, [sys.executable, host.ROOT / 'operations.py', 'backup-run', '--runtime', runtime]))
    host.write(runtime / (name + '.service'), '[Unit]\nDescription=Encrypted home verified backup\nRequires=docker.service\nAfter=docker.service network-online.target\n[Service]\nType=oneshot\nUMask=0077\nExecStart=' + command + '\nTimeoutStartSec=infinity\n')
    host.write(runtime / (name + '.timer'), '[Unit]\nDescription=Daily encrypted home backup\n[Timer]\nOnCalendar=*-*-* 03:00:00\nRandomizedDelaySec=15m\nPersistent=true\n[Install]\nWantedBy=timers.target\n')
    return name


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare-https', 'validate-https', 'invite', 'backup-configure', 'backup-run', 'backup-health', 'schedule'])
    parser.add_argument('--runtime', required=True, type=pathlib.Path)
    parser.add_argument('--client-url')
    parser.add_argument('--tunnel-proxy-port', type=int, help='Explicit TLS-terminating tunnel mode: restricted HTTP origin published only on this loopback port')
    parser.add_argument('--cloudflare-visitor-ip', action='store_true', help='Trust valid CF-Connecting-IP only from loopback cloudflared; Linux host networking')
    parser.add_argument('--repository', type=pathlib.Path)
    parser.add_argument('--password-file', type=pathlib.Path)
    parser.add_argument('--sftp-host'); parser.add_argument('--sftp-user'); parser.add_argument('--sftp-path')
    parser.add_argument('--sftp-port', type=int, default=22)
    parser.add_argument('--ssh-directory', type=pathlib.Path)
    parser.add_argument('--maximum-age', type=int, default=90000)
    args = parser.parse_args()
    state = load(args.runtime)
    if args.action == 'prepare-https':
        if not args.client_url: parser.error('--client-url is required')
        prepare_https(state, args.client_url, args.tunnel_proxy_port, args.cloudflare_visitor_ip)
        print('HTTPS configuration prepared. Validate it, then start this exact project on the target host.')
    elif args.action == 'validate-https':
        host.compose(state, 'run', '--rm', '--no-deps', 'https', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')
    elif args.action == 'invite':
        invitation(state, args.client_url)
        print('Private invitation saved in runtime/invitation-link.txt (one use, one hour).')
    elif args.action == 'backup-configure':
        if not args.password_file or bool(args.repository) == bool(args.sftp_host):
            parser.error('Provide --password-file and exactly one of --repository or --sftp-host')
        configure_backup(state, args)
        print('Private backup configuration saved.')
    elif args.action == 'backup-run':
        (state['runtime'] / 'scheduled-backup').mkdir(mode=0o700, exist_ok=True)
        run_backup(state)
        print('Backup and full-data verification completed.')
    elif args.action == 'backup-health':
        result = health(state, args.maximum_age)
        print(json.dumps(result, indent=2))
        return 0 if result['healthy'] else 1
    elif args.action == 'schedule':
        print('Prepared systemd service and timer: ' + schedule(state))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print(type(exc).__name__ + ': ' + str(exc), file=sys.stderr)
        sys.exit(1)
