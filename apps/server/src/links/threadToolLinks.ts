/**
 * The thread tools' view of linked computers (docs/design/fleet.md, "Tools
 * (A)"): which computers there are, what each offers (its peer.describe,
 * reused for five minutes and refreshed on use), and reads of threads there.
 */
import type { AgentThreadReadResult, EnvironmentId } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ThreadToolComputer, ThreadToolLinks } from "../mcp/threadToolHandlers.ts";
import { resolveProjectPlace } from "../project/projectPlace.ts";
import type { RepositoryIdentityResolverShape } from "../project/Services/RepositoryIdentityResolver.ts";
import type { ComputerLinkClientShape } from "./ComputerLinkClient.ts";
import { type ComputerLinkRepositoryShape, isUsableLink } from "./ComputerLinkRepository.ts";

/**
 * A read of one message (`messageId`) as the linked computer answered it, or
 * `refused` when it ignored `messageId`: an older computer answers with a
 * page instead, whose one message may even be the one asked for, but clipped,
 * without the part's place in it.
 */
export function refuseIgnoredMessageRead(
  messageId: string | undefined,
  read: AgentThreadReadResult,
): AgentThreadReadResult {
  if (messageId === undefined || read.outcome !== "ok") return read;
  const only = read.messages.length === 1 ? read.messages[0]! : undefined;
  if (
    only !== undefined &&
    only.messageId === messageId &&
    (only.clipped !== true || only.offset !== undefined)
  ) {
    return read;
  }
  return {
    outcome: "refused",
    detail:
      "That computer's Threadlines is too old to read one message in full. Update it, then try again.",
    messages: [],
    next: null,
    more: false,
  };
}

/** How long thread_agents waits for a computer before listing it as last seen. */
const DESCRIBE_WAIT = Duration.seconds(4);

export function makeThreadToolLinks(input: {
  readonly client: ComputerLinkClientShape;
  readonly repo: ComputerLinkRepositoryShape;
  readonly identities: RepositoryIdentityResolverShape;
}): ThreadToolLinks {
  const { client, repo, identities } = input;
  const describe: ThreadToolLinks["describe"] = (environmentId) =>
    client
      .describe(environmentId)
      .pipe(Effect.catch((error) => Effect.succeed({ unavailable: error.message })));
  return {
    computers: Effect.gen(function* () {
      const rows = yield* repo.list.pipe(Effect.orElseSucceed(() => []));
      return yield* Effect.forEach(
        rows.filter(isUsableLink),
        (row) =>
          client.describe(row.remoteEnvironmentId).pipe(
            Effect.timeout(DESCRIBE_WAIT),
            Effect.option,
            Effect.map((described): ThreadToolComputer => ({
              environmentId: row.remoteEnvironmentId,
              label: Option.isSome(described) ? described.value.label : row.remoteLabel,
              deviceId: row.deviceId,
              reachable: Option.isSome(described),
              descriptor: Option.isSome(described)
                ? described.value
                : client.cachedDescribe(row.remoteEnvironmentId),
            })),
          ),
        { concurrency: "unbounded" },
      );
    }),
    describe,
    read: (environmentId: EnvironmentId, request) =>
      client
        .withPeer(environmentId, (peer) =>
          peer["peer.thread.read"]({
            threadId: request.threadId,
            ...(request.after !== undefined ? { after: request.after } : {}),
            ...(request.limit !== undefined ? { limit: request.limit } : {}),
            ...(request.messageId !== undefined ? { messageId: request.messageId } : {}),
            ...(request.offset !== undefined ? { offset: request.offset } : {}),
          }),
        )
        .pipe(
          Effect.map((read) => refuseIgnoredMessageRead(request.messageId, read)),
          Effect.catch((error) => Effect.succeed({ unavailable: error.message })),
        ),
    projectPlace: (workspaceRoot) => resolveProjectPlace(identities, workspaceRoot),
  };
}
