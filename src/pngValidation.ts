import { ApiError } from './apiError';
import { IMPORT_LIMITS, IMPORT_LIMIT_TEXT } from '../shared/importLimits';

export { MiB } from '../shared/importLimits';
export const MAX_FILE_BYTES = IMPORT_LIMITS.pngBytes;
const signature = [137, 80, 78, 71, 13, 10, 26, 10];

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  crcTable[index] = value >>> 0;
}

/** PNG and ZIP checksums use the same CRC-32 polynomial. */
export function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]!;
  return (value ^ 0xffffffff) >>> 0;
}

export interface PreparedBrowserAsset {
  name: string;
  filename: string;
  width: number;
  height: number;
  blob: Blob;
  pack?: string;
}

/** Check every chunk before trusting the browser decoder (which may ignore CRC errors). */
export async function validatePng(data: Uint8Array, filename: string, pack?: string): Promise<PreparedBrowserAsset> {
  if (data.length > IMPORT_LIMITS.pngBytes) throw new ApiError(IMPORT_LIMIT_TEXT.png, 413);
  if (data.length < 33 || signature.some((byte, index) => data[index] !== byte)
    || String.fromCharCode(...data.subarray(12, 16)) !== 'IHDR') {
    throw new ApiError(`«${filename}» не является PNG.`, 400);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > IMPORT_LIMITS.pngSide || height > IMPORT_LIMITS.pngSide || width * height > IMPORT_LIMITS.pngPixels) {
    throw new ApiError(IMPORT_LIMIT_TEXT.pixels, 400);
  }
  const malformed = () => new ApiError(`PNG «${filename}» повреждён или имеет неподдерживаемую структуру.`, 400);
  let cursor = 8;
  let sawHeader = false;
  let sawPalette = false;
  let sawImage = false;
  let imageEnded = false;
  let sawEnd = false;
  const depth = data[24]!;
  const colorType = data[25]!;
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[colorType]?.includes(depth) || data[26] !== 0 || data[27] !== 0 || data[28]! > 1) throw malformed();
  while (cursor + 12 <= data.length) {
    const length = view.getUint32(cursor);
    if (length > data.length - cursor - 12) throw malformed();
    const typeBytes = data.subarray(cursor + 4, cursor + 8);
    if ([...typeBytes].some(byte => !((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)))
      || (typeBytes[2]! & 32) !== 0) throw malformed();
    const type = String.fromCharCode(...typeBytes);
    const expected = view.getUint32(cursor + 8 + length);
    if (crc32(data.subarray(cursor + 4, cursor + 8 + length)) !== expected) throw malformed();
    if (!sawHeader && type !== 'IHDR') throw malformed();
    if (type === 'IHDR') {
      if (sawHeader || length !== 13 || cursor !== 8) throw malformed();
      sawHeader = true;
    } else if (type === 'PLTE') {
      if (sawPalette || sawImage || !length || length % 3 !== 0 || length > 768 || colorType === 0 || colorType === 4) throw malformed();
      if (colorType === 3 && length / 3 > 2 ** depth) throw malformed();
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (imageEnded || (colorType === 3 && !sawPalette)) throw malformed();
      sawImage = true;
    } else if (type === 'IEND') {
      if (length !== 0 || !sawImage) throw malformed();
      sawEnd = true;
      cursor += length + 12;
      break;
    } else {
      // Unknown critical chunks cannot be decoded reliably; ancillary chunks are retained.
      if ((typeBytes[0]! & 32) === 0) throw malformed();
      if (sawImage) imageEnded = true;
    }
    cursor += length + 12;
  }
  if (!sawEnd || cursor !== data.length) throw malformed();
  // An owned ArrayBuffer also avoids sharing mutable ZIP input with the saved Blob.
  const blob = new Blob([new Uint8Array(data)], { type: 'image/png' });
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      try { if (bitmap.width !== width || bitmap.height !== height) throw malformed(); }
      finally { bitmap.close(); }
    } else {
      const url = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        if (image.naturalWidth !== width || image.naturalHeight !== height) throw malformed();
      } finally { URL.revokeObjectURL(url); }
    }
  } catch { throw malformed(); }
  const basename = filename.replaceAll('\\', '/').split('/').at(-1)!;
  return {
    name: basename.replace(/\.png$/i, '').trim().slice(0, 120) || 'Без названия',
    filename: basename.slice(0, 240), width, height, blob,
    ...(pack ? { pack: pack.slice(0, 120) } : {}),
  };
}
