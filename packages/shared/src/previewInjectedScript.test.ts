import { describe, expect, it } from "vitest";

import {
  extractInjectedScript,
  INJECTED_SCRIPT_MODULE_PATH,
  INJECTED_SCRIPT_REQUIRED_MARKERS,
} from "./previewInjectedScript.ts";

/**
 * The extractor is the thing standing between a playwright-core upgrade and an
 * agent that silently cannot click. Every case here is a way that upgrade could
 * go wrong, made loud.
 */
const literal = (body: string) =>
  `// ${INJECTED_SCRIPT_MODULE_PATH}\nvar init = __esm({\n  "${INJECTED_SCRIPT_MODULE_PATH}"() {\n    "use strict";\n    source9 = '${body}';\n  }\n});`;

const plausible = () => `${INJECTED_SCRIPT_REQUIRED_MARKERS.join(" ")} ${"x".repeat(250_000)}`;

describe("extractInjectedScript", () => {
  it("finds the script by its module path rather than its variable name", () => {
    // The competitor we studied keys on `source3`, which is an esbuild module
    // counter. It moved to source4 and their targeting broke in the wild. The
    // number here is deliberately not one anybody would guess.
    const script = extractInjectedScript(literal(plausible()));

    expect(script).toContain("parseSelector");
    expect(script.length).toBeGreaterThan(200_000);
  });

  it("undoes the literal's escapes", () => {
    const script = extractInjectedScript(
      literal(`line\\none\\ttab \\u0041 \\'quote\\' ${plausible()}`),
    );

    expect(script).toContain("line\none\ttab A 'quote'");
  });

  it("refuses a module that is too small to be the injected script", () => {
    // How the competitor's bug would present: the right name, the wrong module.
    expect(() => extractInjectedScript(literal("parseSelector querySelector"))).toThrow(
      /expected at least/,
    );
  });

  it("refuses a script that has lost a capability we depend on", () => {
    const withoutAria = plausible().replace("ariaSnapshot", "somethingElse");

    expect(() => extractInjectedScript(literal(withoutAria))).toThrow(/missing ariaSnapshot/);
  });

  it("says so when the module is gone entirely", () => {
    expect(() => extractInjectedScript("var source1 = 'nothing to see';")).toThrow(
      /no module annotated/,
    );
  });

  it("says so when the literal never closes", () => {
    const truncated = literal(plausible()).replace(/';\n {2}}\n}\);$/, "");

    expect(() => extractInjectedScript(truncated)).toThrow(/unterminated/);
  });
});
