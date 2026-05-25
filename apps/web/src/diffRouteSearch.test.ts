import { describe, expect, it } from "vitest";

import {
  parseDiffRouteSearch,
  stripDiffSearchParams,
  stripRightPanelSearchParams,
} from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("parses working tree diff mode and drops turn selection", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffMode: "workingTree",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffMode: "workingTree",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("keeps file value when the whole-thread diff is selected", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffFilePath: "src/app.ts",
    });
  });

  it("parses source control as a separate right panel mode", () => {
    expect(parseDiffRouteSearch({ sourceControl: "1" })).toEqual({
      sourceControl: "1",
    });
  });

  it("lets the diff panel win when source control is also present", () => {
    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffMode: "workingTree",
        sourceControl: "1",
        sourceControlReturn: "1",
      }),
    ).toEqual({
      diff: "1",
      diffMode: "workingTree",
      sourceControlReturn: "1",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });
});

describe("stripDiffSearchParams", () => {
  it("clears retained diff params explicitly", () => {
    expect(
      stripDiffSearchParams({
        diff: "1",
        diffMode: "workingTree",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        keep: "yes",
      }),
    ).toEqual({
      keep: "yes",
      diff: undefined,
      diffMode: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
    });
  });
});

describe("stripRightPanelSearchParams", () => {
  it("clears retained right-panel params explicitly", () => {
    expect(
      stripRightPanelSearchParams({
        diff: "1",
        diffMode: "workingTree",
        sourceControl: "1",
        sourceControlReturn: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        keep: "yes",
      }),
    ).toEqual({
      keep: "yes",
      diff: undefined,
      diffMode: undefined,
      sourceControl: undefined,
      sourceControlReturn: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
    });
  });
});
