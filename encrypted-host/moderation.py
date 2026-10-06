#!/usr/bin/env python3
"""Local administrative report review and explicit reversible account suspension."""
import argparse
import json
import os
import pathlib
import secrets
import sys
import time
from urllib.parse import quote
import host
import operations


def moderate(state, action, user_id=None, reason_file=None, offset=0):
    runtime = state['runtime']
    admin = json.loads((runtime / 'admin.json').read_text())
    reason = None
    if action != 'reports':
        server = json.loads((runtime / 'client-config.json').read_text())['serverName']
        if not user_id or not user_id.startswith('@') or user_id.split(':', 1)[-1] != server:
            raise ValueError('Provide an exact local Matrix user ID')
        if user_id == '@' + admin['username'] + ':' + server:
            raise ValueError('Refusing to suspend the host administrator')
        if not reason_file:
            raise ValueError('Provide a private --reason-file documenting this decision')
        reason_file = operations.recovery.outside_source(reason_file)
        if reason_file.stat().st_mode & 0o077:
            raise ValueError('Decision reason file must be private (0600)')
        reason = reason_file.read_text().strip()
        if not reason or len(reason) > 10000:
            raise ValueError('Decision reason must contain 1–10000 characters')
    token = host.login(state, admin['username'], admin['password'])
    try:
        if action == 'reports':
            code, data = host.request(state, '/_synapse/admin/v1/event_reports?limit=100&from=' + str(offset), token=token)
            if code != 200: raise RuntimeError('Report retrieval failed: HTTP ' + str(code))
            host.write(runtime / 'moderation-reports.json', data)
        else:
            path = '/_synapse/admin/v2/users/' + quote(user_id, safe='')
            code, before = host.request(state, path, token=token)
            if code != 200 or before.get('admin'):
                raise ValueError('Target must be an existing non-administrator account')
            suspended = action == 'suspend'
            record = {'time': time.time(), 'userId': user_id, 'suspended': suspended, 'reason': reason, 'status': 'pending'}
            receipt = runtime / ('moderation-decision-' + secrets.token_hex(8) + '.json')
            host.write(receipt, record)
            code, _ = host.request(state, '/_synapse/admin/v1/suspend/' + quote(user_id, safe=''), {'suspend': suspended}, token, method='PUT')
            if code != 200: raise RuntimeError('Suspension update failed: HTTP ' + str(code))
            code, after = host.request(state, path, token=token)
            if code != 200 or after.get('suspended') is not suspended:
                raise RuntimeError('Suspension readback failed; inspect private pending decision')
            host.write(receipt, {**record, 'status': 'verified'})
    finally:
        code, _ = host.request(state, '/_matrix/client/v3/logout', {}, token)
        if code != 200: raise RuntimeError('Administrator logout failed; revoke the token before continuing')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['reports', 'suspend', 'unsuspend'])
    parser.add_argument('--runtime', required=True, type=pathlib.Path)
    parser.add_argument('--user-id')
    parser.add_argument('--reason-file', type=pathlib.Path)
    parser.add_argument('--offset', type=int, default=0)
    args = parser.parse_args()
    if args.offset < 0: parser.error('Offset must be nonnegative')
    moderate(operations.load(args.runtime), args.action, args.user_id, args.reason_file, args.offset)
    print('Completed. Reports or decision receipt saved privately in the runtime; no evidence printed.')

if __name__ == '__main__':
    try: main()
    except (ValueError, RuntimeError, OSError) as exc:
        print(type(exc).__name__ + ': ' + str(exc), file=sys.stderr); sys.exit(1)
