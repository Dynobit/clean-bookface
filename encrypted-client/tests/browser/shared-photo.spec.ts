import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { transformWithOxc } from 'vite';
let source: string;
test.beforeAll(async () => {
  source = (
    await transformWithOxc(
      await readFile(new URL('../../src/shared-photo.ts', import.meta.url), 'utf8'),
      'shared-photo.ts',
    )
  ).code;
});
// This self-contained helper runs in a blank browser: no host/account/test server.
test('12MP JPEG becomes bounded upright JPEG without source metadata', async ({ page }) => {
  const raw = Buffer.alloc(4000 * 3000 * 3);
  let seed = 12345;
  for (let n = 0; n < raw.length; n++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    raw[n] = seed >>> 24;
  }
  const input = await sharp(raw, { raw: { width: 4000, height: 3000, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { ImageDescription: 'SYNTHETIC_PRIVATE_METADATA_42' } })
    .jpeg({ quality: 95 })
    .toBuffer();
  const result = await page.evaluate(
    async ({ source, base64 }) => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        const { prepareSharedPhoto } = await import(url);
        const photo = await prepareSharedPhoto({
          bytes: new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]),
          mimeType: 'image/jpeg',
        });
        const image = await createImageBitmap(photo.bytes);
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(photo.bytes);
        });
        const result = {
          width: image.width,
          height: image.height,
          size: photo.bytes.size,
          mime: photo.mimeType,
          data,
        };
        image.close();
        return result;
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { source, base64: input.toString('base64') },
  );
  expect(result.mime).toBe('image/jpeg');
  expect(result.size).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.height).toBeLessThanOrEqual(2048);
  expect(result.width / result.height).toBeCloseTo(3 / 4, 2);
  const bytes = Buffer.from(result.data.split(',')[1], 'base64'),
    metadata = await sharp(bytes).metadata();
  expect(metadata.exif).toBeUndefined();
  expect(metadata.xmp).toBeUndefined();
  expect(metadata.iptc).toBeUndefined();
  expect(metadata.orientation).toBeUndefined();
  expect(bytes.includes(Buffer.from('SYNTHETIC_PRIVATE_METADATA_42'))).toBe(false);
  console.log(
    JSON.stringify({
      fixture: '12MP deterministic noise',
      outputBytes: result.size,
      width: result.width,
      height: result.height,
      sourceMetadataRemoved: true,
    }),
  );
});
test('EXIF orientation is applied once and transparent PNG flattens to white', async ({ page }) => {
  const pixels = Buffer.alloc(40 * 20 * 3);
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 40; x++) pixels[(y * 40 + x) * 3 + (x < 20 ? 0 : 2)] = 255;
  const rotated = await sharp(pixels, { raw: { width: 40, height: 20, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 100 })
    .toBuffer();
  const transparent = await sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const results = await page.evaluate(
    async ({ source, fixtures }) => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        const { prepareSharedPhoto } = await import(url),
          results = [];
        for (const fixture of fixtures) {
          const photo = await prepareSharedPhoto({
            bytes: new Blob([Uint8Array.from(atob(fixture.data), (c) => c.charCodeAt(0))]),
            mimeType: fixture.mime,
          });
          const image = await createImageBitmap(photo.bytes),
            canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          results.push({
            width: image.width,
            height: image.height,
            top: [...context.getImageData(5, 5, 1, 1).data],
            bottom: [...context.getImageData(5, image.height - 5, 1, 1).data],
          });
          image.close();
        }
        return results;
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    {
      source,
      fixtures: [
        { mime: 'image/jpeg', data: rotated.toString('base64') },
        { mime: 'image/png', data: transparent.toString('base64') },
      ],
    },
  );
  expect([results[0].width, results[0].height]).toEqual([20, 40]);
  expect(results[0].top[0]).toBeGreaterThan(240);
  expect(results[0].top[2]).toBeLessThan(15);
  expect(results[0].bottom[2]).toBeGreaterThan(240);
  expect(results[0].bottom[0]).toBeLessThan(15);
  expect(results[1].top).toEqual([255, 255, 255, 255]);
});
test('hostile JPEG/WebP and wrong MIME are refused before Chrome decoder invocation', async ({
  page,
}) => {
  const result = await page.evaluate(async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
      original = globalThis.createImageBitmap;
    let decodes = 0;
    globalThis.createImageBitmap = (() => {
      decodes++;
      throw new Error('unexpected decode');
    }) as typeof createImageBitmap;
    try {
      const { prepareSharedPhoto } = await import(url);
      const jpeg = Uint8Array.from([
        255, 216, 255, 192, 0, 11, 8, 39, 16, 39, 16, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63,
        0,
      ]);
      const webp = new Uint8Array(30),
        view = new DataView(webp.buffer);
      webp.set(new TextEncoder().encode('RIFF'), 0);
      view.setUint32(4, 22, true);
      webp.set(new TextEncoder().encode('WEBPVP8 '), 8);
      view.setUint32(16, 10, true);
      webp.set([0, 0, 0, 157, 1, 42], 20);
      view.setUint16(26, 10000, true);
      view.setUint16(28, 10000, true);
      const errors = [];
      for (const [bytes, mimeType] of [
        [jpeg, 'image/jpeg'],
        [webp, 'image/webp'],
        [jpeg, 'image/png'],
      ] as const) {
        try {
          await prepareSharedPhoto({ bytes: new Blob([bytes]), mimeType });
          errors.push('accepted');
        } catch (error) {
          errors.push((error as Error).message);
        }
      }
      return { decodes, errors };
    } finally {
      globalThis.createImageBitmap = original;
      URL.revokeObjectURL(url);
    }
  }, source);
  expect(result.decodes).toBe(0);
  expect(result.errors.every((error) => /dimensions|header/.test(error))).toBe(true);
});
