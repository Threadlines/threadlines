import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { GitHubCliShape } from "./GitHubCli.ts";

const query = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest { id isInMergeQueue autoMergeRequest { enabledAt } }
  }
}`;

const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Struct({ ids: Schema.Array(Schema.String) }),
    }),
  ),
);
const decodeResponse = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        nodes: Schema.Array(
          Schema.NullOr(
            Schema.Struct({
              id: Schema.String,
              isInMergeQueue: Schema.Boolean,
              autoMergeRequest: Schema.NullOr(Schema.Struct({})),
            }),
          ),
        ),
      }),
    }),
  ),
);

/**
 * `gh pr list/view` omit queue membership. Read it in batches per host, together
 * with auto-merge so entering or leaving the queue uses one snapshot. A failed
 * lookup preserves the CLI result instead of hiding the pull requests.
 */
export function withGitHubMergeQueue<
  A extends {
    readonly id?: string;
    readonly url: string;
    readonly state?: string;
    readonly autoMergeEnabled?: boolean;
  },
>(
  execute: GitHubCliShape["execute"],
  cwd: string,
  rows: ReadonlyArray<A>,
): Effect.Effect<ReadonlyArray<A>> {
  return Effect.gen(function* () {
    const byHost = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.id || row.state !== "open") continue;
      const host = URL.parse(row.url)?.hostname;
      if (!host) continue;
      const ids = byHost.get(host) ?? new Set<string>();
      ids.add(row.id);
      byHost.set(host, ids);
    }
    const armed = new Map<string, boolean>();
    for (const [host, ids] of byHost) {
      const allIds = [...ids];
      for (let offset = 0; offset < allIds.length; offset += 100) {
        const nodes = yield* execute({
          cwd,
          args: ["api", "graphql", "--hostname", host, "--input", "-"],
          stdin: encodeRequest({ query, variables: { ids: allIds.slice(offset, offset + 100) } }),
        }).pipe(
          Effect.flatMap((output) => decodeResponse(output.stdout)),
          Effect.map((response) => response.data.nodes),
          Effect.catch(() => Effect.succeed([])),
        );
        for (const node of nodes) {
          if (node)
            armed.set(`${host}/${node.id}`, node.isInMergeQueue || node.autoMergeRequest !== null);
        }
      }
    }
    return rows.map((row) => {
      if (!row.id || row.state !== "open") return row;
      const autoMergeEnabled = armed.get(`${URL.parse(row.url)?.hostname}/${row.id}`);
      return autoMergeEnabled === undefined ? row : { ...row, autoMergeEnabled };
    });
  });
}
