import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../scripts/check-repository.mjs', import.meta.url));

test('repository guard distinguishes HTTP routes and exact container directories from private paths and secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bookface-repository-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitDir = join(root, 'fixture.git');
  const index = join(root, 'fixture.index');
  execFileSync('git', ['init', '--bare', '--quiet', gitDir], { stdio: 'ignore' });
  const env = { ...process.env, GIT_DIR: gitDir, GIT_INDEX_FILE: index, GIT_WORK_TREE: root };
  function check(file: string, content: string): ReturnType<typeof spawnSync> {
    execFileSync('git', ['read-tree', '--empty'], { cwd: root, env });
    const object = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      env,
      input: content,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${object},${file}`], {
      cwd: root,
      env,
    });
    return spawnSync(process.execPath, [guard], { cwd: root, env, encoding: 'utf8' });
  }
  const macPath = ['', 'Users', 'FictionalOperator', 'project', 'file.txt'].join('/');
  const linuxPath = ['', 'home', 'fictional_person', 'project', 'file.txt'].join('/');
  const ssh = ['', 'home', 'node', '.ssh'].join('/');
  const cases = [
    { file: 'tests/maintenance.test.ts', content: "'/users/alice/inbox'", allowed: true },
    { file: 'README.md', content: macPath, allowed: false },
    { file: 'README.md', content: linuxPath, allowed: false },
    { file: 'Dockerfile', content: `RUN mkdir -p ${ssh} && chmod 700 ${ssh}\n`, allowed: true },
    { file: 'scripts/provider-smoke.mjs', content: `stat('${ssh}')`, allowed: true },
    { file: 'README.md', content: ssh, allowed: false },
    { file: 'scripts/other.mjs', content: `stat('${ssh}')`, allowed: false },
    { file: 'Dockerfile', content: `${ssh}/private-key`, allowed: false },
    { file: 'scripts/provider-smoke.mjs', content: `${ssh}-backup`, allowed: false },
    { file: 'Dockerfile', content: `/different${ssh}`, allowed: false },
    { file: 'Dockerfile', content: `${ssh} ${linuxPath}`, allowed: false },
    { file: 'scripts/provider-smoke.mjs', content: `${ssh} ${macPath}`, allowed: false },
    { file: 'Dockerfile', content: ['', 'home', 'node', 'other'].join('/'), allowed: false },
    { file: 'Dockerfile', content: `${ssh}\n${['ghp', 'x'.repeat(40)].join('_')}`, allowed: false },
    {
      file: 'scripts/provider-smoke.mjs',
      content: `${ssh}\n${['-----BEGIN ', 'PRIVATE KEY-----'].join('')}`,
      allowed: false,
    },
    { file: 'README.md', content: ['github_pat', 'x'.repeat(40)].join('_'), allowed: false },
    { file: 'README.md', content: ['AKIA', 'A'.repeat(16)].join(''), allowed: false },
  ];
  for (const item of cases) {
    const result = check(item.file, item.content);
    assert.equal(
      result.status,
      item.allowed ? 0 : 1,
      `${item.file}: ${item.allowed ? 'expected accepted fixture' : 'expected rejected fixture'}; ${String(result.stderr)}`,
    );
    if (!item.allowed) {
      assert.match(String(result.stderr), /possible private path or secret \(value withheld\)/);
      assert.ok(
        !String(result.stderr).includes(item.content),
        'Diagnostics must withhold fixture values',
      );
    }
  }
});
