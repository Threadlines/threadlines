/**
 * The thread tools' view of linked computers (docs/design/fleet.md, "Tools
 * (A)"): which computers there are, what each offers (its peer.describe,
 * reused for five minutes and refreshed on use), and reads of threads there.
 */
import type { EnvironmentId } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ThreadToolComputer, ThreadToolLinks } from "../mcp/threadToolHandlers.ts";
import type { RepositoryIdentityResolverShape } from "../project/Services/RepositoryIdentityResolver.ts";
import type { ComputerLinkClientShape } from "./ComputerLinkClient.ts";
import type { ComputerLinkRepositoryShape } from "./ComputerLinkRepository.ts";

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
        rows.filter((row) => row.state !== "revoked"),
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
          }),
        )
        .pipe(Effect.catch((error) => Effect.succeed({ unavailable: error.message }))),
    projectKey: (workspaceRoot) =>
      identities
        .resolve(workspaceRoot)
        .pipe(Effect.map((identity) => identity?.canonicalKey ?? null)),
  };
}
