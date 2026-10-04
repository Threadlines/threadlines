import { describe, expect, it } from "vite-plus/test";

import {
  backgroundOutputFileFromText,
  backgroundOutputFilesInText,
  isBackgroundRunOutputPath,
} from "./backgroundRunOutput.ts";

describe("backgroundOutputFileFromText", () => {
  it("reads the output file off Claude's reply, spaces and all", () => {
    expect(
      backgroundOutputFileFromText(
        "Command running in background with ID: b1x2. Output is being written to: C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\claude\\s1\\tasks\\b1x2.output",
      ),
    ).toBe("C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\claude\\s1\\tasks\\b1x2.output");
    expect(backgroundOutputFileFromText("Ran 3 tests")).toBeNull();
    // A longer name is never cut short to a shorter file's name.
    expect(
      backgroundOutputFileFromText("Output is being written to: /tmp/tasks/b1.output.bak"),
    ).toBeNull();
    expect(backgroundOutputFileFromText("Output is being written to: /tmp/tasks/b1.output.")).toBe(
      "/tmp/tasks/b1.output",
    );
  });
});

describe("backgroundOutputFilesInText", () => {
  it("finds every announced file and stays fast on hostile text", () => {
    expect(
      backgroundOutputFilesInText(
        "Output is being written to: /tmp/tasks/a.output\nOutput is being written to:\t/tmp/tasks/b.output",
      ),
    ).toEqual(["/tmp/tasks/a.output", "/tmp/tasks/b.output"]);

    const hostile = `Output is being written to:${"\t".repeat(50_000)}x${".outputx".repeat(20_000)}`;
    const startedAt = performance.now();
    expect(backgroundOutputFilesInText(hostile.repeat(3))).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("isBackgroundRunOutputPath", () => {
  it("only accepts absolute tasks/<id>.output paths", () => {
    expect(isBackgroundRunOutputPath("/tmp/claude-502/repo/session/tasks/b1x2.output")).toBe(true);
    expect(isBackgroundRunOutputPath("C:\\Temp\\claude\\session\\tasks\\b1x2.output")).toBe(true);
    expect(isBackgroundRunOutputPath("tasks/b1x2.output")).toBe(false);
    // Drive-relative on Windows: not the file the reply named.
    expect(isBackgroundRunOutputPath("\\Temp\\tasks\\b1x2.output")).toBe(false);
    expect(isBackgroundRunOutputPath("/etc/passwd")).toBe(false);
    expect(isBackgroundRunOutputPath("/tmp/tasks/../tasks/b1x2.output")).toBe(false);
  });
});
