import type { ServerProvider } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkDeviceChanges,
  settingsChangeDeviceLabel,
  settingsChangeLines,
  settingsChangeNothingNotice,
  settingsChangeResultNotice,
} from "./settingsChangeCard.logic";

/** The desktop app, which has no phone alerts of its own. */
const DESKTOP = { desktopApp: true, alerts: "unsupported" } as const;
const PHONE_ALERTS_ON = { desktopApp: false, alerts: "on" } as const;
const PHONE_ALERTS_OFF = { desktopApp: false, alerts: "off" } as const;

const request = {
  changes: [
    { place: "general.streamReplies", value: false, from: true },
    { place: "appearance.theme", value: "light" },
    { place: "general.timeFormat", value: "24-hour" },
  ],
};

describe("settingsChangeLines", () => {
  it("words each change as its row does, with computer values as asked and device values as now", () => {
    const lines = settingsChangeLines(request, (placeId) =>
      placeId === "appearance.theme" ? "dark" : "locale",
    );
    expect(lines.map(({ name, lands, from, to }) => ({ name, lands, from, to }))).toEqual([
      { name: "Stream replies", lands: "computer", from: "On", to: "Off" },
      { name: "Theme", lands: "device", from: "Dark", to: "Light" },
      { name: "Time format", lands: "device", from: "System default", to: "24-hour" },
    ]);
  });

  it("names a model as its computer does, and an alert with what it's about", () => {
    const providers = [
      {
        instanceId: "claudeAgent",
        models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", shortName: "Opus 5.5" }],
      },
    ] as unknown as ReadonlyArray<ServerProvider>;
    const lines = settingsChangeLines(
      {
        changes: [
          { place: "threads.agent", value: "claudeAgent/claude-opus-5-5", from: "none" },
          {
            place: "threads.writingModel",
            value: "codex/gone",
            from: "claudeAgent/claude-opus-5-5",
          },
          { place: "general.alertFailed", value: false },
        ],
      },
      () => true,
      providers,
    );
    expect(lines.map(({ name, from, to }) => ({ name, from, to }))).toEqual([
      { name: "Agent", from: "Last used", to: "Opus 5.5" },
      { name: "Writing model", from: "Opus 5.5", to: "gone" },
      { name: "Alerts: Failed", from: "On", to: "Off" },
    ]);
  });

  it("says which account when a model moves to the same model on another one", () => {
    const account = (instanceId: string, displayName: string) => ({
      instanceId,
      displayName,
      auth: {},
      models: [{ slug: "gpt-test", name: "GPT Test" }],
    });
    const [line] = settingsChangeLines(
      {
        changes: [
          { place: "threads.agent", value: "codex-work/gpt-test", from: "codex-home/gpt-test" },
        ],
      },
      () => undefined,
      [
        account("codex-home", "Home"),
        account("codex-work", "Work"),
      ] as unknown as ReadonlyArray<ServerProvider>,
    );
    expect(line).toMatchObject({ from: "GPT Test (Home)", to: "GPT Test (Work)" });
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
    const check = checkDeviceChanges(request, DESKTOP);
    expect(check.kind).toBe("ready");
    expect(check.kind === "ready" ? check.edits.map((edit) => edit.place) : []).toEqual([
      "appearance.theme",
      "general.timeFormat",
    ]);
    // Only computer changes: nothing for this app to make.
    expect(checkDeviceChanges({ changes: [request.changes[0]!] }, DESKTOP)).toEqual({
      kind: "ready",
      edits: [],
    });
  });

  it("asks for an update when a device change is one this app can't make", () => {
    // A device place a newer app knows, and a value the row doesn't take.
    expect(
      checkDeviceChanges({ changes: [{ place: "general.newerSwitch", value: true }] }, DESKTOP),
    ).toEqual({ kind: "update" });
    // Themes go by name (any library's), so the value a theme row can't take is a non-name.
    expect(
      checkDeviceChanges({ changes: [{ place: "appearance.theme", value: true }] }, DESKTOP),
    ).toEqual({ kind: "update" });
  });

  it("waits for the app that can hold a change, saying which", () => {
    const links = { changes: [{ place: "general.openLinksIn", value: "external" }] };
    expect(checkDeviceChanges(links, DESKTOP).kind).toBe("ready");
    expect(checkDeviceChanges(links, PHONE_ALERTS_ON)).toMatchObject({
      kind: "elsewhere",
      note: expect.stringContaining("desktop app"),
    });

    const alerts = { changes: [{ place: "general.alertFinished", value: false }] };
    expect(checkDeviceChanges(alerts, PHONE_ALERTS_ON).kind).toBe("ready");
    expect(checkDeviceChanges(alerts, PHONE_ALERTS_OFF)).toMatchObject({
      kind: "elsewhere",
      note: expect.stringContaining("Turn on alerts"),
    });
    expect(checkDeviceChanges(alerts, DESKTOP)).toMatchObject({
      kind: "elsewhere",
      note: expect.stringContaining("on your phone or in a browser"),
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
        device: { applied: ["appearance.theme", "general.timeFormat"], failed: [] },
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
          applied: ["appearance.theme"],
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
