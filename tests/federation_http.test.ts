import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpsRequest, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { CONTEXT, PROFILE } from '../src/federation.js';
import type { FederationNetwork } from '../src/federation/network.js';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

test('two HTTPS applications preserve private photos, interactions and revocations through the proxy boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bookface-federation-http-'));
  const origins = ['https://circle.example', 'https://friends.example'];
  const ports = new Map<string, number>();
  const servers: Server[] = [];
  const runtimes: ReturnType<typeof createApplication>[] = [];
  let offlineOrigin: string | undefined;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-subj',
        '/CN=circle.example',
        '-addext',
        'subjectAltName=DNS:circle.example,DNS:friends.example',
      ],
      { stdio: 'ignore' },
    );
    const key = await readFile(join(dir, 'key.pem')),
      cert = await readFile(join(dir, 'cert.pem'));
    const network: FederationNetwork = async (request, maxBytes = 262144) => {
      const url = new URL(request.url),
        port = ports.get(url.origin);
      if (!port) throw Error('Unknown synthetic peer');
      if (url.origin === offlineOrigin) throw Error('Synthetic offline peer');
      const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
      return new Promise((resolve, reject) => {
        const outgoing = httpsRequest(
          {
            hostname: '127.0.0.1',
            port,
            servername: url.hostname,
            ca: cert,
            method: request.method,
            path: url.pathname + url.search,
            headers: { ...Object.fromEntries(request.headers), host: url.host },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > maxBytes) {
                response.destroy();
                reject(Error('Too large'));
              } else chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () =>
              resolve({
                status: response.statusCode!,
                headers: new Headers(
                  Object.entries(response.headers)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
                ),
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        outgoing.on('error', reject);
        outgoing.end(body);
      });
    };
    for (let index = 0; index < origins.length; index++) {
      const origin = origins[index]!;
      const config = readConfig({
        APP_ORIGIN: origin,
        DATA_DIR: join(dir, String(index)),
        NODE_ENV: 'production',
        FEDERATION_ENABLED: 'true',
      });
      const runtime = createApplication(config, { federationNetwork: network });
      runtimes.push(runtime);
      const server = createServer({ key, cert }, async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          // The public edge terminates TLS; the application receives plain HTTP.
          // Host is preserved. Untrusted forwarding headers play no role.
          const request = new Request(origin.replace('https:', 'http:') + req.url, {
            method: req.method,
            headers: new Headers(
              Object.entries(req.headers)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
            ),
            ...(['GET', 'HEAD'].includes(req.method ?? 'GET')
              ? {}
              : { body: Buffer.concat(chunks) }),
          });
          const response = await runtime.app.fetch(request);
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          res.writeHead(500);
          res.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
      ports.set(origin, (server.address() as AddressInfo).port);
    }
    const [a, b] = runtimes;
    const alice = (
      await a!.core.setup({
        username: 'alice',
        displayName: 'Alice Example',
        password: 'synthetic-only-passphrase',
      })
    ).user;
    const bob = (
      await b!.core.setup({
        username: 'bob',
        displayName: 'Bob Example',
        password: 'synthetic-only-passphrase',
      })
    ).user;
    const charlie = (
      await b!.core.register({
        username: 'charlie',
        displayName: 'Charlie Example',
        password: 'synthetic-only-passphrase',
        inviteToken: b!.core.createInvite(bob.id, 'registration').token,
      })
    ).user;
    const follow = {
      '@context': CONTEXT,
      'cb:profile': PROFILE,
      'cb:revision': 1,
      id: `${origins[1]}/federation/activities/${randomUUID()}`,
      type: 'Follow',
      actor: charlie.actor,
      to: [alice.actor],
      object: alice.actor,
    };
    const request = await b!.federation.sign(
      'charlie',
      new Request(`${alice.actor}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/activity+json', 'x-forwarded-proto': 'http' },
        body: JSON.stringify(follow),
      }),
    );
    assert.equal(request.headers.has('accept'), false);
    assert.equal(request.headers.has('origin'), false);
    const result = await network(request);
    assert.equal(result.status, 202, Buffer.from(result.body).toString());
    assert.equal(a!.core.pendingFriends(alice.id)[0]!.actor, charlie.actor);
    const bootstrap = await network(
      new Request(alice.actor, { headers: { accept: 'application/activity+json' } }),
    );
    assert.equal(bootstrap.status, 200);
    assert.equal(Buffer.from(bootstrap.body).toString().includes('Alice Example'), false);
    const forged = {
      ...follow,
      id: `${origins[1]}/federation/activities/${randomUUID()}`,
      actor: alice.actor,
    };
    const rejected = await network(
      await b!.federation.sign(
        'bob',
        new Request(`${alice.actor}/inbox`, {
          method: 'POST',
          headers: { 'content-type': 'application/activity+json' },
          body: JSON.stringify(forged),
        }),
      ),
    );
    assert.equal(rejected.status, 403);
    const browserAction = await network(
      new Request(`${origins[0]}/actions/friends/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'actor=https%3A%2F%2Ffriends.example%2Fusers%2Fbob',
      }),
    );
    assert.equal(browserAction.status, 403);

    type Browser = { origin: string; cookie: string; csrf: string };
    const decode = (response: Awaited<ReturnType<FederationNetwork>>) =>
      JSON.parse(Buffer.from(response.body).toString());
    async function login(origin: string, username: string): Promise<Browser> {
      const response = await network(
        new Request(`${origin}/actions/login`, {
          method: 'POST',
          headers: { accept: 'application/json', origin, 'content-type': 'application/json' },
          body: JSON.stringify({ username, password: 'synthetic-only-passphrase' }),
        }),
      );
      assert.equal(response.status, 200);
      const header = response.headers.get('set-cookie')!;
      assert.match(header, /__Host-bookface=/);
      assert.match(header, /Secure/);
      return { origin, cookie: header.split(';')[0]!, csrf: decode(response).csrf };
    }
    async function api(browser: Browser, path: string, data?: Record<string, unknown>) {
      return network(
        new Request(browser.origin + path, {
          method: data ? 'POST' : 'GET',
          headers: {
            accept: 'application/json',
            cookie: browser.cookie,
            ...(data ? { origin: browser.origin, 'content-type': 'application/json' } : {}),
          },
          ...(data ? { body: JSON.stringify({ ...data, csrf: browser.csrf }) } : {}),
        }),
      );
    }
    const aliceBrowser = await login(origins[0]!, 'alice'),
      bobBrowser = await login(origins[1]!, 'bob'),
      charlieBrowser = await login(origins[1]!, 'charlie');
    assert.equal(
      (await api(bobBrowser, '/actions/friends/request', { actor: alice.actor })).status,
      200,
    );
    assert.equal((await b!.federation.flush()).delivered, 1);
    const pending = a!.core.pendingFriends(alice.id).find((friend) => friend.actor === bob.actor)!;
    assert.equal(
      (await api(aliceBrowser, `/actions/friends/${encodeURIComponent(pending.id)}/accept`, {}))
        .status,
      200,
    );
    assert.equal((await a!.federation.flush()).delivered, 1);
    assert.equal(b!.core.areFriends(bob.actor, alice.actor), true);

    const fixture = await readFile(
      new URL('./fixtures/synthetic/facebook/photos/synthetic-postcard.png', import.meta.url),
    );
    const boundary = `test-${randomUUID()}`;
    const uploadBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${aliceBrowser.csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      fixture,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await network(
      new Request(`${origins[0]}/actions/photo`, {
        method: 'POST',
        headers: {
          origin: origins[0]!,
          cookie: aliceBrowser.cookie,
          accept: 'application/json',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body: uploadBody,
      }),
    );
    assert.equal(upload.status, 200);
    const mediaId = decode(upload).mediaIds[0] as string;
    const publication = await api(aliceBrowser, '/actions/posts', {
      body: 'A synthetic photo for one friend.',
      audience: 'selected',
      recipientActors: [bob.actor],
      mediaIds: [mediaId],
    });
    assert.equal(publication.status, 200);
    const post = decode(publication).post;
    assert.equal((await a!.federation.flush()).delivered, 1);
    const objectURL = `${origins[0]}/federation/objects/${post.id}`,
      remotePath = `/api/posts/${encodeURIComponent(objectURL)}`,
      mediaURL = `${origins[0]}/federation/media/${mediaId}`;
    const bobPost = await api(bobBrowser, remotePath);
    assert.equal(bobPost.status, 200);
    assert.equal(decode(bobPost).post.body, post.body);
    assert.equal((await api(charlieBrowser, remotePath)).status, 404);
    assert.equal((await b!.federation.signedFetch('bob', objectURL)).status, 200);
    assert.equal((await b!.federation.signedFetch('charlie', objectURL)).status, 404);
    assert.equal(
      (await network(new Request(objectURL, { headers: { accept: 'application/activity+json' } })))
        .status,
      403,
    );
    assert.equal((await b!.federation.signedFetch('bob', mediaURL)).status, 200);
    assert.equal((await b!.federation.signedFetch('charlie', mediaURL)).status, 404);
    const proxyPath = `/posts/${encodeURIComponent(objectURL)}/media/${encodeURIComponent(mediaURL)}`;
    const proxiedPhoto = await api(bobBrowser, proxyPath);
    assert.equal(proxiedPhoto.status, 200);
    assert.match(proxiedPhoto.headers.get('content-type')!, /image\/webp/);
    assert.ok((await sharp(Buffer.from(proxiedPhoto.body)).metadata()).width);
    assert.equal((await api(charlieBrowser, proxyPath)).status, 404);
    assert.equal((await network(new Request(`${origins[1]}${proxyPath}`))).status, 401);
    // Native upload creates a private original on A; no B account can read it.
    const original = decode(await api(aliceBrowser, '/api/archive')).items[0];
    assert.ok(original.mediaIds.length);
    assert.equal((await api(aliceBrowser, `/media/${original.mediaIds[0]}`)).status, 200);
    assert.equal(
      (await network(new Request(`${origins[0]}/media/${original.mediaIds[0]}`))).status,
      401,
    );
    assert.equal((await api(bobBrowser, `/media/${original.mediaIds[0]}`)).status, 404);

    const interaction = `/actions/posts/${encodeURIComponent(objectURL)}`;
    assert.equal(
      (await api(charlieBrowser, `${interaction}/comment`, { body: 'Unauthorized' })).status,
      404,
    );
    assert.equal(
      (
        await api(bobBrowser, `${interaction}/comment`, {
          body: 'A reply from the selected friend.',
        })
      ).status,
      200,
    );
    assert.equal((await api(bobBrowser, `${interaction}/like`, {})).status, 200);
    await b!.federation.flush();
    await a!.federation.flush();
    const home = decode(await api(aliceBrowser, `/api/posts/${post.id}`)).post;
    assert.equal(home.comments.length, 1);
    assert.equal(home.comments[0].body, 'A reply from the selected friend.');
    assert.equal(home.likes, 1);
    assert.equal((await api(bobBrowser, `${interaction}/like`, { enabled: false })).status, 200);
    await b!.federation.flush();
    await a!.federation.flush();
    assert.equal(decode(await api(aliceBrowser, `/api/posts/${post.id}`)).post.likes, 0);
    assert.equal(
      (
        await api(aliceBrowser, `/actions/posts/${post.id}/edit`, {
          body: 'The corrected private photo caption.',
        })
      ).status,
      200,
    );
    await a!.federation.flush();
    assert.equal(
      decode(await api(bobBrowser, remotePath)).post.body,
      'The corrected private photo caption.',
    );

    assert.equal(
      (await api(aliceBrowser, `/actions/posts/${post.id}/revoke`, { actor: bob.actor })).status,
      200,
    );
    assert.equal((await b!.federation.signedFetch('bob', objectURL)).status, 404);
    assert.equal((await b!.federation.signedFetch('bob', mediaURL)).status, 404);
    offlineOrigin = origins[1];
    assert.ok((await a!.federation.flush()).pending > 0);
    offlineOrigin = undefined;
    a!.store.db.exec('UPDATE federation_deliveries SET next_attempt=0,lease_until=0');
    await a!.federation.flush();
    assert.equal((await api(bobBrowser, remotePath)).status, 404);
    assert.equal((await api(bobBrowser, proxyPath)).status, 404);
    const second = decode(
      await api(aliceBrowser, '/actions/posts', {
        body: 'This second object will be deleted.',
        audience: 'selected',
        recipientActors: [bob.actor],
      }),
    ).post;
    await a!.federation.flush();
    const secondURL = `${origins[0]}/federation/objects/${second.id}`;
    assert.equal(
      (await api(bobBrowser, `/api/posts/${encodeURIComponent(secondURL)}`)).status,
      200,
    );
    assert.equal((await api(aliceBrowser, `/actions/posts/${second.id}/delete`, {})).status, 200);
    await a!.federation.flush();
    assert.equal(
      (await api(bobBrowser, `/api/posts/${encodeURIComponent(secondURL)}`)).status,
      404,
    );
    assert.equal((await b!.federation.signedFetch('bob', secondURL)).status, 404);
    // SUP02: deletion purges the last reader's cache while the author is offline.
    const finalPost = a!.core.publish(alice.id, {
      body: 'Purge on recipient deletion',
      audience: 'selected',
      recipientActors: [bob.actor],
    });
    await a!.federation.flush();
    const finalURL = a!.core.objectUrl(finalPost.id);
    assert.equal(b!.core.post(finalURL, bob.id).body, 'Purge on recipient deletion');
    // SUP03: even correctly signed replies/likes cannot introduce identities
    // that the deletion envelope would later reject.
    for (const suffix of ['?query=1', '#fragment']) {
      for (const kind of ['reply', 'like']) {
        const activity = {
          '@context': CONTEXT,
          'cb:profile': PROFILE,
          'cb:revision': 1,
          id: `${origins[1]}/federation/activities/${randomUUID()}`,
          actor: bob.actor,
          to: [alice.actor],
          ...(kind === 'reply'
            ? {
                type: 'Create',
                object: {
                  id: `${origins[1]}/federation/comments/bad${suffix}`,
                  type: 'Note',
                  attributedTo: bob.actor,
                  inReplyTo: finalURL,
                  to: [alice.actor],
                  mediaType: 'text/plain',
                  content: 'Invalid identity',
                },
              }
            : {
                type: 'Like',
                object: finalURL,
                'cb:interactionId': `${origins[1]}/federation/activities/bad${suffix}`,
              }),
        };
        const signed = await b!.federation.sign(
          'bob',
          new Request(`${alice.actor}/inbox`, {
            method: 'POST',
            headers: { 'content-type': 'application/activity+json' },
            body: JSON.stringify(activity),
          }),
        );
        assert.equal((await network(signed)).status, 403);
      }
    }
    b!.core.transferAdministration(bob.id, charlie.id);
    offlineOrigin = origins[0];
    b!.core.deleteAccount(bob.id);
    assert.equal(
      (b!.store.db.prepare('SELECT body FROM publications WHERE id=?').get(finalURL) as any).body,
      '',
    );
    offlineOrigin = undefined;
    a!.core.revokeRecipients(alice.id, finalPost.id, [bob.actor]);
    assert.ok((await a!.federation.flush()).delivered >= 1);
    const removal = a!.store.db
      .prepare(
        "SELECT state,last_status FROM federation_deliveries WHERE object_id=? AND kind='post.revoke'",
      )
      .get(finalPost.id) as any;
    assert.equal(removal.state, 'delivered');
    assert.equal(removal.last_status, 202);
    const newFollow = {
      '@context': CONTEXT,
      'cb:profile': PROFILE,
      'cb:revision': 1,
      id: `${origins[0]}/federation/activities/${randomUUID()}`,
      type: 'Follow',
      actor: alice.actor,
      to: [bob.actor],
      object: bob.actor,
    };
    const signedFollow = await a!.federation.sign(
      'alice',
      new Request(`${bob.actor}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/activity+json' },
        body: JSON.stringify(newFollow),
      }),
    );
    assert.equal(
      (await network(signedFollow)).status,
      403,
      'deleted recipient never accepts fresh content or consent',
    );
  } finally {
    for (const server of servers)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const runtime of runtimes) await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
