import { SquarePenIcon, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { scopedProjectKey, scopeProjectRef } from "@threadlines/client-runtime";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import { cn } from "../../lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  resolveRowSurfaceTone,
  ROW_ACTION_BUTTON_CLASS_NAME,
  ROW_SURFACE_CLASS_NAME,
} from "./InboxRows";

const SNIPPET_MAX_CHARS = 90;

/**
 * What the sidebar knows about the project a draft session targets, keyed by
 * scoped project ref. Built once by the sidebar so a draft row costs no store
 * subscription of its own.
 */
export interface SidebarDraftProjectInfo {
  /** Logical (possibly grouped) key, the same one the inbox scope filters on. */
  projectKey: string;
  displayName: string;
  cwd: string;
  isGeneralChat: boolean;
}

export type SidebarDraftProjectInfoByScopedRef = ReadonlyMap<string, SidebarDraftProjectInfo>;

interface DraftSessionSlices {
  draftThreadsByThreadKey: Record<string, DraftSessionState>;
  draftsByThreadKey: Record<string, ComposerThreadDraftState>;
}

function draftProjectRefKey(session: DraftSessionState): string {
  return scopedProjectKey(scopeProjectRef(session.environmentId, session.projectId));
}

/**
 * The half of the row filter that does not depend on composer content, so the
 * open draft's frozen row and the live rows can share it.
 *
 * General chats have their own page and never join the inbox, so their drafts
 * stay out of it too. A draft whose project is unknown here (another machine,
 * or a project removed since) still gets a row while the inbox is unscoped —
 * it cannot belong to a scope it has no key for.
 */
function draftSessionMatchesScope(input: {
  session: DraftSessionState;
  project: SidebarDraftProjectInfo | undefined;
  scopedProjectKey: string | null;
  scopedEnvironmentId: string | null;
}): boolean {
  if (input.project?.isGeneralChat === true) {
    return false;
  }
  if (
    input.scopedEnvironmentId !== null &&
    input.session.environmentId !== input.scopedEnvironmentId
  ) {
    return false;
  }
  if (input.scopedProjectKey === null) {
    return true;
  }
  return input.project?.projectKey === input.scopedProjectKey;
}

/**
 * How many draft rows the block will render, for the sidebar's empty state.
 *
 * Selecting a number keeps typing in a draft composer from re-rendering the
 * whole sidebar — {@link SidebarDraftBlock} owns the per-keystroke content
 * subscription. Gate order mirrors the block's row filter exactly, including
 * the frozen-row rule for the open draft, so "No threads yet" stays up while
 * the user types into a draft that is not showing a row yet.
 */
export function countVisibleDraftSessions(input: {
  store: DraftSessionSlices;
  projectInfoByScopedRef: SidebarDraftProjectInfoByScopedRef;
  scopedProjectKey: string | null;
  scopedEnvironmentId: string | null;
  routeDraftId: string | null;
  frozenOpenDraftRow: SidebarDraftRowData | null;
}): number {
  let count = 0;
  for (const [draftKey, session] of Object.entries(input.store.draftThreadsByThreadKey)) {
    if (session.promotedTo != null) {
      continue;
    }
    if (
      !draftSessionMatchesScope({
        session,
        project: input.projectInfoByScopedRef.get(draftProjectRefKey(session)),
        scopedProjectKey: input.scopedProjectKey,
        scopedEnvironmentId: input.scopedEnvironmentId,
      })
    ) {
      continue;
    }
    if (draftKey === input.routeDraftId) {
      if (input.frozenOpenDraftRow?.draftId === draftKey) {
        count += 1;
      }
      continue;
    }
    if (!composerDraftHasUserContent(input.store.draftsByThreadKey[draftKey])) {
      continue;
    }
    count += 1;
  }
  return count;
}

/**
 * The row's one line of content: the first line of the typed prompt, or a
 * count of the chips a wordless draft carries.
 */
