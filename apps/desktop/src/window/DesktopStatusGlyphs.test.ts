import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";

import * as DesktopStatusGlyphs from "./DesktopStatusGlyphs.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Buffer;
}

function decodePng(dataUrl: string): DecodedPng {
  const base64 = dataUrl.replace("data:image/png;base64,", "");
  const bytes = Buffer.from(base64, "base64");
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE);

  let width = 0;
  let height = 0;
  let idat = Buffer.alloc(0);
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      assert.equal(payload[8], 8, "bit depth");
      assert.equal(payload[9], 6, "color type RGBA");
    } else if (type === "IDAT") {
      idat = Buffer.concat([idat, payload]);
    }
    offset += 12 + length;
  }

  const raw = NodeZlib.inflateSync(idat);
  const stride = 1 + width * 4;
  assert.equal(raw.length, height * stride, "decoded scanline size");
  const rgba = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    assert.equal(raw[row * stride], 0, "scanline filter type");
    raw.copy(rgba, row * width * 4, row * stride + 1, (row + 1) * stride);
  }
  return { width, height, rgba };
}

function maxAlpha(png: DecodedPng): number {
  let max = 0;
  for (let index = 3; index < png.rgba.length; index += 4) {
    max = Math.max(max, png.rgba[index] ?? 0);
  }
  return max;
}

function pixelAt(png: DecodedPng, x: number, y: number): readonly [number, number, number, number] {
  const offset = (y * png.width + x) * 4;
  return [
    png.rgba[offset] ?? 0,
    png.rgba[offset + 1] ?? 0,
    png.rgba[offset + 2] ?? 0,
    png.rgba[offset + 3] ?? 0,
  ];
}

function hasWhitePixel(png: DecodedPng): boolean {
  for (let offset = 0; offset < png.rgba.length; offset += 4) {
    if (
      (png.rgba[offset] ?? 0) > 240 &&
      (png.rgba[offset + 1] ?? 0) > 240 &&
      (png.rgba[offset + 2] ?? 0) > 240 &&
      (png.rgba[offset + 3] ?? 0) > 200
    ) {
      return true;
    }
  }
  return false;
}

function assertColorIsBlack(png: DecodedPng): void {
  for (let index = 0; index < png.rgba.length; index += 4) {
    assert.equal(png.rgba[index], 0);
    assert.equal(png.rgba[index + 1], 0);
    assert.equal(png.rgba[index + 2], 0);
  }
}

