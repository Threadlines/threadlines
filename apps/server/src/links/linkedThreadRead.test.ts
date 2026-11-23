import {
  type AgentThreadReadResult,
  EnvironmentId,
  type OrchestrationThreadShell,
  type PeerThreadReadInput,
  ThreadId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  type ComputerLinkClientShape,
  ComputerLinkUnavailableError,
} from "./ComputerLinkClient.ts";
import { makeLinkedThreadRead } from "./linkedThreadRead.ts";

const WINDOWS = EnvironmentId.make("env-windows");
const PARENT = ThreadId.make("parent");
const CHILD = ThreadId.make("child");

const ANSWER: AgentThreadReadResult = {
  outcome: "ok",
  messages: [
    {
      messageId: "m1",
      sequence: 4,
      at: "2026-11-23T10:00:00.000Z",
      role: "assistant",
      author: "Codex",
      origin: "agent",
      text: "Done.",
    },
  ],
  next: 4,
  more: false,
};

const parentShell = {
  id: PARENT,
  remoteChildren: [
    {
      environmentId: WINDOWS,
      label: "Windows PC",
      threadId: CHILD,
      handle: "Codex",
      title: "Fix the build",
      attachmentEpoch: 0,
      cachedStatus: "idle",
      updatedAt: "2026-11-23T10:00:00.000Z",
    },
  ],
} as unknown as OrchestrationThreadShell;

function makeRead(
  peer: (input: PeerThreadReadInput) => Effect.Effect<AgentThreadReadResult, never>,
) {
  const asked: PeerThreadReadInput[] = [];
  const client = {
    withPeer: (_environmentId, use) =>
      use({
        "peer.thread.read": (input: PeerThreadReadInput) => {
          asked.push(input);
          return peer(input);
        },
      } as never),
  } as Pick<ComputerLinkClientShape, "withPeer"> as ComputerLinkClientShape;
  const read = makeLinkedThreadRead({
    client,
    snapshots: {
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === PARENT ? Option.some(parentShell) : Option.none()),
    },
  });
  return { read, asked };
}

it.effect("reads a parent's child through the link, and only a child the parent holds", () =>
  Effect.gen(function* () {
    const { read, asked } = makeRead(() => Effect.succeed(ANSWER));
    const page = yield* read({
      parentThreadId: PARENT,
      environmentId: WINDOWS,
      threadId: CHILD,
      limit: 50,
    });
    assert.deepStrictEqual(page, ANSWER);
    assert.deepStrictEqual(asked, [{ threadId: CHILD, limit: 50 }]);

    const stranger = yield* Effect.flip(
      read({ parentThreadId: PARENT, environmentId: WINDOWS, threadId: ThreadId.make("other") }),
    );
    assert.strictEqual(stranger.detail, "That thread wasn't started from this computer.");
    assert.strictEqual(asked.length, 1);
  }),
);

it.effect("refuses one message an older computer answered with a page instead", () =>
  Effect.gen(function* () {
    const { read } = makeRead(() => Effect.succeed(ANSWER));
    const page = yield* read({
      parentThreadId: PARENT,
      environmentId: WINDOWS,
      threadId: CHILD,
      messageId: "m-asked",
      offset: 0,
    });
    assert.strictEqual(page.outcome, "refused");
    assert.deepStrictEqual(page.messages, []);
  }),
);

it.effect("says which computer can't be reached", () =>
  Effect.gen(function* () {
    const { read } = makeRead(
      () =>
        Effect.fail(
          new ComputerLinkUnavailableError({
            environmentId: WINDOWS,
            detail: "socket closed",
            revoked: false,
          }),
        ) as never,
    );
    const error = yield* Effect.flip(
      read({ parentThreadId: PARENT, environmentId: WINDOWS, threadId: CHILD }),
    );
    assert.strictEqual(error.detail, "Windows PC can't be reached right now.");
  }),
);
