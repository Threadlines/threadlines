import { assert, it } from "@effect/vitest";

import { readInstalledPiCatalog } from "../../../scripts/generate-pi-model-catalog.ts";
import { PI_MODEL_CATALOG_VERSION, PI_PUBLIC_MODELS } from "./_generated/piModelCatalog.gen.ts";

it("keeps Pi's published model list in step with the installed Pi", async () => {
  const installed = await readInstalledPiCatalog();
  assert.isDefined(installed, "Pi isn't installed: run `vp install`.");
  assert.deepStrictEqual(
    { version: PI_MODEL_CATALOG_VERSION, slugs: [...PI_PUBLIC_MODELS] },
    { version: installed.version, slugs: [...installed.slugs] },
    "Pi was updated: run `node apps/server/scripts/generate-pi-model-catalog.ts`.",
  );
});
