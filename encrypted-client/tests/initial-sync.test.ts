import test from 'node:test';
import assert from 'node:assert/strict';
import { freshInitialSyncFetch } from '../src/identity';

test('initial sync nonce bypasses stale raw-filter cache includes departed rooms without changing timeline or request options', async () => {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    return new Response('{}');
  };
  const wrapped = freshInitialSyncFetch('https://home.example', fetcher);
  const filter = {
    room: { timeline: { limit: 20 } },
    account_data: { not_types: ['fictional.ignored'] },
  };
  const url = new URL('https://home.example/_matrix/client/v3/sync?timeout=0&_cacheBuster=1');
  url.searchParams.set('filter', JSON.stringify(filter));
  const init = {
    headers: { Authorization: 'Bearer fictional' },
    signal: new AbortController().signal,
    credentials: 'omit' as const,
  };
  await wrapped(url, init);
  await wrapped(url, init);
  const first = JSON.parse(requests[0].url.searchParams.get('filter')!);
  const second = JSON.parse(requests[1].url.searchParams.get('filter')!);
  assert.notEqual(
    first['org.cleanbookface.sync_instance'],
    second['org.cleanbookface.sync_instance'],
  );
  delete first['org.cleanbookface.sync_instance'];
  assert.deepEqual(first, { ...filter, room: { ...filter.room, include_leave: true } });
  assert.equal(requests[0].init, init);
  assert.equal(requests[0].url.searchParams.get('timeout'), '0');
  assert.equal(url.searchParams.get('filter'), JSON.stringify(filter));
});
test('incremental sync, foreign origins and other endpoints pass through unchanged', async () => {
  const seen: unknown[] = [];
  const wrapped = freshInitialSyncFetch('https://home.example', async (input) => {
    seen.push(input);
    return new Response('{}');
  });
  for (const input of [
    'https://home.example/_matrix/client/v3/sync?since=abc',
    'https://other.example/_matrix/client/v3/sync',
    'https://home.example/_matrix/client/v3/keys/query',
  ]) {
    await wrapped(input);
    assert.equal(seen.at(-1), input);
  }
});
test('invalid initial filters fail closed without making a request', async () => {
  let sent = 0;
  const wrapped = freshInitialSyncFetch('https://home.example', async () => {
    sent++;
    return new Response('{}');
  });
  for (const filter of ['', '5', 'null', '[]', '{bad'])
    await assert.rejects(
      wrapped('https://home.example/_matrix/client/v3/sync?filter=' + encodeURIComponent(filter)),
      /valid inline filter/,
    );
  assert.equal(sent, 0);
});
