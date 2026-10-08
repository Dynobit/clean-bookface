import { SHARED_PHOTO_LIMITS, validatePhotoHeader } from './shared-photo.js';
export const LOCAL_PHOTO_LIMITS = {
  bytes: 16 * 1024 * 1024,
  pixels: 8_000_000,
  pagePixels: 24_000_000,
} as const;
/** One sequential budget per rendered page; never invokes a decoder. */
export class LocalPhotoBudget {
  private pixels = 0;
  private active = true;
  cancel() {
    this.active = false;
  }
  async admit(bytes: Blob, mimeType: string): Promise<boolean> {
    if (
      !this.active ||
      bytes.size > LOCAL_PHOTO_LIMITS.bytes ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
    )
      return false;
    try {
      const header = new Uint8Array(
        await bytes.slice(0, SHARED_PHOTO_LIMITS.headerBytes).arrayBuffer(),
      );
      const { width, height } = validatePhotoHeader(header, mimeType, bytes.size);
      const pixels = width * height;
      if (
        !this.active ||
        pixels > LOCAL_PHOTO_LIMITS.pixels ||
        this.pixels + pixels > LOCAL_PHOTO_LIMITS.pagePixels
      )
        return false;
      this.pixels += pixels;
      return true;
    } catch {
      return false;
    }
  }
}
