/** Bounded, metadata-free sharing derivatives. Private originals are never modified. */
export const SHARED_PHOTO_LIMITS = Object.freeze({
  headerBytes: 1024 * 1024,
  inputBytes: 96 * 1024 * 1024,
  pixels: 40_000_000,
  dimension: 16_384,
  outputEdge: 2048,
  outputBytes: 2 * 1024 * 1024,
});
export type PhotoDimensions = { width: number; height: number };
const invalid = (): never => {
  throw new Error('Photo has a malformed or unsupported image header');
};
const ascii = (bytes: Uint8Array, offset: number, value: string) =>
  [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
function dimensions(width: number, height: number): PhotoDimensions {
  if (
    !width ||
    !height ||
    width > SHARED_PHOTO_LIMITS.dimension ||
    height > SHARED_PHOTO_LIMITS.dimension ||
    width * height > SHARED_PHOTO_LIMITS.pixels
  )
    throw new Error('Photo dimensions exceed sharing limit');
  return { width, height };
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inspect only a bounded prefix, before invoking any browser image decoder.
 * JPEG dimensions are unrotated; preparation honors EXIF orientation in pixels.
 * Animated PNG/WebP and unusual JPEG frame types are deliberately refused.
 */
export function validatePhotoHeader(
  header: Uint8Array,
  mimeType: string,
  totalBytes = header.length,
): PhotoDimensions {
  const bytes = header.subarray(0, SHARED_PHOTO_LIMITS.headerBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < bytes.length ||
    totalBytes > SHARED_PHOTO_LIMITS.inputBytes
  )
    return invalid();
  const present = (offset: number, size: number) => offset >= 0 && offset + size <= bytes.length;
  if (mimeType === 'image/png') {
    if (
      !present(0, 33) ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ||
      view.getUint32(8) !== 13 ||
      !ascii(bytes, 12, 'IHDR') ||
      crc32(bytes.subarray(12, 29)) !== view.getUint32(29)
    )
      return invalid();
    const size = dimensions(view.getUint32(16), view.getUint32(20));
    const depths: Record<number, number[]> = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16],
    };
    if (
      !depths[bytes[25]]?.includes(bytes[24]) ||
      bytes[26] !== 0 ||
      bytes[27] !== 0 ||
      bytes[28] > 1
    )
      return invalid();
    for (let offset = 33; present(offset, 8);) {
      const length = view.getUint32(offset);
      if (offset + 12 + length > totalBytes) return invalid();
      if (
        ascii(bytes, offset + 4, 'acTL') ||
        ascii(bytes, offset + 4, 'IHDR') ||
        ascii(bytes, offset + 4, 'IEND')
      )
        return invalid();
      if (ascii(bytes, offset + 4, 'IDAT')) return size;
      offset += 12 + length;
    }
    return invalid();
  }
  if (mimeType === 'image/jpeg') {
    if (!present(0, 2) || bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalid();
    let size: PhotoDimensions | undefined;
    for (let offset = 2; present(offset, 2);) {
      if (bytes[offset++] !== 0xff) return invalid();
      while (bytes[offset] === 0xff) offset++;
      if (!present(offset, 3)) return invalid();
      const marker = bytes[offset++];
      const length = view.getUint16(offset);
      if (length < 2 || !present(offset, length) || offset + length > totalBytes) return invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (
          size ||
          length < 8 ||
          bytes[offset + 2] !== 8 ||
          ![1, 3, 4].includes(bytes[offset + 7]) ||
          length !== 8 + 3 * bytes[offset + 7]
        )
          return invalid();
        size = dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      } else if (marker === 0xda) {
        if (
          !size ||
          length < 6 ||
          ![1, 2, 3, 4].includes(bytes[offset + 2]) ||
          length !== 6 + 2 * bytes[offset + 2]
        )
          return invalid();
        return size;
      } else if (!(
        marker === 0xc4 ||
        marker === 0xdb ||
        marker === 0xdd ||
        marker === 0xfe ||
        (marker >= 0xe0 && marker <= 0xef)
      )) {
        return invalid();
      }
      offset += length;
    }
    return invalid();
  }
  if (mimeType === 'image/webp') {
    if (
      !present(0, 20) ||
      !ascii(bytes, 0, 'RIFF') ||
      !ascii(bytes, 8, 'WEBP') ||
      view.getUint32(4, true) + 8 !== totalBytes
    )
      return invalid();
    let extended: PhotoDimensions | undefined;
    const little24 = (offset: number) =>
      bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
    for (let offset = 12; present(offset, 8);) {
      const length = view.getUint32(offset + 4, true),
        start = offset + 8;
      if (start + length + (length & 1) > totalBytes) return invalid();
      let size: PhotoDimensions | undefined;
      if (ascii(bytes, offset, 'VP8X')) {
        if (
          offset !== 12 ||
          length !== 10 ||
          !present(start, 10) ||
          bytes[start] & 0xc3 ||
          bytes[start + 1] ||
          bytes[start + 2] ||
          bytes[start + 3]
        )
          return invalid();
        extended = dimensions(little24(start + 4) + 1, little24(start + 7) + 1);
      } else if (ascii(bytes, offset, 'VP8 ')) {
        if (
          length < 10 ||
          !present(start, 10) ||
          bytes[start] & 1 ||
          !ascii(bytes, start + 3, '\x9d\x01\x2a')
        )
          return invalid();
        size = dimensions(
          view.getUint16(start + 6, true) & 0x3fff,
          view.getUint16(start + 8, true) & 0x3fff,
        );
      } else if (ascii(bytes, offset, 'VP8L')) {
        if (length < 5 || !present(start, 5) || bytes[start] !== 0x2f || bytes[start + 4] & 0xe0)
          return invalid();
        const bits = view.getUint32(start + 1, true);
        size = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      } else if (
        !extended ||
        !['ICCP', 'ALPH', 'EXIF', 'XMP '].some((tag) => ascii(bytes, offset, tag))
      ) {
        return invalid();
      }
      if (size) {
        if (extended && (size.width !== extended.width || size.height !== extended.height))
          return invalid();
        return size;
      }
      offset = start + length + (length & 1);
    }
  }
  return invalid();
}

