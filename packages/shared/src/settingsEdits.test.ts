import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";

import { APP_PLACES, type EditControl, type EditValue, type PlaceId } from "./appPlaces.ts";
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
  }
};

/** The dotted settings a patch touches, one level into nested settings. */
const leavesOf = (patch: object): ReadonlyArray<string> =>
  Object.entries(patch).flatMap(([key, value]) =>
    typeof value === "object" && value !== null && !Duration.isDuration(value)
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
          expect(leavesOf(patch), id).toEqual(edit.leaves);
          expect(edit.read(applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch)), id).toBe(
            value,
          );
        } else {
          const patch = edit.patch(value);
          expect(leavesOf(patch), id).toEqual(edit.leaves);
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
