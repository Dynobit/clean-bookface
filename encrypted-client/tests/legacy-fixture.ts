import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
export async function legacyFixture(root: string) {
  // Runtime import keeps the separately packaged browser typecheck independent of server dependencies.
  const serverModule = new URL('../../src/app.ts', import.meta.url).href;
  const { createApplication } = await import(serverModule);
  const origin = 'http://legacy.example.org';
  const runtime = createApplication({
    origin,
    dataDir: join(root, 'source'),
    production: false,
    federation: false,
    host: '127.0.0.1',
    port: 3000,
    maxUploadBytes: 1024 ** 2,
    instanceName: 'Synthetic circle',
  });
  try {
    const { user } = await runtime.core.setup({
      username: 'alice',
      displayName: 'Alice Example',
      password: 'fictional-migration-password',
    });
    const input = join(root, 'input');
    await mkdir(join(input, 'photos'), { recursive: true });
    const media = await readFile(
      new URL(
        '../../tests/fixtures/synthetic/facebook/photos/synthetic-postcard.png',
        import.meta.url,
      ),
    );
    await writeFile(join(input, 'photos', 'card.png'), media);
    const posts = [
      {
        id: 'history',
        timestamp: 946684800,
        data: [{ post: 'Earlier memory Café שלום' }],
        attachments: [{ data: [{ media: { uri: 'photos/card.png' } }] }],
      },
    ];
    await writeFile(join(input, 'posts.json'), JSON.stringify(posts));
    await runtime.archive.importDirectory(user.id, input);
    posts[0].data[0].post = 'Revised memory Café שלום';
    await writeFile(join(input, 'posts.json'), JSON.stringify(posts));
    await runtime.archive.importDirectory(user.id, input);
    const items = runtime.archive.list(user.id);
    const publication = runtime.core.publish(user.id, {
      body: 'Native publication',
      audience: 'private',
      mediaIds: [],
    });
    runtime.core.comment(user.id, publication.id, 'Native comment');
    const session = await runtime.core.login('alice', 'fictional-migration-password');
    const response = await runtime.app.fetch(
      new Request(`${origin}/actions/export`, {
        method: 'POST',
        headers: {
          origin,
          cookie: `bookface=${session.token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ csrf: session.csrf }),
      }),
    );
    assert.equal(response.status, 200);
    const file = new File([await response.arrayBuffer()], 'account.zip');
    return { file, items, media };
  } finally {
    await runtime.close();
  }
}
