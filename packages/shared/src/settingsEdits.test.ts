import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";

import {
  APP_PLACES,
  type EditControl,
  type EditValue,
  NO_MODEL,
  type PlaceId,
} from "./appPlaces.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  type CheckedEdit,
  checkEdits,
  composeServerPatch,
  describeEditValue,
} from "./settingsEdits.ts";

/** Every value a control takes at its edges: both switch states, every choice, the range ends and off. */
const valuesOf = (control: EditControl): ReadonlyArray<EditValue> => {
  switch (control.kind) {
    case "switch":
      return [true, false];
    case "choice":
      return Object.keys(control.options);
    case "count":
      return [control.min, control.max, ...(control.offAtZero === true ? [0] : [])];
    case "model":
      return [
        "codex/gpt-test",
        "gateway/vendor/model-with-a-slash",
        ...(control.noneLabel !== undefined ? [NO_MODEL] : []),
      ];
  }
};

/**
 * The dotted settings a patch touches, one level into nested settings unless
 * the place declares the whole setting as its leaf.
 */
const leavesOf = (patch: object, declared: ReadonlyArray<string>): ReadonlyArray<string> =>
  Object.entries(patch).flatMap(([key, value]) =>
    !declared.includes(key) &&
    typeof value === "object" &&
    value !== null &&
    !Duration.isDuration(value)
      ? Object.keys(value).map((leaf) => `${key}.${leaf}`)
      : [key],
  );

const editable = APP_PLACES.flatMap((place) =>
  "edit" in place && place.edit !== undefined ? [{ id: place.id as PlaceId, place }] : [],
);

describe("agents' settings changes", () => {
  it("never lets agents change what widens their reach", () => {
    expect(editable.length).toBeGreaterThan(0);
    for (const place of APP_PLACES) {
      if ("widensAgents" in place && place.widensAgents === true) {
        expect("edit" in place, place.id).toBe(false);
      }
    }
  });

  it("writes only its own settings, and reads back every value it writes", () => {
    for (const { id, place } of editable) {
      const edit = place.edit;
      if (!("leaves" in edit)) continue;
      for (const value of valuesOf(edit.control)) {
        if (edit.lands === "computer") {
          const patch = edit.patch(value);
          expect(leavesOf(patch, edit.leaves), id).toEqual(edit.leaves);
          expect(edit.read(applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch)), id).toBe(
            value,
          );
        } else {
          const patch = edit.patch(value);
          expect(leavesOf(patch, edit.leaves), id).toEqual(edit.leaves);
          const next: ClientSettings = { ...DEFAULT_CLIENT_SETTINGS, ...patch };
          expect(edit.read(next), id).toBe(value);
        }
      }
    }
  });

  it("refuses a whole request for one bad change, saying why", () => {
    const refused = (changes: Parameters<typeof checkEdits>[0]) => {
      const result = checkEdits(changes);
      return "refused" in result ? result.refused.reason : null;
    };
    expect(refused([])).toBe("count");
    expect(refused([{ place: "settings.nowhere", value: true }])).toBe("unknown");
    expect(refused([{ place: "threads.agentThreads", value: "auto" }])).toBe("user_only");
    expect(refused([{ place: "general.usageAnalytics", value: true }])).toBe("not_editable");
    expect(
      refused([
        { place: "general.theme", value: "light" },
        { place: "general.theme", value: "dark" },
      ]),
    ).toBe("duplicate");
    expect(refused([{ place: "general.terminalTextSize", value: 12.5 }])).toBe("bad_value");
    expect(refused([{ place: "sourceControl.writingStyle", value: "custom" }])).toBe("bad_value");
    expect(refused([{ place: "sourceControl.fetchInterval", value: 5 }])).toBe("bad_value");
    expect(
      refused([
        { place: "general.streamReplies", value: false },
        { place: "general.agentsPanel", value: "yes" },
      ]),
    ).toBe("bad_value");
    expect(refused([{ place: "sourceControl.fetchInterval", value: 0 }])).toBeNull();
    // "Another branch" needs a branch picked on the row; the writing model always has one.
    expect(refused([{ place: "threads.worktreesFrom", value: "named" }])).toBe("bad_value");
    expect(refused([{ place: "threads.writingModel", value: NO_MODEL }])).toBe("bad_value");
    expect(refused([{ place: "threads.agent", value: "no-model-named" }])).toBe("bad_value");
    expect(refused([{ place: "threads.agent", value: "codex/gpt-test" }])).toBeNull();
    expect(refused([{ place: "threads.agent", value: NO_MODEL }])).toBeNull();
    // Alerts need a phone or browser, these rows the desktop app: no card could be accepted.
    expect(
      refused([
        { place: "general.alertFailed", value: false },
        { place: "general.openLinksIn", value: "external" },
      ]),
    ).toBe("no_one_app");
  });

  it("writes two changes under one setting together, keeping the rest of it", () => {
    const checked = checkEdits([
      { place: "sourceControl.writingStyle", value: "conventional_commits" },
      { place: "sourceControl.followPrTemplates", value: false },
      { place: "general.theme", value: "light" },
    ]);
    if (!("edits" in checked)) throw new Error("refused");
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlWritingStyle: { mode: "custom", customInstructions: "Keep it short." },
    });
    const next = applyServerSettingsPatch(current, composeServerPatch(checked.edits));
    expect(next.sourceControlWritingStyle).toEqual({
      mode: "conventional_commits",
      customInstructions: "Keep it short.",
      followPrTemplates: false,
    });
  });

  it("words values as their rows do", () => {
    expect(describeEditValue("general.streamReplies", false)).toBe("Off");
    expect(describeEditValue("general.theme", "light")).toBe("Light");
    expect(describeEditValue("general.terminalTextSize", 14)).toBe("14 px");
    expect(describeEditValue("sourceControl.fetchInterval", 0)).toBe("Off");
    // A value agents can't pick still reads as its row shows it.
    expect(describeEditValue("sourceControl.writingStyle", "custom")).toBe("Custom instructions");
    expect(describeEditValue("threads.agent", NO_MODEL)).toBe("Last used");
    expect(describeEditValue("threads.agent", "codex/gpt-test")).toBe("gpt-test");
    // A size typed by hand reads as its dimensions, not as a choice.
    expect(describeEditValue("general.browserPageSize", "1000 × 700")).toBe("1000 × 700");
  });

  it("keeps a computer patch to computer changes", () => {
    const checked = checkEdits([
      { place: "general.streamReplies", value: false },
      { place: "general.terminalTextSize", value: 14 },
    ]);
    if (!("edits" in checked)) throw new Error("refused");
    const edits: ReadonlyArray<CheckedEdit> = checked.edits;
    expect(composeServerPatch(edits)).toEqual({ enableAssistantStreaming: false });
  });
});
