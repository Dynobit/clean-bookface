#!/usr/bin/env python3
"""Synthetic report and reversible suspension on a new disposable local home."""
import json
import secrets
import pathlib
import subprocess
import sys
import socket
import tempfile
from urllib.parse import quote
import host
import moderation
import operations


def main():
    root = pathlib.Path(tempfile.mkdtemp(prefix='cbf-moderation-qual-'))
    runtime = root / 'home'
    for _ in range(30):
        port = 20000 + secrets.randbelow(9000)
        try:
            with socket.socket() as first, socket.socket() as second:
                first.bind(('127.0.0.1', port)); second.bind(('127.0.0.1', port + 1))
            break
        except OSError: continue
    else: raise RuntimeError('No free fixture port pair')
    def cli(*args): subprocess.run([sys.executable, str(host.ROOT / 'host.py'), *map(str, args)], check=True)
    try:
        cli('bootstrap', '--runtime', runtime, '--port', port, '--imported-images', '--test-rate-profile')
        state = operations.load(runtime)
        users = json.loads((runtime / 'fictional-credentials.json').read_text())
        alice, bob = users[:2]
        a = host.login(state, alice['username'], alice['password'])
        b = host.login(state, bob['username'], bob['password'])
        code, room = host.request(state, '/_matrix/client/v3/createRoom', {'preset': 'private_chat', 'invite': [bob['userId']]}, a)
        assert code == 200
        room_id = quote(room['room_id'], safe='')
        assert host.request(state, '/_matrix/client/v3/join/' + room_id, {}, b)[0] == 200
        path = '/_matrix/client/v3/rooms/' + room_id
        code, event = host.request(state, path + '/send/m.room.message/one', {'msgtype': 'm.text', 'body': 'Synthetic reported test item'}, b, method='PUT')
        assert code == 200
        assert host.request(state, path + '/report/' + quote(event['event_id'], safe=''), {'reason': 'Synthetic selected report evidence', 'score': -100}, a)[0] == 200
        moderation.moderate(state, 'reports')
        reports = json.loads((runtime / 'moderation-reports.json').read_text())
        assert reports['event_reports'][0]['reason'] == 'Synthetic selected report evidence'
        assert (runtime / 'moderation-reports.json').stat().st_mode & 0o777 == 0o600
        host.write(root / 'reason', 'Synthetic review decision')
        moderation.moderate(state, 'suspend', bob['userId'], root / 'reason')
        assert host.request(state, path + '/send/m.room.message/two', {'msgtype': 'm.text', 'body': 'Denied test item'}, b, method='PUT')[0] == 403
        moderation.moderate(state, 'unsuspend', bob['userId'], root / 'reason')
        assert host.request(state, path + '/send/m.room.message/three', {'msgtype': 'm.text', 'body': 'Allowed test item'}, b, method='PUT')[0] == 200
        assert all(json.loads(p.read_text())['status'] == 'verified' for p in runtime.glob('moderation-decision-*.json'))
        host.request(state, '/_matrix/client/v3/logout', {}, a)
        host.request(state, '/_matrix/client/v3/logout', {}, b)
        print('PASS: actual selected report, private retrieval, suspension/send denial, unsuspension/send success, decision readback')
        moderation.moderate(state, 'suspend', bob['userId'], root / 'reason')
        receipts = {p.name:p.read_bytes() for p in runtime.glob('moderation-decision-*.json')}
        host.write(root / 'restic-password', secrets.token_urlsafe(32))
        common = ['--runtime',str(runtime),'--repository',str(root/'repository'),'--password-file',str(root/'restic-password')]
        subprocess.run([sys.executable,str(host.ROOT/'recovery.py'),'backup',*common,'--leave-stopped'],check=True)
        subprocess.run([sys.executable,str(host.ROOT/'recovery.py'),'restore-local',*common,'--destination',str(root/'standby'),'--port',str(port+1)],check=True)
        restored=operations.load(root/'standby')
        assert {p.name:p.read_bytes() for p in (root/'standby').glob('moderation-decision-*.json')} == receipts
        assert not (root/'standby/reason').exists()
        admin=json.loads((root/'standby/admin.json').read_text())
        token=host.login(restored,admin['username'],admin['password'])
        try:
            code,account=host.request(restored,'/_synapse/admin/v2/users/'+quote(bob['userId'],safe=''),token=token)
            assert code==200 and account['suspended'] is True
        finally: host.request(restored,'/_matrix/client/v3/logout',{},token)
        print('PASS: real encrypted backup/fenced restore preserved exact decision receipts and suspended database state')
    finally:
        if (root/'standby/state.json').exists(): cli('destroy-local','--runtime',root/'standby')
        if (runtime / 'state.json').exists(): cli('destroy-local', '--runtime', runtime)

if __name__ == '__main__': main()
