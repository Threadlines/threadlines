/**
 * Event tasks' storage (docs/design/event-tasks.md, "Storage"): each task's
 * address, its relay hooks and secret generations, the events it was sent
 * (the queue and the log in one table), the duplicate check's record, and
 * which thread each issue or pull request runs in. One computer's own, beside
 * ScheduledTaskRepository on the same database; `transact` puts writes of
 * both in one transaction.
 */
import {
  type ProjectId,
  RelayHookId,
  ScheduledTaskId,
  type ThreadId,
  ThreadId as ThreadIdSchema,
  type WebhookEventSource,
  type WebhookEventStatus,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

export class WebhookTaskRepositoryError extends Data.TaggedError("WebhookTaskRepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** An event task's address and its GitHub connection. */
export interface TaskWebhookRow {
  readonly taskId: ScheduledTaskId;
  /** The current relay hook; null while the task waits for the relay. */
  readonly hookId: RelayHookId | null;
  readonly relayUrl: string | null;
  /** The relay identity `hookId` was minted under. */
  readonly mintedHostId: string | null;
  /** The secret half of the task's address on this computer's own port. */
  readonly localToken: string;
  /** Headers its hook keeps beyond the always-kept ones. */
  readonly keptHeaders: ReadonlyArray<string>;
  /** The webhook Threadlines added on GitHub; null when not connected. */
  readonly githubHookId: string | null;
  readonly githubRepository: string | null;
  /** What GitHub has now: the address, events and secret generation it was given. */
  readonly githubHookUrl: string | null;
  readonly githubEvents: ReadonlyArray<string> | null;
  readonly githubSecretGeneration: number | null;
  readonly addressChanged: boolean;
  readonly lastEventAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The columns of a task's address that change after it is made. */
export type TaskWebhookUpdate = Partial<
  Pick<
    TaskWebhookRow,
    | "hookId"
    | "relayUrl"
    | "mintedHostId"
    | "localToken"
    | "keptHeaders"
    | "githubHookId"
    | "githubRepository"
    | "githubHookUrl"
    | "githubEvents"
    | "githubSecretGeneration"
    | "addressChanged"
  >
>;

const TASK_WEBHOOK_COLUMNS: { readonly [Key in keyof Required<TaskWebhookUpdate>]: string } = {
  hookId: "hook_id",
  relayUrl: "relay_url",
  mintedHostId: "minted_host_id",
  localToken: "local_token",
  keptHeaders: "kept_headers_json",
  githubHookId: "github_hook_id",
  githubRepository: "github_repository",
  githubHookUrl: "github_hook_url",
  githubEvents: "github_events_json",
  githubSecretGeneration: "github_secret_generation",
  addressChanged: "address_changed",
};

/** The GitHub connection's columns, all cleared: the task has no webhook on GitHub now. */
export const NO_GITHUB_CONNECTION: TaskWebhookUpdate = {
  githubHookId: null,
  githubRepository: null,
  githubHookUrl: null,
  githubEvents: null,
  githubSecretGeneration: null,
};

/** A webhook on GitHub that Threadlines has to remove and couldn't yet. */
export interface GitHubRemovalRow {
  readonly repository: string;
  readonly hookId: string;
  /** The task it was for (it may be deleted since). */
  readonly taskId: ScheduledTaskId;
  /** Why the last try failed, in one plain sentence. */
  readonly reason: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebhookSecretRow {
  readonly taskId: ScheduledTaskId;
  readonly generation: number;
  readonly createdAt: string;
  readonly retiredAt: string | null;
}

/** One event as stored: the queue's entry and the log's row. */
export interface WebhookEventRow {
  readonly eventId: string;
  readonly taskId: ScheduledTaskId;
  readonly receivedAt: string;
  readonly source: WebhookEventSource;
  readonly replayOf: string | null;
  readonly method: string;
  /** The query string without its `?`. */
  readonly query: string;
  /** The kept headers, names lowercase, as received. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** The body was cut to an excerpt (kept 7 days whole). */
  readonly bodyTruncated: boolean;
  readonly status: WebhookEventStatus;
  readonly reason: string | null;
  /** Its signature passed (or the task checks none); null until checked. */
  readonly verified: boolean | null;
  /** Its last pass checked a signature (true) or the task checked none (false); null until checked. */
  readonly signatureChecked: boolean | null;
  readonly eventName: string | null;
  readonly subject: string | null;
  readonly sender: string | null;
  readonly summary: string | null;
  /** The duplicate check's key, hashed. */
  readonly dedupeHash: string | null;
  readonly missingFields: ReadonlyArray<string>;
  /** The run it started or joined. */
  readonly runSlotUtc: string | null;
  /** That run's thread, when it has one. */
  readonly threadId: ThreadId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NewWebhookEvent = Omit<
  WebhookEventRow,
  | "status"
  | "reason"
  | "missingFields"
  | "runSlotUtc"
  | "threadId"
  | "createdAt"
  | "updatedAt"
  | "bodyTruncated"
>;

/** Which thread an issue or pull request runs in, for "same issue, same thread". */
export interface WebhookSubjectRow {
  readonly taskId: ScheduledTaskId;
  readonly subject: string;
  readonly projectId: ProjectId;
  /** Null while its first run (`reservedByRun`, a slot) starts the thread. */
  readonly threadId: ThreadId | null;
  readonly reservedByRun: string | null;
  readonly updatedAt: string;
}

/** Finished events are kept at least this long, so a delivery sent again always finds its row. */
export const WEBHOOK_EVENT_MIN_KEEP_MS = 48 * 60 * 60_000;
/** Past that, each task keeps its newest this many finished events... */
export const WEBHOOK_EVENT_KEEP_COUNT = 100;
/** ...and none older than this. */
export const WEBHOOK_EVENT_MAX_KEEP_MS = 14 * 24 * 60 * 60_000;
/** A finished event's body is cut to an excerpt after this; "Run with this event" ends with it. */
export const WEBHOOK_BODY_KEEP_MS = 7 * 24 * 60 * 60_000;
export const WEBHOOK_BODY_EXCERPT_BYTES = 16 * 1024;
/** The duplicate check remembers an event that ran this long. */
export const WEBHOOK_SEEN_KEEP_MS = 7 * 24 * 60 * 60_000;
/** A retired hook, or secret generation, is forgotten this long after retiring. */
export const WEBHOOK_RETIRED_KEEP_MS = 25 * 60 * 60_000;
/**
 * A retired secret generation is forgotten this long after retiring: an
 * event received up to 24 hours after (the grace it still verifies in) may
 * wait up to 24 hours more (the longest late limit) and is checked again
 * when it runs, so the secret outlives both, with an hour to spare.
 */
export const WEBHOOK_SECRET_KEEP_MS = 49 * 60 * 60_000;

interface TaskWebhookDbRow {
  readonly taskId: string;
  readonly hookId: string | null;
  readonly relayUrl: string | null;
  readonly mintedHostId: string | null;
  readonly localToken: string;
  readonly keptHeaders: string;
  readonly githubHookId: string | null;
  readonly githubRepository: string | null;
  readonly githubHookUrl: string | null;
  readonly githubEvents: string | null;
  readonly githubSecretGeneration: number | null;
  readonly addressChanged: number;
  readonly lastEventAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface WebhookEventDbRow {
  readonly eventId: string;
  readonly taskId: string;
  readonly receivedAt: string;
  readonly source: WebhookEventSource;
  readonly replayOf: string | null;
  readonly method: string;
  readonly query: string;
  readonly headers: string;
  readonly body: Uint8Array | string | null;
  readonly bodyTruncated: number;
  readonly status: WebhookEventStatus;
  readonly reason: string | null;
  readonly verified: number | null;
  readonly signatureChecked: number | null;
  readonly eventName: string | null;
  readonly subject: string | null;
  readonly sender: string | null;
  readonly summary: string | null;
  readonly dedupeHash: string | null;
  readonly missingFields: string | null;
  readonly runSlotUtc: string | null;
  readonly threadId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const stringArray = (json: string | null): ReadonlyArray<string> => {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
};

const headerRecord = (json: string): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[name] = value;
    }
    return out;
  } catch {
    return {};
  }
};

const toTaskWebhook = (row: TaskWebhookDbRow): TaskWebhookRow => ({
  taskId: ScheduledTaskId.make(row.taskId),
  hookId: row.hookId === null ? null : RelayHookId.make(row.hookId),
  relayUrl: row.relayUrl,
  mintedHostId: row.mintedHostId,
  localToken: row.localToken,
  keptHeaders: stringArray(row.keptHeaders),
  githubHookId: row.githubHookId,
  githubRepository: row.githubRepository,
  githubHookUrl: row.githubHookUrl,
  githubEvents: row.githubEvents === null ? null : stringArray(row.githubEvents),
  githubSecretGeneration:
    row.githubSecretGeneration === null ? null : Number(row.githubSecretGeneration),
  addressChanged: Number(row.addressChanged) !== 0,
  lastEventAt: row.lastEventAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const bodyBytes = (body: Uint8Array | string | null): Uint8Array =>
  body === null
    ? new Uint8Array(0)
    : typeof body === "string"
      ? new TextEncoder().encode(body)
      : Uint8Array.from(body);

const toEvent = (row: WebhookEventDbRow): WebhookEventRow => ({
  eventId: row.eventId,
  taskId: ScheduledTaskId.make(row.taskId),
  receivedAt: row.receivedAt,
  source: row.source,
  replayOf: row.replayOf,
  method: row.method,
  query: row.query,
  headers: headerRecord(row.headers),
  body: bodyBytes(row.body),
  bodyTruncated: Number(row.bodyTruncated) !== 0,
  status: row.status,
  reason: row.reason,
  verified: row.verified === null ? null : Number(row.verified) !== 0,
  signatureChecked: row.signatureChecked === null ? null : Number(row.signatureChecked) !== 0,
  eventName: row.eventName,
  subject: row.subject,
  sender: row.sender,
  summary: row.summary,
  dedupeHash: row.dedupeHash,
  missingFields: stringArray(row.missingFields),
  runSlotUtc: row.runSlotUtc,
  threadId: row.threadId === null ? null : ThreadIdSchema.make(row.threadId),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export interface WebhookTaskRepositoryShape {
  /** Runs `effect` in one transaction with any repository on this database. */
  readonly transact: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WebhookTaskRepositoryError, R>;

  // Addresses ---------------------------------------------------------------
  readonly listTaskWebhooks: Effect.Effect<
    ReadonlyArray<TaskWebhookRow>,
    WebhookTaskRepositoryError
  >;
  readonly getTaskWebhook: (
    taskId: ScheduledTaskId,
  ) => Effect.Effect<Option.Option<TaskWebhookRow>, WebhookTaskRepositoryError>;
  /** Writes a new event task's address whole; inside the task's own save. */
  readonly insertTaskWebhook: (
    row: TaskWebhookRow,
  ) => Effect.Effect<void, WebhookTaskRepositoryError>;
  /**
   * Writes only the given columns of a task's address, so a write never
   * puts back what another one changed since it read; with `where`, only
   * while those columns are still as it read them. True when it wrote.
   */
  readonly updateTaskWebhook: (input: {
    readonly taskId: ScheduledTaskId;
    readonly set: TaskWebhookUpdate;
    /** Only while these columns still hold these values. */
    readonly where?: Partial<Pick<TaskWebhookRow, "hookId" | "relayUrl" | "githubHookId">>;
    readonly now: string;
  }) => Effect.Effect<boolean, WebhookTaskRepositoryError>;
  /**
   * Forgets a task's address when it stops being an event task (or is
   * deleted): its hooks retire (their rows stay 25 hours) and its secret
   * generations retire. With `everything`, its events, duplicate record and
   * subjects go too. Returns the secret generations it had.
   */
  readonly forgetTask: (input: {
    readonly taskId: ScheduledTaskId;
    readonly everything: boolean;
    readonly now: string;
  }) => Effect.Effect<ReadonlyArray<WebhookSecretRow>, WebhookTaskRepositoryError>;

  // GitHub webhooks to remove ------------------------------------------------
  readonly listGitHubRemovals: Effect.Effect<
    ReadonlyArray<GitHubRemovalRow>,
    WebhookTaskRepositoryError
  >;
  /** Records (or updates the reason of) a webhook still to remove. */
  readonly putGitHubRemoval: (input: {
    readonly repository: string;
    readonly hookId: string;
    readonly taskId: ScheduledTaskId;
    readonly reason: string;
    readonly now: string;
  }) => Effect.Effect<void, WebhookTaskRepositoryError>;
  readonly deleteGitHubRemoval: (input: {
    readonly repository: string;
    readonly hookId: string;
  }) => Effect.Effect<void, WebhookTaskRepositoryError>;

  // Hooks -------------------------------------------------------------------
  readonly insertHook: (input: {
    readonly hookId: RelayHookId;
    readonly taskId: ScheduledTaskId;
    readonly now: string;
  }) => Effect.Effect<void, WebhookTaskRepositoryError>;
  /** Retires a task's hooks other than `keep`. */
  readonly retireHooks: (input: {
    readonly taskId: ScheduledTaskId;
    readonly keep: RelayHookId | null;
    readonly now: string;
  }) => Effect.Effect<void, WebhookTaskRepositoryError>;
  /** The task a hook (active, or retired under 25 hours ago) belongs to. */
  readonly hookTask: (
    hookId: string,
  ) => Effect.Effect<Option.Option<ScheduledTaskId>, WebhookTaskRepositoryError>;

  // Secrets -----------------------------------------------------------------
  readonly listSecrets: (
    taskId: ScheduledTaskId,
  ) => Effect.Effect<ReadonlyArray<WebhookSecretRow>, WebhookTaskRepositoryError>;
  /** Tasks with a signing secret not retired. */
  readonly tasksWithSecret: Effect.Effect<ReadonlySet<ScheduledTaskId>, WebhookTaskRepositoryError>;
  /** A new generation, numbered after the task's last one. */
  readonly insertSecret: (input: {
    readonly taskId: ScheduledTaskId;
    readonly now: string;
  }) => Effect.Effect<number, WebhookTaskRepositoryError>;
  /** Retires the task's generations below `below`. */
  readonly retireSecrets: (input: {
    readonly taskId: ScheduledTaskId;
    readonly below: number;
    readonly now: string;
  }) => Effect.Effect<void, WebhookTaskRepositoryError>;

  // Events ------------------------------------------------------------------
  /** Stores an event unless its id is stored already; true when it was new. */
  readonly insertEvent: (
    event: NewWebhookEvent & { readonly now: string },
  ) => Effect.Effect<boolean, WebhookTaskRepositoryError>;
  readonly getEvent: (
    eventId: string,
  ) => Effect.Effect<Option.Option<WebhookEventRow>, WebhookTaskRepositoryError>;
  /** A task's events still in the queue (received or waiting), in arrival order. */
  readonly listQueued: (
    taskId: ScheduledTaskId,
  ) => Effect.Effect<ReadonlyArray<WebhookEventRow>, WebhookTaskRepositoryError>;
  /** Tasks with an event in the queue; `waitingOnly` for those with one waiting. */
  readonly tasksWithQueued: (input: {
    readonly waitingOnly: boolean;
  }) => Effect.Effect<ReadonlyArray<ScheduledTaskId>, WebhookTaskRepositoryError>;
  /** A task's events, newest first; `before` (a receive time) pages back. */
  readonly listEvents: (input: {
    readonly taskId: ScheduledTaskId;
    readonly before?: string | undefined;
    /** With `before`: the previous page's last event; ties at its time after it come next. */
    readonly beforeEventId?: string | undefined;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<WebhookEventRow>, WebhookTaskRepositoryError>;
  /** Moves an event on; only while it is still in the queue. True when it changed. */
  readonly updateEvent: (input: {
    readonly eventId: string;
    readonly status: WebhookEventStatus;
    readonly reason: string | null;
    readonly verified?: boolean;
    readonly signatureChecked?: boolean;
    readonly missingFields?: ReadonlyArray<string>;
    readonly now: string;
  }) => Effect.Effect<boolean, WebhookTaskRepositoryError>;
  /** Marks the event a run was for failed, when the run couldn't start. */
  readonly failRunEvent: (input: {
    readonly taskId: ScheduledTaskId;
    readonly runSlotUtc: string;
    readonly reason: string;
    readonly now: string;
  }) => Effect.Effect<void, WebhookTaskRepositoryError>;
  readonly deleteEvent: (eventId: string) => Effect.Effect<void, WebhookTaskRepositoryError>;
  /** When each task's event log last changed (an event stored, or moved on). */
  readonly eventsChangedAt: Effect.Effect<
    ReadonlyMap<ScheduledTaskId, string>,
    WebhookTaskRepositoryError
  >;
  /** Events waiting for room, other than `except`. */
  readonly countWaiting: (input: {
    readonly taskId: ScheduledTaskId;
    readonly except: string;
  }) => Effect.Effect<number, WebhookTaskRepositoryError>;
  /** The task's last event time, for "GitHub connected" and the address panel. */
  readonly touchLastEvent: (input: {
    readonly taskId: ScheduledTaskId;
    readonly at: string;
  }) => Effect.Effect<void, WebhookTaskRepositoryError>;

  // Duplicates --------------------------------------------------------------
  /**
   * Whether an event with this key ran for the task since `since`, or
   * another one with it waits.
   */
  readonly isDuplicate: (input: {
    readonly taskId: ScheduledTaskId;
    readonly keyHash: string;
    readonly except: string;
    readonly since: string;
  }) => Effect.Effect<boolean, WebhookTaskRepositoryError>;

  // Subjects ----------------------------------------------------------------
  readonly getSubject: (input: {
    readonly taskId: ScheduledTaskId;
    readonly subject: string;
  }) => Effect.Effect<Option.Option<WebhookSubjectRow>, WebhookTaskRepositoryError>;
  /** The thread a reserving run started; true when the reservation was still open. */
  readonly fillSubjectThread: (input: {
    readonly taskId: ScheduledTaskId;
    readonly runSlotUtc: string;
    readonly threadId: ThreadId;
    readonly now: string;
  }) => Effect.Effect<boolean, WebhookTaskRepositoryError>;
  /** Releases a reservation whose run never made its thread; true when there was one. */
  readonly releaseSubject: (input: {
    readonly taskId: ScheduledTaskId;
    readonly runSlotUtc: string;
  }) => Effect.Effect<boolean, WebhookTaskRepositoryError>;

  // Retention ---------------------------------------------------------------
  /**
   * Forgets what event tasks no longer need: finished events past the log's
   * limits, old bodies cut to an excerpt, old duplicate records, hooks
   * retired over 25 hours ago. Returns secret generations retired over 49
   * hours ago, deleted here, whose stored secrets go too.
   */
  readonly prune: (
    now: number,
  ) => Effect.Effect<ReadonlyArray<WebhookSecretRow>, WebhookTaskRepositoryError>;
}

export class WebhookTaskRepository extends Context.Service<
  WebhookTaskRepository,
  WebhookTaskRepositoryShape
>()("threadlines/scheduled/WebhookTaskRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new WebhookTaskRepositoryError({ operation, cause })));

  const transact: WebhookTaskRepositoryShape["transact"] = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) =>
          SqlError.isSqlError(error)
            ? new WebhookTaskRepositoryError({ operation: "transact", cause: error })
            : error,
        ),
      );

  const selectTaskWebhook = `
    SELECT
      task_id AS "taskId",
      hook_id AS "hookId",
      relay_url AS "relayUrl",
      minted_host_id AS "mintedHostId",
      local_token AS "localToken",
      kept_headers_json AS "keptHeaders",
      github_hook_id AS "githubHookId",
      github_repository AS "githubRepository",
      github_hook_url AS "githubHookUrl",
      github_events_json AS "githubEvents",
      github_secret_generation AS "githubSecretGeneration",
      address_changed AS "addressChanged",
      last_event_at AS "lastEventAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM scheduled_task_webhooks
  `;

  const listTaskWebhooks: WebhookTaskRepositoryShape["listTaskWebhooks"] = sql
    .unsafe<TaskWebhookDbRow>(`${selectTaskWebhook} ORDER BY created_at, task_id`)
    .pipe(
      Effect.map((rows) => rows.map(toTaskWebhook)),
      wrap("listTaskWebhooks"),
    );

  const getTaskWebhook: WebhookTaskRepositoryShape["getTaskWebhook"] = (taskId) =>
    sql.unsafe<TaskWebhookDbRow>(`${selectTaskWebhook} WHERE task_id = ?`, [taskId]).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toTaskWebhook))),
      wrap("getTaskWebhook"),
    );

  const updateTaskWebhook: WebhookTaskRepositoryShape["updateTaskWebhook"] = (input) =>
    Effect.gen(function* () {
      const sets: Array<string> = ["updated_at = ?"];
      const values: Array<string | number | null> = [input.now];
      for (const key of Object.keys(TASK_WEBHOOK_COLUMNS) as Array<keyof TaskWebhookUpdate>) {
        const value = input.set[key];
        if (value === undefined) continue;
        sets.push(`${TASK_WEBHOOK_COLUMNS[key]} = ?`);
        values.push(
          value === null
            ? null
            : typeof value === "boolean"
              ? value
                ? 1
                : 0
              : typeof value === "string" || typeof value === "number"
                ? value
                : JSON.stringify(value),
        );
      }
      const guards: Array<string> = [];
      const guardValues: Array<string> = [];
      for (const key of ["hookId", "relayUrl", "githubHookId"] as const) {
        const expected = input.where?.[key];
        if (expected === undefined) continue;
        if (expected === null) {
          guards.push(` AND ${TASK_WEBHOOK_COLUMNS[key]} IS NULL`);
        } else {
          guards.push(` AND ${TASK_WEBHOOK_COLUMNS[key]} = ?`);
          guardValues.push(expected);
        }
      }
      const rows = yield* sql.unsafe<{ readonly taskId: string }>(
        `UPDATE scheduled_task_webhooks SET ${sets.join(", ")}
         WHERE task_id = ?${guards.join("")}
         RETURNING task_id AS "taskId"`,
        [...values, input.taskId, ...guardValues],
      );
      return rows.length > 0;
    }).pipe(wrap("updateTaskWebhook"));

  const insertTaskWebhook: WebhookTaskRepositoryShape["insertTaskWebhook"] = (row) =>
    sql`
      INSERT INTO scheduled_task_webhooks (
        task_id, hook_id, relay_url, minted_host_id, local_token, kept_headers_json,
        github_hook_id, github_repository, github_hook_url, github_events_json,
        github_secret_generation, address_changed, last_event_at, created_at, updated_at
      ) VALUES (
        ${row.taskId}, ${row.hookId}, ${row.relayUrl}, ${row.mintedHostId}, ${row.localToken},
        ${JSON.stringify(row.keptHeaders)}, ${row.githubHookId}, ${row.githubRepository},
        ${row.githubHookUrl},
        ${row.githubEvents === null ? null : JSON.stringify(row.githubEvents)},
        ${row.githubSecretGeneration}, ${row.addressChanged ? 1 : 0}, ${row.lastEventAt},
        ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT(task_id) DO UPDATE SET
        hook_id = excluded.hook_id,
        relay_url = excluded.relay_url,
        minted_host_id = excluded.minted_host_id,
        local_token = excluded.local_token,
        kept_headers_json = excluded.kept_headers_json,
        github_hook_id = excluded.github_hook_id,
        github_repository = excluded.github_repository,
        github_hook_url = excluded.github_hook_url,
        github_events_json = excluded.github_events_json,
        github_secret_generation = excluded.github_secret_generation,
        address_changed = excluded.address_changed,
        last_event_at = excluded.last_event_at,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, wrap("insertTaskWebhook"));

  const selectSecrets = (where: string, params: ReadonlyArray<string>) =>
    sql
      .unsafe<{
        readonly taskId: string;
        readonly generation: number;
        readonly createdAt: string;
        readonly retiredAt: string | null;
      }>(
        `SELECT task_id AS "taskId", generation AS "generation", created_at AS "createdAt",
           retired_at AS "retiredAt"
         FROM webhook_secrets ${where}`,
        [...params],
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row): WebhookSecretRow => ({
            taskId: ScheduledTaskId.make(row.taskId),
            generation: Number(row.generation),
            createdAt: row.createdAt,
            retiredAt: row.retiredAt,
          })),
        ),
      );

  const forgetTask: WebhookTaskRepositoryShape["forgetTask"] = (input) =>
    Effect.gen(function* () {
      const secrets = yield* selectSecrets("WHERE task_id = ? ORDER BY generation", [input.taskId]);
      yield* sql`DELETE FROM scheduled_task_webhooks WHERE task_id = ${input.taskId}`;
      yield* sql`
        UPDATE webhook_hooks SET active = 0, retired_at = COALESCE(retired_at, ${input.now})
        WHERE task_id = ${input.taskId}
      `;
      if (input.everything) {
        yield* sql`DELETE FROM webhook_secrets WHERE task_id = ${input.taskId}`;
        yield* sql`DELETE FROM webhook_events WHERE task_id = ${input.taskId}`;
        yield* sql`DELETE FROM webhook_seen WHERE task_id = ${input.taskId}`;
        yield* sql`DELETE FROM scheduled_webhook_subjects WHERE task_id = ${input.taskId}`;
      } else {
        yield* sql`
          UPDATE webhook_secrets SET retired_at = ${input.now}
          WHERE task_id = ${input.taskId} AND retired_at IS NULL
        `;
      }
      return secrets;
    }).pipe(sql.withTransaction, wrap("forgetTask"));

  const listGitHubRemovals: WebhookTaskRepositoryShape["listGitHubRemovals"] = sql<{
    readonly repository: string;
    readonly hookId: string;
    readonly taskId: string;
    readonly reason: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>`
    SELECT repository AS "repository", hook_id AS "hookId", task_id AS "taskId",
      reason AS "reason", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM webhook_github_removals
    ORDER BY created_at, repository, hook_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): GitHubRemovalRow => ({ ...row, taskId: ScheduledTaskId.make(row.taskId) })),
    ),
    wrap("listGitHubRemovals"),
  );

  const putGitHubRemoval: WebhookTaskRepositoryShape["putGitHubRemoval"] = (input) =>
    sql`
      INSERT INTO webhook_github_removals (
        repository, hook_id, task_id, reason, created_at, updated_at
      ) VALUES (
        ${input.repository}, ${input.hookId}, ${input.taskId}, ${input.reason}, ${input.now},
        ${input.now}
      )
      ON CONFLICT(repository, hook_id) DO UPDATE SET
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, wrap("putGitHubRemoval"));

  const deleteGitHubRemoval: WebhookTaskRepositoryShape["deleteGitHubRemoval"] = (input) =>
    sql`
      DELETE FROM webhook_github_removals
      WHERE repository = ${input.repository} AND hook_id = ${input.hookId}
    `.pipe(Effect.asVoid, wrap("deleteGitHubRemoval"));

  const insertHook: WebhookTaskRepositoryShape["insertHook"] = (input) =>
    sql`
      INSERT INTO webhook_hooks (hook_id, task_id, active, created_at)
      VALUES (${input.hookId}, ${input.taskId}, 1, ${input.now})
      ON CONFLICT(hook_id) DO NOTHING
    `.pipe(Effect.asVoid, wrap("insertHook"));

  const retireHooks: WebhookTaskRepositoryShape["retireHooks"] = (input) =>
    (input.keep === null
      ? sql`
          UPDATE webhook_hooks SET active = 0, retired_at = ${input.now}
          WHERE task_id = ${input.taskId} AND active = 1
        `
      : sql`
          UPDATE webhook_hooks SET active = 0, retired_at = ${input.now}
          WHERE task_id = ${input.taskId} AND active = 1 AND hook_id != ${input.keep}
        `
    ).pipe(Effect.asVoid, wrap("retireHooks"));

  const hookTask: WebhookTaskRepositoryShape["hookTask"] = (hookId) =>
    sql<{ readonly taskId: string }>`
      SELECT task_id AS "taskId" FROM webhook_hooks WHERE hook_id = ${hookId}
    `.pipe(
      Effect.map((rows) =>
        Option.fromNullishOr(rows[0]).pipe(Option.map((row) => ScheduledTaskId.make(row.taskId))),
      ),
      wrap("hookTask"),
    );

  const listSecrets: WebhookTaskRepositoryShape["listSecrets"] = (taskId) =>
    selectSecrets("WHERE task_id = ? ORDER BY generation", [taskId]).pipe(wrap("listSecrets"));

  const tasksWithSecret: WebhookTaskRepositoryShape["tasksWithSecret"] = sql<{
    readonly taskId: string;
  }>`
    SELECT DISTINCT task_id AS "taskId" FROM webhook_secrets WHERE retired_at IS NULL
  `.pipe(
    Effect.map(
      (rows): ReadonlySet<ScheduledTaskId> =>
        new Set(rows.map((row) => ScheduledTaskId.make(row.taskId))),
    ),
    wrap("tasksWithSecret"),
  );

  const insertSecret: WebhookTaskRepositoryShape["insertSecret"] = (input) =>
    Effect.gen(function* () {
      const last = yield* sql<{ readonly generation: number | null }>`
        SELECT MAX(generation) AS "generation" FROM webhook_secrets WHERE task_id = ${input.taskId}
      `;
      const generation = Number(last[0]?.generation ?? 0) + 1;
      yield* sql`
        INSERT INTO webhook_secrets (task_id, generation, created_at)
        VALUES (${input.taskId}, ${generation}, ${input.now})
      `;
      return generation;
    }).pipe(sql.withTransaction, wrap("insertSecret"));

  const retireSecrets: WebhookTaskRepositoryShape["retireSecrets"] = (input) =>
    sql`
      UPDATE webhook_secrets SET retired_at = ${input.now}
      WHERE task_id = ${input.taskId} AND generation < ${input.below} AND retired_at IS NULL
    `.pipe(Effect.asVoid, wrap("retireSecrets"));

  const selectEvent = `
    SELECT
      e.event_id AS "eventId",
      e.task_id AS "taskId",
      e.received_at AS "receivedAt",
      e.source AS "source",
      e.replay_of AS "replayOf",
      e.method AS "method",
      e.query AS "query",
      e.headers_json AS "headers",
      e.body AS "body",
      e.body_truncated AS "bodyTruncated",
      e.status AS "status",
      e.reason AS "reason",
      e.verified AS "verified",
      e.signature_checked AS "signatureChecked",
      e.event_name AS "eventName",
      e.subject AS "subject",
      e.sender AS "sender",
      e.summary AS "summary",
      e.dedupe_hash AS "dedupeHash",
      e.missing_fields_json AS "missingFields",
      e.run_slot_utc AS "runSlotUtc",
      r.thread_id AS "threadId",
      e.created_at AS "createdAt",
      e.updated_at AS "updatedAt"
    FROM webhook_events AS e
    LEFT JOIN scheduled_runs AS r
      ON r.task_id = e.task_id AND r.slot_utc = e.run_slot_utc
  `;
  const findEvents = (where: string, params: ReadonlyArray<string | number>) =>
    sql
      .unsafe<WebhookEventDbRow>(`${selectEvent} ${where}`, [...params])
      .pipe(Effect.map((rows) => rows.map(toEvent)));

  const insertEvent: WebhookTaskRepositoryShape["insertEvent"] = (event) =>
    sql<{ readonly eventId: string }>`
      INSERT INTO webhook_events (
        event_id, task_id, received_at, source, replay_of, method, query, headers_json, body,
        status, verified, signature_checked, event_name, subject, sender, summary, dedupe_hash,
        created_at, updated_at
      ) VALUES (
        ${event.eventId}, ${event.taskId}, ${event.receivedAt}, ${event.source},
        ${event.replayOf}, ${event.method}, ${event.query}, ${JSON.stringify(event.headers)},
        ${event.body}, 'received',
        ${event.verified === null ? null : event.verified ? 1 : 0},
        ${event.signatureChecked === null ? null : event.signatureChecked ? 1 : 0},
        ${event.eventName}, ${event.subject}, ${event.sender}, ${event.summary},
        ${event.dedupeHash}, ${event.now}, ${event.now}
      )
      ON CONFLICT(event_id) DO NOTHING
      RETURNING event_id AS "eventId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      wrap("insertEvent"),
    );

  const getEvent: WebhookTaskRepositoryShape["getEvent"] = (eventId) =>
    findEvents("WHERE e.event_id = ?", [eventId]).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      wrap("getEvent"),
    );

  const listQueued: WebhookTaskRepositoryShape["listQueued"] = (taskId) =>
    findEvents(
      "WHERE e.task_id = ? AND e.status IN ('received', 'waiting') ORDER BY e.received_at, e.rowid",
      [taskId],
    ).pipe(wrap("listQueued"));

  const tasksWithQueued: WebhookTaskRepositoryShape["tasksWithQueued"] = (input) =>
    (input.waitingOnly
      ? sql<{ readonly taskId: string }>`
          SELECT DISTINCT task_id AS "taskId" FROM webhook_events WHERE status = 'waiting'
        `
      : sql<{ readonly taskId: string }>`
          SELECT DISTINCT task_id AS "taskId" FROM webhook_events
          WHERE status IN ('received', 'waiting')
        `
    ).pipe(
      Effect.map((rows) => rows.map((row) => ScheduledTaskId.make(row.taskId))),
      wrap("tasksWithQueued"),
    );

  /**
   * Newest first, by receive time and then arrival. A page after the one
   * ending at `beforeEventId` goes on with that event's later-arrived
   * neighbours at the same time (an event pruned since: the next time).
   */
  const listEvents: WebhookTaskRepositoryShape["listEvents"] = (input) =>
    (input.before === undefined
      ? findEvents("WHERE e.task_id = ? ORDER BY e.received_at DESC, e.rowid DESC LIMIT ?", [
          input.taskId,
          input.limit,
        ])
      : input.beforeEventId === undefined
        ? findEvents(
            "WHERE e.task_id = ? AND e.received_at < ? ORDER BY e.received_at DESC, e.rowid DESC LIMIT ?",
            [input.taskId, input.before, input.limit],
          )
        : findEvents(
            `WHERE e.task_id = ? AND (
               e.received_at < ?
               OR (e.received_at = ? AND e.rowid < (
                 SELECT rowid FROM webhook_events WHERE event_id = ? AND task_id = e.task_id
               ))
             )
             ORDER BY e.received_at DESC, e.rowid DESC LIMIT ?`,
            [input.taskId, input.before, input.before, input.beforeEventId, input.limit],
          )
    ).pipe(wrap("listEvents"));

  const updateEvent: WebhookTaskRepositoryShape["updateEvent"] = (input) =>
    Effect.gen(function* () {
      const sets: Array<string> = ["status = ?", "reason = ?", "updated_at = ?"];
      const values: Array<string | number | null> = [input.status, input.reason, input.now];
      if (input.verified !== undefined) {
        sets.push("verified = ?");
        values.push(input.verified ? 1 : 0);
      }
      if (input.signatureChecked !== undefined) {
        sets.push("signature_checked = ?");
        values.push(input.signatureChecked ? 1 : 0);
      }
      if (input.missingFields !== undefined) {
        sets.push("missing_fields_json = ?");
        values.push(JSON.stringify(input.missingFields));
      }
      const rows = yield* sql.unsafe<{ readonly eventId: string }>(
        `UPDATE webhook_events SET ${sets.join(", ")}
         WHERE event_id = ? AND status IN ('received', 'waiting')
         RETURNING event_id AS "eventId"`,
        [...values, input.eventId],
      );
      return rows.length > 0;
    }).pipe(wrap("updateEvent"));

  const failRunEvent: WebhookTaskRepositoryShape["failRunEvent"] = (input) =>
    sql`
      UPDATE webhook_events SET status = 'failed', reason = ${input.reason},
        updated_at = ${input.now}
      WHERE task_id = ${input.taskId} AND run_slot_utc = ${input.runSlotUtc}
        AND status IN ('ran', 'joined')
    `.pipe(Effect.asVoid, wrap("failRunEvent"));

  const deleteEvent: WebhookTaskRepositoryShape["deleteEvent"] = (eventId) =>
    sql`DELETE FROM webhook_events WHERE event_id = ${eventId}`.pipe(
      Effect.asVoid,
      wrap("deleteEvent"),
    );

  const eventsChangedAt: WebhookTaskRepositoryShape["eventsChangedAt"] = sql<{
    readonly taskId: string;
    readonly changedAt: string;
  }>`
    SELECT task_id AS "taskId", MAX(updated_at) AS "changedAt"
    FROM webhook_events
    GROUP BY task_id
  `.pipe(
    Effect.map(
      (rows): ReadonlyMap<ScheduledTaskId, string> =>
        new Map(rows.map((row) => [ScheduledTaskId.make(row.taskId), row.changedAt])),
    ),
    wrap("eventsChangedAt"),
  );

  const countWaiting: WebhookTaskRepositoryShape["countWaiting"] = (input) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM webhook_events
      WHERE task_id = ${input.taskId} AND status = 'waiting' AND event_id != ${input.except}
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
      wrap("countWaiting"),
    );

  const touchLastEvent: WebhookTaskRepositoryShape["touchLastEvent"] = (input) =>
    sql`
      UPDATE scheduled_task_webhooks SET last_event_at = ${input.at}
      WHERE task_id = ${input.taskId}
        AND (last_event_at IS NULL OR last_event_at < ${input.at})
    `.pipe(Effect.asVoid, wrap("touchLastEvent"));

  const isDuplicate: WebhookTaskRepositoryShape["isDuplicate"] = (input) =>
    Effect.gen(function* () {
      const seen = yield* sql<{ readonly found: number }>`
        SELECT 1 AS "found" FROM webhook_seen
        WHERE task_id = ${input.taskId} AND key_hash = ${input.keyHash}
          AND seen_at >= ${input.since}
      `;
      if (seen.length > 0) return true;
      const waiting = yield* sql<{ readonly found: number }>`
        SELECT 1 AS "found" FROM webhook_events
        WHERE task_id = ${input.taskId} AND dedupe_hash = ${input.keyHash}
          AND status = 'waiting' AND event_id != ${input.except}
        LIMIT 1
      `;
      return waiting.length > 0;
    }).pipe(wrap("isDuplicate"));

  const getSubject: WebhookTaskRepositoryShape["getSubject"] = (input) =>
    sql<{
      readonly projectId: string;
      readonly threadId: string | null;
      readonly reservedByRun: string | null;
      readonly updatedAt: string;
    }>`
      SELECT project_id AS "projectId", thread_id AS "threadId",
        reserved_by_run AS "reservedByRun", updated_at AS "updatedAt"
      FROM scheduled_webhook_subjects
      WHERE task_id = ${input.taskId} AND subject = ${input.subject}
    `.pipe(
      Effect.map((rows) =>
        Option.fromNullishOr(rows[0]).pipe(
          Option.map((row): WebhookSubjectRow => ({
            taskId: input.taskId,
            subject: input.subject,
            projectId: row.projectId as ProjectId,
            threadId: row.threadId === null ? null : ThreadIdSchema.make(row.threadId),
            reservedByRun: row.reservedByRun,
            updatedAt: row.updatedAt,
          })),
        ),
      ),
      wrap("getSubject"),
    );

  const fillSubjectThread: WebhookTaskRepositoryShape["fillSubjectThread"] = (input) =>
    sql<{ readonly subject: string }>`
      UPDATE scheduled_webhook_subjects
      SET thread_id = ${input.threadId}, updated_at = ${input.now}
      WHERE task_id = ${input.taskId} AND reserved_by_run = ${input.runSlotUtc}
        AND thread_id IS NULL
      RETURNING subject AS "subject"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      wrap("fillSubjectThread"),
    );

  const releaseSubject: WebhookTaskRepositoryShape["releaseSubject"] = (input) =>
    sql<{ readonly subject: string }>`
      DELETE FROM scheduled_webhook_subjects
      WHERE task_id = ${input.taskId} AND reserved_by_run = ${input.runSlotUtc}
        AND thread_id IS NULL
      RETURNING subject AS "subject"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      wrap("releaseSubject"),
    );

  const prune: WebhookTaskRepositoryShape["prune"] = (now) =>
    Effect.gen(function* () {
      const iso = (ms: number) => new Date(now - ms).toISOString();
      const minKeep = iso(WEBHOOK_EVENT_MIN_KEEP_MS);
      // Past 48 hours: all past 14 days, and beyond each task's newest 100.
      yield* sql`
        DELETE FROM webhook_events
        WHERE status IN ('ran', 'joined', 'skipped', 'failed')
          AND received_at < ${minKeep}
          AND received_at < ${iso(WEBHOOK_EVENT_MAX_KEEP_MS)}
      `;
      yield* sql`
        DELETE FROM webhook_events
        WHERE status IN ('ran', 'joined', 'skipped', 'failed')
          AND received_at < ${minKeep}
          AND event_id IN (
            SELECT event_id FROM (
              SELECT event_id, ROW_NUMBER() OVER (
                PARTITION BY task_id ORDER BY received_at DESC, rowid DESC
              ) AS position
              FROM webhook_events
              WHERE status IN ('ran', 'joined', 'skipped', 'failed')
            )
            WHERE position > ${WEBHOOK_EVENT_KEEP_COUNT}
          )
      `;
      yield* sql`
        UPDATE webhook_events
        SET body = substr(body, 1, ${WEBHOOK_BODY_EXCERPT_BYTES}), body_truncated = 1
        WHERE status IN ('ran', 'joined', 'skipped', 'failed')
          AND body_truncated = 0
          AND received_at < ${iso(WEBHOOK_BODY_KEEP_MS)}
      `;
      yield* sql`DELETE FROM webhook_seen WHERE seen_at < ${iso(WEBHOOK_SEEN_KEEP_MS)}`;
      const retiredBefore = iso(WEBHOOK_RETIRED_KEEP_MS);
      yield* sql`
        DELETE FROM webhook_hooks WHERE retired_at IS NOT NULL AND retired_at < ${retiredBefore}
      `;
      const secretsRetiredBefore = iso(WEBHOOK_SECRET_KEEP_MS);
      const secrets = yield* selectSecrets("WHERE retired_at IS NOT NULL AND retired_at < ?", [
        secretsRetiredBefore,
      ]);
      yield* sql`
        DELETE FROM webhook_secrets
        WHERE retired_at IS NOT NULL AND retired_at < ${secretsRetiredBefore}
      `;
      return secrets;
    }).pipe(sql.withTransaction, wrap("prune"));

  return WebhookTaskRepository.of({
    transact,
    listTaskWebhooks,
    getTaskWebhook,
    insertTaskWebhook,
    updateTaskWebhook,
    listGitHubRemovals,
    putGitHubRemoval,
    deleteGitHubRemoval,
    forgetTask,
    insertHook,
    retireHooks,
    hookTask,
    listSecrets,
    tasksWithSecret,
    insertSecret,
    retireSecrets,
    insertEvent,
    getEvent,
    listQueued,
    tasksWithQueued,
    listEvents,
    updateEvent,
    failRunEvent,
    deleteEvent,
    countWaiting,
    eventsChangedAt,
    touchLastEvent,
    isDuplicate,
    getSubject,
    fillSubjectThread,
    releaseSubject,
    prune,
  });
});

export const WebhookTaskRepositoryLive = Layer.effect(WebhookTaskRepository, make);
