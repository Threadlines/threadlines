import { spawnSync } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  type OrchestrationCommand,
  type OrchestrationSecretRequest,
  type OrchestrationThread,
  ProjectId,
  type SecretRequestError,
  SecretRequestId,
  type SecretRequestRespondInput,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { secretRequestStateOn } from "@threadlines/shared/secretRequestState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { make } from "./AgentSecretRequests.ts";
import { makeSecretDestinations, type RunGit, threadKeyOf } from "./secretDestinations.ts";

const THREAD = ThreadId.make("thread-secrets");
const REQUEST = SecretRequestId.make("4f1c2e8a-0b7d-4c7e-9a1f-3d2b6c5e8f10");
const AT = "2026-11-18T10:00:00.000Z";
/** A value no command, event or log may ever carry. */
const CANARY = "sk_test_CANARY_7f3a9c";

const runGit: RunGit = (cwd, args) =>
  Effect.sync(() => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return result.error === undefined
      ? { code: result.status, stdout: result.stdout, stderr: result.stderr }
      : null;
  });

let home: string;
let project: string;

beforeEach(() => {
  home = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "secret-answers-")));
  project = NodePath.join(home, "project");
  NodeFs.mkdirSync(project);
  spawnSync("git", ["-C", project, "init", "-q"]);
  NodeFs.writeFileSync(NodePath.join(project, ".gitignore"), ".env.local\n");
});

afterEach(() => {
  NodeFs.rmSync(home, { recursive: true, force: true });
});

const waiting = (use: OrchestrationSecretRequest["use"]): OrchestrationSecretRequest => ({
  requestId: REQUEST,
  participantId: null,
  turnId: TurnId.make("turn-1"),
  name: "STRIPE_SECRET_KEY",
  reason: "To run the checkout tests.",
  use,
  replaces: false,
  ...(use.kind === "env_file" ? { folder: project, parent: project } : {}),
  status: "waiting",
  createdAt: AT,
  noted: false,
});

const ENV = { kind: "env_file", path: ".env.local" } as const;
const COMMANDS = { kind: "commands" } as const;

const save = (
  claimId: string,
  value: string,
  deviceLabel = "iPhone",
): SecretRequestRespondInput => ({
  threadId: THREAD,
  requestId: REQUEST,
  claimId,
  deviceLabel,
  answer: { type: "save", value: Redacted.make(value) },
});

/**
 * The service over one thread's requests, an engine that keeps them the way
 * the decider and projections do (a command they'd refuse is refused), and
 * real destinations in a throwaway home. Every dispatched command is kept.
 */
