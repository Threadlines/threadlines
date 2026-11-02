import {
  type OrchestrationSettingsChangeRequest,
  SettingsChangeRequestId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SETTLED_SETTINGS_REQUESTS_KEPT,
  hasPendingSettingsChange,
  settingsChangeNotesFor,
  settingsChangeStateOn,
  shownSettingsChange,
} from "./settingsChangeState.ts";

const threadId = ThreadId.make("thread-1");
const reviewer = ThreadParticipantId.make("reviewer");
const at = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, "0")}:00.000Z`;

const request = (
  id: string,
  minute: number,
  participantId: ThreadParticipantId | null = null,
): OrchestrationSettingsChangeRequest => ({
  requestId: SettingsChangeRequestId.make(id),
  participantId,
  turnId: TurnId.make("turn-1"),
  changes: [{ place: "general.streamReplies", value: false, from: true }],
  status: "waiting",
  createdAt: at(minute),
  noted: false,
});

const claim = { claimId: "claim-a", deviceLabel: "iPhone" };

describe("settings change state", () => {
  it("replaces an agent's waiting card with its next one, and only that agent's", () => {
    let state = settingsChangeStateOn.requested([], request("a", 0));
    state = settingsChangeStateOn.requested(state, request("r", 1, reviewer));
    state = settingsChangeStateOn.requested(state, request("b", 2));
    expect(state.map((entry) => [entry.requestId, entry.status])).toEqual([
      ["a", "replaced"],
      ["r", "waiting"],
      ["b", "waiting"],
    ]);
    // The agent made the replacement, so it isn't told about it.
    expect(settingsChangeNotesFor(state, null)).toEqual([]);
    expect(shownSettingsChange(state)?.requestId).toBe("r");
  });

  it("moves only forward: claimed from waiting, endings from open, one device report", () => {
    const requestId = SettingsChangeRequestId.make("a");
    let state = settingsChangeStateOn.requested([], request("a", 0));
    state = settingsChangeStateOn.claimed(state, { threadId, requestId, claim, claimedAt: at(1) });
    expect(state[0]?.status).toBe("claimed");
    expect(hasPendingSettingsChange(state)).toBe(true);
    // A second claim, or a decline, can't take it from the first.
    const again = settingsChangeStateOn.claimed(state, {
      threadId,
      requestId,
      claim: { claimId: "claim-b", deviceLabel: "Mac" },
      claimedAt: at(2),
    });
    expect(again).toBe(state);
    state = settingsChangeStateOn.settled(state, {
      threadId,
      requestId,
      ending: "changed",
      settledAt: at(3),
    });
    expect(state[0]?.status).toBe("changed");
    expect(hasPendingSettingsChange(state)).toBe(false);
    expect(
      settingsChangeStateOn.settled(state, {
        threadId,
        requestId,
        ending: "cancelled",
        settledAt: at(4),
      }),
    ).toBe(state);
    const device = { applied: ["general.theme"], failed: [] };
    state = settingsChangeStateOn.deviceReported(state, {
      threadId,
      requestId,
      device,
      reportedAt: at(4),
    });
    expect(state[0]?.device).toEqual(device);
    expect(
      settingsChangeStateOn.deviceReported(state, {
        threadId,
        requestId,
        device: { applied: [], failed: [] },
        reportedAt: at(5),
      }),
    ).toBe(state);
    expect(settingsChangeNotesFor(state, null).map((entry) => entry.requestId)).toEqual(["a"]);
    state = settingsChangeStateOn.notesDelivered(state, {
      threadId,
      requestIds: [requestId],
      deliveredAt: at(6),
    });
    expect(settingsChangeNotesFor(state, null)).toEqual([]);
  });

  it("keeps every open card and only the newest settled ones", () => {
    let state = settingsChangeStateOn.requested([], request("open", 0, reviewer));
    for (let index = 0; index < SETTLED_SETTINGS_REQUESTS_KEPT + 3; index += 1) {
      const id = `done-${index}`;
      state = settingsChangeStateOn.requested(state, request(id, index + 1));
      state = settingsChangeStateOn.settled(state, {
        threadId,
        requestId: SettingsChangeRequestId.make(id),
        ending: "declined",
        settledAt: at(index + 1),
      });
    }
    expect(state.length).toBe(SETTLED_SETTINGS_REQUESTS_KEPT + 1);
    expect(state[0]?.requestId).toBe("open");
    expect(state.some((entry) => entry.requestId === "done-0")).toBe(false);
    expect(state.at(-1)?.requestId).toBe(`done-${SETTLED_SETTINGS_REQUESTS_KEPT + 2}`);
  });
});
