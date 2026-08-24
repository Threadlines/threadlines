import { BookmarkIcon, XIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import { cn } from "~/lib/utils";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";

const SNIPPET_MAX_CHARS = 90;
const MAX_ROW_THUMBNAILS = 3;

export interface ComposerStashControlProps {
  entries: ReadonlyArray<PromptStashEntry>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The composer has something worth stashing right now. */
  canStash: boolean;
  /** Rendered right-aligned on the stash action row; null when unbound. */
  stashShortcutLabel: string | null;
  onStash: () => void;
  onRestore: (entry: PromptStashEntry) => void;
  /** Called only after the user confirms the delete dialog. */
  onDelete: (entry: PromptStashEntry) => void;
}

export function useComposerStashDelete(onDelete: ComposerStashControlProps["onDelete"]) {
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

function stashEntrySnippet(entry: PromptStashEntry): string {
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
 * Popover body: the queue as a dense divided list, with the stash action for
 * the current prompt pinned at the bottom. The popup opens above the trigger,
 * so the bottom row is what a straight upward hover from the trigger lands
 * on; keeping the harmless action there means that path never crosses an
 * entry's delete button.
 */
export const ComposerStashMenuItems = memo(function ComposerStashMenuItems(
  props: ComposerStashControlProps,
) {
  const { entries, canStash, stashShortcutLabel, onStash, onRestore, onDelete } = props;

  return (
    <>
      {entries.length === 0 ? (
        <p className="px-2 py-1.5 text-muted-foreground text-xs">
          Nothing stashed yet. Press {stashShortcutLabel ?? "the stash shortcut"} with a prompt
          typed to stash it.
        </p>
      ) : (
        entries.map((entry) => (
          <StashEntryRow key={entry.id} entry={entry} onRestore={onRestore} onDelete={onDelete} />
        ))
      )}
      {canStash ? (
        <>
          {/* Entry rows carry their own bottom hairline, so a separator is
              only needed after the borderless empty-state text. */}
          {entries.length === 0 ? <MenuSeparator /> : null}
          <MenuItem onClick={onStash}>
            <BookmarkIcon aria-hidden="true" />
            Stash this prompt
            {stashShortcutLabel ? <MenuShortcut>{stashShortcutLabel}</MenuShortcut> : null}
          </MenuItem>
        </>
      ) : null}
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

/**
 * Composer footer stash control: a bookmark button carrying the queue depth,
 * opening the stashed prompts above it. Always visible, so the queue is never
 * something the user has to remember a shortcut to find.
 */
export const ComposerStashControl = memo(function ComposerStashControl(
  props: ComposerStashControlProps,
) {
  const { entries, open, onOpenChange, onDelete } = props;
  const stashDelete = useComposerStashDelete(onDelete);

  // The confirm dialog steals focus from the menu; without this guard the
  // menu would close underneath it and the stash list would be gone once
  // the dialog resolves.
  const handleMenuOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && stashDelete.deleteConfirmOpen) {
        return;
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, stashDelete.deleteConfirmOpen],
  );

  return (
    <>
      <Menu open={open} onOpenChange={handleMenuOpenChange}>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size={entries.length > 0 ? "sm" : "icon-sm"}
              className={cn(
                "rounded-full text-muted-foreground/70 hover:text-foreground/80",
                entries.length > 0 && "gap-1 px-2",
              )}
              aria-label={
                entries.length > 0 ? `Stashed prompts (${entries.length})` : "Stashed prompts"
              }
            />
          }
        >
          <BookmarkIcon className="size-4" aria-hidden="true" />
          {entries.length > 0 ? (
            <span className="text-xs tabular-nums">{entries.length}</span>
          ) : null}
        </MenuTrigger>
        <MenuPopup
          align="end"
          // Negative = rightward for end alignment. Nudges the popup so the
          // straight-up hover path from the trigger meets a row's timestamp,
          // not the delete button that sits flush-right above an end-aligned
          // trigger. Collision handling still pulls it back near the viewport
          // edge.
          alignOffset={-32}
          side="top"
          className="w-96 max-w-[min(24rem,calc(100vw-2rem))]"
        >
          <ComposerStashMenuItems {...props} onDelete={stashDelete.requestDelete} />
        </MenuPopup>
      </Menu>
      <ComposerStashDeleteConfirmation
        pendingDelete={stashDelete.pendingDelete}
        open={stashDelete.deleteConfirmOpen}
        onOpenChange={stashDelete.setDeleteConfirmOpen}
        onConfirm={stashDelete.confirmPendingDelete}
      />
    </>
  );
});