function run<A>(
  requests: ReadonlyArray<OrchestrationSecretRequest>,
  body: (
    service: Effect.Success<ReturnType<typeof make>>,
    state: () => ReadonlyArray<OrchestrationSecretRequest>,
  ) => Effect.Effect<A, SecretRequestError>,
  options?: {
    readonly archivedAfterReads?: number;
    readonly archived?: boolean;
    readonly recoverySeesNothing?: boolean;
    readonly threadReadFails?: boolean;
  },
) {
  let state = requests;
  let reads = 0;
  const commands: OrchestrationCommand[] = [];
  const engine = Layer.mock(OrchestrationEngineService)({
    streamDomainEvents: Stream.empty,
    dispatch: (command) =>
      Effect.suspend(() => {
        commands.push(command);
        const before = state;
        const request = state.find(
          (entry) => "requestId" in command && entry.requestId === command.requestId,
        );
        if (command.type === "thread.secret-request.claim") {
          state = secretRequestStateOn.claimed(state, {
            threadId: THREAD,
            requestId: command.requestId,
            claim: command.claim,
            claimedAt: command.createdAt,
          });
        } else if (command.type === "thread.secret-request.settle") {
          const allowed =
            command.ending === "declined"
              ? request?.status === "waiting"
              : request?.status === "claimed" && request.claim?.claimId === command.claim.claimId;
          if (allowed) {
            state = secretRequestStateOn.settled(state, {
              threadId: THREAD,
              requestId: command.requestId,
              ending: command.ending,
              claim: command.claim,
              ...(command.detail !== undefined ? { detail: command.detail } : {}),
              ...(command.savedAt !== undefined ? { savedAt: command.savedAt } : {}),
              ...(command.expiresAt !== undefined ? { expiresAt: command.expiresAt } : {}),
              ...(command.message !== undefined ? { noted: true } : {}),
              settledAt: command.createdAt,
            });
          }
        } else if (command.type === "thread.secret-request.remove") {
          state = secretRequestStateOn.removed(state, {
            threadId: THREAD,
            requestId: command.requestId,
            removedAt: command.createdAt,
          });
        }
        return state === before
          ? Effect.fail({ _tag: "OrchestrationCommandInvariantError", message: "refused" } as never)
          : Effect.succeed({ sequence: 1 });
      }),
  });
  const threadNow = (): OrchestrationThread => {
    reads += 1;
    const archived =
      options?.archived === true ||
      (options?.archivedAfterReads !== undefined && reads > options.archivedAfterReads);
    return {
      id: THREAD,
      projectId: ProjectId.make("project-1"),
      worktreePath: project,
      deletedAt: null,
      archivedAt: archived ? AT : null,
      move: null,
      participants: [],
      secretRequests: state,
    } as unknown as OrchestrationThread;
  };
  const program = Effect.gen(function* () {
    const service = yield* make(
      {
        thread: () =>
          options?.threadReadFails === true ? Effect.succeed(undefined) : Effect.sync(threadNow),
        threadFolder: () => Effect.succeed(project),
        all: Effect.sync(() =>
          options?.recoverySeesNothing === true
            ? []
            : [{ threadId: THREAD, secretRequests: state }],
        ),
      },
      makeSecretDestinations({ agentSecretsDir: NodePath.join(home, "agent-secrets"), runGit }),
    );
    return yield* body(service, () => state);
  });
  return Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(engine))).then((result) => ({
    result,
    commands,
  }));
}

const envFile = () => NodePath.join(project, ".env.local");
const commandsFile = () =>
  NodePath.join(home, "agent-secrets", threadKeyOf(THREAD), REQUEST, "value");

