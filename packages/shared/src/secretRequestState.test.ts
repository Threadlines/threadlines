import {
  type OrchestrationSecretRequest,
  SecretRequestId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SETTLED_SECRET_REQUESTS_KEPT,
  hasPendingSecretRequest,
  secretRequestNotesFor,
  secretRequestStateOn,
} from "./secretRequestState.ts";

const threadId = ThreadId.make("thread-1");
const reviewer = ThreadParticipantId.make("reviewer");
const phone = { claimId: "claim-phone", deviceLabel: "iPhone" };
const at = (minute: number) =>
  `2026-11-02T${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
const id = (value: string) => SecretRequestId.make(value);

const request = (
  requestId: string,
  overrides: Partial<OrchestrationSecretRequest> = {},
): OrchestrationSecretRequest => ({
  requestId: id(requestId),
  participantId: null,
  turnId: TurnId.make("turn-1"),
  name: "STRIPE_SECRET_KEY",
  reason: "To run the checkout tests.",
  use: { kind: "env_file", path: ".env.local" },
  replaces: false,
  folder: "/repo",
  parent: "/repo",
  status: "waiting",
  createdAt: at(0),
  noted: false,
  ...overrides,
});

const create = (
  state: ReadonlyArray<OrchestrationSecretRequest>,
  entry: OrchestrationSecretRequest,
  replaces?: ReadonlyArray<string>,
) =>
  secretRequestStateOn.created(state, {
    threadId,
    request: entry,
    ...(replaces !== undefined ? { replaces: replaces.map(id) } : {}),
  });

const claim = (state: ReadonlyArray<OrchestrationSecretRequest>, requestId: string) =>
  secretRequestStateOn.claimed(state, {
    threadId,
    requestId: id(requestId),
    claim: phone,
    claimedAt: at(1),
  });

const settle = (
  state: ReadonlyArray<OrchestrationSecretRequest>,
  requestId: string,
  ending: "saved" | "failed" | "uncertain" | "declined" | "cancelled",
  extra: {
    readonly noted?: boolean;
    readonly settledAt?: string;
    readonly expiresAt?: string;
  } = {},
) =>
  secretRequestStateOn.settled(state, {
    threadId,
    requestId: id(requestId),
    ending,
    claim: phone,
    ...(ending === "saved" ? { savedAt: at(2) } : {}),
    ...(extra.expiresAt !== undefined ? { expiresAt: extra.expiresAt } : {}),
    ...(extra.noted !== undefined ? { noted: extra.noted } : {}),
    settledAt: extra.settledAt ?? at(2),
  });

const statuses = (state: ReadonlyArray<OrchestrationSecretRequest>) =>
  state.map((entry) => [entry.requestId, entry.status, entry.noted]);

describe("secret request state", () => {
  it("replaces the waiting requests a new one names, without a note, and ignores a repeat", () => {
    let state = create([], request("a"));
    state = create(state, request("b", { participantId: reviewer }));
    state = create(state, request("c", { createdAt: at(5) }), ["a", "b"]);
    expect(statuses(state)).toEqual([
      ["a", "replaced", true],
      ["b", "replaced", true],
      ["c", "waiting", false],
    ]);
    expect(state[0]?.settledAt).toBe(at(5));
    expect(create(state, request("c"))).toBe(state);
  });

  it("moves only forward: claimed from waiting, endings from open, never back to waiting", () => {
    let state = create([], request("a", { use: { kind: "commands" } }));
    // An ending before the claim (Not now) records the app that said it.
    const declined = settle(state, "a", "declined");
    expect(declined[0]).toMatchObject({ status: "declined", claim: phone, noted: false });
    expect(claim(declined, "a")).toBe(declined);

    state = claim(state, "a");
    expect(state[0]).toMatchObject({ status: "claimed", claim: phone });
    expect(hasPendingSecretRequest(state)).toBe(true);
    expect(claim(state, "a")).toBe(state);

    state = settle(state, "a", "saved", { expiresAt: at(30), noted: true });
    expect(state[0]).toMatchObject({
      status: "saved",
      savedAt: at(2),
      expiresAt: at(30),
      settledAt: at(2),
      noted: true,
    });
    expect(hasPendingSecretRequest(state)).toBe(false);
    expect(settle(state, "a", "cancelled")).toBe(state);
    expect(claim(state, "a")).toBe(state);
  });

  it("marks a file removed only for a saved key for commands, once", () => {
    const removed = (state: ReadonlyArray<OrchestrationSecretRequest>, requestId: string) =>
      secretRequestStateOn.removed(state, { threadId, requestId: id(requestId), removedAt: at(9) });
    let state = create([], request("env"));
    state = create(state, request("cmd", { name: "GH_TOKEN", use: { kind: "commands" } }));
    state = create(state, request("open", { name: "NPM_TOKEN", use: { kind: "commands" } }));
    for (const requestId of ["env", "cmd"]) {
      state = settle(claim(state, requestId), requestId, "saved");
    }
    expect(removed(state, "env")).toBe(state);
    expect(removed(state, "open")).toBe(state);
    state = removed(state, "cmd");
    expect(state[1]?.removedAt).toBe(at(9));
    expect(removed(state, "cmd")).toBe(state);
  });

  it("keeps whatever is still needed, and only the newest settled others", () => {
    let state = create([], request("waiting", { name: "A" }));
    state = create(state, request("claimed", { name: "B" }));
    state = claim(state, "claimed");
    state = create(state, request("live", { name: "C", use: { kind: "commands" } }));
    state = settle(claim(state, "live"), "live", "saved", { noted: true, settledAt: at(1) });
    state = create(state, request("owed", { name: "D" }));
    state = settle(state, "owed", "declined", { settledAt: at(1) });
    const extra = 3;
    for (let index = 0; index < SETTLED_SECRET_REQUESTS_KEPT + extra; index += 1) {
      const requestId = `done-${index}`;
      state = create(state, request(requestId, { name: `DONE_${index}` }));
      state = settle(state, requestId, "declined", { noted: true, settledAt: at(10 + index) });
    }
    const kept = state.map((entry) => entry.requestId);
    expect(kept.slice(0, 4)).toEqual(["waiting", "claimed", "live", "owed"]);
    expect(kept.slice(4)).toEqual(
      Array.from({ length: SETTLED_SECRET_REQUESTS_KEPT }, (_, index) => `done-${index + extra}`),
    );
  });

  it("owes a note for each settled request to the agent that asked, until it is delivered", () => {
    let state = create([], request("mine", { name: "A" }));
    state = create(state, request("theirs", { name: "B", participantId: reviewer }));
    state = create(state, request("told", { name: "C" }));
    state = create(state, request("open", { name: "D" }));
    state = settle(state, "mine", "declined");
    state = settle(state, "theirs", "cancelled");
    state = settle(claim(state, "told"), "told", "saved", { noted: true });
    const notes = (participantId: ThreadParticipantId | null) =>
      secretRequestNotesFor(state, participantId).map((entry) => entry.requestId);
    expect(notes(null)).toEqual(["mine"]);
    expect(notes(reviewer)).toEqual(["theirs"]);

    const delivered = secretRequestStateOn.notesDelivered(state, {
      threadId,
      requestIds: [id("mine"), id("open")],
      deliveredAt: at(5),
    });
    expect(secretRequestNotesFor(delivered, null)).toEqual([]);
    // A waiting request isn't marked: its note comes when it ends.
    expect(delivered.find((entry) => entry.requestId === "open")?.noted).toBe(false);
    expect(
      secretRequestStateOn.notesDelivered(delivered, {
        threadId,
        requestIds: [id("mine")],
        deliveredAt: at(6),
      }),
    ).toBe(delivered);
  });
});
