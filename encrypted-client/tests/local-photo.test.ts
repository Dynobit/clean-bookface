/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { LocalPhotoBudget } from '../src/local-photo.js';
async function png(width: number, height: number) {
  return new Blob(
    [
      new Uint8Array(
        await sharp({ create: { width, height, channels: 3, background: '#334455' } })
          .png()
          .toBuffer(),
      ),
    ],
    { type: 'image/png' },
  );
}
test('valid small encoded PNG exceeding decoded pixel budget is refused', async () => {
  const oversized = await png(8192, 8192);
  assert.ok(oversized.size < 16 * 1024 * 1024);
  assert.equal(await new LocalPhotoBudget().admit(oversized, 'image/png'), false);
  assert.equal(await new LocalPhotoBudget().admit(await png(3000, 3000), 'image/png'), false);
});
test('page admits at most 24M pixels and cancels in-flight header reads', async () => {
  const image = await png(4000, 2000),
    budget = new LocalPhotoBudget();
  assert.equal(await budget.admit(image, 'image/png'), true);
  assert.equal(await budget.admit(image, 'image/png'), true);
  assert.equal(await budget.admit(image, 'image/png'), true);
  assert.equal(await budget.admit(image, 'image/png'), false);
  const cancelled = new LocalPhotoBudget(),
    pending = cancelled.admit(image, 'image/png');
  cancelled.cancel();
  assert.equal(await pending, false);
  assert.equal(await new LocalPhotoBudget().admit(new Blob(['GIF89a']), 'image/gif'), false);
});
