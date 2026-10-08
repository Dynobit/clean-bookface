import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = join(root, 'encrypted-client');
export function clientManifest(directory) {
  const files = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name),
        name = relative(directory, full).replaceAll('\\', '/');
      if (name === 'build-manifest.json') continue;
      if (entry.isDirectory() && name === 'assets') {
        visit(full);
        continue;
      }
      if (
        !entry.isFile() ||
        !lstatSync(full).isFile() ||
        !/^(?:(?:index|book)\.html|_headers|favicon\.svg|album-mark\.svg|LICENSE\.txt|THIRD_PARTY_NOTICES\.txt|assets\/[A-Za-z0-9_.-]+\.(?:js|css|wasm))$/.test(
          name,
        )
      )
        throw new Error('Unexpected client build entry; review before packaging');
      const bytes = readFileSync(full);
      files.push({
        path: name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  visit(directory);
  if (
    !files.some((file) => file.path === 'index.html') ||
    !files.some((file) => file.path === 'book.html') ||
    !files.some((file) => file.path.endsWith('.wasm'))
  )
    throw new Error('Incomplete browser build');
  return {
    format: 'clean-bookface-client-files-v1',
    files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = join(client, 'dist'),
    manifest = clientManifest(directory);
  writeFileSync(join(directory, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `Client manifest: ${manifest.files.length} reviewed build paths, SHA-256 and size for each file.`,
  );
}
