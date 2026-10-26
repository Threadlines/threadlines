/**
 * The server's record of what the host last said about each pull request,
 * whoever asked: the pull requests page, a thread's lookup, a checkout's
 * status read, the merge automation. Every read that went to the host lands
 * here (`observe`), never a cached answer replayed, and every client is sent
 * each change (`stream`), so one read updates every surface on every device.
 *
 * A record is kept in parts that change together: the pull request's state
 * (with its draft flag and when it settled), whether it is armed to merge,
 * and its checks with the commit they ran on. Each part is as of the newest
 * read that covered it, ordered by when the read began: a slow read that
 * started earlier never overwrites a quicker one that started later.
 *
 * @module PullRequestObservations
 */
import type {
  PullRequestChecksState,
  PullRequestObservation,
  PullRequestState,
  SourceControlProviderKind,
} from "@threadlines/contracts";
import { pullRequestIdentityKey } from "@threadlines/shared/sourceControl";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/** Pull requests kept; the least recently changed go first. */
const MAX_RECORDS = 1_000;

/** What one read of the host said about one pull request. */
export interface PullRequestRead {
  readonly provider: SourceControlProviderKind;
  /** `owner/name`, as the host spells it. */
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headBranch: string;
  readonly state: PullRequestState;
  /** Absent where the read cannot tell drafts apart. */
  readonly isDraft?: boolean | undefined;
  readonly settledAt?: string | null | undefined;
  /** Armed or queued to merge; absent where the read does not say. */
  readonly autoMergeEnabled?: boolean | undefined;
  /** Present only from a read of the pull request itself, which knows its head. */
  readonly checks?:
    | {
        readonly headSha: string | null;
        readonly state: PullRequestChecksState | null;
      }
    | undefined;
}

/** A record and when the read behind each of its parts began. */
export interface StoredPullRequestRecord {
  readonly observation: PullRequestObservation;
  readonly stateReadAtMs: number;
  /** Apart from the state: a read that cannot tell drafts apart says nothing about one. */
  readonly draftReadAtMs: number | null;
  readonly autoMergeReadAtMs: number | null;
  readonly checksReadAtMs: number | null;
}

/** Two hosts can each have an `owner/name#42`; an address that names none falls back to its provider. */
function pullRequestRecordKey(read: PullRequestRead): string {
  return (
    pullRequestIdentityKey(read) ??
    `${read.provider}:${read.repository.toLowerCase()}#${read.number}`
  );
}

/**
 * The record after one more read, or null where the read changes nothing a
 * client shows (it may still be newer: the times move on regardless).
 */
export function recordPullRequestRead(
  previous: StoredPullRequestRecord | undefined,
  read: PullRequestRead,
  readAtMs: number,
): { readonly record: StoredPullRequestRecord; readonly changed: boolean } {
  const iso = new Date(readAtMs).toISOString();
  const before = previous?.observation;
  const takesState = previous === undefined || readAtMs >= previous.stateReadAtMs;
  const takesDraft =
    read.isDraft !== undefined &&
    (previous?.draftReadAtMs == null || readAtMs >= previous.draftReadAtMs);
  const takesAutoMerge =
    read.autoMergeEnabled !== undefined &&
    (previous?.autoMergeReadAtMs == null || readAtMs >= previous.autoMergeReadAtMs);
  const takesChecks =
    read.checks !== undefined &&
    (previous?.checksReadAtMs == null || readAtMs >= previous.checksReadAtMs);

  const isDraft = takesDraft ? read.isDraft : before?.isDraft;
  const settledAt = takesState
    ? read.state === "open"
      ? undefined
      : (read.settledAt ?? (before?.state === read.state ? before.settledAt : undefined))
    : before?.settledAt;
  const autoMergeEnabled = takesAutoMerge ? read.autoMergeEnabled : before?.autoMergeEnabled;
  const checks =
    takesChecks && read.checks !== undefined
      ? { headSha: read.checks.headSha, state: read.checks.state, observedAt: iso }
      : before?.checks;

  const observation: PullRequestObservation = {
    provider: read.provider,
    repository: takesState || before === undefined ? read.repository : before.repository,
    number: read.number,
    sequence: before?.sequence ?? 0,
    observedAt:
      before === undefined || readAtMs >= Date.parse(before.observedAt) ? iso : before.observedAt,
    title: takesState || before === undefined ? read.title : before.title,
    url: takesState || before === undefined ? read.url : before.url,
    headBranch: takesState || before === undefined ? read.headBranch : before.headBranch,
    state: takesState || before === undefined ? read.state : before.state,
    ...(isDraft === undefined ? {} : { isDraft }),
    ...(settledAt == null ? {} : { settledAt }),
    ...(autoMergeEnabled === undefined ? {} : { autoMergeEnabled }),
    ...(checks === undefined ? {} : { checks }),
  };
  const record: StoredPullRequestRecord = {
    observation,
    stateReadAtMs: takesState ? readAtMs : (previous?.stateReadAtMs ?? readAtMs),
    draftReadAtMs: takesDraft ? readAtMs : (previous?.draftReadAtMs ?? null),
    autoMergeReadAtMs: takesAutoMerge ? readAtMs : (previous?.autoMergeReadAtMs ?? null),
    checksReadAtMs: takesChecks ? readAtMs : (previous?.checksReadAtMs ?? null),
  };
  return { record, changed: before === undefined || !sameShownRecord(before, observation) };
}

