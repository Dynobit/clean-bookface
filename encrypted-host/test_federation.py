import argparse
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import host


class FederationConfiguration(unittest.TestCase):
    def test_exact_peer_identity_validation(self):
        self.assertEqual(host.federation_peer('https://friend.example:8448'), 'friend.example:8448')
        self.assertEqual(host.federation_peer('friend.example'), 'friend.example')
        for peer in ['*','https://friend.example/path','http://friend.example','user@friend.example','127.0.0.1','localhost','a..example','-a.example','a.example:0','a.example:65536','https://a.example?x=1']:
            with self.subTest(peer=peer), self.assertRaises(argparse.ArgumentTypeError):
                host.federation_peer(peer)

    def test_generated_policy_default_closed_and_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            for name,peers in [('closed',[]),('peered',['https://friend.example','friend.example'])]:
                runtime=pathlib.Path(directory)/name
                args=argparse.Namespace(runtime=runtime,mode='production',server_name='home.example',public_url='https://matrix.home.example',port=0,imported_images=False,federation_peer=peers)
                with patch.object(host,'compose',side_effect=RuntimeError('stop before containers')):
                    with self.assertRaisesRegex(RuntimeError,'stop before containers'): host.initialize(args)
                config=json.loads((runtime/'synapse/homeserver.yaml').read_text())
                self.assertEqual(config['federation_domain_whitelist'],['friend.example'] if peers else [])
                self.assertEqual(config['listeners'][0]['resources'][0]['names'],['client','federation'] if peers else ['client'])
                for weakened in ['ip_range_whitelist','ip_range_blacklist','federation_verify_certificates','federation_custom_ca_list']:
                    self.assertNotIn(weakened,config)
                self.assertEqual(config['trusted_key_servers'],[])
                self.assertFalse(config['allow_public_rooms_over_federation'])
                state=json.loads((runtime/'state.json').read_text())
                self.assertEqual(state['federationPeers'],config['federation_domain_whitelist'])

if __name__=='__main__': unittest.main()
