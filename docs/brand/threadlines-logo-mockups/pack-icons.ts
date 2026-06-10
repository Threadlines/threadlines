/**
 * Packs the rendered PNG size set into .ico and .icns containers.
 * Both formats accept PNG-compressed entries (Windows Vista+/modern macOS),
 * so no raster re-encoding is needed. Run with: bun pack-icons.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const pngDir = join(root, "png");
const outDir = join(root, "dist-icons");
mkdirSync(outDir, { recursive: true });

function pngForSize(size: number): Buffer {
  return readFileSync(join(pngDir, `threadlines-icon-minimal-${size}.png`));
}

function buildIco(sizes: ReadonlyArray<number>): Buffer {
  const images = sizes.map((size) => ({ size, data: pngForSize(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0); // width, 0 = 256
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1); // height
    entry.writeUInt8(0, 2); // palette colors
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

const ICNS_TYPE_BY_SIZE: Record<number, string> = {
  16: "icp4",
  32: "icp5",
  128: "ic07",
  256: "ic08",
  512: "ic09",
  1024: "ic10",
};

function buildIcns(sizes: ReadonlyArray<number>): Buffer {
  const chunks = sizes.map((size) => {
    const type = ICNS_TYPE_BY_SIZE[size];
    if (type === undefined) throw new Error(`No icns chunk type for size ${size}`);
    const data = pngForSize(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([header, data]);
  });
  const body = Buffer.concat(chunks);
  const fileHeader = Buffer.alloc(8);
  fileHeader.write("icns", 0, "ascii");
  fileHeader.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([fileHeader, body]);
}

writeFileSync(join(outDir, "threadlines-windows.ico"), buildIco([256, 128, 64, 48, 32, 16]));
writeFileSync(join(outDir, "threadlines-web-favicon.ico"), buildIco([48, 32, 16]));
writeFileSync(join(outDir, "threadlines-icon.icns"), buildIcns([1024, 512, 256, 128, 32, 16]));
console.log(`wrote 3 containers to ${outDir}`);
