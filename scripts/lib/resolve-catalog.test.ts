import { readFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";
import { parse as parseYaml } from "yaml";

import { resolveCatalogDependencies } from "./resolve-catalog.ts";

it("resolves every workspace override the release builds copy", () => {
  // The desktop artifact build and the server npm package both copy the
  // workspace overrides, so a key the resolver cannot read fails a release.
  const workspace = parseYaml(
    readFileSync(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8"),
  ) as { catalog: Record<string, string>; overrides: Record<string, string> };

  const overrides = resolveCatalogDependencies(
    workspace.overrides,
    workspace.catalog,
    "workspace overrides",
  );

  for (const [key, spec] of Object.entries(overrides)) {
    assert.isFalse(spec.startsWith("catalog:"), `override '${key}' is still '${spec}'`);
  }
});

it("resolves a bare catalog spec by the package a versioned key names", () => {
  assert.deepStrictEqual(
    resolveCatalogDependencies(
      { "vite@*": "catalog:", "@scope/pkg@^1": "catalog:", pinned: "1.0.0" },
      { vite: "npm:core@1.3.0", "@scope/pkg": "1.2.3" },
      "test",
    ),
    { "vite@*": "npm:core@1.3.0", "@scope/pkg@^1": "1.2.3", pinned: "1.0.0" },
  );
});
