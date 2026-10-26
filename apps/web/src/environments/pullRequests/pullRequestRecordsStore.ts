/**
 * Each computer's record of what the host last said about every pull request
 * it read (`pullRequests.subscribeObservations`), kept while the app runs.
 * One read anywhere (a listing, a lookup, a full read, a checkout's status,
 * the merge automation) updates the record, and every surface showing that
 * pull request reads it here, so the composer's row, the sidebar badge and a
 * link in the chat say the same thing.
 */
import type { EnvironmentId, PullRequestObservation } from "@threadlines/contracts";
import { pullRequestIdentityKey } from "@threadlines/shared/sourceControl";
import { useMemo } from "react";
import { create } from "zustand";

type RecordsByKey = Readonly<Record<string, PullRequestObservation>>;

interface PullRequestRecordsState {
  readonly byEnvironmentId: Readonly<Partial<Record<EnvironmentId, RecordsByKey>>>;
}

export const usePullRequestRecordsStore = create<PullRequestRecordsState>(() => ({
  byEnvironmentId: {},
}));

/** Records kept per computer; the ones changed longest ago go first. */
const MAX_RECORDS_PER_COMPUTER = 1_000;

/**
 * What a surface knows about a pull request it asks the records about. The
 * address names the host, since two hosts can each have an `owner/name#42`.
 */
export interface PullRequestRecordSubject {
  readonly url: string | null | undefined;
  readonly repository: string | null | undefined;
  readonly number: number;
}

/** How a record is filed; null where the surface does not know enough to find one. */
export function pullRequestRecordKey(subject: PullRequestRecordSubject): string | null {
  if (!subject.url || !subject.repository) return null;
  return pullRequestIdentityKey({
    url: subject.url,
    repository: subject.repository,
    number: subject.number,
  });
}

/**
 * Keeps a record unless one already held is newer. A computer that restarted
 * starts its sequence again, so the server's read time decides, then the
 * sequence between reads of the same moment. Only times from one computer
 * are ever compared.
 */
export function receivePullRequestRecord(
  environmentId: EnvironmentId,
  record: PullRequestObservation,
): { readonly kept: boolean; readonly previous: PullRequestObservation | undefined } {
  const key = pullRequestRecordKey(record);
  if (key === null) return { kept: false, previous: undefined };
  const { byEnvironmentId } = usePullRequestRecordsStore.getState();
  const records = byEnvironmentId[environmentId] ?? {};
  const held = records[key];
  if (held !== undefined) {
    const heldAt = Date.parse(held.observedAt);
    const recordAt = Date.parse(record.observedAt);
    if (heldAt > recordAt || (heldAt === recordAt && held.sequence >= record.sequence)) {
      return { kept: false, previous: held };
    }
  }
  // Re-filed last, so the oldest change is first in line when room runs out.
  const { [key]: _replaced, ...rest } = records;
  const keys = Object.keys(rest);
  const kept =
    keys.length < MAX_RECORDS_PER_COMPUTER
      ? rest
      : Object.fromEntries(
          keys
            .slice(keys.length - MAX_RECORDS_PER_COMPUTER + 1)
            .map((kept) => [kept, rest[kept]!] as const),
        );
  usePullRequestRecordsStore.setState({
    byEnvironmentId: { ...byEnvironmentId, [environmentId]: { ...kept, [key]: record } },
  });
  return { kept: true, previous: held };
}

/** Finds a pull request's record on one computer; undefined where it has none. */
export type PullRequestRecordLookup = (
  subject: PullRequestRecordSubject,
) => PullRequestObservation | undefined;

const noRecords: PullRequestRecordLookup = () => undefined;

function lookupIn(records: RecordsByKey | undefined): PullRequestRecordLookup {
  if (records === undefined) return noRecords;
  return (subject) => {
    const key = pullRequestRecordKey(subject);
    return key === null ? undefined : records[key];
  };
}

/** A pull request's record on one computer, read outside rendering. */
export function readPullRequestRecord(
  environmentId: EnvironmentId | null | undefined,
  subject: PullRequestRecordSubject,
): PullRequestObservation | undefined {
  if (!environmentId) return undefined;
  return lookupIn(usePullRequestRecordsStore.getState().byEnvironmentId[environmentId])(subject);
}

/** One computer's records, as a lookup that changes whenever one of them does. */
export function usePullRequestRecords(
  environmentId: EnvironmentId | null | undefined,
): PullRequestRecordLookup {
  const records = usePullRequestRecordsStore((state) =>
    environmentId ? state.byEnvironmentId[environmentId] : undefined,
  );
  return useMemo(() => lookupIn(records), [records]);
}

/**
 * One pull request's record on one computer, changing only when that record
 * does: for a surface showing one pull request (a link in a transcript).
 */
export function usePullRequestRecord(
  environmentId: EnvironmentId | null | undefined,
  subject: PullRequestRecordSubject,
): PullRequestObservation | undefined {
  const key = pullRequestRecordKey(subject);
  return usePullRequestRecordsStore((state) =>
    environmentId && key !== null ? state.byEnvironmentId[environmentId]?.[key] : undefined,
  );
}

function outranksOnAnotherClock(
  record: PullRequestObservation,
  held: PullRequestObservation,
): boolean {
  const merged = record.state === "merged";
  if (merged !== (held.state === "merged")) return merged;
  return Date.parse(record.observedAt) > Date.parse(held.observedAt);
}

/**
 * A pull request's record where no computer is known to read it (a link in a
 * transcript no project here can address): whichever computer holds one. Two
 * computers' clocks can disagree, so a merge, which is never undone, wins over
 * any other state; between the rest the newer read wins. Null asks for nothing.
 */
export function usePullRequestRecordOnAnyComputer(
  subject: PullRequestRecordSubject | null,
): PullRequestObservation | undefined {
  const key = subject === null ? null : pullRequestRecordKey(subject);
  return usePullRequestRecordsStore((state) => {
    if (key === null) return undefined;
    let chosen: PullRequestObservation | undefined;
    for (const records of Object.values(state.byEnvironmentId)) {
      const record = records?.[key];
      if (record === undefined) continue;
      if (chosen === undefined || outranksOnAnotherClock(record, chosen)) chosen = record;
    }
    return chosen;
  });
}

/** Every computer's records, for a surface listing pull requests from several. */
export function useAllPullRequestRecords(): (
  environmentId: EnvironmentId,
) => PullRequestRecordLookup {
  const byEnvironmentId = usePullRequestRecordsStore((state) => state.byEnvironmentId);
  return useMemo(() => {
    const lookups = new Map<string, PullRequestRecordLookup>(
      Object.entries(byEnvironmentId).map(([environmentId, records]) => [
        environmentId,
        lookupIn(records),
      ]),
    );
    return (environmentId) => lookups.get(environmentId) ?? noRecords;
  }, [byEnvironmentId]);
}
