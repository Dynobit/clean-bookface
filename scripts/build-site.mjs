import { copyFile, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist-site');
// Explicit allowlist: never publish the repository, an app data volume or local state.
const files = [
  ['site/index.html', 'index.html'],
  ['site/styles.css', 'styles.css'],
  ['public/favicon.svg', 'favicon.svg'],
  ['public/assets/album-mark.svg', 'assets/album-mark.svg'],
  ['site/assets/cover-weekend.png', 'assets/cover-weekend.png'],
  ['docs/images/feed-desktop.png', 'assets/feed-desktop.png'],
  ['docs/images/feed-mobile.png', 'assets/feed-mobile.png'],
];
for (const [source] of files) {
  const info = await lstat(resolve(root, source));
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Site input must be a regular reviewed file: ${source}`);
}
await rm(output, { recursive: true, force: true });
for (const [source, destination] of files) {
  const target = resolve(output, destination);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, source), target);
}
await writeFile(resolve(output, '.nojekyll'), '');
await writeFile(resolve(output, 'CNAME'), 'cleanbookface.org\n');
console.log(`Built ${files.length} reviewed site files plus .nojekyll and CNAME in dist-site/`);
