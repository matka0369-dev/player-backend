// Shared by the DTO validator (well-formed and under the size cap?) and the
// service (actually decoding it to store) — one parser so the two can never
// disagree about what counts as a valid image.

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB decoded

// How long an attached image's bytes stick around before RequestsService's
// scheduled purge clears them — the request row itself (kind, amount,
// status, note, resolution) is never touched, only imageData/imageMimeType.
// See ARCHITECTURE.md "Hard safety boundaries" (2026-09-15 revision).
export const IMAGE_RETENTION_DAYS = 15;
export const IMAGE_RETENTION_MS = IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/;

export function parseImageDataUrl(value: string): { mimeType: string; buffer: Uint8Array } | null {
  const match = DATA_URL_RE.exec(value);
  if (!match) return null;
  const [, mimeType, base64] = match;
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) return null;
  // Prisma's Bytes fields want a plain Uint8Array<ArrayBuffer> — Buffer's own
  // type (Uint8Array<ArrayBufferLike>, to admit SharedArrayBuffer) doesn't
  // structurally match, hence the copy rather than returning the Buffer
  // itself.
  const buffer = Uint8Array.from(Buffer.from(base64, 'base64'));
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
  return { mimeType, buffer };
}
