import { execFileSync } from 'node:child_process';

// Check the reviewed Git index, not ignored runtime data or a developer's home.
const files = execFileSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const problems = [];
const forbidden =
  /(?:^|\/)(?:data|imports|exports|uploads|media|secrets|private|\.local|backups|screenshots|reports|logs|browser-profiles|node_modules|dist|test-results|playwright-report|blob-report)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:db|sqlite3?)(?:[-.]|$)|\.(?:zip|tar|tgz|7z|age|pem|key|p12)$/i;
const allowedImages = new Set([
  'public/assets/our-memories.png',
  'site/assets/cover-weekend.png',
  'encrypted-client/src/sample-weekend.png',
  'docs/images/feed-desktop.png',
  'docs/images/feed-mobile.png',
  'docs/images/encrypted-feed-desktop.png',
  'docs/images/encrypted-feed-mobile.png',
  'docs/images/local-book-desktop.png',
  'tests/fixtures/synthetic/facebook/photos/synthetic-postcard.png',
]);
// Filesystem roots are case-sensitive: /users/... is also an HTTP route.
const privatePath = /\/(?:Users|home)\/[A-Za-z][A-Za-z0-9_.-]*\//;
const containerSshFiles = new Set(['Dockerfile', 'scripts/provider-smoke.mjs']);
const containerSshDirectory = /(?<![A-Za-z0-9_./-])\/home\/node\/\.ssh(?=$|[\s'"])/g;
const sensitiveText = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
];
for (const entry of files) {
  const tab = entry.indexOf('\t');
  const file = entry.slice(tab + 1);
  const [mode, , stage] = entry.slice(0, tab).split(' ');
  if (file !== '.env.example' && forbidden.test(file))
    problems.push(`${file}: runtime, credential or archive artifact`);
  if (!['100644', '100755'].includes(mode) || stage !== '0') {
    problems.push(`${file}: only ordinary files belong in the release`);
    continue;
  }
  const bytes = execFileSync('git', ['show', `:${file}`], { maxBuffer: 16 * 1024 * 1024 });
  if (allowedImages.has(file)) {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      problems.push(`${file}: expected reviewed PNG`);
    continue;
  }
  if (bytes.includes(0)) {
    problems.push(`${file}: unreviewed binary`);
    continue;
  }
  const content = bytes.toString('utf8');
  // Exempt only this complete, reviewed container directory in these two files.
  // Child paths, other home directories, and all credential patterns still fail.
  const pathContent = containerSshFiles.has(file)
    ? content.replace(containerSshDirectory, '[reviewed container SSH directory]')
    : content;
  if (privatePath.test(pathContent) || sensitiveText.some((pattern) => pattern.test(content)))
    problems.push(`${file}: possible private path or secret (value withheld)`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Repository artifact checks passed for ${files.length} tracked files. Exact content review is still required.`,
  );
