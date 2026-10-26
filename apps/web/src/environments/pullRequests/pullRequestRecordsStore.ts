/**
 * Each computer's record of what the host last said about every pull request
 * it read (`pullRequests.subscribeObservations`), kept while the app runs.
 * One read anywhere (a listing, a lookup, a full read, a checkout's status,
 * the merge automation) updates the record, and every surface showing that
 * pull request reads it here, so the composer's row, the sidebar badge and a
 * link in the chat say the same thing.
 */
import type { EnvironmentId, PullRequestObservation } from "@threadlines/contracts";
import { useMemo } from "react";
import { create } from "zustand";

type RecordsByKey = Readonly<Record<string, PullRequestObservation>>;

interface PullRequestRecordsState {
  readonly byEnvironmentId: Readonly<Partial<Record<EnvironmentId, RecordsByKey>>>;
}

export const usePullRequestRecordsStore = create<PullRequestRecordsState>(() => ({
  byEnvironmentId: {},
}));

/** How a record is filed: the host ignores a repository's casing, and so does this. */
export function pullRequestRecordKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`;
}

/**
 * Keeps a record unless one already held is newer. A computer that restarted
 * starts its sequence again, so the server's read time decides, then the
 * sequence between reads of the same moment.
 */
export function receivePullRequestRecord(
  environmentId: EnvironmentId,
  record: PullRequestObservation,
): { readonly kept: boolean; readonly previous: PullRequestObservation | undefined } {
  const { byEnvironmentId } = usePullRequestRecordsStore.getState();
  const records = byEnvironmentId[environmentId] ?? {};
  const key = pullRequestRecordKey(record.repository, record.number);
  const held = records[key];
  if (held !== undefined) {
    const heldAt = Date.parse(held.observedAt);
    const recordAt = Date.parse(record.observedAt);
    if (heldAt > recordAt || (heldAt === recordAt && held.sequence >= record.sequence)) {
      return { kept: false, previous: held };
    }
  }
  usePullRequestRecordsStore.setState({
    byEnvironmentId: { ...byEnvironmentId, [environmentId]: { ...records, [key]: record } },
  });
  return { kept: true, previous: held };
}

/** Finds a pull request's record on one computer; undefined where it has none. */
export type PullRequestRecordLookup = (
  repository: string | null | undefined,
  number: number,
) => PullRequestObservation | undefined;

const noRecords: PullRequestRecordLookup = () => undefined;

function lookupIn(records: RecordsByKey | undefined): PullRequestRecordLookup {
  if (records === undefined) return noRecords;
  return (repository, number) =>
    repository ? records[pullRequestRecordKey(repository, number)] : undefined;
}

/** A pull request's record on one computer, read outside rendering. */
export function readPullRequestRecord(
  environmentId: EnvironmentId | null | undefined,
  repository: string | null | undefined,
  number: number,
): PullRequestObservation | undefined {
  if (!environmentId) return undefined;
  return lookupIn(usePullRequestRecordsStore.getState().byEnvironmentId[environmentId])(
    repository,
    number,
  );
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
 * The newest record of one pull request on any computer, for a surface that
 * does not know which computer it came from (a link in a transcript). Changes
 * only when that record does.
 */
export function useNewestPullRequestRecord(
  repository: string | null | undefined,
  number: number,
): PullRequestObservation | undefined {
  return usePullRequestRecordsStore((state) => {
    if (!repository) return undefined;
    const key = pullRequestRecordKey(repository, number);
    let newest: PullRequestObservation | undefined;
    for (const records of Object.values(state.byEnvironmentId)) {
      const record = records?.[key];
      if (record !== undefined && (newest === undefined || record.observedAt > newest.observedAt)) {
        newest = record;
      }
    }
    return newest;
  });
}

/** Every computer's records, for a surface listing pull requests from several. */
export function useAllPullRequestRecords(): (
  environmentId: EnvironmentId,
) => PullRequestRecordLookup {
  const byEnvironmentId = usePullRequestRecordsStore((state) => state.byEnvironmentId);
  return useMemo(() => {
    const lookups = new Map<EnvironmentId, PullRequestRecordLookup>();
    return (environmentId) => {
      let lookup = lookups.get(environmentId);
      if (lookup === undefined) {
        lookup = lookupIn(byEnvironmentId[environmentId]);
        lookups.set(environmentId, lookup);
      }
      return lookup;
    };
  }, [byEnvironmentId]);
}
