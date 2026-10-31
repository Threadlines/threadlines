import { BookmarkIcon, XIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import { stripInlineTerminalContextPlaceholders } from "../../lib/terminalContext";
import { stashEntryChipCount, type PromptStashEntry } from "../../promptStashStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
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
import { MenuItem } from "../ui/menu";

const SNIPPET_MAX_CHARS = 90;
const MAX_ROW_THUMBNAILS = 3;

/** The composer's stash: parked prompts, shown in the "+" menu. */
export interface ComposerStashProps {
  entries: ReadonlyArray<PromptStashEntry>;
  /** The composer has something worth stashing right now. */
  canStash: boolean;
  /** Rendered right-aligned on the stash action row; null when unbound. */
  stashShortcutLabel: string | null;
  onStash: () => void;
  onRestore: (entry: PromptStashEntry) => void;
  /** Called only after the user confirms the delete dialog. */
  onDelete: (entry: PromptStashEntry) => void;
}

export function useComposerStashDelete(onDelete: ComposerStashProps["onDelete"]) {
  // The entry survives past close so the dialog text stays put while the
  // popup animates out; only the open flag drives visibility.
  const [pendingDelete, setPendingDelete] = useState<PromptStashEntry | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const requestDelete = useCallback((entry: PromptStashEntry) => {
    setPendingDelete(entry);
    setDeleteConfirmOpen(true);
  }, []);
  const confirmPendingDelete = useCallback(() => {
    if (pendingDelete !== null) {
      onDelete(pendingDelete);
    }
    setDeleteConfirmOpen(false);
  }, [onDelete, pendingDelete]);

  return {
    pendingDelete,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    requestDelete,
    confirmPendingDelete,
  };
}

/** Attachments that did not make it into the entry, whatever the reason. */
function missingAttachmentCount(entry: PromptStashEntry): number {
  return entry.droppedAttachmentNames.length + (entry.unreadableAttachmentNames?.length ?? 0);
}

export function stashEntrySnippet(entry: PromptStashEntry): string {
  // Inline terminal placeholders are invisible object-replacement characters
  // in the live composer; left in they would render as tofu in the list.
  const trimmed = stripInlineTerminalContextPlaceholders(entry.prompt).trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) {
    return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed;
  }
  const attachmentCount = entry.attachments.length + entry.droppedAttachmentNames.length;
  if (attachmentCount > 0) {
    return `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  }
  const chipCount = stashEntryChipCount(entry);
  return chipCount > 0 ? `${chipCount} chip${chipCount === 1 ? "" : "s"}` : "Empty prompt";
}

const StashEntryRow = memo(function StashEntryRow(props: {
  entry: PromptStashEntry;
  onRestore: (entry: PromptStashEntry) => void;
  onDelete: (entry: PromptStashEntry) => void;
}) {
  const { entry, onRestore, onDelete } = props;
  const thumbnails = entry.attachments
    .filter((attachment) => attachment.mimeType.startsWith("image/"))
    .slice(0, MAX_ROW_THUMBNAILS);
  const chipCount = stashEntryChipCount(entry);
  const missingCount = missingAttachmentCount(entry);

  return (
    <MenuItem
      className="group/stash gap-2 rounded-none border-border border-b px-2 last:border-b-0"
      onClick={() => {
        onRestore(entry);
      }}
    >
      {thumbnails.length > 0 ? (
        <span className="-space-x-1.5 flex shrink-0 items-center">
          {thumbnails.map((attachment) => (
            <img
              key={attachment.id}
              src={attachment.dataUrl}
              alt=""
              aria-hidden="true"
              className="size-5 rounded-xs border border-border object-cover"
            />
          ))}
        </span>
      ) : (
        <BookmarkIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate">{stashEntrySnippet(entry)}</span>
      {chipCount > 0 ? (
        <span className="shrink-0 text-muted-foreground text-xs">
          {chipCount} chip{chipCount === 1 ? "" : "s"}
        </span>
      ) : null}
      {entry.pendingAttachmentCount ? (
        <span className="shrink-0 text-muted-foreground text-xs">
          saving {entry.pendingAttachmentCount}
        </span>
      ) : missingCount > 0 ? (
        <span className="shrink-0 text-warning-foreground text-xs">{missingCount} dropped</span>
      ) : null}
      <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
        {formatRelativeTimeLabel(entry.createdAt)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        // Always visible: a hover-revealed X materializes under the pointer
        // on the way into the popup, which is exactly how prompts get
        // discarded by accident. It also keeps delete reachable on touch.
        className="shrink-0 text-muted-foreground/50 hover:text-destructive"
        aria-label={`Delete stashed prompt: ${stashEntrySnippet(entry)}`}
        // The row itself restores on click; without both of these the delete
        // would restore the very prompt it is meant to throw away.
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDelete(entry);
        }}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </MenuItem>
  );
});

/**
 * The stashed prompts as a dense divided list, newest first: the "+" menu's
 * Stashed prompts submenu. Clicking a row restores it; its X asks first.
 */
export const ComposerStashMenuItems = memo(function ComposerStashMenuItems(
  props: Pick<ComposerStashProps, "entries" | "stashShortcutLabel" | "onRestore" | "onDelete">,
) {
  const { entries, stashShortcutLabel, onRestore, onDelete } = props;
  return entries.length === 0 ? (
    <p className="px-2 py-1.5 text-muted-foreground text-xs">
      Nothing stashed yet. Press {stashShortcutLabel ?? "the stash shortcut"} with a prompt typed to
      stash it.
    </p>
  ) : (
    <>
      {entries.map((entry) => (
        <StashEntryRow key={entry.id} entry={entry} onRestore={onRestore} onDelete={onDelete} />
      ))}
    </>
  );
});

export const ComposerStashDeleteConfirmation = memo(
  function ComposerStashDeleteConfirmation(props: {
    pendingDelete: PromptStashEntry | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
  }) {
    return (
      <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete stashed prompt?</AlertDialogTitle>
            <AlertDialogDescription>
              "{props.pendingDelete !== null ? stashEntrySnippet(props.pendingDelete) : ""}" will be
              removed from the stash. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={props.onConfirm}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    );
  },
);
