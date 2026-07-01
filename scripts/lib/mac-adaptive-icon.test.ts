import { assert, describe, it } from "@effect/vitest";

import { composeMacAdaptiveIconDocument } from "./mac-adaptive-icon.ts";

describe("mac-adaptive-icon", () => {
  it("swaps the artwork and plate fill per system appearance", () => {
    const document = composeMacAdaptiveIconDocument() as {
      readonly "fill-specializations": Array<{ appearance?: string; value: unknown }>;
      readonly groups: Array<{
        readonly layers: Array<{
          readonly glass: boolean;
          readonly "image-name-specializations": Array<{ appearance?: string; value: string }>;
        }>;
      }>;
      readonly "supported-platforms": unknown;
    };

    const fills = document["fill-specializations"];
    assert.equal(fills.length, 2);
    assert.equal(fills[0]?.appearance, undefined);
    assert.equal(fills[1]?.appearance, "dark");

    const layer = document.groups[0]?.layers[0];
    assert.equal(layer?.glass, false);
    assert.deepEqual(layer?.["image-name-specializations"], [
      { value: "light.png" },
      { appearance: "dark", value: "dark.png" },
    ]);

    assert.deepEqual(document["supported-platforms"], { squares: "shared" });
  });
});
