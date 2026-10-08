/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalBook, selectRecords } from '../src/local-book.js';
import type { MemoryRecord, importArchives } from '../src/archive.js';
const record = (id: string): MemoryRecord => ({
  id,
  kind: 'message',
  title: id,
  text: '<img onerror=alert(1)>',
  timestamp: 10,
  sourcePath: id,
  attachments: [],
  privateOnly: true,
});
function harness() {
  const pending: {
    resolve: (result: { records: MemoryRecord[]; warnings: string[] }) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    progress?: (done: number, total: number) => void;
  }[] = [];
  const importer: typeof importArchives = async (_files, options) =>
    new Promise((resolve, reject) =>
      pending.push({ resolve, reject, signal: options?.signal, progress: options?.onProgress }),
    );
  return {
    pending,
    book: new LocalBook(
      () => [record('sample')],
      () => {},
      importer,
    ),
  };
}
test('clear aborts import and ignores late completion and progress', async () => {
  const { book, pending } = harness();
  const opening = book.open([]);
  book.clear();
  assert.equal(pending[0].signal?.aborted, true);
  pending[0].progress?.(1, 2);
  pending[0].resolve({ records: [record('late')], warnings: ['late'] });
  await opening;
  assert.deepEqual(book.state.records, []);
  assert.equal(book.state.progress, '');
  assert.equal(book.state.mode, 'empty');
});
test('cancel keeps previous book; replacement wins an out-of-order race', async () => {
  const { book, pending } = harness();
  const first = book.open([]);
  book.cancel();
  assert.equal(book.state.records[0].id, 'sample');
  const second = book.open([]);
  pending[1].resolve({ records: [record('new')], warnings: ['warning'] });
  await second;
  pending[0].resolve({ records: [record('stale')], warnings: [] });
  await first;
  assert.equal(book.state.records[0].id, 'new');
  assert.deepEqual(book.state.warnings, ['warning']);
});
test('failed open preserves book and reset defeats a pending failure', async () => {
  const { book, pending } = harness();
  const first = book.open([]);
  pending[0].reject(new Error('Malformed'));
  await first;
  assert.equal(book.state.records[0].id, 'sample');
  assert.equal(book.state.error, 'Malformed');
  const next = book.open([]);
  book.reset();
  pending[1].reject(new Error('Old failure'));
  await next;
  assert.equal(book.state.error, '');
  assert.equal(book.state.mode, 'sample');
});
test('search and kind selection retain message privacy and stable input', () => {
  const records = [record('FIRST'), { ...record('second'), kind: 'post' as const, timestamp: 20 }];
  assert.equal(selectRecords(records, 'first', 'message', false)[0].privateOnly, true);
  assert.equal(selectRecords(records, '', '', false)[0].id, 'second');
  assert.equal(records[0].id, 'FIRST');
});
test('entry progress never triggers expensive book rendering', async () => {
  let fullRenders = 0,
    statusRenders = 0;
  const importer: typeof importArchives = async (_files, options) => {
    for (let i = 1; i <= 1000; i++) options?.onProgress?.(i, 1000);
    return { records: [record('imported')], warnings: [] };
  };
  const book = new LocalBook(
    () => [record('sample')],
    (update) => {
      if (update === 'progress') statusRenders++;
      else fullRenders++;
    },
    importer,
  );
  await book.open([]);
  assert.equal(statusRenders, 1000);
  assert.equal(fullRenders, 3);
  assert.equal(book.state.records[0].id, 'imported');
});

test('delayed exports never download after clear/reset/replacement/pagehide invalidation', async () => {
  const { LocalExport } = await import('../src/local-book.js');
  for (const boundary of ['clear', 'reset', 'replacement', 'pagehide']) {
    let resolve!: (blob: Blob) => void;
    let deliveries = 0;
    const task = new LocalExport(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = task.run([record(boundary)], () => {
      deliveries++;
    });
    task.cancel();
    resolve(new Blob(['private']));
    assert.equal(await pending, 'cancelled', boundary);
    assert.equal(deliveries, 0, boundary);
  }
  let reject!: (error: Error) => void;
  const failed = new LocalExport(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  const pending = failed.run([], () => assert.fail('late download'));
  failed.cancel();
  reject(new Error('late'));
  assert.equal(await pending, 'cancelled');
});
