/**
 * Packs PNG images into one Windows .ico file. Entries keep their PNG data as is (supported
 * since Windows Vista), so the writer needs no image library.
 * `images`: [{ size, png }] with `size` in pixels (1 to 256) and `png` a Buffer.
 */
export function writeIco(images) {
  if (images.length === 0) throw new Error("An icon needs at least one image");
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256)
      throw new Error(`Icon size must be 1 to 256, got ${size}`);
    const at = index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, at); // width, 0 means 256
    directory.writeUInt8(size === 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}
