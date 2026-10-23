import { RelayHookId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const WantedHooks = Schema.Array(
  Schema.Struct({ hookId: RelayHookId, keptHeaders: Schema.Array(Schema.String) }),
);

/**
 * The hooks this computer wants at the relay (migration 085). Every hook
 * call takes a fresh `revision`; `syncedRevision === revision` means the
 * relay is known to hold exactly `active`, anything less that it may not.
 */
export const RelayHookState = Schema.Struct({
  revision: Schema.Number,
  syncedRevision: Schema.Number,
  active: WantedHooks,
  /** The relay identity `active` was minted under. */
  mintedHostId: Schema.NullOr(Schema.String),
  /** The hook public key last sent to the relay. */
  publicKey: Schema.NullOr(Schema.String),
});
export type RelayHookState = typeof RelayHookState.Type;

export const EMPTY_RELAY_HOOK_STATE: RelayHookState = {
  revision: 0,
  syncedRevision: 0,
  active: [],
  mintedHostId: null,
  publicKey: null,
};

const RelayHookStateDbRow = Schema.Struct({
  ...RelayHookState.fields,
  active: Schema.fromJsonString(WantedHooks),
});
const encodeActive = Schema.encodeSync(Schema.fromJsonString(WantedHooks));

export class RelayHookStateRepositoryError extends Data.TaggedError(
  "RelayHookStateRepositoryError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface RelayHookStateRepositoryShape {
  readonly get: Effect.Effect<RelayHookState, RelayHookStateRepositoryError>;
  readonly save: (
    state: RelayHookState,
    now: string,
  ) => Effect.Effect<void, RelayHookStateRepositoryError>;
}

export class RelayHookStateRepository extends Context.Service<
  RelayHookStateRepository,
  RelayHookStateRepositoryShape
>()("threadlines/relay/RelayHookStateRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get: RelayHookStateRepositoryShape["get"] = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: RelayHookStateDbRow,
    execute: () => sql`
      SELECT
        revision AS "revision",
        synced_revision AS "syncedRevision",
        active_json AS "active",
        minted_host_id AS "mintedHostId",
        public_key AS "publicKey"
      FROM relay_hook_state WHERE id = 1
    `,
  })(undefined).pipe(
    Effect.map(Option.getOrElse(() => EMPTY_RELAY_HOOK_STATE)),
    Effect.mapError((cause) => new RelayHookStateRepositoryError({ operation: "get", cause })),
  );

  const save: RelayHookStateRepositoryShape["save"] = (state, now) => {
    const active = encodeActive(state.active);
    return sql`
      INSERT INTO relay_hook_state (
        id, revision, synced_revision, active_json, minted_host_id, public_key, updated_at
      ) VALUES (
        1, ${state.revision}, ${state.syncedRevision}, ${active}, ${state.mintedHostId},
        ${state.publicKey}, ${now}
      )
      ON CONFLICT(id) DO UPDATE SET
        revision = excluded.revision,
        synced_revision = excluded.synced_revision,
        active_json = excluded.active_json,
        minted_host_id = excluded.minted_host_id,
        public_key = excluded.public_key,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new RelayHookStateRepositoryError({ operation: "save", cause })),
    );
  };

  return RelayHookStateRepository.of({ get, save });
});

export const RelayHookStateRepositoryLive = Layer.effect(RelayHookStateRepository, make);
