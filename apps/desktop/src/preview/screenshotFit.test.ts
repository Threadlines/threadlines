import { describe, expect, it } from "vitest";

import {
  AGENT_SCREENSHOT_PNG_ENCODINGS,
  fitScreenshot,
  type ScreenshotEncoding,
} from "./screenshotFit.ts";

/**
 * A stand-in for the real encoders, sized the way a page behaves: a PNG of
 * `pngBytes` at full size, a JPEG that shrinks with quality, and both shrinking
 * with the area when the picture loses pixels. Records what it was asked for.
 */
const page = (pngBytes: number, jpegBytesPerQuality: number) => {
  const asked: ScreenshotEncoding[] = [];
  const sizeOf = (encoding: ScreenshotEncoding) => {
    const area = encoding.scale * encoding.scale;
    const bytes =
      encoding.mimeType === "image/png"
        ? pngBytes * area
        : encoding.quality * jpegBytesPerQuality * area;
    return Math.round(bytes);
  };
  const encode = (encoding: ScreenshotEncoding) => {
    asked.push(encoding);
    return new Uint8Array(sizeOf(encoding));
  };
  return { encode, asked, sizeOf };
};

describe("fitScreenshot", () => {
  it("keeps a page that fits as PNG lossless, at full size", () => {
    const text = page(150_000, 2_000);

    const fitted = fitScreenshot(text.encode, 700_000);

    expect(fitted).toMatchObject({ mimeType: "image/png", scale: 1 });
    expect(fitted.bytes.byteLength).toBe(150_000);
    // Nothing else was encoded: on a text page JPEG is wasted work.
    expect(text.asked).toHaveLength(1);
  });

  it("turns to JPEG at full size for a photo-heavy page PNG cannot hold", () => {
    // Close to the probe's photo gallery: 1.2 MB as PNG, 190 KB as JPEG 85.
    const photos = page(1_200_000, 2_250);

    const fitted = fitScreenshot(photos.encode, 700_000);

    expect(fitted.mimeType).toBe("image/jpeg");
    expect(fitted.scale).toBe(1);
    expect(fitted.bytes.byteLength).toBeLessThanOrEqual(700_000);
  });

  it("shrinks the picture only once quality alone cannot make it fit", () => {
    // A very large viewport: even JPEG 55 at full size is over the budget.
    const huge = page(9_000_000, 20_000);

    const fitted = fitScreenshot(huge.encode, 700_000);

    expect(fitted.mimeType).toBe("image/jpeg");
    expect(fitted.scale).toBeLessThan(1);
    expect(fitted.bytes.byteLength).toBeLessThanOrEqual(700_000);
  });

  it("gives up after a bounded number of tries with the smallest it made", () => {
    const impossible = page(90_000_000, 900_000);

    const fitted = fitScreenshot(impossible.encode, 700_000);

    expect(fitted.bytes.byteLength).toBe(Math.min(...impossible.asked.map(impossible.sizeOf)));
    // Every encoding is tried at most once: no loop that keeps shrinking.
    expect(new Set(impossible.asked).size).toBe(impossible.asked.length);
    expect(impossible.asked.length).toBeLessThanOrEqual(8);
  });

  it("never makes a JPEG for a server that would call it a PNG", () => {
    const photos = page(1_200_000, 2_250);

    const fitted = fitScreenshot(photos.encode, 700_000, AGENT_SCREENSHOT_PNG_ENCODINGS);

    expect(photos.asked.every((encoding) => encoding.mimeType === "image/png")).toBe(true);
    expect(fitted).toMatchObject({ mimeType: "image/png", scale: 0.75 });
  });
});
