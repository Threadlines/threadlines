import {
  type OrchestrationSettingsChangeRequest,
  SettingsChangeRequestId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { settingsChangeNote } from "./settingsChangeNotes.ts";

const ended = (
  patch: Partial<OrchestrationSettingsChangeRequest>,
): OrchestrationSettingsChangeRequest => ({
  requestId: SettingsChangeRequestId.make("request-1"),
  participantId: null,
  turnId: TurnId.make("turn-1"),
  changes: [
    { place: "general.streamReplies", value: false, from: true },
    { place: "appearance.theme", value: "light" },
  ],
  status: "changed",
  claim: { claimId: "claim-a", deviceLabel: "iPhone" },
  createdAt: "2026-11-02T10:00:00.000Z",
  noted: false,
  ...patch,
});

describe("the agent's note about its settings change", () => {
  it("says what changed where, and what the device reported", () => {
    expect(
      settingsChangeNote(ended({ device: { applied: ["appearance.theme"], failed: [] } })),
    ).toBe(
      "The user accepted your settings change. On this computer: Settings › General › Chat & diffs › Stream replies is now Off. On iPhone: Settings › Appearance › Themes › Theme is now Light.",
    );
  });

  it("doesn't claim a device change the app never confirmed", () => {
    expect(settingsChangeNote(ended({}))).toContain(
      "Their app on iPhone didn't confirm the change there (Settings › Appearance › Themes › Theme to Light).",
    );
  });

  it("says no plainly, and stays quiet about a card the agent replaced itself", () => {
    expect(settingsChangeNote(ended({ status: "declined", claim: undefined }))).toContain(
      "The user said no to your settings change",
    );
    expect(settingsChangeNote(ended({ status: "replaced" }))).toBeNull();
  });
});