export async function prepareSharedPhoto(input: {
  bytes: Blob;
  mimeType: string;
}): Promise<{ bytes: Blob; mimeType: 'image/jpeg' }> {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(input.mimeType) ||
    !input.bytes.size ||
    input.bytes.size > SHARED_PHOTO_LIMITS.inputBytes
  )
    throw new Error('Sharing supports bounded JPEG, PNG and WebP photos only');
  const header = new Uint8Array(
    await input.bytes.slice(0, SHARED_PHOTO_LIMITS.headerBytes).arrayBuffer(),
  );
  const source = validatePhotoHeader(header, input.mimeType, input.bytes.size);
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined')
    throw new Error('Photo sharing requires browser image preparation');
  // Explicitly apply EXIF rotation/mirroring once. Re-encoding drops source EXIF,
  // GPS, comments, XMP and other source metadata; upright pixels remain upright.
  const image = await createImageBitmap(input.bytes, { imageOrientation: 'from-image' });
  let canvas: HTMLCanvasElement | undefined;
  try {
    dimensions(image.width, image.height);
    if (!(
      (image.width === source.width && image.height === source.height) ||
      (image.width === source.height && image.height === source.width)
    ))
      return invalid();
    canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Photo preparation unavailable');
    const initialScale = Math.min(
      1,
      SHARED_PHOTO_LIMITS.outputEdge / Math.max(image.width, image.height),
    );
    for (const reduction of [1, 0.8, 0.6]) {
      canvas.width = Math.max(1, Math.round(image.width * initialScale * reduction));
      canvas.height = Math.max(1, Math.round(image.height * initialScale * reduction));
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.8, 0.7, 0.6]) {
        const bytes = await new Promise<Blob>((resolve, reject) =>
          canvas!.toBlob(
            (value) => (value ? resolve(value) : reject(new Error('Photo preparation failed'))),
            'image/jpeg',
            quality,
          ),
        );
        if (bytes.type !== 'image/jpeg') throw new Error('JPEG preparation unavailable');
        if (bytes.size && bytes.size <= SHARED_PHOTO_LIMITS.outputBytes)
          return { bytes, mimeType: 'image/jpeg' };
      }
    }
    throw new Error('Prepared photo exceeds sharing limit');
  } finally {
    image.close();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}
