/**
 * The Showcase in the app (docs/design/custom-themes.md, "Showcase"): the
 * list and its pictures, read through a computer whose server reports
 * `themeShowcase` (this one first), trying a theme from it, and the shares
 * made from each computer, which the library's tiles show the state of.
 */
import type {
  EnvironmentId,
  ReportProblemAccount,
  ThemeShowcaseEntry,
  ThemeShowcaseListing,
  ThemeShowcasePreparation,
  ThemeShowcaseShareInput,
  ThemeShowcaseSubmission,
} from "@threadlines/contracts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { readEnvironmentConnection } from "../environments/runtime";
import { randomUUID } from "../lib/utils";
import { startThemeTrial } from "../theme/themeStore";
import { useThemeEnvironments } from "./themeLibraryState";

interface ShowcaseState {
  readonly listing: ThemeShowcaseListing | null;
  readonly loading: boolean;
  /** Each picture as a data URL, or "failed"; absent until asked for. */
  readonly pictures: Readonly<Record<string, string>>;
  /** Shares by the computer that made them. */
  readonly shares: Readonly<Record<string, ReadonlyArray<ThemeShowcaseSubmission>>>;
}

const useShowcaseStore = create<ShowcaseState>(() => ({
  listing: null,
  loading: false,
  pictures: {},
  shares: {},
}));

const clientOf = (environmentId: EnvironmentId) => {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) throw new Error("That computer isn't connected right now.");
  return connection.client.themeShowcase;
};

/** The computers that read the Showcase and share to it, this one first. */
export function useShowcaseEnvironments() {
  const environments = useThemeEnvironments();
  return useMemo(
    () => environments.filter((environment) => environment.capabilities.themeShowcase === true),
    [environments],
  );
}

/** Fetches the list (again when `refresh`), through one computer. */
export async function loadShowcase(environmentId: EnvironmentId, refresh = false): Promise<void> {
  useShowcaseStore.setState({ loading: true });
  try {
    const listing = await clientOf(environmentId).list(refresh ? { refresh } : {});
    useShowcaseStore.setState({ listing });
  } catch {
    const { listing } = useShowcaseStore.getState();
    useShowcaseStore.setState({
      listing: {
        themes: listing?.themes ?? [],
        fetchedAt: listing?.fetchedAt ?? null,
        issue: "unreachable",
      },
    });
  } finally {
    useShowcaseStore.setState({ loading: false });
  }
}

/** The list as last fetched, fetched when the Showcase first shows. */
export function useShowcase(environmentId: EnvironmentId | null) {
  const listing = useShowcaseStore((state) => state.listing);
  const loading = useShowcaseStore((state) => state.loading);
  useEffect(() => {
    if (environmentId !== null) void loadShowcase(environmentId);
  }, [environmentId]);
  return { listing, loading };
}

const asked = new Set<string>();

/** A theme's picture, fetched once it's asked for; null until then, "failed" if it couldn't be. */
export function useShowcasePicture(environmentId: EnvironmentId | null, id: string): string | null {
  const picture = useShowcaseStore((state) => state.pictures[id] ?? null);
  useEffect(() => {
    if (environmentId === null || picture !== null || asked.has(id)) return;
    asked.add(id);
    void clientOf(environmentId)
      .picture({ id })
      .then(({ dataUrl }) => dataUrl)
      .catch(() => "failed")
      .then((value) => {
        if (value === "failed") asked.delete(id);
        useShowcaseStore.setState((state) => ({ pictures: { ...state.pictures, [id]: value } }));
      });
  }, [environmentId, id, picture]);
  return picture;
}

/** Starts a trial of a Showcase theme; Keep then saves it to the library like any offer. */
export async function tryShowcaseTheme(
  environmentId: EnvironmentId,
  entry: ThemeShowcaseEntry,
): Promise<void> {
  const theme = await clientOf(environmentId).read({ id: entry.id });
  startThemeTrial({
    choice: { kind: "unsaved", hash: theme.hash, name: theme.manifest.name },
    manifest: theme.manifest,
  });
}

/** Who a share from this computer would post as: the GitHub account `gh` uses there. */
export function readShowcaseAccount(
  environmentId: EnvironmentId,
): Promise<ReportProblemAccount | { readonly status: "noServer" }> {
  const server = readEnvironmentConnection(environmentId)?.client.server ?? null;
  if (server === null) return Promise.resolve({ status: "noServer" });
  return server.getReportProblemAccount().catch(() => ({
    status: "unavailable" as const,
    reason: "Couldn't check GitHub on this computer.",
  }));
}

/** What sharing a library theme would publish, worked out on a computer that holds it. */
export function prepareShowcaseShare(
  environmentId: EnvironmentId,
  input: ThemeShowcaseShareInput,
): Promise<ThemeShowcasePreparation> {
  return clientOf(environmentId).prepare(input);
}

/** Shares it: a pull request from the GitHub account the person saw (`login`). */
export async function submitShowcaseShare(
  environmentId: EnvironmentId,
  input: ThemeShowcaseShareInput & { readonly submissionId: string; readonly login: string },
): Promise<ThemeShowcaseSubmission> {
  const submission = await clientOf(environmentId).submit(input);
  useShowcaseStore.setState((state) => ({
    shares: {
      ...state.shares,
      [environmentId]: [
        submission,
        ...(state.shares[environmentId] ?? []).filter(
          (share) => share.submissionId !== submission.submissionId,
        ),
      ],
    },
  }));
  return submission;
}

/** A share's id: sending it again resumes that share instead of starting another. */
export const newShowcaseSubmissionId = () => randomUUID().replaceAll("-", "").slice(0, 24);

/**
 * The newest share of each library entry, across the computers that share:
 * what its tile says (In review, In the Showcase, Not added).
 */
export function useShowcaseShares(): ReadonlyMap<string, ThemeShowcaseSubmission> {
  const environments = useShowcaseEnvironments();
  const shares = useShowcaseStore((state) => state.shares);
  useEffect(() => {
    for (const { environmentId } of environments) {
      void clientOf(environmentId)
        .submissions({})
        .then(({ submissions }) =>
          useShowcaseStore.setState((state) => ({
            shares: { ...state.shares, [environmentId]: submissions },
          })),
        )
        .catch(() => undefined);
    }
  }, [environments]);
  return useMemo(() => {
    const newest = new Map<string, ThemeShowcaseSubmission>();
    for (const list of Object.values(shares)) {
      for (const share of list) {
        const seen = newest.get(share.entryId);
        if (seen === undefined || share.createdAt > seen.createdAt)
          newest.set(share.entryId, share);
      }
    }
    return newest;
  }, [shares]);
}

export const SHOWCASE_SHARE_WORDS: Record<ThemeShowcaseSubmission["state"], string> = {
  inReview: "In review for the Showcase",
  listed: "In the Showcase",
  notAdded: "Not added to the Showcase",
};
