/**
 * Reads the naming records a WOFF2 font carries about itself: its family, its
 * copyright notice and its license. The theme Showcase uses them to confirm an
 * embedded font (`fonts.*.data`) keeps its notice inside the font, which is how
 * the SIL Open Font License's "keep the notice" condition is met.
 *
 * Pure and platform-neutral: the caller supplies Brotli (`zlib.brotliDecompressSync`
 * on Node). Follows the W3C WOFF2 spec, https://www.w3.org/TR/WOFF2/.
 */

export interface FontNotice {
  /** Name ID 16 (typographic family), or name ID 1 when the font has no 16. */
  readonly family: string | null;
  /** Name ID 0. */
  readonly copyright: string | null;
  /** Name ID 13. */
  readonly licenseDescription: string | null;
  /** Name ID 14. */
  readonly licenseUrl: string | null;
}

export type Woff2NoticeResult =
  | { readonly ok: true; readonly notice: FontNotice }
  | { readonly ok: false; readonly error: string };

/**
 * The most font data a WOFF2 file may decompress to. The reader refuses anything
 * larger; bound the decompressor you pass in with it too (Node's
 * `maxOutputLength`), so a hostile stream stops before it fills memory.
 */
export const WOFF2_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

const WOFF2_SIGNATURE = 0x774f4632; // 'wOF2'
const COLLECTION_FLAVOR = 0x74746366; // 'ttcf'
const HEADER_BYTES = 48;
const EXPLICIT_TAG = 63;

/**
 * Table tags by the index in a directory entry's low six bits (spec 4.1, "Known
 * Table Tags"). Three-letter tags get their trailing space back, as in sfnt.
 */
const KNOWN_TAGS = (
  "cmap head hhea hmtx maxp name OS/2 post cvt fpgm glyf loca prep CFF VORG EBDT " +
  "EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH " +
  "CBDT CBLC COLR CPAL SVG sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar " +
  "gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill"
)
  .split(" ")
  .map((tag) => tag.padEnd(4));

const OFL_MARKERS = ["scripts.sil.org/ofl", "openfontlicense.org", "sil open font license"];
const APACHE_MARKERS = ["apache.org/licenses/license-2.0", "apache license, version 2.0"];

/** Mac OS Roman bytes 0x80 to 0xFF; the lower half is ASCII. */
const MAC_ROMAN_HIGH =
  "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø" +
  "¿¡¬√ƒ≈∆«»…\u00a0ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uf8ffÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";

const fail = (error: string): Woff2NoticeResult => ({ ok: false, error });

const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * Reads a WOFF2 font's naming records. Never throws: anything unreadable
 * (wrong signature, truncation, a collection, bad Brotli data, no `name`
 * table) comes back as `{ ok: false, error }` with a short plain reason.
 */
export function readWoff2Notice(
  bytes: Uint8Array,
  brotliDecompress: (data: Uint8Array) => Uint8Array,
): Woff2NoticeResult {
  try {
    return readNotice(bytes, brotliDecompress);
  } catch {
    // Every read is bounds-checked; this only keeps the never-throws promise.
    return fail("font couldn't be read");
  }
}

/** The license a notice names, by its URL or description: OFL 1.1, Apache 2.0, or null when it names neither. */
export function fontNoticeLicense(notice: FontNotice): "OFL-1.1" | "Apache-2.0" | null {
  for (const text of [notice.licenseUrl, notice.licenseDescription]) {
    if (text === null) continue;
    const lower = text.toLowerCase();
    if (OFL_MARKERS.some((marker) => lower.includes(marker))) return "OFL-1.1";
    if (APACHE_MARKERS.some((marker) => lower.includes(marker))) return "Apache-2.0";
  }
  return null;
}

/** Walks the header and table directory, decompresses the table data and parses `name`. */
function readNotice(
  bytes: Uint8Array,
  brotliDecompress: (data: Uint8Array) => Uint8Array,
): Woff2NoticeResult {
  const view = viewOf(bytes);
  if (bytes.length < 4 || view.getUint32(0) !== WOFF2_SIGNATURE) return fail("not a WOFF2 font");
  if (bytes.length < HEADER_BYTES) return fail("font file is truncated");
  if (view.getUint32(4) === COLLECTION_FLAVOR) return fail("font collections aren't supported");
  const declaredLength = view.getUint32(8);
  if (declaredLength > bytes.length) return fail("font file is truncated");
  if (declaredLength < bytes.length) return fail("font file is longer than its header says");
  const numTables = view.getUint16(12);
  const totalSfntSize = view.getUint32(16);
  const totalCompressedSize = view.getUint32(20);
  if (numTables === 0) return fail("font has no tables");
  if (totalSfntSize > WOFF2_MAX_DECOMPRESSED_BYTES) return fail("font is larger than 32 MB");

  // Each table's data follows the last one's in the decompressed stream, with
  // no padding between them (spec 5), so its offset is the sum of the lengths
  // before it.
  let pos = HEADER_BYTES;
  let dataLength = 0;
  let nameTable: { readonly offset: number; readonly length: number } | null = null;
  for (let index = 0; index < numTables; index++) {
    const flags = bytes[pos];
    if (flags === undefined) return fail("font file is truncated");
    pos += 1;
    let tag: string | undefined;
    if ((flags & 0x3f) === EXPLICIT_TAG) {
      if (pos + 4 > bytes.length) return fail("font file is truncated");
      tag = String.fromCharCode(...bytes.subarray(pos, pos + 4));
      pos += 4;
    } else {
      tag = KNOWN_TAGS[flags & 0x3f];
    }
    const origLength = readUIntBase128(bytes, pos);
    if (tag === undefined || origLength === null) {
      return fail("font's table directory is malformed");
    }
    pos = origLength.next;
    const transformed = isTransformed(tag, flags >> 6);
    if (transformed === null) return fail("font uses a table transform this reader doesn't know");
    let storedLength = origLength.value;
    if (transformed) {
      const transformLength = readUIntBase128(bytes, pos);
      if (transformLength === null) return fail("font's table directory is malformed");
      pos = transformLength.next;
      storedLength = transformLength.value;
    }
    if (tag === "name" && nameTable === null) {
      nameTable = { offset: dataLength, length: storedLength };
    }
    dataLength += storedLength;
  }
  if (nameTable === null) return fail("font has no name table");
  if (dataLength > WOFF2_MAX_DECOMPRESSED_BYTES) return fail("font is larger than 32 MB");
  if (pos + totalCompressedSize > bytes.length) return fail("font file is truncated");

  let tables: Uint8Array;
  try {
    tables = brotliDecompress(bytes.subarray(pos, pos + totalCompressedSize));
  } catch {
    return fail("font data doesn't decompress");
  }
  if (tables.length > WOFF2_MAX_DECOMPRESSED_BYTES) return fail("font is larger than 32 MB");
  if (tables.length !== dataLength) {
    return fail("font data doesn't match its table directory");
  }
  return readNameTable(tables.subarray(nameTable.offset, nameTable.offset + nameTable.length));
}

