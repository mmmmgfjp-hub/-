import { HttpError } from '../http';

export interface DecodedImage {
  mime: string;
  ext: string;
  bytes: number;
  dataUrl: string;
  buffer: Buffer;
}

const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

export function detectImageType(buffer: Buffer): { mime: string; ext: string } | null {
  for (const sig of SIGNATURES) {
    if (sig.test(buffer)) return { mime: sig.mime, ext: sig.ext };
  }
  return null;
}

/**
 * Accepts a data URL, verifies the *actual* file signature (not just the declared mime),
 * and enforces the size limit before any bytes reach the AI provider.
 */
export function decodeImageDataUrl(input: unknown, maxBytes: number, field = 'image'): DecodedImage {
  if (typeof input !== 'string' || input.length === 0) {
    throw new HttpError(400, 'IMAGE_REQUIRED', `A base64 data URL is required in "${field}".`);
  }
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(input.trim());
  if (!match) {
    throw new HttpError(
      400,
      'INVALID_IMAGE_FORMAT',
      'Expected an image data URL (data:image/png;base64,...).',
    );
  }
  const declaredMime = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) {
    throw new HttpError(400, 'INVALID_IMAGE', 'The uploaded image is empty.');
  }
  if (buffer.length > maxBytes) {
    throw new HttpError(
      413,
      'IMAGE_TOO_LARGE',
      `The image is too large (${(buffer.length / (1024 * 1024)).toFixed(2)} MB). Maximum is ${(maxBytes / (1024 * 1024)).toFixed(1)} MB.`,
    );
  }
  const detected = detectImageType(buffer);
  if (!detected) {
    throw new HttpError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Only PNG, JPEG or WebP images are accepted.');
  }
  if (detected.mime !== declaredMime && !(declaredMime === 'image/jpg' && detected.mime === 'image/jpeg')) {
    throw new HttpError(
      415,
      'IMAGE_TYPE_MISMATCH',
      `The file content (${detected.mime}) does not match the declared type (${mimeLabel(declaredMime)}).`,
    );
  }
  return {
    mime: detected.mime,
    ext: detected.ext,
    bytes: buffer.length,
    dataUrl: `data:${detected.mime};base64,${buffer.toString('base64')}`,
    buffer,
  };
}

function mimeLabel(mime: string): string {
  return mime.replace('image/', '').toUpperCase();
}

export function validateTxHash(txHash: unknown, network: string): string {
  if (typeof txHash !== 'string' || txHash.trim().length === 0) {
    throw new HttpError(400, 'TX_HASH_REQUIRED', 'A transaction hash is required.');
  }
  const clean = txHash.trim();
  if (/tron|trc/i.test(network)) {
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
      throw new HttpError(
        400,
        'INVALID_TX_HASH',
        'A TRON (TRC20) transaction hash must be 64 hexadecimal characters.',
      );
    }
    return clean.toLowerCase();
  }
  if (!/^[A-Za-z0-9:_-]{16,128}$/.test(clean)) {
    throw new HttpError(400, 'INVALID_TX_HASH', 'The transaction hash format is not valid.');
  }
  return clean;
}