describe("DesktopStatusGlyphs", () => {
  it("renders decodable 1x and 2x template PNGs for every glyph", () => {
    const glyphs = DesktopStatusGlyphs.makeMacTrayGlyphSet();
    const allGlyphs = [glyphs.idle, ...glyphs.workingFrames, ...glyphs.completedFrames];

    for (const glyph of allGlyphs) {
      assert.lengthOf(glyph.representations, 2);
      for (const representation of glyph.representations) {
        const decoded = decodePng(representation.dataUrl);
        const expectedSize = DesktopStatusGlyphs.TRAY_GLYPH_SIZE_PT * representation.scaleFactor;
        assert.equal(decoded.width, expectedSize);
        assert.equal(decoded.height, expectedSize);
        // Pop-in frames fade from low alpha, so only require visible pixels.
        assert.isAbove(maxAlpha(decoded), 50, "glyph has visible pixels");
        assertColorIsBlack(decoded);
      }
      assert.deepEqual(
        glyph.representations.map((representation) => representation.scaleFactor),
        [1, 2],
      );
    }

    for (const restingGlyph of [glyphs.idle, glyphs.completedFrames.at(-1)]) {
      const dataUrl = restingGlyph?.representations[1]?.dataUrl;
      assert.isDefined(dataUrl);
      assert.isAbove(maxAlpha(decodePng(dataUrl)), 200, "resting glyphs render at full strength");
    }
  });

  it("memoizes the glyph set and keeps animation frames distinct", () => {
    const glyphs = DesktopStatusGlyphs.makeMacTrayGlyphSet();
    assert.equal(glyphs, DesktopStatusGlyphs.makeMacTrayGlyphSet());

    assert.isAtLeast(glyphs.workingFrames.length, 8, "smooth working loop");
    assert.isAtLeast(glyphs.completedFrames.length, 2, "completed pop plays in");

    const workingDataUrls = glyphs.workingFrames.map(
      (frame) => frame.representations[1]?.dataUrl ?? "",
    );
    assert.equal(new Set(workingDataUrls).size, workingDataUrls.length);

    const completedDataUrls = glyphs.completedFrames.map(
      (frame) => frame.representations[1]?.dataUrl ?? "",
    );
    assert.notEqual(completedDataUrls.at(0), completedDataUrls.at(-1));
  });

  it("renders distinct template menu state icons", () => {
    const menuGlyphs = DesktopStatusGlyphs.makeMacMenuStateGlyphs();
    assert.equal(menuGlyphs, DesktopStatusGlyphs.makeMacMenuStateGlyphs());

    for (const glyph of [menuGlyphs.running, menuGlyphs.completed]) {
      assert.deepEqual(
        glyph.representations.map((representation) => representation.scaleFactor),
        [1, 2],
      );
      for (const representation of glyph.representations) {
        const decoded = decodePng(representation.dataUrl);
        assert.equal(decoded.width, 16 * representation.scaleFactor);
        assert.isAbove(maxAlpha(decoded), 200);
        assertColorIsBlack(decoded);
      }
    }
    assert.notEqual(
      menuGlyphs.running.representations[1]?.dataUrl,
      menuGlyphs.completed.representations[1]?.dataUrl,
    );
  });

  it("renders colored taskbar overlay chips and caches them by label", () => {
    const runningTwo = DesktopStatusGlyphs.makeTaskbarOverlayChip({ kind: "running", count: 2 });
    assert.equal(
      runningTwo,
      DesktopStatusGlyphs.makeTaskbarOverlayChip({ kind: "running", count: 2 }),
    );
    // Counts clamp to a single digit, so all 10+ counts reuse the "9+" chip.
    assert.equal(
      DesktopStatusGlyphs.makeTaskbarOverlayChip({ kind: "running", count: 12 }),
      DesktopStatusGlyphs.makeTaskbarOverlayChip({ kind: "running", count: 99 }),
    );

    assert.deepEqual(
      runningTwo.representations.map((representation) => representation.scaleFactor),
      [1, 2],
    );
    for (const representation of runningTwo.representations) {
      const decoded = decodePng(representation.dataUrl);
      const expectedSize = DesktopStatusGlyphs.TASKBAR_OVERLAY_SIZE_PT * representation.scaleFactor;
      assert.equal(decoded.width, expectedSize);
      assert.equal(decoded.height, expectedSize);
    }

    const runningPng = decodePng(runningTwo.representations[1]?.dataUrl ?? "");
    // Corners stay transparent, the chip body carries the accent background,
    // and the digit renders in white.
    assert.equal(pixelAt(runningPng, 0, 0)[3], 0);
    const [red, green, blue, alpha] = pixelAt(runningPng, 6, 16);
    assert.equal(alpha, 255);
    assert.closeTo(red, 0x6e, 8);
    assert.closeTo(green, 0x94, 8);
    assert.closeTo(blue, 0xfa, 8);
    assert.isTrue(hasWhitePixel(runningPng));

    const completedOne = DesktopStatusGlyphs.makeTaskbarOverlayChip({
      kind: "completed",
      count: 1,
    });
    const completedThree = DesktopStatusGlyphs.makeTaskbarOverlayChip({
      kind: "completed",
      count: 3,
    });
    assert.notEqual(
      completedOne.representations[1]?.dataUrl,
      completedThree.representations[1]?.dataUrl,
    );
    const completedPng = decodePng(completedOne.representations[1]?.dataUrl ?? "");
    const [completedRed, completedGreen] = pixelAt(completedPng, 6, 16);
    assert.isAbove(completedGreen, completedRed, "completed chip is green");
    assert.isTrue(hasWhitePixel(completedPng));
  });
});