function describeComposerDraft(draft: ComposerThreadDraftState): string {
  const promptPreview = draft.prompt.trim().split("\n", 1)[0] ?? "";
  if (promptPreview.length > 0) {
    return promptPreview;
  }
  // `attachments` mirrors `persistedAttachments` once rehydration finishes;
  // before that only the persisted list is populated, hence max not sum.
  const attachmentCount = Math.max(draft.attachments.length, draft.persistedAttachments.length);
  // Same vocabulary as the prompt stash: files are attachments, everything
  // else the composer carries is a chip.
  const chipCount =
    draft.terminalContexts.length +
    draft.transcriptHighlightContexts.length +
    draft.fileSelectionContexts.length +
    draft.pickedElementContexts.length +
    draft.drawingContexts.length;
  if (attachmentCount > 0) {
    return `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  }
  return `${chipCount} chip${chipCount === 1 ? "" : "s"}`;
}

function toSnippet(text: string): string {
  return text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS - 1)}…` : text;
}

export interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
}

/**
 * The open draft's row, FROZEN at the moment the draft became the route: it
 * stays visible (like a thread row) but never repaints while the user types. A
 * draft that has never been navigated away from has no snapshot to freeze, so a
 * fresh typing session shows no row at all. Captured synchronously on route
 * change (setState-during-render derived state) so the row never flickers out
 * for a frame between route change and capture.
 *
 * Owned by the sidebar, not the block, so the row count gating the empty state
 * and the rows the block renders can never disagree.
 */
export function useFrozenOpenDraftRow(routeDraftId: string | null): SidebarDraftRowData | null {
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId === routeDraftId) {
    return frozenActive.row;
  }
  let row: SidebarDraftRowData | null = null;
  if (routeDraftId !== null) {
    const draftId = DraftId.make(routeDraftId);
    const store = useComposerDraftStore.getState();
    const session = store.getDraftSession(draftId);
    const composer = store.getComposerDraft(draftId);
    row =
      session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
        ? { composer, draftId, session }
        : null;
  }
  setFrozenActive({ routeDraftId, row });
  return row;
}

/**
 * One unsent draft session the user has invested content in. Two lines,
 * nothing else: project name, then the typed prompt. All the draft's settings
 * (model, env mode, branch, worktree) still travel with it — clicking is a
 * plain navigation to /draft/$draftId, which touches nothing.
 *
 * While the draft is open the row renders a frozen snapshot (see
 * {@link SidebarDraftBlock}); memoized so per-keystroke block re-renders skip
 * it entirely.
 */
const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  composer: ComposerThreadDraftState;
  session: DraftSessionState;
  project: SidebarDraftProjectInfo | undefined;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onRequestDiscard: (row: SidebarDraftRowData) => void;
}) {
  const { composer, draftId, isActive, onNavigate, onRequestDiscard, project, session } = props;
  const preview = describeComposerDraft(composer);
  const handleActivate = useCallback(() => {
    onNavigate(draftId);
  }, [draftId, onNavigate]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Keys targeting the nested discard button belong to the button:
      // preventDefault here would swallow Space's synthesized click and
      // navigate instead of discarding.
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onNavigate(draftId);
    },
    [draftId, onNavigate],
  );
  const handleDiscardClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onRequestDiscard({ composer, draftId, session });
    },
    [composer, draftId, onRequestDiscard, session],
  );
  return (
    <li className="group/draft-row relative w-full">
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-draft-row"
        className={cn(
          ROW_SURFACE_CLASS_NAME,
          "flex flex-col gap-0.5 px-3 py-1.5",
          resolveRowSurfaceTone({ isActive, isSelected: false }),
        )}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <SquarePenIcon
            aria-hidden="true"
            className="size-3 shrink-0 text-amber-600 dark:text-amber-300/90"
          />
          {project ? (
            <ProjectFavicon
              environmentId={session.environmentId}
              cwd={project.cwd}
              name={project.displayName}
              className="size-3.5 shrink-0 opacity-70"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
            {project?.displayName ?? "Unknown project"}
          </span>
          <button
            type="button"
            data-thread-selection-safe
            data-testid="sidebar-draft-discard"
            aria-label="Discard draft"
            className={cn(
              ROW_ACTION_BUTTON_CLASS_NAME,
              "size-4 opacity-0 transition-opacity group-hover/draft-row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
            )}
            onClick={handleDiscardClick}
          >
            <XIcon className="size-3" />
          </button>
        </div>
        <span
          className="min-w-0 truncate text-xs text-foreground/90"
          data-testid="sidebar-draft-preview"
        >
          {preview}
        </span>
      </div>
    </li>
  );
});

