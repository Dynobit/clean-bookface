import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatrixError, type MatrixClient } from 'matrix-js-sdk';
import {
  setBlocked,
  isBlocked,
  blockedUsers,
  reportSelectedEvidence,
  deactivateAccount,
} from '../src/lifecycle';

const me = '@alice:example.invalid';
function fixture(initial: string[] = []) {
  let ignored = Object.fromEntries(initial.map((id) => [id, {}]));
  const policies = new Map<string, { getContent: () => unknown }>();
  const client = {
    getUserId: () => me,
    store: { accountData: policies },
    getAccountData: (type: string) => policies.get(type),
    getIgnoredUsers: () => Object.keys(ignored),
    isUserIgnored: (id: string) => Object.hasOwn(ignored, id),
    getAccountDataFromServer: async () => {
      throw new Error('Cached SDK method cannot qualify readback');
    },
    setAccountData: async (type: string, value: unknown) => {
      policies.set(type, { getContent: () => value });
      return {};
    },
    setIgnoredUsers: async (ids: string[]) => {
      ignored = Object.fromEntries(ids.map((id) => [id, {}]));
      return {};
    },
    http: {
      authedRequest: async (method: string, path: string): Promise<unknown> => {
        assert.equal(method, 'GET');
        const type = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
        if (type === 'm.ignored_user_list') return { ignored_users: structuredClone(ignored) };
        return policies.get(type)?.getContent();
      },
    },
  };
  return { client: client as unknown as MatrixClient, mutable: client, policies };
}
test('blocking preserves legacy metadata and explicit unblock overrides the legacy fallback', async () => {
  const { client, mutable } = fixture(['@existing:example.invalid']);
  await setBlocked(client, '@ben:example.invalid', true);
  assert.deepEqual(blockedUsers(client), ['@ben:example.invalid', '@existing:example.invalid']);
  await setBlocked(client, '@ben:example.invalid', false);
  await mutable.setIgnoredUsers(['@ben:example.invalid', '@existing:example.invalid']);
  assert.equal(isBlocked(client, '@ben:example.invalid'), false);
  assert.deepEqual(blockedUsers(client), ['@existing:example.invalid']);
  await assert.rejects(setBlocked(client, me, true), /own account/);
});
test('different-peer simultaneous blocks survive a forced legacy-list lost update', async () => {
  const { client, mutable } = fixture();
  const x = '@x:example.invalid',
    y = '@y:example.invalid';
  const originalRead = mutable.http.authedRequest,
    originalWrite = mutable.setIgnoredUsers;
  let initialReads = 0,
    release!: () => void,
    firstReadback!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstFinished = new Promise<void>((resolve) => {
    firstReadback = resolve;
  });
  mutable.http.authedRequest = async (method, path) => {
    if (!path.endsWith('/m.ignored_user_list')) return originalRead(method, path);
    if (++initialReads <= 2) {
      if (initialReads === 2) release();
      await bothRead;
      return { ignored_users: {} };
    }
    const value = await originalRead(method, path);
    if (initialReads === 3) firstReadback();
    return value;
  };
  mutable.setIgnoredUsers = async (ids) => {
    if (ids.includes(y)) await firstFinished;
    return originalWrite(ids);
  };
  await Promise.all([setBlocked(client, x, true), setBlocked(client, y, true)]);
  assert.deepEqual(client.getIgnoredUsers(), [y]); // demonstrate the old lost-update schedule
  assert.equal(isBlocked(client, x), true);
  assert.equal(isBlocked(client, y), true);
  assert.deepEqual(blockedUsers(client), [x, y]);
});
test('same-peer concurrent overwrite and malformed canonical policy fail closed', async () => {
  const { client, mutable, policies } = fixture();
  mutable.setAccountData = async (type) => {
    policies.set(type, { getContent: () => ({ blocked: false }) });
    return {};
  };
  await assert.rejects(setBlocked(client, '@ben:example.invalid', true), /another device/);
  policies.set('org.cleanbookface.block.v1.' + encodeURIComponent('@ben:example.invalid'), {
    getContent: () => ({ blocked: 'false' }),
  });
  assert.throws(() => isBlocked(client, '@ben:example.invalid'), /invalid account block policy/);
  assert.throws(() => blockedUsers(client), /invalid account block policy/);
});
test('fresh canonical readback errors propagate instead of qualifying cached block state', async () => {
  const { client, mutable } = fixture();
  mutable.http.authedRequest = async () => {
    throw new MatrixError({ errcode: 'M_FORBIDDEN', error: 'Refused' }, 403);
  };
  await assert.rejects(setBlocked(client, '@ben:example.invalid', true));
});
test('report reveals exactly selected text, not the whole post or attachments', async () => {
  let sent: unknown[] = [];
  const client = {
    reportEvent: async (...args: unknown[]) => {
      sent = args;
    },
  } as unknown as MatrixClient;
  const post = {
    roomId: '!pair:example.invalid',
    eventId: '$test',
    record: { text: 'UNSELECTED_PRIVATE_TEXT' },
    attachments: ['PRIVATE_FILENAME'],
  };
  await reportSelectedEvidence(client, post, 'Bot account', 'Chosen evidence');
  assert.deepEqual(sent, [
    post.roomId,
    post.eventId,
    -100,
    'Bot account\n\nText selected by the reporting person:\nChosen evidence',
  ]);
  assert.ok(!JSON.stringify(sent).includes('PRIVATE'));
  await assert.rejects(reportSelectedEvidence(client, post, '', ''), /Write a report/);
  await assert.rejects(reportSelectedEvidence(client, post, 'reason', 'x'.repeat(4001)), /4,000/);
});
test('account closure requires exact typed identity, then uses the server UIA challenge', async () => {
  const requests: unknown[][] = [];
  const client = {
    getUserId: () => me,
    deactivateAccount: async (...args: unknown[]) => {
      requests.push(args);
      if (requests.length === 1)
        throw new MatrixError(
          {
            errcode: 'M_UNAUTHORIZED',
            error: 'Authentication required',
            session: 'synthetic-session',
          },
          401,
        );
      return {};
    },
  } as unknown as MatrixClient;
  await assert.rejects(
    deactivateAccount(client, 'alice', 'fictional-password'),
    /complete account name/,
  );
  assert.equal(requests.length, 0);
  await deactivateAccount(client, me, 'fictional-password');
  assert.deepEqual(requests, [
    [undefined, true],
    [
      {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: me },
        password: 'fictional-password',
        session: 'synthetic-session',
      },
      true,
    ],
  ]);
});
test('wrong credentials and server failure never become successful account closure', async () => {
  let calls = 0;
  const client = {
    getUserId: () => me,
    deactivateAccount: async () => {
      calls++;
      throw new MatrixError({ errcode: 'M_FORBIDDEN', error: 'Refused' }, 403);
    },
  } as unknown as MatrixClient;
  await assert.rejects(deactivateAccount(client, me, 'incorrect-password'));
  assert.equal(calls, 1);
});
