import {
  type OrchestrationSecretRequest,
  SecretRequestId,
  SecretRequestRespondInput,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  dockedSecretRequest,
  secretAnswerEffect,
  secretAnswerRow,
  secretCardEndedNotice,
  secretCardPhase,
  secretRespondInput,
} from "./secretRequestCard.logic";

const request = (
  id: string,
  overrides: Partial<OrchestrationSecretRequest> = {},
): OrchestrationSecretRequest => ({
  requestId: SecretRequestId.make(id),
  participantId: null,
  turnId: TurnId.make("turn-1"),
  name: "STRIPE_SECRET_KEY",
  reason: "To run the checkout tests.",
  use: { kind: "env_file", path: ".env.local" },
  replaces: false,
  status: "waiting",
  createdAt: "2026-11-18T12:00:00.000Z",
  noted: false,
  ...overrides,
});

const encodeRespondInput = Schema.encodeSync(SecretRequestRespondInput);

const OWN = { claimId: "claim-own", deviceLabel: "Will's MacBook Pro" };
const PHONE = { claimId: "claim-phone", deviceLabel: "iPhone" };

describe("dockedSecretRequest", () => {
  it("shows the oldest open card and counts every open one, skipping settled ones", () => {
    const docked = dockedSecretRequest([
      request("saved", { status: "saved", settledAt: "2026-11-18T12:01:00.000Z" }),
      request("first"),
      request("second", { status: "claimed", claim: PHONE }),
    ]);
    expect(docked?.request.requestId).toBe("first");
    expect(docked).toMatchObject({ position: 1, count: 2 });
    expect(dockedSecretRequest([request("done", { status: "declined" })])).toBeNull();
    expect(dockedSecretRequest(undefined)).toBeNull();
  });
});

describe("secretCardPhase", () => {
  it("opens the field only while waiting, and names the app whose claim holds it", () => {
    expect(secretCardPhase(request("a"), null)).toEqual({ kind: "typing" });
    expect(secretCardPhase({ status: "claimed", claim: OWN }, OWN.claimId)).toEqual({
      kind: "saving",
    });
    expect(secretCardPhase({ status: "claimed", claim: PHONE }, OWN.claimId)).toEqual({
      kind: "elsewhere",
      deviceLabel: "iPhone",
    });
  });
});

describe("secretAnswerEffect", () => {
  it("keeps the field on a rejected value, with the reason under it", () => {
    expect(
      secretAnswerEffect(
        { outcome: "rejected", detail: "An env file can't hold this value as typed" },
        "STRIPE_SECRET_KEY",
      ),
    ).toEqual({ kind: "retry", detail: "An env file can't hold this value as typed." });
  });

  it("lets the card go quietly on saved and Not now, and says why on every other ending", () => {
    expect(secretAnswerEffect({ outcome: "saved" }, "KEY")).toEqual({ kind: "done" });
    expect(secretAnswerEffect({ outcome: "declined" }, "KEY")).toEqual({ kind: "done" });
    const titles = (
      [
        { outcome: "already_answered", by: "iPhone" },
        { outcome: "replaced" },
        { outcome: "cancelled", detail: "the thread was archived" },
        { outcome: "gone" },
        { outcome: "failed", detail: ".env.local is tracked by git now" },
      ] as const
    ).map((answer) => {
      const effect = secretAnswerEffect(answer, "KEY");
      return effect.kind === "ended" ? [effect.notice.title, effect.notice.description] : null;
    });
    expect(titles).toEqual([
      ["Answered on iPhone", "Nothing was sent from here."],
      ["The agent asked for KEY again", "Type it on the new card."],
      ["Request cancelled", "The thread was archived."],
      ["Request gone", "The agent's request for KEY isn't open anymore. Nothing was sent."],
      ["Couldn't save KEY", ".env.local is tracked by git now."],
    ]);
  });
});

describe("secretCardEndedNotice", () => {
  it("says nothing while the card still waits or this app's own claim holds it", () => {
    expect(secretCardEndedNotice(request("a"), "KEY", null)).toBeNull();
    expect(
      secretCardEndedNotice(request("a", { status: "saved", claim: OWN }), "KEY", OWN.claimId),
    ).toBeNull();
  });

  it("says why typed text went for each way a card ends elsewhere", () => {
    const title = (value: OrchestrationSecretRequest | undefined) =>
      secretCardEndedNotice(value, "KEY", OWN.claimId)?.title;
    expect(title(request("a", { status: "claimed", claim: PHONE }))).toBe("Answered on iPhone");
    expect(title(request("a", { status: "declined", claim: PHONE }))).toBe("Answered on iPhone");
    expect(title(request("a", { status: "replaced" }))).toBe("The agent asked for KEY again");
    expect(title(request("a", { status: "cancelled" }))).toBe("Request cancelled");
    expect(title(undefined)).toBe("Request gone");
  });
});

describe("secretRespondInput", () => {
  it("wraps the value so it never prints, and still encodes it for the wire", () => {
    const input = secretRespondInput({
      threadId: ThreadId.make("thread-1"),
      requestId: SecretRequestId.make("request-1"),
      claim: OWN,
      answer: { type: "save", value: "sk_test_canary" },
    });
    expect(JSON.stringify(input)).not.toContain("sk_test_canary");
    expect(String(input.answer.type === "save" ? input.answer.value : "")).not.toContain(
      "sk_test_canary",
    );
    expect(encodeRespondInput(input)).toEqual({
      threadId: "thread-1",
      requestId: "request-1",
      claimId: OWN.claimId,
      deviceLabel: OWN.deviceLabel,
      answer: { type: "save", value: "sk_test_canary" },
    });
  });
});

describe("secretAnswerRow", () => {
  it("says where a saved key went, and when a commands key's file goes", () => {
    expect(secretAnswerRow(request("env", { status: "saved" }))).toEqual({
      kind: "saved",
      name: "STRIPE_SECRET_KEY",
      where: "to .env.local",
      removal: null,
      removable: false,
    });
    const commands = request("commands", {
      use: { kind: "commands" },
      status: "saved",
      expiresAt: "2026-11-19T12:00:00.000Z",
    });
    expect(secretAnswerRow(commands)).toMatchObject({
      where: "for the agent's commands",
      removal: { kind: "at", iso: "2026-11-19T12:00:00.000Z" },
      removable: true,
    });
    expect(secretAnswerRow({ ...commands, removedAt: "2026-11-18T13:00:00.000Z" })).toMatchObject({
      removal: { kind: "removed" },
      removable: false,
    });
  });

  it("says why a save failed, and falls back when the request was pruned", () => {
    expect(
      secretAnswerRow(request("failed", { status: "failed", detail: "The file changed." })),
    ).toEqual({ kind: "failed", name: "STRIPE_SECRET_KEY", detail: "The file changed." });
    expect(secretAnswerRow(undefined)).toEqual({ kind: "unknown" });
  });
});