/**
 * Draft sessions with user content, surfaced above the inbox rows so an
 * interrupted "new thread" stays one click away. Self-contained (own store
 * subscription + closing divider) so per-keystroke composer updates re-render
 * only this block, never the whole sidebar. Vanishes at count 0.
 */
export const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectInfoByScopedRef: SidebarDraftProjectInfoByScopedRef;
  scopedProjectKey: string | null;
  scopedEnvironmentId: string | null;
  routeDraftId: string | null;
  /** From {@link useFrozenOpenDraftRow}, owned by the sidebar. */
  frozenOpenDraftRow: SidebarDraftRowData | null;
  onNavigateToDraft: (draftId: DraftId) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const [pendingDiscard, setPendingDiscard] = useState<SidebarDraftRowData | null>(null);
  const {
    frozenOpenDraftRow,
    projectInfoByScopedRef,
    routeDraftId,
    scopedEnvironmentId,
    scopedProjectKey: scopeKey,
  } = props;
  const drafts = useMemo(() => {
    const rows: SidebarDraftRowData[] = [];
    // Every non-promoted session with content gets a row, mapped or not:
    // new-thread surfaces mint fresh drafts and leave invested ones behind
    // unmapped, so the mapping only knows about the latest per project.
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (
        !draftSessionMatchesScope({
          session,
          project: projectInfoByScopedRef.get(draftProjectRefKey(session)),
          scopedProjectKey: scopeKey,
          scopedEnvironmentId,
        })
      ) {
        continue;
      }
      if (draftKey === routeDraftId) {
        // Open draft: render the frozen entry snapshot, or nothing for a draft
        // that has never been left. Gated on the LIVE session above so send and
        // discard still remove the row immediately.
        if (frozenOpenDraftRow?.draftId === draftKey) {
          rows.push(frozenOpenDraftRow);
        }
        continue;
      }
      const composer = draftsByThreadKey[draftKey];
      if (!composer || !composerDraftHasUserContent(composer)) {
        continue;
      }
      rows.push({ composer, draftId: DraftId.make(draftKey), session });
    }
    rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    return rows;
  }, [
    draftThreadsByThreadKey,
    draftsByThreadKey,
    frozenOpenDraftRow,
    projectInfoByScopedRef,
    routeDraftId,
    scopedEnvironmentId,
    scopeKey,
  ]);
  const handleDiscardOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setPendingDiscard(null);
    }
  }, []);
  const confirmDiscard = useCallback(() => {
    if (pendingDiscard === null) {
      return;
    }
    // The /draft/$draftId route redirects home on its own when the draft it
    // renders disappears, so discarding the open draft needs no special-casing
    // here.
    clearDraftThread(pendingDiscard.draftId);
    setPendingDiscard(null);
  }, [clearDraftThread, pendingDiscard]);
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      <ul data-testid="sidebar-draft-list">
        {drafts.map((row) => (
          <SidebarDraftRow
            key={row.draftId}
            draftId={row.draftId}
            composer={row.composer}
            session={row.session}
            project={projectInfoByScopedRef.get(draftProjectRefKey(row.session))}
            isActive={row.draftId === routeDraftId}
            onNavigate={props.onNavigateToDraft}
            onRequestDiscard={setPendingDiscard}
          />
        ))}
      </ul>
      <span
        aria-hidden="true"
        data-testid="sidebar-draft-divider"
        className="mx-3 my-1.5 block h-px bg-sidebar-border"
      />
      {/* Typed text is real work: discarding it asks first, the same way a
          stashed prompt does. */}
      <AlertDialog open={pendingDiscard !== null} onOpenChange={handleDiscardOpenChange}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard draft?</AlertDialogTitle>
            <AlertDialogDescription>
              "{pendingDiscard ? toSnippet(describeComposerDraft(pendingDiscard.composer)) : ""}"
              will be discarded. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDiscard}>
              Discard
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});
