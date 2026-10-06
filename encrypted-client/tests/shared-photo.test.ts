/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  prepareSharedPhoto,
  SHARED_PHOTO_LIMITS,
  validatePhotoHeader,
} from '../src/shared-photo.js';
function jpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([
    255,
    216,
    255,
    192,
    0,
    11,
    8,
    height >>> 8,
    height & 255,
    width >>> 8,
    width & 255,
    1,
    1,
    17,
    0,
    255,
    218,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    255,
    217,
  ]);
}
function webp(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(30),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode('WEBPVP8 '), 8);
  view.setUint32(16, 10, true);
  bytes.set([0, 0, 0, 157, 1, 42], 20);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}
test('real PNG/JPEG/lossy and lossless WebP headers are accepted before decoding', async () => {
  const input = sharp({
    create: {
      width: 120,
      height: 80,
      channels: 4,
      background: { r: 200, g: 40, b: 80, alpha: 0.5 },
    },
  });
  for (const [mime, bytes] of [
    ['image/png', await input.clone().png().toBuffer()],
    ['image/jpeg', await input.clone().jpeg({ progressive: true }).toBuffer()],
    ['image/webp', await input.clone().webp().toBuffer()],
    ['image/webp', await input.clone().webp({ lossless: true }).toBuffer()],
    ['image/webp', await input.clone().withMetadata().webp().toBuffer()],
  ] as const)
    assert.deepEqual(validatePhotoHeader(bytes, mime), { width: 120, height: 80 });
});
test('huge JPEG/WebP, wrong MIME and malformed headers never reach decoder', async () => {
  let decodes = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: () => {
      decodes++;
      throw new Error('decoder invoked');
    },
  });
  try {
    for (const [mime, bytes] of [
      ['image/jpeg', jpeg(10000, 10000)],
      ['image/webp', webp(10000, 10000)],
      ['image/png', jpeg(100, 100)],
      ['image/jpeg', webp(100, 100)],
      ['image/jpeg', jpeg(100, 100).slice(0, 9)],
      ['image/webp', webp(100, 100).slice(0, 23)],
      ['image/jpeg', Uint8Array.from([255, 216, 255, 218, 0, 2])],
    ] as const)
      await assert.rejects(
        prepareSharedPhoto({ bytes: new Blob([bytes]), mimeType: mime }),
        /header|dimensions/,
      );
    assert.equal(decodes, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'createImageBitmap', previous);
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  }
});
test('PNG dimensions require intact IHDR and invalid bit depth is refused', async () => {
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const damaged = Buffer.from(bytes);
  damaged[24] = 3;
  assert.throws(() => validatePhotoHeader(damaged, 'image/png'), /header/);
  const huge = await sharp({
    create: { width: 7000, height: 6000, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  assert.throws(() => validatePhotoHeader(huge, 'image/png'), /dimensions/);
});
test('WebP small extended canvas cannot hide oversized or different codec dimensions', () => {
  const bytes = new Uint8Array(48),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 40, true);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
  view.setUint32(16, 10, true);
  bytes[24] = 99;
  bytes[27] = 99;
  bytes.set(webp(10000, 10000).slice(12), 30);
  assert.throws(() => validatePhotoHeader(bytes, 'image/webp'), /dimensions/);
  bytes.set(webp(200, 100).slice(12), 30);
  assert.throws(() => validatePhotoHeader(bytes, 'image/webp'), /header/);
  bytes[20] = 2;
  assert.throws(() => validatePhotoHeader(bytes, 'image/webp'), /header/);
});
test('JPEG metadata scan is bounded and zero-size/multiple frames are refused', () => {
  const app = new Uint8Array(65537);
  app.set([255, 225, 255, 255]);
  const bytes = new Uint8Array(2 + app.length * 17 + jpeg(10, 10).length - 2);
  bytes.set([255, 216]);
  for (let n = 0; n < 17; n++) bytes.set(app, 2 + n * app.length);
  bytes.set(jpeg(10, 10).slice(2), 2 + app.length * 17);
  assert.ok(bytes.length > SHARED_PHOTO_LIMITS.headerBytes);
  assert.throws(() => validatePhotoHeader(bytes, 'image/jpeg'), /header/);
  assert.throws(() => validatePhotoHeader(jpeg(0, 10), 'image/jpeg'), /dimensions/);
  assert.throws(
    () =>
      validatePhotoHeader(
        Uint8Array.from([...jpeg(10, 10).slice(0, 15), ...jpeg(10, 10).slice(2)]),
        'image/jpeg',
      ),
    /header/,
  );
});
