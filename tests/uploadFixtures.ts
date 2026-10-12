import { randomFillSync } from 'node:crypto';
import { PNG } from 'pngjs';

let largeImage: Buffer | undefined;

/** A valid, poorly compressible PNG larger than the previous 8 MiB ceiling. */
export function largePngFixture(): Buffer {
  if (!largeImage) {
    const image = new PNG({ width: 1536, height: 1536 });
    randomFillSync(image.data);
    largeImage = PNG.sync.write(image);
    if (largeImage.length <= 8 * 1024 * 1024) throw new Error('Fixture did not exceed the old upload limit');
  }
  return Buffer.from(largeImage);
}
