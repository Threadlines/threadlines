import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import {
  fontNoticeLicense,
  readWoff2Notice,
  WOFF2_MAX_DECOMPRESSED_BYTES,
  type FontNotice,
} from "./fontNotice.ts";
import { FIGTREE, JETBRAINS_MONO, M_PLUS_1_CODE, ZEN_KAKU_GOTHIC_NEW_500 } from "./starterFonts.ts";

const brotli = (data: Uint8Array) =>
  brotliDecompressSync(data, { maxOutputLength: WOFF2_MAX_DECOMPRESSED_BYTES });

const woff2 = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

interface TestRecord {
  readonly platformID: number;
  readonly encodingID: number;
  readonly languageID: number;
  readonly nameID: number;
  readonly data: Uint8Array;
}

const windows = (languageID: number, nameID: number, text: string): TestRecord => ({
  platformID: 3,
  encodingID: 1,
  languageID,
  nameID,
  data: new Uint8Array([...text].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])),
});

const mac = (nameID: number, bytes: readonly number[]): TestRecord => ({
  platformID: 1,
  encodingID: 0,
  languageID: 0,
  nameID,
  data: new Uint8Array(bytes),
});

/**
 * Packs name records into a WOFF2 file holding only a `name` table, written
 * with an explicit tag, for the record choices the starter fonts don't reach.
 */
const packWoff2 = (records: readonly TestRecord[]) => wrapNameTable(nameTable(records));

/** A `name` table holding the records, each string after the last. */
const nameTable = (records: readonly TestRecord[]) => {
  const headerLength = 6 + records.length * 12;
  const table = new Uint8Array(headerLength + records.reduce((sum, r) => sum + r.data.length, 0));
  const tableView = new DataView(table.buffer);
  tableView.setUint16(2, records.length);
  tableView.setUint16(4, headerLength);
  let stringOffset = 0;
  records.forEach((record, index) => {
    const at = 6 + index * 12;
    tableView.setUint16(at, record.platformID);
    tableView.setUint16(at + 2, record.encodingID);
    tableView.setUint16(at + 4, record.languageID);
    tableView.setUint16(at + 6, record.nameID);
    tableView.setUint16(at + 8, record.data.length);
    tableView.setUint16(at + 10, stringOffset);
    table.set(record.data, headerLength + stringOffset);
    stringOffset += record.data.length;
  });
  return table;
};

/** A WOFF2 file holding only this `name` table. */
const wrapNameTable = (table: Uint8Array) => {
  // UIntBase128 for lengths under 16384.
  const length =
    table.length < 128 ? [table.length] : [0x80 | (table.length >> 7), table.length & 0x7f];
  const directory = [0x3f, ...Buffer.from("name"), ...length];
  const compressed = brotliCompressSync(table);
  const file = new Uint8Array(48 + directory.length + compressed.length);
  const fileView = new DataView(file.buffer);
  fileView.setUint32(0, 0x774f4632);
  fileView.setUint32(4, 0x00010000);
  fileView.setUint32(8, file.length);
  fileView.setUint16(12, 1);
  fileView.setUint32(16, 12 + 16 + table.length);
  fileView.setUint32(20, compressed.length);
  file.set(directory, 48);
  file.set(compressed, 48 + directory.length);
  return file;
};

