import { describe, expect, it } from "vite-plus/test";

import {
  BACKDROP_FRAME_CONTENT_SECURITY_POLICY,
  BACKDROP_FRAME_SANDBOX,
  buildBackdropFrameDocument,
} from "./backdropFrame.ts";
import { backdropTintMath } from "./backdropTint.ts";
import { colorBox, minimumGlassTint, relativeLuminance } from "./color.ts";

/** A seeded generator, so a failure names inputs that reproduce. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * A function's source evaluated where nothing it imported exists: what the
 * frame document does with it. A closed function survives this.
 */
const fromSource = <T>(fn: (...args: never[]) => unknown) =>
  // Evaluating the inlined source is the point.
  new Function(`"use strict"; return (${fn.toString()});`)() as T;

describe("backdrop tint math", () => {
  it("matches color.ts minimumGlassTint, inlined from source", () => {
    const math = fromSource<typeof backdropTintMath>(backdropTintMath)();
    const next = random(7);
    for (let round = 0; round < 400; round++) {
      const pick = () => ({ r: next(), g: next(), b: next() });
      const box = colorBox([pick(), pick(), pick()]);
      const tint = pick();
      const texts = Array.from({ length: 1 + Math.floor(next() * 6) }, () => ({
        color: pick(),
        ratio: next() > 0.8 ? 3 : 4.5,
      }));
      const floor = next() > 0.3 ? next() : 0;
      const expected = minimumGlassTint({ tint, box, texts, floor });
      const actual = math.minimumTint(
        tint,
        {
          minR: box.min.r,
          minG: box.min.g,
          minB: box.min.b,
          maxR: box.max.r,
          maxG: box.max.g,
          maxB: box.max.b,
        },
        texts.map((text) => ({ luminance: relativeLuminance(text.color), ratio: text.ratio })),
        floor,
      );
      expect(actual).toBe(expected);
    }
  });
});

describe("backdrop frame document", () => {
  it("carries the content policy and the runtime, and no theme content", () => {
    const html = buildBackdropFrameDocument();
    expect(BACKDROP_FRAME_SANDBOX).toBe("allow-scripts");
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${BACKDROP_FRAME_CONTENT_SECURITY_POLICY}">`,
    );
    expect(BACKDROP_FRAME_CONTENT_SECURITY_POLICY).toMatch(/^default-src 'none';/);
    // One script element: the runtime's.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain("RTCPeerConnection");
    expect(html).toContain('"testHooks":false');
    expect(buildBackdropFrameDocument({ testHooks: true })).toContain('"testHooks":true');
  });
});