/** Whether two records show the same thing, whatever their times. */
function sameShownRecord(left: PullRequestObservation, right: PullRequestObservation): boolean {
  return (
    left.repository === right.repository &&
    left.title === right.title &&
    left.url === right.url &&
    left.headBranch === right.headBranch &&
    left.state === right.state &&
    left.isDraft === right.isDraft &&
    left.settledAt === right.settledAt &&
    left.autoMergeEnabled === right.autoMergeEnabled &&
    left.checks?.headSha === right.checks?.headSha &&
    left.checks?.state === right.checks?.state
  );
}

/** A read's result and when it began, which is how it is weighed against the records. */
export interface ObservedRead<A> {
  readonly result: A;
  /** On the server's clock; the `observedAt` of the records this read made. */
  readonly observedAt: string;
}

export interface PullRequestObservationsShape {
  /**
   * Runs `read`, a call that goes to the host, and records what it said about
   * each pull request. A failed read records nothing; recording never fails.
   */
  readonly observe: <A, E, R>(
    read: Effect.Effect<A, E, R>,
    toReads: (result: A) => ReadonlyArray<PullRequestRead>,
  ) => Effect.Effect<ObservedRead<A>, E, R>;
  /** Every record kept, oldest change first, then each change as it lands. */
  readonly stream: Stream.Stream<PullRequestObservation>;
}

export class PullRequestObservations extends Context.Service<
  PullRequestObservations,
  PullRequestObservationsShape
>()("threadlines/pullRequest/PullRequestObservations") {}

interface State {
  readonly sequence: number;
  readonly records: ReadonlyMap<string, StoredPullRequestRecord>;
}

export const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<PullRequestObservation>();
  const state = yield* Ref.make<State>({ sequence: 0, records: new Map() });

  const record = (reads: ReadonlyArray<PullRequestRead>, readAtMs: number) =>
    Ref.modify(state, (current): [ReadonlyArray<PullRequestObservation>, State] => {
      const records = new Map(current.records);
      let sequence = current.sequence;
      const changed: PullRequestObservation[] = [];
      for (const read of reads) {
        const key = pullRequestRecordKey(read);
        const next = recordPullRequestRead(records.get(key), read, readAtMs);
        const stored = next.changed
          ? {
              ...next.record,
              observation: { ...next.record.observation, sequence: ++sequence },
            }
          : next.record;
        // Re-inserting keeps the map in order of change, oldest first.
        records.delete(key);
        records.set(key, stored);
        if (next.changed) changed.push(stored.observation);
      }
      while (records.size > MAX_RECORDS) {
        const oldest = records.keys().next().value;
        if (oldest === undefined) break;
        records.delete(oldest);
      }
      return [changed, { sequence, records }];
    }).pipe(Effect.flatMap((changed) => PubSub.publishAll(pubsub, changed)));

  const observe: PullRequestObservationsShape["observe"] = (read, toReads) =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const result = yield* read;
      yield* Effect.suspend(() => record(toReads(result), startedAtMs)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pull request observation failed", { cause: String(cause) }),
        ),
      );
      return { result, observedAt: new Date(startedAtMs).toISOString() };
    });

  // Subscribed before the snapshot is read, so nothing recorded in between is lost.
  const stream = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(pubsub);
      const current = yield* Ref.get(state);
      const snapshot = Array.from(current.records.values(), (entry) => entry.observation).toSorted(
        (left, right) => left.sequence - right.sequence,
      );
      return Stream.concat(
        Stream.fromIterable(snapshot),
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((observation) => observation.sequence > current.sequence),
        ),
      );
    }),
  );

  return { observe, stream } satisfies PullRequestObservationsShape;
});

export const layer = Layer.effect(PullRequestObservations, make);
