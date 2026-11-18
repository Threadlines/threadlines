/**
 * The handler behind `secret_request` (secretRequestTools.ts): checks the
 * name, reason and use, binds an env file request to the real folders it
 * will write, and records a request on the caller's thread for its card
 * (docs/design/secret-requests.md, "The tool"). It never sees a value and
 * returns at once: the answer reaches the agent as a message.
 */
import {
  CommandId,
  type OrchestrationSecretRequest,
  type OrchestrationThread,
  SecretRequestId,
  type SecretRequestUse,
  type ThreadId,
} from "@threadlines/contracts";
import {
  secretNameProblem,
  secretReasonProblem,
  secretUseProblem,
} from "@threadlines/shared/secretRequests";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { derivedUuid } from "../orchestration/childRequestIds.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { SecretDestinations } from "../secrets/secretDestinations.ts";
import { dispatchOutcome } from "../threads/threadOperations.ts";
import { latchCallerTurn } from "./callerTurn.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { SECRET_REQUEST_TOOL_NAME } from "./roomToolAccess.ts";
import type { SecretRequestResult } from "./secretRequestTools.ts";

export interface SecretRequestToolDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  /** The folder the thread works in: its worktree, or its project's root. */
  readonly threadFolder: (thread: OrchestrationThread) => Effect.Effect<string | undefined>;
  readonly destinations: Pick<SecretDestinations, "checkEnvFile" | "commandsUnavailable">;
}

export const SECRET_REQUEST_ASKED =
  "The user was asked on a card. End your turn or go on with other work. A message arrives when they answer. Don't ask for the value in chat.";
const NOT_YOUR_TURN = "A key can only be asked for during your own turn.";
const SIDE =
  "Only an agent working on the thread can ask for a key. Mention it in your answer instead.";

/** The command id of a request: a provider's retry of the same call is the same command. */
export const secretRequestCommandId = (requestId: string) =>
  CommandId.make(`server:secret-request:${requestId}`);

/** How a recorded request stands, for a retry of the call that made it. */
function standing(request: OrchestrationSecretRequest): string {
  switch (request.status) {
    case "waiting":
    case "claimed":
      return SECRET_REQUEST_ASKED;
    case "saved":
      return `The user already saved ${request.name}.`;
    case "declined":
      return `The user already said no to ${request.name}.`;
    case "replaced":
      return "A newer request for the same key replaced this one.";
    default:
      return `This request already ended: ${request.detail ?? request.status}.`;
  }
}

/** The use as the agent gave it, normalized: the env path with forward slashes. */
const normalizedUse = (use: SecretRequestUse): SecretRequestUse =>
  use.kind === "env_file"
    ? { kind: "env_file", path: use.path.trim().replaceAll("\\", "/").replace(/^\.\//, "") }
    : use.multiline === true
      ? { kind: "commands", multiline: true }
      : { kind: "commands" };

export function makeSecretRequestToolHandler(deps: SecretRequestToolDeps) {
  return (
    scope: McpInvocationScope,
    input: { readonly name: string; readonly reason: string; readonly use: SecretRequestUse },
  ): Effect.Effect<SecretRequestResult> =>
    Effect.gen(function* () {
      if (scope.side !== undefined || !scope.roomTools.has(SECRET_REQUEST_TOOL_NAME)) {
        return { outcome: "not_allowed" as const, detail: SIDE };
      }
      const name = input.name.trim();
      const reason = input.reason.trim();
      const use = normalizedUse(input.use);
      const problem =
        secretNameProblem(name) ?? secretReasonProblem(reason) ?? secretUseProblem(use);
      if (problem !== null) return { outcome: "refused" as const, detail: problem };
      const latched = yield* latchCallerTurn(deps.readThread, scope);
      if ("gone" in latched) return { outcome: "refused" as const, detail: "This thread is gone." };
      if ("notYours" in latched) return { outcome: "not_allowed" as const, detail: NOT_YOUR_TURN };
      const { thread, turnId } = latched;
      if (thread.archivedAt !== null) {
        return { outcome: "refused" as const, detail: "This thread is archived." };
      }
      if ((thread.move ?? null) !== null) {
        return {
          outcome: "refused" as const,
          detail: "This thread is moving to another computer.",
        };
      }
      let bound: { folder?: string; parent?: string; replaces: boolean } = { replaces: false };
      if (use.kind === "env_file") {
        const folder = yield* deps.threadFolder(thread);
        if (folder === undefined) {
          return {
            outcome: "refused" as const,
            detail: "This thread's folder isn't on this computer.",
          };
        }
        const checked = yield* deps.destinations
          .checkEnvFile({ threadFolder: folder, path: use.path, name })
          .pipe(Effect.result);
        if (checked._tag === "Failure") {
          return { outcome: "refused" as const, detail: checked.failure.detail };
        }
        bound = checked.success;
      } else {
        const unavailable = yield* deps.destinations.commandsUnavailable;
        if (unavailable !== null) return { outcome: "refused" as const, detail: unavailable };
      }
      const participant = scope.participantId ?? null;
      const requestId = SecretRequestId.make(
        derivedUuid(
          String(scope.threadId),
          participant ?? "primary",
          String(turnId),
          SECRET_REQUEST_TOOL_NAME,
          JSON.stringify([name, reason, use]),
        ),
      );
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const dispatched = yield* deps.engine
        .dispatch({
          type: "thread.secret-request.request",
          commandId: secretRequestCommandId(requestId),
          threadId: scope.threadId,
          requestId,
          participantId: participant,
          turnId,
          name,
          reason,
          use,
          replaces: bound.replaces,
          ...(bound.folder !== undefined ? { folder: bound.folder } : {}),
          ...(bound.parent !== undefined ? { parent: bound.parent } : {}),
          createdAt: now,
        })
        .pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(dispatchOutcome(error))),
        );
      if (dispatched !== null) {
        return { outcome: "refused" as const, detail: dispatched.detail };
      }
      // The same call again (a provider's retry) dispatched nothing new: say how it stands.
      const recorded = (yield* deps.readThread(scope.threadId))?.secretRequests?.find(
        (request) => request.requestId === requestId,
      );
      return {
        outcome: "asked_user" as const,
        detail: recorded === undefined ? SECRET_REQUEST_ASKED : standing(recorded),
      };
    });
}
