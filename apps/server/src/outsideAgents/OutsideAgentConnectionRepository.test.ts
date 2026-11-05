import { EnvironmentId, OutsideAgentConnectionId, ProjectId } from "@threadlines/contracts";
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
  assistantPick: null,
  via: null,
  viaLinkDeviceId: null,
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

    it.effect(
      "keeps an agent from a linked computer apart, gone with its link, and never owed to the relay",
      () =>
        Effect.gen(function* () {
          const repo = yield* OutsideAgentConnectionRepository;
          const viaId = OutsideAgentConnectionId.make("connection-via");
          const there = OutsideAgentConnectionId.make("connection-on-mac");
          yield* repo.insertReplacing({
            ...row,
            connectionId: viaId,
            signIn: "linked",
            clientIdHash: "via:device-mac:connection-on-mac",
            resource: "linked",
            via: {
              environmentId: EnvironmentId.make("env-mac"),
              computer: "Mac",
              connectionId: there,
            },
            viaLinkDeviceId: "device-mac",
          });
          const found = yield* repo.findVia({ linkDeviceId: "device-mac", viaConnectionId: there });
          assert.deepStrictEqual(Option.getOrThrow(found).via, {
            environmentId: EnvironmentId.make("env-mac"),
            computer: "Mac",
            connectionId: there,
          });
          assert.deepStrictEqual(
            yield* repo.removeVia({ linkDeviceId: "device-mac", now: "2026-10-30T11:00:00.000Z" }),
            [viaId],
          );
          assert.isTrue(
            Option.isNone(
              yield* repo.findVia({ linkDeviceId: "device-mac", viaConnectionId: there }),
            ),
          );
          // An assistant's own row is owed to the relay once removed; this one never signed in there.
          assert.deepStrictEqual(yield* repo.pendingRevocations(10), []);
        }),
    );
  },
);
