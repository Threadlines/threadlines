import { OutsideAgentConnectionId, ProjectId, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OutsideAgentConnections } from "../outsideAgents/OutsideAgentConnections.ts";
import { mcpSessionRegistry } from "./McpSessionRegistry.ts";
import { makeOutsideToolLimits } from "./outsideToolLimit.ts";

const MARKED = ThreadId.make("thread-marked");
const QUIET = ThreadId.make("thread-quiet");
const GROK = OutsideAgentConnectionId.make("connection-grok");
const DOTS = OutsideAgentConnectionId.make("connection-dots");
const WEB = ProjectId.make("project-web");
const API = ProjectId.make("project-api");

const shells = new Map<string, object>([
  [
    MARKED,
    {
      id: MARKED,
      outsideWork: [
        {
          participantId: null,
          connections: [
            { connectionId: GROK, name: "Grok Bot" },
            { connectionId: DOTS, name: "dots" },
          ],
          since: "2026-10-30T10:00:00.000Z",
        },
      ],
    },
  ],
  [QUIET, { id: QUIET }],
]);
const ARCHIVED = ThreadId.make("thread-archived");
const archived = new Map<string, object>([
  [ARCHIVED, { id: ARCHIVED, outsideWork: shells.get(MARKED)!["outsideWork" as never] }],
]);

const limitsWith = (grants: Map<string, { projectIds: ReadonlyArray<ProjectId> | null } | null>) =>
  makeOutsideToolLimits.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectionSnapshotQuery, {
          getThreadShellById: (threadId: string) =>
            Effect.succeed(Option.fromNullishOr(shells.get(threadId))),
          // Archived threads: ARCHIVED only.
          getThreadDetailById: (threadId: string) =>
            Effect.succeed(Option.fromNullishOr(archived.get(threadId))),
        } as never),
        Layer.succeed(OutsideAgentConnections, {
          grant: (connectionId: string) => {
            const grant = grants.get(connectionId);
            return Effect.succeed(
              grant === undefined || grant === null
                ? null
                : { access: "work", maxRuntimeMode: "approval-required", ...grant },
            );
          },
        } as never),
      ),
    ),
  );

const scopeOf = (sessionKey: ThreadId, toolDirectory?: string) =>
  Effect.gen(function* () {
    const credential = yield* mcpSessionRegistry.credentialFor({
      sessionKey,
      browser: true,
      room: true,
      ...(toolDirectory !== undefined ? { toolDirectory } : {}),
    });
    const scope = yield* mcpSessionRegistry.resolve(credential.token);
    return { scope: scope!, revoke: mcpSessionRegistry.revoke(sessionKey, credential.generation) };
  });

describe("outside tool limits", () => {
  it("reads stay inside every marking grant; a removed connection leaves none", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const marked = yield* scopeOf(MARKED);
        const quiet = yield* scopeOf(QUIET);
        const archivedScope = yield* scopeOf(ARCHIVED);
        const both = yield* limitsWith(
          new Map([
            [GROK, { projectIds: [WEB, API] }],
            [DOTS, { projectIds: [WEB] }],
          ]),
        );
        const removed = yield* limitsWith(new Map([[GROK, { projectIds: null }]]));
        const out = {
          both: yield* both.forScope(marked.scope),
          removed: yield* removed.forScope(marked.scope),
          quiet: yield* both.forScope(quiet.scope),
          // Archived: its runtimes stop after, so it still counts until then.
          archived: yield* both.forScope(archivedScope.scope),
        };
        yield* marked.revoke;
        yield* quiet.revoke;
        yield* archivedScope.revoke;
        return out;
      }),
    );
    expect(result.both?.names).toEqual(["Grok Bot", "dots"]);
    expect([...(result.both?.projectIds ?? [])]).toEqual([WEB]);
    expect([...(result.removed?.projectIds ?? ["(all)"])]).toEqual([]);
    expect(result.quiet).toBeNull();
    expect(result.archived?.names).toEqual(["Grok Bot", "dots"]);
  });

  it("limits every session sharing an OpenCode folder with a marked agent", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const marked = yield* scopeOf(MARKED, "/repo/web");
        const neighbor = yield* scopeOf(QUIET, "/repo/web");
        const elsewhere = yield* scopeOf(ThreadId.make("thread-elsewhere"), "/repo/api");
        const limits = yield* limitsWith(
          new Map([
            [GROK, { projectIds: null }],
            [DOTS, { projectIds: null }],
          ]),
        );
        const out = {
          neighbor: yield* limits.forScope(neighbor.scope),
          elsewhere: yield* limits.forScope(elsewhere.scope),
        };
        yield* marked.revoke;
        yield* neighbor.revoke;
        yield* elsewhere.revoke;
        return out;
      }),
    );
    expect(result.neighbor?.names).toEqual(["Grok Bot", "dots"]);
    expect(result.neighbor?.projectIds).toBeNull();
    expect(result.elsewhere).toBeNull();
  });
});
