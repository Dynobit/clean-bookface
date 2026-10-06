import argparse
import json
import pathlib
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import host
import operations


class Operations(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='cbf-ops-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.state = {'runtime': self.root, 'project': 'cbf-e2ee-0123456789', 'mode': 'production'}
        host.write(self.root / 'client-config.json', {'homeserverUrl': 'https://home.example', 'serverName': 'identity.example', 'federationPeers': []})
        (self.root / 'synapse').mkdir()
        host.write(self.root / 'synapse/homeserver.yaml', {'server_name': 'identity.example', 'federation_domain_whitelist': [], 'listeners': [{'resources': [{'names': ['client']}]}]})
        host.write(self.root / 'compose.json', {'services': {}, 'volumes': {}})

    def test_cloudflare_transport_is_explicit_and_loopback_only(self):
        self.state['url'] = 'http://127.0.0.1:18280'
        with self.assertRaises(ValueError):
            operations.prepare_https(self.state, 'https://client.example', cloudflare_visitor_ip=True)
        operations.prepare_https(self.state, 'https://client.example', 18281, True)
        service = json.loads((self.root / 'compose.json').read_text())['services']['https']
        self.assertEqual(service['network_mode'], 'host')
        self.assertNotIn('ports', service)
        self.assertNotIn('networks', service)
        config = (self.root / 'Caddyfile').read_text()
        self.assertIn('bind 127.0.0.1', config)
        self.assertIn('reverse_proxy 127.0.0.1:18280', config)
        self.assertIn('trusted_proxies static 127.0.0.1/32 ::1/128', config)
        self.assertIn('client_ip_headers CF-Connecting-IP', config)
        self.assertNotIn('client_ip_headers X-Forwarded-For', config)
        self.state['url'] = 'http://127.0.0.1:18281'
        with self.assertRaises(ValueError):
            operations.prepare_https(self.state, 'https://client.example', 18281, True)

    def test_separate_origin_and_injection_denied(self):
        for bad in ['http://home.example', 'https://home.example/x', 'https://a.example\nfoo', 'https://user@home.example']:
            with self.assertRaises(ValueError): operations.origin(bad)
        with self.assertRaises(ValueError): operations.prepare_https(self.state, 'https://home.example')
        self.assertFalse((self.root / 'Caddyfile').exists())

    def test_repeatable_https_preparation_preserves_services(self):
        host.write(self.root / 'compose.json', {'services': {'synapse': {'image': 'existing'}}, 'volumes': {}})
        operations.prepare_https(self.state, 'https://client.example')
        first = (self.root / 'compose.json').read_text()
        operations.prepare_https(self.state, 'https://client.example')
        self.assertEqual(first, (self.root / 'compose.json').read_text())
        self.assertEqual(json.loads(first)['services']['synapse']['image'], 'existing')

    def test_https_federation_policy_drift_fails_before_writing(self):
        self.state['federationPeers'] = ['friend.example']
        with self.assertRaisesRegex(ValueError, 'policy differ'):
            operations.prepare_https(self.state, 'https://client.example')
        self.assertFalse((self.root / 'Caddyfile').exists())
        public = json.loads((self.root / 'client-config.json').read_text())
        public['federationPeers'] = ['friend.example'];host.write(self.root / 'client-config.json', public)
        config = json.loads((self.root / 'synapse/homeserver.yaml').read_text())
        config['federation_domain_whitelist'] = ['friend.example'];host.write(self.root / 'synapse/homeserver.yaml', config)
        with self.assertRaisesRegex(ValueError, 'listener differs'):
            operations.prepare_https(self.state, 'https://client.example')
        config['listeners'][0]['resources'][0]['names'].append('federation');host.write(self.root / 'synapse/homeserver.yaml', config)
        with self.assertRaisesRegex(ValueError, 'independent'):
            operations.prepare_https(self.state, 'https://identity.example')
        operations.prepare_https(self.state, 'https://client.example')
        self.assertEqual(json.loads((self.root / 'hosting.json').read_text())['federationPeers'], ['friend.example'])

    def test_tunnel_origin_is_explicit_loopback_only_and_port_validated(self):
        with self.assertRaisesRegex(ValueError, 'unprivileged loopback'):
            operations.prepare_https(self.state, 'https://client.example', 443)
        self.assertFalse((self.root / 'Caddyfile').exists())
        operations.prepare_https(self.state, 'https://client.example', 18281)
        spec = json.loads((self.root / 'compose.json').read_text())
        self.assertEqual(spec['services']['https']['ports'], ['127.0.0.1:18281:8080'])
        self.assertEqual(spec['services']['https']['cap_add'], ['NET_BIND_SERVICE'])
        self.assertEqual(json.loads((self.root / 'hosting.json').read_text())['transport'], 'tunnel-origin')

    def test_invitation_fragment_and_private_file(self):
        with patch('host.invite', return_value={'token': 'secret&token', 'uses_allowed': 1}):
            operations.invitation(self.state, 'https://client.example')
        from urllib.parse import urlsplit, parse_qs
        url = (self.root / 'invitation-link.txt').read_text().strip()
        self.assertEqual(urlsplit(url).query, '')
        self.assertEqual(parse_qs(urlsplit(url).fragment), {'home': ['https://home.example'], 'invite': ['secret&token']})
        self.assertEqual((self.root / 'invitation-link.txt').stat().st_mode & 0o777, 0o600)

    def test_health_never_failed_stale_and_verified(self):
        self.assertFalse(operations.health(self.state)['healthy'])
        config = {'repository': '/fixture/repo', 'password_file': '/fixture/password'}
        host.write(self.root / 'backup-config.json', config)
        for status, age, expected in [('verified', 10, True), ('verified', 100000, False), ('failed', 10, False), ('running', 10, False)]:
            host.write(self.root / 'backup-health.json', {'status': status, 'snapshotStarted': time.time() - age, 'configSha256': operations.config_digest(config)})
            self.assertEqual(operations.health(self.state)['healthy'], expected)

    def test_failed_backup_does_not_advance_verified_snapshot(self):
        (self.root / 'scheduled-backup').mkdir()
        host.write(self.root / 'backup-config.json', {'repository': '/synthetic/repo', 'password_file': '/synthetic/password'})
        with patch('subprocess.run'):
            operations.run_backup(self.state)
        before = operations.health(self.state)
        with patch('subprocess.run', side_effect=subprocess.CalledProcessError(1, ['fixture'])):
            with self.assertRaises(subprocess.CalledProcessError): operations.run_backup(self.state)
        after = operations.health(self.state)
        self.assertFalse(after['healthy'])
        self.assertEqual(before['lastSuccess'], after['lastSuccess'])
        self.assertEqual(before['snapshotStarted'], after['snapshotStarted'])

    def test_health_is_bound_to_successful_destination_and_requires_fresh_backup(self):
        (self.root / 'scheduled-backup').mkdir()
        original = {'repository': '/fixture/original', 'password_file': '/fixture/password'}
        host.write(self.root / 'backup-config.json', original)
        with patch('subprocess.run'):
            operations.run_backup(self.state)
        self.assertTrue(operations.health(self.state)['healthy'])
        changed = {**original, 'repository': '/fixture/new-destination'}
        host.write(self.root / 'backup-config.json', changed)
        self.assertFalse(operations.health(self.state)['healthy'])
        self.assertFalse(operations.health(self.state)['configurationMatches'])
        with patch('subprocess.run'):
            operations.run_backup(self.state)
        self.assertTrue(operations.health(self.state)['healthy'])
        # Formatting/key order is not a destination change.
        (self.root / 'backup-config.json').write_text(json.dumps(dict(reversed(list(changed.items())))))
        self.assertTrue(operations.health(self.state)['healthy'])
        (self.root / 'backup-config.json').unlink()
        self.assertFalse(operations.health(self.state)['healthy'])

    def test_configuration_change_during_backup_does_not_mark_new_destination_healthy(self):
        (self.root / 'scheduled-backup').mkdir()
        host.write(self.root / 'backup-config.json', {'repository': '/fixture/original'})
        def change_destination(*args, **kwargs):
            host.write(self.root / 'backup-config.json', {'repository': '/fixture/new'})
        with patch('subprocess.run', side_effect=change_destination):
            operations.run_backup(self.state)
        self.assertEqual(operations.health(self.state)['status'], 'verified')
        self.assertFalse(operations.health(self.state)['healthy'])

    def test_root_install_uses_unprivileged_synapse_and_restores_data_ownership(self):
        directory = self.root / 'synapse'
        (directory / 'homeserver.yaml').write_text('synthetic')
        with patch('os.getuid', return_value=0), patch('os.chown') as chown:
            self.assertEqual(host.synapse_user(), '991:991')
            host.prepare_synapse_ownership(self.root, {'services': {'synapse': {'user': '991:991'}}})
            self.assertEqual(chown.call_count, 2)
            for call in chown.call_args_list:
                self.assertEqual(call.args[1:], (991, 991))
                self.assertFalse(call.kwargs['follow_symlinks'])
            with self.assertRaises(RuntimeError):
                host.prepare_synapse_ownership(self.root, {'services': {'synapse': {'user': '0:0'}}})

    def test_schedule_is_repeatable_and_configuration_not_executable(self):
        host.write(self.root / 'backup-config.json', {})
        name = operations.schedule(self.state)
        first = (self.root / (name + '.service')).read_text()
        self.assertEqual(name, operations.schedule(self.state))
        self.assertEqual(first, (self.root / (name + '.service')).read_text())
        with self.assertRaises(ValueError): operations.storage_args({'leave_stopped': True})


    def test_moderation_rejects_administrator_and_logs_out_on_error(self):
        import moderation
        host.write(self.root / 'admin.json', {'username': 'host_admin', 'password': 'synthetic'})
        host.write(self.root / 'client-config.json', {'serverName': 'home.example'})
        with self.assertRaises(ValueError):
            moderation.moderate(self.state, 'suspend', '@host_admin:home.example')
        with patch('host.login', return_value='synthetic'), patch('host.request', side_effect=[(500, {}), (200, {})]) as request:
            with self.assertRaises(RuntimeError): moderation.moderate(self.state, 'reports')
            self.assertEqual(request.call_args.args[1], '/_matrix/client/v3/logout')

if __name__ == '__main__': unittest.main()
