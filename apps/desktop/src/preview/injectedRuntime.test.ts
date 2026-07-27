import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { INJECTED_SCRIPT_REQUIRED_MARKERS } from "@threadlines/shared/previewInjectedScript";

import { buildInjectedRuntimeScript } from "./injectedRuntime.ts";

/**
 * These check the file on disk, so they live with the file. The extractor that
 * produced it is tested in @threadlines/shared, where it is shared with the
 * build scripts that run it.
 */
describe("the vendored copy", () => {
  const vendored = readFileSync(
    join(import.meta.dirname, "vendor", "playwrightInjected.js"),
    "utf8",
  );
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "vendor", "playwrightInjected.json"), "utf8"),
  ) as { bytes: number; playwrightCoreVersion: string };

  it("is the real injected script, with everything we ask of it", () => {
    // Cheap insurance that what got checked in is what the extractor thinks it
    // extracted -- a truncated or half-written file would pass every unit test
    // above and fail only in front of a user.
    expect(vendored.length).toBe(manifest.bytes);
    for (const marker of INJECTED_SCRIPT_REQUIRED_MARKERS) {
      expect(vendored).toContain(marker);
    }
  });

  it("is constructed with options this version of the engine reads", () => {
    // The gap the hash check cannot cover: an upgrade whose bytes legitimately
    // change AND that renames a constructor option. The script would extract
    // cleanly, pass every marker check, and then quietly ignore what we passed
    // it. Comparing what we send against what its constructor actually reads
    // catches that without needing a DOM to run in.
    const constructorStart = vendored.indexOf("var InjectedScript = class {");
    const nextMethod = /\n {2}[a-zA-Z_$][\w$]*\(/.exec(vendored.slice(constructorStart + 40));
    const constructorBody = vendored.slice(
      constructorStart,
      constructorStart + 40 + (nextMethod?.index ?? 0),
    );
    const read = new Set([...constructorBody.matchAll(/options\.(\w+)/g)].map((m) => m[1]));

    const wrapper = buildInjectedRuntimeScript("/* engine */");
    const passed = [...wrapper.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);

    expect(passed.length).toBeGreaterThan(0);
    expect(passed.filter((name) => !read.has(name))).toEqual([]);
  });

  it("evaluates to a constructible InjectedScript", () => {
    // Parsed, not just pattern-matched. A literal that decoded wrongly would
    // sail past a substring check and throw the first time a page ran it.
    expect(() => new Function(`${vendored}\nreturn typeof pwExport;`)).not.toThrow();
  });
});