/**
 * Whether a table's data is stored transformed (and so has a `transformLength`),
 * from its tag and the version in its flags' top two bits (spec 4.1). Null for a
 * version the spec doesn't define, which means the whole font must be rejected.
 */
function isTransformed(tag: string, version: number): boolean | null {
  if (tag === "glyf" || tag === "loca") return version === 0 ? true : version === 3 ? false : null;
  if (tag === "hmtx") return version === 1 ? true : version === 0 ? false : null;
  return version === 0 ? false : null;
}

/**
 * Reads a UIntBase128 at `pos` (spec 3.1) and where the next field starts. Null
 * when it runs past the end, has a leading zero byte, is longer than five bytes
 * or overflows 32 bits.
 */
function readUIntBase128(
  bytes: Uint8Array,
  pos: number,
): { readonly value: number; readonly next: number } | null {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    const byte = bytes[pos + index];
    if (byte === undefined) return null;
    if (index === 0 && byte === 0x80) return null;
    if (value > 0x01ffffff) return null;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: pos + index + 1 };
  }
  return null;
}

interface NameRecord {
  readonly platformID: number;
  readonly encodingID: number;
  readonly languageID: number;
  readonly nameID: number;
  readonly data: Uint8Array;
}

/**
 * Parses a `name` table (format 0 or 1) into a notice. Records whose string runs
 * outside the table are skipped; a header or record list that does is an error.
 */
function readNameTable(table: Uint8Array): Woff2NoticeResult {
  const view = viewOf(table);
  if (table.length < 6) return fail("font's name table is truncated");
  const format = view.getUint16(0);
  if (format !== 0 && format !== 1) return fail(`font's name table has unknown format ${format}`);
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  if (6 + count * 12 > table.length || storage > table.length) {
    return fail("font's name table is truncated");
  }
  const records: NameRecord[] = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 12;
    const start = storage + view.getUint16(at + 10);
    const end = start + view.getUint16(at + 8);
    if (end > table.length) continue;
    records.push({
      platformID: view.getUint16(at),
      encodingID: view.getUint16(at + 2),
      languageID: view.getUint16(at + 4),
      nameID: view.getUint16(at + 6),
      data: table.subarray(start, end),
    });
  }
  return {
    ok: true,
    notice: {
      family: pickName(records, 16) ?? pickName(records, 1),
      copyright: pickName(records, 0),
      licenseDescription: pickName(records, 13),
      licenseUrl: pickName(records, 14),
    },
  };
}

/**
 * The best non-blank string for a name ID: Windows Unicode in English, then
 * Windows Unicode in any language, then Mac Roman (English first). Null when
 * none has one.
 */
function pickName(records: readonly NameRecord[], nameID: number): string | null {
  const ranked = records
    .flatMap((record) => {
      const rank = record.nameID === nameID ? recordRank(record) : null;
      return rank === null ? [] : [{ rank, record }];
    })
    .sort((a, b) => a.rank - b.rank);
  for (const { record } of ranked) {
    const text = record.platformID === 3 ? decodeUtf16Be(record.data) : decodeMacRoman(record.data);
    if (text.trim() !== "") return text;
  }
  return null;
}

/** Lower ranks win; null for platforms and encodings this reader doesn't decode. */
function recordRank(record: NameRecord): number | null {
  if (record.platformID === 3 && record.encodingID === 1)
    return record.languageID === 0x409 ? 0 : 1;
  if (record.platformID === 1 && record.encodingID === 0) return record.languageID === 0 ? 2 : 3;
  return null;
}

/** Decodes UTF-16BE; a trailing odd byte is dropped. */
function decodeUtf16Be(data: Uint8Array): string {
  const view = viewOf(data);
  let text = "";
  for (let at = 0; at + 1 < data.length; at += 2) text += String.fromCharCode(view.getUint16(at));
  return text;
}

/** Decodes Mac OS Roman. */
function decodeMacRoman(data: Uint8Array): string {
  let text = "";
  for (const byte of data) {
    text += byte < 0x80 ? String.fromCharCode(byte) : MAC_ROMAN_HIGH.charAt(byte - 0x80);
  }
  return text;
}
