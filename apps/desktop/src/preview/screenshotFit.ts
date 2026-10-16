/**
 * How an agent's screenshot is encoded: the cheapest picture that still fits.
 *
 * Kept apart from the capture, with the encoding passed in, so the choice can
 * be tested without Electron. The capture side (`PreviewAutomation`) hands in
 * an encoder over the page at its CSS-pixel size.
 */

/**
 * What an agent's picture may weigh, in image bytes. Base64 adds a third on
 * the way to the server, which keeps it well inside the broker's screenshot
 * limit, and a photo-heavy page fits as JPEG at full size with room to spare.
 */
export const AGENT_SCREENSHOT_BUDGET_BYTES = 700_000;

export type ScreenshotMimeType = "image/png" | "image/jpeg";

/** One way to encode the page: a format, and a size as a fraction of its CSS pixels. */
export type ScreenshotEncoding =
  | { readonly mimeType: "image/png"; readonly scale: number }
  | { readonly mimeType: "image/jpeg"; readonly quality: number; readonly scale: number };

/**
 * Tried in order, and the first that fits wins. PNG first, because most pages
 * are text and flat colour, where it is lossless and small. Photos are where
 * PNG balloons, and JPEG is built for them. Only once quality has gone as far
 * as it usefully can does the picture lose pixels, since a smaller picture
 * hides small text, which is usually what the agent wanted to read.
 */
export const AGENT_SCREENSHOT_ENCODINGS: readonly [ScreenshotEncoding, ...ScreenshotEncoding[]] = [
  { mimeType: "image/png", scale: 1 },
  { mimeType: "image/jpeg", quality: 85, scale: 1 },
  { mimeType: "image/jpeg", quality: 70, scale: 1 },
  { mimeType: "image/jpeg", quality: 55, scale: 1 },
  { mimeType: "image/jpeg", quality: 55, scale: 0.75 },
  { mimeType: "image/jpeg", quality: 55, scale: 0.5 },
];

/**
 * The tries for a server that cannot be told a picture is a JPEG: an older
 * one labels every screenshot PNG, and a model refuses a JPEG called a PNG.
 * Fewer pixels is the only way left to make a large page fit.
 */
export const AGENT_SCREENSHOT_PNG_ENCODINGS: readonly [
  ScreenshotEncoding,
  ...ScreenshotEncoding[],
] = [
  { mimeType: "image/png", scale: 1 },
  { mimeType: "image/png", scale: 0.75 },
  { mimeType: "image/png", scale: 0.5 },
];

export interface FittedScreenshot {
  readonly mimeType: ScreenshotMimeType;
  readonly bytes: Uint8Array;
  /** Image pixels per CSS pixel. */
  readonly scale: number;
}

/**
 * The first of `encodings` that fits the budget, or the smallest of them when
 * none does: a bounded number of tries, never a loop, and the broker's own
 * limit refuses anything still absurd.
 */
export function fitScreenshot(
  encode: (encoding: ScreenshotEncoding) => Uint8Array,
  budgetBytes: number = AGENT_SCREENSHOT_BUDGET_BYTES,
  encodings: readonly [ScreenshotEncoding, ...ScreenshotEncoding[]] = AGENT_SCREENSHOT_ENCODINGS,
): FittedScreenshot {
  const attempt = (encoding: ScreenshotEncoding): FittedScreenshot => ({
    mimeType: encoding.mimeType,
    bytes: encode(encoding),
    scale: encoding.scale,
  });
  const [first, ...rest] = encodings;
  let smallest = attempt(first);
  if (smallest.bytes.byteLength <= budgetBytes) {
    return smallest;
  }
  for (const encoding of rest) {
    const candidate = attempt(encoding);
    if (candidate.bytes.byteLength <= budgetBytes) {
      return candidate;
    }
    if (candidate.bytes.byteLength < smallest.bytes.byteLength) {
      smallest = candidate;
    }
  }
  return smallest;
}
