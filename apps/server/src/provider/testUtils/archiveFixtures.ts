/**
 * Test helpers that build small archives in memory: a ustar writer and a zip
 * writer simple enough to produce entries no real tool would (a device, a
 * path that climbs out, a link with any target).
 */
import * as zlib from "node:zlib";

export interface TarEntry {
  readonly name: string;
  /** ustar type flag: "0" file, "2" symlink, "3" character device, "S" sparse. */
  readonly type?: string;
  readonly data?: Buffer;
  readonly mode?: number;
  readonly linkname?: string;
  /** Declares a size without carrying that much data, for entries that are refused on sight. */
  readonly declaredSize?: number;
}

/** A minimal ustar writer, for entries no real tool would produce. */
export function makeTar(entries: ReadonlyArray<TarEntry>): Buffer {
  const blocks: Array<Buffer> = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    const size = entry.declaredSize ?? data.length;
    header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write(entry.linkname ?? "", 157, 100, "utf8");
    header.write("ustar\u000000", 257, 8, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export interface ZipEntry {
  readonly name: string;
  readonly data?: Buffer;
  /** Unix mode with its type bits, e.g. 0o100755 or 0o120777 for a link. */
  readonly mode?: number;
}

/** A minimal zip writer: stored entries made on "Unix", then the central directory. */
export function makeZip(entries: ReadonlyArray<ZipEntry>): Buffer {
  const parts: Array<Buffer> = [];
  const central: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? Buffer.alloc(0);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
