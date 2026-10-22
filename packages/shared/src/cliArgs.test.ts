import { describe, expect, it } from "vite-plus/test";

import { parseCliArgs } from "./cliArgs.ts";

describe("parseCliArgs", () => {
  it("returns empty result for whitespace-only string", () => {
    expect(parseCliArgs("   ")).toEqual({ flags: {}, positionals: [] });
  });

  it("returns empty result for empty array", () => {
    expect(parseCliArgs([])).toEqual({ flags: {}, positionals: [] });
  });

  it("parses --chrome --effort high --debug", () => {
    expect(parseCliArgs("--chrome --effort high --debug")).toEqual({
      flags: { chrome: null, effort: "high", debug: null },
      positionals: [],
    });
  });

  it("parses --key=value mixed with boolean flags", () => {
    expect(parseCliArgs("--chrome --model=claude-sonnet-4-6 --debug")).toEqual({
      flags: { chrome: null, model: "claude-sonnet-4-6", debug: null },
      positionals: [],
    });
  });

  it("collects positional arguments", () => {
    expect(parseCliArgs("1.2.3")).toEqual({
      flags: {},
      positionals: ["1.2.3"],
    });
  });

  it("collects positionals mixed with flags (argv array)", () => {
    expect(parseCliArgs(["1.2.3", "--root", "/path", "--github-output"])).toEqual({
      flags: { root: "/path", "github-output": null },
      positionals: ["1.2.3"],
    });
  });

  it("handles extra whitespace between tokens", () => {
    expect(parseCliArgs("  --chrome   --verbose  ")).toEqual({
      flags: { chrome: null, verbose: null },
      positionals: [],
    });
  });

  it("ignores bare -- with no flag name", () => {
    expect(parseCliArgs("--")).toEqual({ flags: {}, positionals: [] });
  });

  it("boolean flag does not consume next token as value", () => {
    expect(parseCliArgs(["--github-output", "1.2.3"], { booleanFlags: ["github-output"] })).toEqual(
      {
        flags: { "github-output": null },
        positionals: ["1.2.3"],
      },
    );
  });

  it("non-boolean flag still consumes next token", () => {
    expect(parseCliArgs(["--root", "/path", "1.2.3"], { booleanFlags: ["github-output"] })).toEqual(
      {
        flags: { root: "/path" },
        positionals: ["1.2.3"],
      },
    );
  });

  it("mixes boolean and value flags with positionals", () => {
    expect(
      parseCliArgs(["--github-output", "--root", "/path", "1.2.3"], {
        booleanFlags: ["github-output"],
      }),
    ).toEqual({
      flags: { "github-output": null, root: "/path" },
      positionals: ["1.2.3"],
    });
  });
});
