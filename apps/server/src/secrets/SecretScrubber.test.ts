import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  type OrchestrationSecretRequest,
  SecretRequestId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { readBackSecret } from "./SecretScrubber.ts";
import { threadKeyOf } from "./secretDestinations.ts";

const THREAD = ThreadId.make("thread-1");
const REQUEST = SecretRequestId.make("4f1c2e8a-0b7d-4c7e-9a1f-3d2b6c5e8f10");
let home: string;

beforeEach(() => {
  home = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "scrub-read-")));
});
afterEach(() => NodeFs.rmSync(home, { recursive: true, force: true }));

const request = (fields: Partial<OrchestrationSecretRequest>): OrchestrationSecretRequest => ({
  requestId: REQUEST,
  participantId: null,
  turnId: TurnId.make("turn-1"),
  name: "STRIPE_SECRET_KEY",
  reason: "Tests.",
  use: { kind: "commands" },
  replaces: false,
  status: "saved",
  createdAt: "2026-11-19T10:00:00.000Z",
  noted: true,
  ...fields,
});

const read = (entry: OrchestrationSecretRequest) =>
  Effect.runPromise(readBackSecret(NodePath.join(home, "agent-secrets"), THREAD, entry));

describe("reading saved keys back at startup", () => {
  it("reads a commands key's file while it exists, and nothing once it was removed", async () => {
    const folder = NodePath.join(home, "agent-secrets", threadKeyOf(THREAD), REQUEST);
    NodeFs.mkdirSync(folder, { recursive: true });
    NodeFs.writeFileSync(NodePath.join(folder, "value"), "sk_test_51HvQq2abc");
    expect(await read(request({}))).toBe("sk_test_51HvQq2abc");
    expect(await read(request({ removedAt: "2026-11-19T11:00:00.000Z" }))).toBeUndefined();
  });

  it("reads an env key unquoted, also when a crash left the request uncertain", async () => {
    NodeFs.writeFileSync(
      NodePath.join(home, ".env.local"),
      "A=1\nSTRIPE_SECRET_KEY='abc#123456'\n",
    );
    const env = { use: { kind: "env_file", path: ".env.local" }, parent: home } as const;
    expect(await read(request({ ...env }))).toBe("abc#123456");
    expect(await read(request({ ...env, status: "uncertain" }))).toBe("abc#123456");
    expect(await read(request({ ...env, status: "declined" }))).toBeUndefined();
    expect(await read(request({ ...env, name: "MISSING_KEY" }))).toBeUndefined();
  });
});
