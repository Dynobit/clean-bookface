import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = resolve(root, 'encrypted-client');
if (process.argv.slice(2).some((arg) => arg !== '--check'))
  throw new Error('Use no arguments to regenerate notices, or --check to verify them.');
const check = process.argv.includes('--check');
const lock = JSON.parse(await readFile(resolve(client, 'package-lock.json'), 'utf8'));
const sections = [
  'Clean Bookface encrypted browser — third-party notices',
  'The following license texts accompany the pinned production dependency set.\n' +
    'Some packages may be eliminated from a particular browser build.\n' +
    'License wording is reproduced from the installed upstream packages;\n' +
    'line endings and trailing whitespace are normalized.',
];
let packages = 0;
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
  a < b ? -1 : a > b ? 1 : 0,
)) {
  if (!path || entry.dev) continue;
  if (!/^node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(path))
    throw new Error(`Review the new production package path: ${path}`);
  const directory = resolve(client, path);
  const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  if (metadata.version !== entry.version)
    throw new Error(`Install the exact lockfile before generating notices: ${path}`);
  const files = (await readdir(directory))
    .filter((name) => /^(?:licen[sc]e(?:[-.].*)?|notice(?:\.txt|\.md)?)$/iu.test(name))
    .sort();
  if (!files.some((name) => /^licen[sc]e/iu.test(name)))
    throw new Error(`Review missing upstream license text: ${metadata.name}`);
  sections.push(
    `${'='.repeat(72)}\n${metadata.name} ${metadata.version}\nLicense: ${metadata.license}`,
  );
  for (const name of files) {
    const text = (await readFile(resolve(directory, name), 'utf8'))
      .replace(/\r\n?/gu, '\n')
      .replace(/[ \t]+$/gmu, '')
      .trimEnd();
    sections.push(`--- ${name} ---\n${text}`);
  }
  packages++;
}
const outputs = [
  ['LICENSE.txt', await readFile(resolve(root, 'LICENSE'), 'utf8')],
  ['THIRD_PARTY_NOTICES.txt', sections.join('\n\n') + '\n'],
];
for (const [name, text] of outputs) {
  const destination = resolve(client, 'public', name);
  if (check) {
    if ((await readFile(destination, 'utf8')) !== text)
      throw new Error(`Review dependency changes and run node scripts/client-notices.mjs: ${name}`);
  } else await writeFile(destination, text);
}
console.log(
  `${check ? 'Verified' : 'Generated'} browser notices for ${packages} production packages.`,
);
