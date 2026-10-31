import { OutsideAgentConnectionId, ProjectId } from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  OutsideAgentConnectionRepository,
  OutsideAgentConnectionRepositoryLive,
  type OutsideAgentConnectionRow,
} from "./OutsideAgentConnectionRepository.ts";

const CONNECTION = OutsideAgentConnectionId.make("connection-1");
const WEB = ProjectId.make("project-web");

const row: OutsideAgentConnectionRow = {
  connectionId: CONNECTION,
  kind: "assistant",
  signIn: "oauth",
  clientIdHash: "hash",
  clientName: "Grok Bot",
  softwareId: null,
  redirectUri: "https://grok.example/callback",
  resource: "https://relay.example/mcp",
  access: "work",
  maxRuntimeMode: "approval-required",
  projectIds: [WEB],
  tokenGeneration: 1,
  identity: null,
  hostId: null,
  routeTag: null,
  refresh: null,
  keyHash: null,
  createdAt: "2026-10-30T10:00:00.000Z",
  lastUsedAt: null,
  removedAt: null,
  removedReason: null,
};

it.layer(OutsideAgentConnectionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "outside agent connections",
  (it) => {
    it.effect("stores Work so an older build reads Start, and its grant change drops Work", () =>
      Effect.gen(function* () {
        const repo = yield* OutsideAgentConnectionRepository;
        const sql = yield* SqlClient.SqlClient;
        const access = () =>
          repo.get(CONNECTION).pipe(Effect.map((found) => Option.getOrThrow(found).access));
        yield* repo.insertReplacing(row);
        // What an older build reads: the one column it knows.
        const stored = yield* sql<{ readonly access: string }>`
          SELECT access FROM outside_agent_connections WHERE connection_id = ${CONNECTION}
        `;
        assert.strictEqual(stored[0]?.access, "start");
        assert.strictEqual(yield* access(), "work");

        // This build's own change keeps Work.
        yield* repo.setGrant({
          connectionId: CONNECTION,
          grant: { access: "work", maxRuntimeMode: "auto", projectIds: [WEB] },
        });
        assert.strictEqual(yield* access(), "work");

        // An older build's Change (to See, then back to Start) writes only
        // the columns it knows: Work doesn't come back.
        yield* sql`UPDATE outside_agent_connections SET access = 'see' WHERE connection_id = ${CONNECTION}`;
        yield* sql`UPDATE outside_agent_connections SET access = 'start' WHERE connection_id = ${CONNECTION}`;
        assert.strictEqual(yield* access(), "start");
      }),
    );
  },
);