describe("answering an agent's request for a key", () => {
  it("Save writes the env line, settles with the agent's message, and no command carries the value", async () => {
    const { result, commands } = await run([waiting(ENV)], (service, state) =>
      Effect.gen(function* () {
        const answer = yield* service.respond(save("claim-a", CANARY));
        return { answer, request: state()[0] };
      }),
    );
    expect(result.answer).toEqual({ outcome: "saved" });
    expect(NodeFs.readFileSync(envFile(), "utf8")).toBe(`STRIPE_SECRET_KEY=${CANARY}\n`);
    expect(result.request).toMatchObject({ status: "saved", noted: true });
    const settle = commands.find((command) => command.type === "thread.secret-request.settle");
    expect(settle).toMatchObject({
      message: {
        messageId: `secret-answer:${REQUEST}`,
        text: expect.stringContaining("I saved STRIPE_SECRET_KEY to .env.local"),
      },
    });
    expect(JSON.stringify(commands)).not.toContain(CANARY);
  });

  it("the first app to press Save wins; the second is told who answered and its value is dropped", async () => {
    const { result } = await run([waiting(ENV)], (service) =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.all(
          [
            service.respond(save("claim-a", "first_value", "iPhone")),
            service.respond(save("claim-b", "second_value", "Chrome on macOS")),
          ],
          { concurrency: "unbounded" },
        );
        return { first, second };
      }),
    );
    expect(result.first).toEqual({ outcome: "saved" });
    expect(result.second).toMatchObject({ outcome: "already_answered", by: "iPhone" });
    expect(NodeFs.readFileSync(envFile(), "utf8")).toBe("STRIPE_SECRET_KEY=first_value\n");
  });

  it("a value the env file can't hold is rejected with the card still waiting, and nothing is claimed", async () => {
    const { result, commands } = await run([waiting(ENV)], (service, state) =>
      Effect.gen(function* () {
        const answer = yield* service.respond(save("claim-a", "it's"));
        return { answer, status: state()[0]?.status };
      }),
    );
    expect(result.answer.outcome).toBe("rejected");
    expect(result.status).toBe("waiting");
    expect(commands).toEqual([]);
    expect(NodeFs.existsSync(envFile())).toBe(false);
  });

  it("a retry with the same claim gets the stored answer and writes nothing again", async () => {
    const { result } = await run([waiting(ENV)], (service) =>
      Effect.gen(function* () {
        yield* service.respond(save("claim-a", "first_value"));
        return yield* service.respond(save("claim-a", "different_value"));
      }),
    );
    expect(result).toEqual({ outcome: "saved" });
    expect(NodeFs.readFileSync(envFile(), "utf8")).toBe("STRIPE_SECRET_KEY=first_value\n");
  });

  it("Not now records its app: its retry says declined, another app's Save is told it was answered", async () => {
    const decline = {
      threadId: THREAD,
      requestId: REQUEST,
      claimId: "claim-a",
      deviceLabel: "iPhone",
      answer: { type: "decline" },
    } as const;
    const { result } = await run([waiting(ENV)], (service) =>
      Effect.gen(function* () {
        const first = yield* service.respond(decline);
        const retry = yield* service.respond(decline);
        const other = yield* service.respond(save("claim-b", "value"));
        return { first, retry, other };
      }),
    );
    expect(result.first).toEqual({ outcome: "declined" });
    expect(result.retry).toEqual({ outcome: "declined" });
    expect(result.other).toMatchObject({ outcome: "already_answered", by: "iPhone" });
    expect(NodeFs.existsSync(envFile())).toBe(false);
  });

  it("a key for commands lands in its private file, and Remove now takes it away", async () => {
    const { result, commands } = await run([waiting(COMMANDS)], (service, state) =>
      Effect.gen(function* () {
        const answer = yield* service.respond(save("claim-a", CANARY));
        const saved = state()[0];
        const contentBefore = NodeFs.readFileSync(commandsFile(), "utf8");
        yield* service.remove({ threadId: THREAD, requestId: REQUEST });
        return { answer, saved, contentBefore, after: state()[0] };
      }),
    );
    expect(result.answer).toEqual({ outcome: "saved" });
    expect(result.contentBefore).toBe(CANARY);
    expect(result.saved?.expiresAt).toBeDefined();
    expect(result.after?.removedAt).toBeDefined();
    expect(NodeFs.existsSync(commandsFile())).toBe(false);
    const settle = commands.find((command) => command.type === "thread.secret-request.settle");
    expect(settle?.type === "thread.secret-request.settle" && settle.message?.text).toContain(
      commandsFile(),
    );
    expect(JSON.stringify(commands)).not.toContain(CANARY);
  });

  it("a thread archived during the save removes what was written for commands and fails", async () => {
    // The first read finds the request; the read after the write sees it archived.
    const { result } = await run(
      [waiting(COMMANDS)],
      (service, state) =>
        Effect.gen(function* () {
          const answer = yield* service.respond(save("claim-a", "value"));
          return { answer, status: state()[0]?.status };
        }),
      { archivedAfterReads: 1 },
    );
    expect(result.answer).toMatchObject({ outcome: "failed" });
    expect(result.status).toBe("failed");
    expect(NodeFs.existsSync(commandsFile())).toBe(false);
  });

  it("a retry of this app's own unfinished claim settles without writing again", async () => {
    // A claim this run left unfinished, after startup recovery already ran.
    const claimed = {
      ...waiting(ENV),
      status: "claimed" as const,
      claim: { claimId: "claim-a", deviceLabel: "iPhone" },
    };
    NodeFs.writeFileSync(envFile(), "STRIPE_SECRET_KEY=landed\n");
    const { result } = await run(
      [claimed],
      (service, state) =>
        Effect.gen(function* () {
          const answer = yield* service.respond(save("claim-a", "different_value"));
          return { answer, status: state()[0]?.status };
        }),
      { recoverySeesNothing: true },
    );
    expect(result.answer.outcome).toBe("uncertain");
    expect(result.status).toBe("uncertain");
    expect(NodeFs.readFileSync(envFile(), "utf8")).toBe("STRIPE_SECRET_KEY=landed\n");
  });

  it("Remove now that can't remove the file says so, and the key stays live", async () => {
    const { result } = await run([waiting(COMMANDS)], (service, state) =>
      Effect.gen(function* () {
        yield* service.respond(save("claim-a", "value"));
        const threadFolder = NodePath.dirname(NodePath.dirname(commandsFile()));
        NodeFs.chmodSync(threadFolder, 0o500);
        const removed = yield* service
          .remove({ threadId: THREAD, requestId: REQUEST })
          .pipe(Effect.result);
        NodeFs.chmodSync(threadFolder, 0o700);
        return { removed, request: state()[0] };
      }),
    );
    expect(result.removed._tag).toBe("Failure");
    expect(result.request?.removedAt).toBeUndefined();
    expect(NodeFs.existsSync(commandsFile())).toBe(true);
  });

  it("at startup, a saved key of a thread archived while the server was down is removed", async () => {
    const saved: OrchestrationSecretRequest = {
      ...waiting(COMMANDS),
      status: "saved",
      claim: { claimId: "claim-a", deviceLabel: "iPhone" },
      savedAt: AT,
      expiresAt: "2099-01-01T00:00:00.000Z",
      noted: true,
    };
    const folder = NodePath.dirname(commandsFile());
    NodeFs.mkdirSync(folder, { recursive: true });
    NodeFs.writeFileSync(commandsFile(), "value");
    const orphan = NodePath.join(home, "agent-secrets", "0".repeat(32));
    NodeFs.mkdirSync(orphan);
    const { result } = await run(
      [saved],
      (service, state) =>
        Effect.gen(function* () {
          yield* service.respond(save("claim-z", "x")).pipe(Effect.ignore);
          return state()[0];
        }),
      { archived: true },
    );
    expect(result?.removedAt).toBeDefined();
    expect(NodeFs.existsSync(commandsFile())).toBe(false);
    expect(NodeFs.existsSync(orphan)).toBe(false);
  });

  it("at startup, a thread whose read fails keeps its live key", async () => {
    const saved: OrchestrationSecretRequest = {
      ...waiting(COMMANDS),
      status: "saved",
      claim: { claimId: "claim-a", deviceLabel: "iPhone" },
      savedAt: AT,
      expiresAt: "2099-01-01T00:00:00.000Z",
      noted: true,
    };
    NodeFs.mkdirSync(NodePath.dirname(commandsFile()), { recursive: true });
    NodeFs.writeFileSync(commandsFile(), "value");
    const { result } = await run(
      [saved],
      (service, state) =>
        Effect.gen(function* () {
          yield* service.respond(save("claim-z", "x")).pipe(Effect.ignore);
          return state()[0];
        }),
      { threadReadFails: true },
    );
    expect(result?.removedAt).toBeUndefined();
    expect(NodeFs.readFileSync(commandsFile(), "utf8")).toBe("value");
  });

  it("at startup, a claim a stopped run left mid-save settles without its value", async () => {
    const claim = { claimId: "claim-a", deviceLabel: "iPhone" };
    const envClaimed = { ...waiting(ENV), status: "claimed" as const, claim };
    const leftover = NodePath.join(project, `..env.local.${REQUEST}.tmp`);
    NodeFs.writeFileSync(leftover, "STRIPE_SECRET_KEY=half\n");
    const { result } = await run([envClaimed], (service, state) =>
      Effect.gen(function* () {
        // Any answer waits for recovery first.
        yield* service.respond(save("claim-z", "x")).pipe(Effect.ignore);
        return state()[0];
      }),
    );
    expect(result).toMatchObject({ status: "uncertain" });
    expect(result?.detail).toContain("may or may not be in .env.local");
    expect(NodeFs.existsSync(leftover)).toBe(false);
  });
});
