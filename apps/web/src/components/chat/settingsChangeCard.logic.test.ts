import { describe, expect, it } from "vite-plus/test";

import {
  checkDeviceChanges,
  settingsChangeDeviceLabel,
  settingsChangeLines,
  settingsChangeNothingNotice,
  settingsChangeResultNotice,
} from "./settingsChangeCard.logic";

const request = {
  changes: [
    { place: "general.streamReplies", value: false, from: true },
    { place: "general.theme", value: "light" },
    { place: "general.timeFormat", value: "24-hour" },
  ],
};

describe("settingsChangeLines", () => {
  it("words each change as its row does, with computer values as asked and device values as now", () => {
    const lines = settingsChangeLines(request, (placeId) =>
      placeId === "general.theme" ? "dark" : "locale",
    );
    expect(lines.map(({ name, lands, from, to }) => ({ name, lands, from, to }))).toEqual([
      { name: "Stream replies", lands: "computer", from: "On", to: "Off" },
      { name: "Theme", lands: "device", from: "Dark", to: "Light" },
      { name: "Time format", lands: "device", from: "System default", to: "24-hour" },
    ]);
  });

  it("keeps a place this app doesn't know: the computer's when it carries a value as asked", () => {
    const [line] = settingsChangeLines(
      { changes: [{ place: "general.newerSwitch", value: true, from: false }] },
      () => undefined,
    );
    expect(line).toMatchObject({ placeId: null, lands: "computer", from: "Off", to: "On" });
  });
});

describe("checkDeviceChanges", () => {
  it("checks only the device changes, with this app's catalog", () => {
    const check = checkDeviceChanges(request);
    expect(check.kind).toBe("ready");
    expect(check.kind === "ready" ? check.edits.map((edit) => edit.place) : []).toEqual([
      "general.theme",
      "general.timeFormat",
    ]);
    // Only computer changes: nothing for this app to make.
    expect(checkDeviceChanges({ changes: [request.changes[0]!] })).toEqual({
      kind: "ready",
      edits: [],
    });
  });

  it("asks for an update when a device change is one this app can't make", () => {
    // A device place a newer app knows, and a value the row doesn't take.
    expect(
      checkDeviceChanges({ changes: [{ place: "general.newerSwitch", value: true }] }),
    ).toEqual({ kind: "update" });
    expect(checkDeviceChanges({ changes: [{ place: "general.theme", value: "sepia" }] })).toEqual({
      kind: "update",
    });
  });
});

describe("settingsChangeDeviceLabel", () => {
  it("names the desktop app by its computer, and a browser by what it is", () => {
    const browserLabel = "iPhone";
    expect(
      settingsChangeDeviceLabel({ desktopApp: true, thisComputerName: "Studio", browserLabel }),
    ).toBe("Studio");
    expect(
      settingsChangeDeviceLabel({ desktopApp: true, thisComputerName: null, browserLabel }),
    ).toBe("the desktop app");
    expect(
      settingsChangeDeviceLabel({ desktopApp: false, thisComputerName: "Studio", browserLabel }),
    ).toBe("iPhone");
  });
});

describe("settings change notices", () => {
  const lines = settingsChangeLines(request, () => "dark");

  it("doesn't claim the computer's settings stayed when it couldn't tell", () => {
    const notice = settingsChangeResultNotice({
      lines: lines.filter((line) => line.lands === "computer"),
      computer: { ending: "uncertain", detail: "Threadlines stopped while making the change." },
      device: null,
    });
    expect(notice.title).toMatch(/^Check this setting|^Check these settings/);
    expect(notice.description).toContain("Threadlines stopped while making the change.");
  });

  it("says what changed when everything did", () => {
    expect(
      settingsChangeResultNotice({
        lines,
        computer: { ending: "changed" },
        device: { applied: ["general.theme", "general.timeFormat"], failed: [] },
      }),
    ).toEqual({
      type: "success",
      title: "Settings changed",
      description: "Stream replies is now Off. Theme is now Light. Time format is now 24-hour.",
    });
  });

  it("says what didn't change, and why the computer's part didn't", () => {
    expect(
      settingsChangeResultNotice({
        lines,
        computer: {
          ending: "failed",
          detail: "Stream replies was changed to Off since the agent asked",
        },
        device: {
          applied: ["general.theme"],
          failed: [{ place: "general.timeFormat", detail: "Couldn't save it on this device" }],
        },
      }),
    ).toEqual({
      type: "warning",
      title: "Some settings didn't change",
      description:
        "Theme is now Light. Stream replies was changed to Off since the agent asked. Time format didn't change on this device.",
    });
  });

  it("says why an answer changed nothing here", () => {
    expect(settingsChangeNothingNotice({ outcome: "declined" })).toMatchObject({
      title: "Nothing changed",
    });
    expect(settingsChangeNothingNotice({ outcome: "already_answered" })).toMatchObject({
      title: "Already answered",
    });
    expect(
      settingsChangeNothingNotice({ outcome: "cancelled", detail: "the thread was archived" }),
    ).toMatchObject({ description: "The thread was archived. Nothing changed." });
  });
});