describe("readWoff2Notice", () => {
  it("reads the notice each starter font carries", () => {
    const expected = [
      {
        font: FIGTREE,
        notice: {
          family: "Figtree Light",
          copyright:
            "Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree)",
          licenseDescription: null,
          licenseUrl: "https://openfontlicense.org",
        },
      },
      {
        font: JETBRAINS_MONO,
        notice: {
          family: "JetBrains Mono",
          copyright:
            "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)",
          licenseUrl: "https://scripts.sil.org/OFL",
        },
      },
      {
        font: M_PLUS_1_CODE,
        notice: {
          family: "M PLUS 1 Code",
          copyright: expect.stringMatching(/^Copyright 2021 The M\+ FONTS Project Authors/),
          licenseUrl: "https://openfontlicense.org",
        },
      },
      {
        font: ZEN_KAKU_GOTHIC_NEW_500,
        notice: {
          family: "Zen Kaku Gothic New Medium",
          copyright: expect.stringMatching(/^Copyright 2022 The Zen Project Authors/),
          licenseUrl: "https://scripts.sil.org/OFL",
        },
      },
    ];
    for (const { font, notice } of expected) {
      const result = readWoff2Notice(woff2(font), brotli);
      expect(result).toMatchObject({ ok: true, notice });
      expect(result.ok && fontNoticeLicense(result.notice)).toBe("OFL-1.1");
    }
  });

  it("prefers Windows English records, then any language, then Mac Roman", () => {
    const result = readWoff2Notice(
      packWoff2([
        mac(0, [0xa9, 0x20, 0x41]),
        mac(13, [0x4d, 0x61, 0x63]),
        windows(0x407, 13, "Beschreibung"),
        windows(0x409, 13, "Description"),
        windows(0x409, 1, "Legacy"),
        windows(0x409, 16, " "),
        windows(0x407, 16, "Typo"),
        windows(0x407, 14, "https://www.apache.org/licenses/LICENSE-2.0"),
      ]),
      brotli,
    );
    expect(result).toEqual({
      ok: true,
      notice: {
        family: "Typo",
        copyright: "© A",
        licenseDescription: "Description",
        licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
      },
    });
    expect(result.ok && fontNoticeLicense(result.notice)).toBe("Apache-2.0");
  });

  it("turns damaged and foreign files into errors instead of throwing", () => {
    const font = woff2(FIGTREE);
    const compressedSize = new DataView(font.buffer).getUint32(20);
    const patched = (at: number, bytes: readonly number[]) => {
      const copy = font.slice();
      copy.set(bytes, at);
      return copy;
    };
    const uint32 = (value: number) => [
      value >>> 24,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    const cases: ReadonlyArray<readonly [Uint8Array, (data: Uint8Array) => Uint8Array]> = [
      [new Uint8Array(0), brotli],
      [new Uint8Array(200).fill(0x5a), brotli],
      [font.subarray(0, font.length >> 1), brotli],
      [patched(0, [...Buffer.from("wOFF")]), brotli],
      [patched(4, [...Buffer.from("ttcf")]), brotli],
      [patched(16, uint32(WOFF2_MAX_DECOMPRESSED_BYTES + 1)), brotli],
      [patched(20, uint32(compressedSize - 100)), brotli],
      [font, () => new Uint8Array(10)],
      [
        font,
        () => {
          throw new Error("no brotli");
        },
      ],
    ];
    for (const [bytes, decompress] of cases) {
      expect(readWoff2Notice(bytes, decompress)).toEqual({ ok: false, error: expect.any(String) });
    }
  });
});

describe("readWoff2Notice on a hostile name table", () => {
  it("reads overlapping strings with bounded work and gives up past the budget", () => {
    // 600 copyright records over one 6 KB blank span, each starting a byte later:
    // 3.6 MB of decoding unbounded, a 14 KB table.
    const count = 600;
    const span = 6000;
    const headerLength = 6 + count * 12;
    const table = new Uint8Array(headerLength + span + count).fill(0x20, headerLength);
    const view = new DataView(table.buffer);
    view.setUint16(2, count);
    view.setUint16(4, headerLength);
    for (let index = 0; index < count; index++) {
      const at = 6 + index * 12;
      view.setUint16(at, 1); // Mac Roman
      view.setUint16(at + 6, 0); // copyright
      view.setUint16(at + 8, span);
      view.setUint16(at + 10, index);
    }
    const started = performance.now();
    expect(readWoff2Notice(wrapNameTable(table), brotli)).toEqual({
      ok: false,
      error: "font's name table is too large to read",
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("fontNoticeLicense", () => {
  it("names the license from either field, or none", () => {
    const notice = (licenseDescription: string | null, licenseUrl: string | null): FontNotice => ({
      family: null,
      copyright: null,
      licenseDescription,
      licenseUrl,
    });
    expect(
      fontNoticeLicense(
        notice(
          "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
          null,
        ),
      ),
    ).toBe("OFL-1.1");
    expect(
      fontNoticeLicense(
        notice("Licensed under the Apache License, Version 2.0", "https://example.com"),
      ),
    ).toBe("Apache-2.0");
    expect(fontNoticeLicense(notice("Ubuntu Font Licence 1.0", "https://ubuntu.com/legal"))).toBe(
      null,
    );
    expect(fontNoticeLicense(notice(null, null))).toBe(null);
  });
});
