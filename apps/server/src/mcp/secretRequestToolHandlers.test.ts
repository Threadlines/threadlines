import {
  type OrchestrationCommand,
  type OrchestrationThread,
  ProjectId,
  SideTurnId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { secretRequestStateOn } from "@threadlines/shared/secretRequestState";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { SecretDestinationError } from "../secrets/secretDestinations.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { roomToolsFor } from "./roomToolAccess.ts";
import { makeSecretRequestToolHandler, SECRET_REQUEST_ASKED } from "./secretRequestToolHandlers.ts";

const THREAD = ThreadId.make("thread-secrets");
const TURN = TurnId.make("turn-1");

const makeThread = (): OrchestrationThread =>
  ({
    id: THREAD,
    projectId: ProjectId.make("project-1"),
    worktreePath: "/work/project",
    session: { threadId: THREAD, status: "running", participantId: null, activeTurnId: TURN },
    archivedAt: null,
    deletedAt: null,
    move: null,
    secretRequests: [],
  }) as unknown as OrchestrationThread;

const mainCaller = (): McpInvocationScope => ({
  threadId: THREAD,
  sessionKey: THREAD,
  participantId: null,
  generation: 1,
  agentId: "agent-test",
  browser: true,
  pages: true,
  commands: false,
  roomTools: new Set(roomToolsFor(undefined)),
});

/** The tool over an engine that keeps receipts by command id and records requests as the decider would. */
function harness(check: "ok" | "untracked" = "ok") {
  let thread = makeThread();
  const dispatched: OrchestrationCommand[] = [];
  const receipts = new Set<string>();
  const handler = makeSecretRequestToolHandler({
    engine: {
      dispatch: (command) =>
        Effect.sync(() => {
          if (receipts.has(command.commandId)) return { sequence: 1 };
          receipts.add(command.commandId);
          dispatched.push(command);
          if (command.type === "thread.secret-request.request") {
            const { type: _type, commandId: _commandId, threadId, ...fields } = command;
            thread = {
              ...thread,
              secretRequests: secretRequestStateOn.created(thread.secretRequests ?? [], {
                threadId,
                request: { ...fields, status: "waiting", noted: false },
              }),
            };
          }
          return { sequence: 1 };
        }),
    },
    readThread: () => Effect.sync(() => thread),
    threadFolder: () => Effect.succeed("/work/project"),
    destinations: {
      checkEnvFile: () =>
        check === "ok"
          ? Effect.succeed({ folder: "/work/project", parent: "/work/project", replaces: true })
          : Effect.fail(
              new SecretDestinationError({
                detail:
                  ".env.local isn't ignored by git here. Add it to .gitignore, then ask again.",
              }),
            ),
      commandsUnavailable: Effect.succeed(null),
    },
  });
  return { handler, dispatched };
}

const ask = {
  name: "STRIPE_SECRET_KEY",
  reason: "To run the checkout tests against Stripe test mode.",
  use: { kind: "env_file", path: "./.env.local" },
} as const;

describe("secret_request", () => {
  it("puts a card bound to the env file's real folders on the thread, once per call", async () => {
    const { handler, dispatched } = harness();
    const first = await Effect.runPromise(handler(mainCaller(), ask));
    const retry = await Effect.runPromise(handler(mainCaller(), ask));

    expect(first).toEqual({ outcome: "asked_user", detail: SECRET_REQUEST_ASKED });
    expect(retry).toEqual(first);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.secret-request.request",
      name: "STRIPE_SECRET_KEY",
      use: { kind: "env_file", path: ".env.local" },
      replaces: true,
      folder: "/work/project",
      parent: "/work/project",
      turnId: TURN,
    });
  });

  it("refuses what the destination refuses, a template file and a browser-exposed name, before any card", async () => {
    const untracked = harness("untracked");
    expect(await Effect.runPromise(untracked.handler(mainCaller(), ask))).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining(".gitignore"),
    });

    const { handler, dispatched } = harness();
    const template = await Effect.runPromise(
      handler(mainCaller(), { ...ask, use: { kind: "env_file", path: ".env.example" } }),
    );
    const exposed = await Effect.runPromise(
      handler(mainCaller(), { ...ask, name: "VITE_API_KEY" }),
    );
    expect(template.outcome).toBe("refused");
    expect(exposed).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining("browsers"),
    });
    expect([...untracked.dispatched, ...dispatched]).toEqual([]);
  });

  it("is not for a side runtime", async () => {
    const { handler, dispatched } = harness();
    const side = await Effect.runPromise(
      handler(
        { ...mainCaller(), side: { kind: "ask", sideTurnId: SideTurnId.make("side-1") } },
        ask,
      ),
    );
    expect(side.outcome).toBe("not_allowed");
    expect(dispatched).toEqual([]);
  });
});
