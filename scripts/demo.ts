import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';

// Fictional demonstration only. Refuses a public origin or production mode.
if (process.env.NODE_ENV === 'production')
  throw new Error('The demonstration cannot run in production.');
const port = Number(process.env.PORT ?? 3100);
const config = readConfig({
  ...process.env,
  PORT: String(port),
  APP_ORIGIN: `http://localhost:${port}`,
  DATA_DIR: process.env.DEMO_DATA_DIR ?? './data/demo',
  BIND_ADDRESS: '127.0.0.1',
  FEDERATION_ENABLED: 'false',
});
const runtime = createApplication(config);
const password = 'fictional-demo-password-only';
if (!runtime.core.isSetup()) {
  const alice = (
    await runtime.core.setup({ username: 'alice', displayName: 'Alice Morgan', password })
  ).user;
  const ben = (
    await runtime.core.register({
      username: 'ben',
      displayName: 'Ben Rivers',
      password,
      inviteToken: runtime.core.createInvite(alice.id, 'registration').token,
    })
  ).user;
  const casey = (
    await runtime.core.register({
      username: 'casey',
      displayName: 'Casey Park',
      password,
      inviteToken: runtime.core.createInvite(alice.id, 'registration').token,
    })
  ).user;
  runtime.core.acceptFriend(ben.id, runtime.core.requestFriend(alice.id, ben.actor));
  runtime.core.acceptFriend(casey.id, runtime.core.requestFriend(alice.id, casey.actor));
  runtime.core.updateSettings(alice.id, {
    bio: 'Collector of old photographs. Usually out for a walk.',
    discoverable: true,
  });
  runtime.core.updateSettings(ben.id, {
    bio: 'Good coffee, long conversations, terrible puns.',
    discoverable: true,
  });
  runtime.core.publish(ben.id, {
    body: 'Does anyone else still print their photos? Found a shoebox from 2012 this morning. Half of them are blurry. All of them are keepers.',
    audience: 'friends',
  });
  runtime.core.publish(casey.id, {
    body: 'The Saturday walk is back on. Same little park, same unreasonable optimism about the weather. Bring a flask if you fancy it. ☕',
    audience: 'friends',
  });
  const photo = await runtime.archive.uploadPhoto(
    alice.id,
    resolve('public/assets/our-memories.png'),
  );
  const post = runtime.core.publish(alice.id, {
    body: 'A little album of the good stuff. Ordinary days, the people who were there, and a place to keep it all.\n\nGlad you made it here.',
    audience: 'friends',
    mediaIds: [photo.id],
  });
  runtime.core.comment(ben.id, post.id, 'This feels like the internet I missed. See you Saturday!');
  runtime.core.like(casey.id, post.id);
}
runtime.start();
const server = serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port }, () =>
  console.log(
    `Fictional preview: ${config.origin}\nUsername: alice\nPassword: ${password}\nUse only synthetic data in this preview.`,
  ),
);
async function stop() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
