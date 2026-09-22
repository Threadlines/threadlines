/**
 * The card behind every pull request chip: the one in a transcript and the
 * `#number` on the composer's pull request row.
 *
 * A chip is a number and a colour, which is the right size for a line of
 * prose and too small to answer "which one is that, and how is it going". The
 * card answers exactly that, and nothing more: the state, the repository, when
 * it last moved, its title, who wrote it and how big it is.
 *
 * One handle per surface, the way {@link ThreadHoverCard} does it: two preview
 * card roots sharing a handle is undefined behaviour, so each surface creates
 * its own and every chip inside points at that one. A chip rendered outside a
 * provider (a transcript in the pull request panel, say) stays a chip.
 *
 * @module PullRequestHoverCard
 */
import type { EnvironmentId, PullRequestRef, PullRequestState } from "@threadlines/contracts";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/shallow";

import { DiffStatLabel } from "../chat/DiffStatLabel";
import {
  pullRequestDetailQueryOptions,
  useLoadedPullRequestEntries,
} from "../../lib/pullRequestsReactQuery";
import { cn } from "../../lib/utils";
import { selectWorkspaceProjectsAcrossEnvironments, useStore } from "../../store";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
  createPreviewCardHandle,
} from "../ui/previewCard";
import { PullRequestActorAvatar } from "./pullRequestPresentation";
import {
  projectRepository,
  pullRequestArmedToMerge,
  pullRequestBadgeTone,
  type ThreadPullRequest,
} from "./pullRequests.logic";

/** What a chip knows about its pull request before the card reads anything. */
export interface PullRequestChipState {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  /** The host is landing it on its own: armed, or already in the merge queue. */
  readonly autoMergeEnabled: boolean;
}

/** Everything the card needs to draw itself and then read the rest. */
export interface PullRequestHoverCardPayload extends PullRequestChipState {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
}

type PullRequestCardHandle = ReturnType<
  typeof createPreviewCardHandle<PullRequestHoverCardPayload>
>;

/** The checkout whose host tool can read one repository. */
interface PullRequestRepositoryScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: PullRequestRef["projectId"];
  readonly repository: string;
}

interface PullRequestChipSurface {
  readonly handle: PullRequestCardHandle;
  /** The state a chip wears, keyed by {@link chipKey}. */
  readonly stateByKey: ReadonlyMap<string, PullRequestChipState>;
  /** Which environment and project can read a repository, keyed by its lowercased name. */
  readonly scopeByRepository: ReadonlyMap<string, PullRequestRepositoryScope>;
}

const PullRequestChipSurfaceContext = createContext<PullRequestChipSurface | null>(null);

function chipKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}:${number}`;
}

/**
 * What one chip should look like and, where the workspace can read it, what the
 * card would address. A repository no project here points at still gets a chip,
 * drawn as an open pull request in the muted tone that says "state unknown".
 */
export function usePullRequestChip(
  repository: string,
  number: number,
): {
  readonly state: PullRequestChipState | null;
  readonly payload: PullRequestHoverCardPayload | null;
} {
  const surface = useContext(PullRequestChipSurfaceContext);
  const state = surface?.stateByKey.get(chipKey(repository, number)) ?? null;
  const scope = surface?.scopeByRepository.get(repository.toLowerCase()) ?? null;
  return useMemo(
    () => ({
      state,
      payload:
        scope === null
          ? null
          : {
              environmentId: scope.environmentId,
              reference: { projectId: scope.projectId, repository: scope.repository, number },
              state: state?.state ?? "open",
              isDraft: state?.isDraft ?? false,
              autoMergeEnabled: state?.autoMergeEnabled ?? false,
            },
    }),
    [number, scope, state],
  );
}

/**
 * A chip's half of the card: a trigger carrying its pull request as payload.
 * Renders its child untouched where the surface has no card, or where the
 * workspace cannot read this repository and there would be nothing to show.
 */
export function PullRequestHoverCard({
  payload,
  children,
}: {
  readonly payload: PullRequestHoverCardPayload | null;
  readonly children: ReactNode;
}) {
  const surface = useContext(PullRequestChipSurfaceContext);
  if (surface === null || payload === null) {
    return <>{children}</>;
  }
  return (
    <PreviewCardTrigger
      handle={surface.handle}
      closeDelay={120}
      payload={payload}
      render={children as never}
    />
  );
}

/**
 * A surface's card and the two lookups its chips read: which state a pull
 * request is in, and which checkout could read it. Both are computed once here
 * rather than per chip, so a transcript full of references costs one
 * subscription.
 */
export function PullRequestHoverCardProvider({
  threadPullRequest = null,
  children,
}: {
  /**
   * The thread's own pull request, whose state the listings may not carry: a
   * checkout reports a merge long before the merged listing is re-read.
   */
  readonly threadPullRequest?: ThreadPullRequest | null;
  readonly children: ReactNode;
}) {
  const [handle] = useState(() => createPreviewCardHandle<PullRequestHoverCardPayload>());
  const entries = useLoadedPullRequestEntries();
  const projects = useStore(useShallow(selectWorkspaceProjectsAcrossEnvironments));

  const stateByKey = useMemo(() => {
    const byKey = new Map<string, PullRequestChipState>();
    for (const entry of entries) {
      byKey.set(chipKey(entry.repository, entry.number), {
        state: entry.state,
        isDraft: entry.isDraft,
        autoMergeEnabled: entry.autoMergeEnabled === true,
      });
    }
    // The thread's own resolution wins: it is the one read that can see a
    // branch land without waiting for the settled listing to come round again.
    if (threadPullRequest?.repository) {
      byKey.set(chipKey(threadPullRequest.repository, threadPullRequest.number), {
        state: threadPullRequest.state,
        isDraft: threadPullRequest.isDraft,
        autoMergeEnabled: threadPullRequest.autoMergeEnabled,
      });
    }
    return byKey;
  }, [entries, threadPullRequest]);

  const scopeByRepository = useMemo(() => {
    const byRepository = new Map<string, PullRequestRepositoryScope>();
    for (const project of projects) {
      const repository = projectRepository(project);
      if (repository === null || byRepository.has(repository.toLowerCase())) {
        continue;
      }
      byRepository.set(repository.toLowerCase(), {
        environmentId: project.environmentId,
        projectId: project.id,
        repository,
      });
    }
    return byRepository;
  }, [projects]);

  const surface = useMemo<PullRequestChipSurface>(
    () => ({ handle, scopeByRepository, stateByKey }),
    [handle, scopeByRepository, stateByKey],
  );

  return (
    <PullRequestChipSurfaceContext.Provider value={surface}>
      {children}
      <PreviewCard handle={handle}>
        {({ payload }: { payload: PullRequestHoverCardPayload | undefined }) => (
          <PreviewCardPopup
            side="top"
            sideOffset={8}
            align="start"
            className="w-[372px] max-w-[calc(100vw-2rem)] rounded-md p-2.5 text-left shadow-none elevate-popover"
            data-testid="pull-request-hover-card"
          >
            {payload ? <PullRequestHoverCardContent {...payload} /> : null}
          </PreviewCardPopup>
        )}
      </PreviewCard>
    </PullRequestChipSurfaceContext.Provider>
  );
}

function PullRequestHoverCardContent({
  environmentId,
  reference,
  state,
  isDraft,
  autoMergeEnabled,
}: PullRequestHoverCardPayload) {
  const detail = useQuery(pullRequestDetailQueryOptions({ environmentId, reference })).data;
  const tone = pullRequestBadgeTone(
    detail?.state ?? state,
    detail?.isDraft ?? isDraft,
    detail ? pullRequestArmedToMerge(detail) : autoMergeEnabled,
  );
  const settledAt = detail ? (detail.mergedAt ?? detail.closedAt) : null;
  const timestamp = detail ? formatRelativeTimeLabel(settledAt ?? detail.updatedAt) : null;

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            // The tone tints its own background rather than naming a second
            // colour: one table decides what open, merged and closed look like.
            "inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,currentColor_14%,transparent)] px-1.5 font-medium",
            tone.className,
          )}
        >
          <tone.Icon aria-hidden className="size-3" />
          {tone.label}
        </span>
        <span className="min-w-0 truncate font-mono text-muted-foreground">
          {reference.repository} #{reference.number}
        </span>
        {timestamp ? (
          <span className="ml-auto shrink-0 text-muted-foreground">{timestamp}</span>
        ) : null}
      </div>
      <p
        className={cn(
          "mt-1.5 line-clamp-2 font-semibold text-[13px] leading-snug",
          detail ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {detail?.title ?? "Loading…"}
      </p>
      {detail ? (
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <PullRequestActorAvatar actor={detail.author} />
          <span className="min-w-0 truncate">{detail.author?.login ?? "ghost"}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="rounded-sm bg-muted px-1.5 font-mono">
              <DiffStatLabel
                additions={detail.additions}
                deletions={detail.deletions}
                separator="space"
              />
            </span>
            <span className="rounded-sm bg-muted px-1.5 font-mono">
              {detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}
            </span>
          </span>
        </div>
      ) : null}
    </>
  );
}
