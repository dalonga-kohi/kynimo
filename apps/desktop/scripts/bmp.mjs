/**
 * Encodes raw pixels as an uncompressed 24-bit Windows BMP (what NSIS reads for its sidebar and
 * header images). `rgba` is width * height * 4 bytes, top row first; alpha is ignored.
 */
export function writeBmp(width, height, rgba) {
  if (rgba.length !== width * height * 4)
    throw new Error(`Expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`);
  const stride = Math.ceil((width * 3) / 4) * 4;
  const pixels = stride * height;
  const file = Buffer.alloc(54 + pixels);
  file.write("BM", 0, "latin1");
  file.writeUInt32LE(file.length, 2);
  file.writeUInt32LE(54, 10); // where the pixels start
  file.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  file.writeInt32LE(width, 18);
  file.writeInt32LE(height, 22); // positive: rows are stored bottom-up
  file.writeUInt16LE(1, 26);
  file.writeUInt16LE(24, 28);
  file.writeUInt32LE(pixels, 34);
  file.writeInt32LE(2835, 38); // 72 dpi
  file.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    let at = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      file[at++] = rgba[from + 2];
      file[at++] = rgba[from + 1];
      file[at++] = rgba[from];
    }
  }
  return file;
}
