import { memo } from "react";
import {
  AtSignIcon,
  BookmarkIcon,
  BookmarkPlusIcon,
  CameraIcon,
  ChevronRightIcon,
  CirclePlusIcon,
  FileUpIcon,
  ImageIcon,
  XIcon,
} from "lucide-react";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Drawer, DrawerPopup, DrawerTitle } from "../ui/drawer";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ComposerStashDeleteConfirmation,
  ComposerStashMenuItems,
  stashEntrySnippet,
  useComposerStashDelete,
  type ComposerStashProps,
} from "./ComposerStashControl";

export interface ComposerAddMenuProps {
  /** Phones get a sheet with the camera and photo library as their own rows. */
  isMobileViewport: boolean;
  /** Nothing can be added right now (a question or approval is waiting). */
  disabled: boolean;
  disabledReason: string | null;
  /** The thread works in a project, so its files can be mentioned with @. */
  canReferenceProjectFiles: boolean;
  /** Any file type (on a phone, the document picker). */
  onAttachFiles: () => void;
  /** Phones: the photo library. */
  onAddPhotos: () => void;
  /** Phones: the camera. */
  onTakePhoto: () => void;
  /** Types "@" at the caret, which opens the project file search. */
  onReferenceProjectFile: () => void;
  stash: ComposerStashProps;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Stashed prompts list, which the stash shortcut opens on its own. */
  stashListOpen: boolean;
  onStashListOpenChange: (open: boolean) => void;
}

const TRIGGER_CLASS_NAME = "rounded-full text-muted-foreground hover:text-foreground";

/**
 * The composer's "+": everything you can add to a message. Files and images,
 * a project file by @ mention, and the stash (park what you typed, or bring
 * a parked prompt back). On a phone it opens as a sheet from the bottom with
 * the photo library and camera first.
 */
export const ComposerAddMenu = memo(function ComposerAddMenu(props: ComposerAddMenuProps) {
  const { open, onOpenChange, stashListOpen, onStashListOpenChange } = props;
  const setOpen = (next: boolean) => {
    onOpenChange(next);
    if (!next) onStashListOpenChange(false);
  };
  const stashDelete = useComposerStashDelete(props.stash.onDelete);
  // The confirm dialog takes focus from the menu; without this the menu and
  // its stash list would close underneath it and be gone once it resolves.
  const handleOpenChange = (next: boolean) => {
    if (!next && stashDelete.deleteConfirmOpen) return;
    setOpen(next);
  };
  const handleStashListOpenChange = (next: boolean) => {
    if (!next && stashDelete.deleteConfirmOpen) return;
    onStashListOpenChange(next);
  };
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  if (props.disabled) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={TRIGGER_CLASS_NAME}
              aria-label="Add to message"
              disabled
            />
          }
        >
          <CirclePlusIcon className="size-4.5" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">{props.disabledReason ?? "Add to message"}</TooltipPopup>
      </Tooltip>
    );
  }

  const { entries, canStash, stashShortcutLabel, onStash, onRestore } = props.stash;
  const deleteConfirmation = (
    <ComposerStashDeleteConfirmation
      pendingDelete={stashDelete.pendingDelete}
      open={stashDelete.deleteConfirmOpen}
      onOpenChange={stashDelete.setDeleteConfirmOpen}
      onConfirm={stashDelete.confirmPendingDelete}
    />
  );

  if (props.isMobileViewport) {
    return (
      <>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={TRIGGER_CLASS_NAME}
          aria-label="Add to message"
          aria-haspopup="dialog"
          aria-expanded={open}
          // Keeps the keyboard up: the sheet opens over it.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setOpen(true)}
        >
          <CirclePlusIcon className="size-5" aria-hidden="true" />
        </Button>
        <Drawer open={open} onOpenChange={handleOpenChange}>
          <DrawerPopup side="bottom" data-composer-add-sheet="true">
            <DrawerTitle className="sr-only">Add to this message</DrawerTitle>
            <PhoneAddSheet
              {...props}
              onDone={() => setOpen(false)}
              onRequestDelete={stashDelete.requestDelete}
            />
          </DrawerPopup>
        </Drawer>
        {deleteConfirmation}
      </>
    );
  }

  return (
    <>
      <Menu open={open} onOpenChange={handleOpenChange}>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={TRIGGER_CLASS_NAME}
              aria-label="Add to message"
            />
          }
        >
          <CirclePlusIcon className="size-4.5" aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="start" side="top" className="min-w-60">
          <MenuItem onClick={run(props.onAttachFiles)}>
            <FileUpIcon aria-hidden="true" />
            Files and images…
          </MenuItem>
          {props.canReferenceProjectFiles ? (
            <MenuItem onClick={run(props.onReferenceProjectFile)}>
              <AtSignIcon aria-hidden="true" />
              Project file
              <MenuShortcut>@</MenuShortcut>
            </MenuItem>
          ) : null}
          <MenuSeparator />
          {canStash ? (
            <MenuItem onClick={run(onStash)}>
              <BookmarkPlusIcon aria-hidden="true" />
              Stash this prompt
              {stashShortcutLabel ? <MenuShortcut>{stashShortcutLabel}</MenuShortcut> : null}
            </MenuItem>
          ) : null}
          <MenuSub open={stashListOpen} onOpenChange={handleStashListOpenChange}>
            <MenuSubTrigger>
              <BookmarkIcon aria-hidden="true" />
              Stashed prompts
              {entries.length > 0 ? (
                <span className="ms-auto font-mono text-muted-foreground text-xs tabular-nums">
                  {entries.length}
                </span>
              ) : null}
            </MenuSubTrigger>
            <MenuSubPopup className="w-96 max-w-[min(24rem,calc(100vw-2rem))]">
              <ComposerStashMenuItems
                entries={entries}
                stashShortcutLabel={stashShortcutLabel}
                onRestore={(entry) => {
                  setOpen(false);
                  onRestore(entry);
                }}
                onDelete={stashDelete.requestDelete}
              />
            </MenuSubPopup>
          </MenuSub>
        </MenuPopup>
      </Menu>
      {deleteConfirmation}
    </>
  );
});

const SHEET_ROW_CLASS =
  "flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-base text-foreground outline-none hover:bg-accent focus-visible:bg-accent active:bg-accent [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

function PhoneAddSheet(
  props: ComposerAddMenuProps & {
    onDone: () => void;
    onRequestDelete: (entry: ComposerStashProps["entries"][number]) => void;
  },
) {
  const showStash = props.stashListOpen;
  const setShowStash = props.onStashListOpenChange;
  const { entries, canStash, onStash, onRestore } = props.stash;
  const run = (action: () => void) => () => {
    props.onDone();
    action();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-2 pb-3">
      <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 shrink-0 rounded-full bg-border" />
      {showStash ? (
        <>
          <button type="button" className={SHEET_ROW_CLASS} onClick={() => setShowStash(false)}>
            <ChevronRightIcon aria-hidden="true" className="rotate-180" />
            <span className="font-medium">Stashed prompts</span>
          </button>
          {entries.length === 0 ? (
            <p className="px-3 py-2 text-muted-foreground text-sm">Nothing stashed yet.</p>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-1">
                <button
                  type="button"
                  className={SHEET_ROW_CLASS}
                  onClick={run(() => onRestore(entry))}
                >
                  <BookmarkIcon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{stashEntrySnippet(entry)}</span>
                  <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                    {formatRelativeTimeLabel(entry.createdAt)}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete stashed prompt: ${stashEntrySnippet(entry)}`}
                  onClick={() => props.onRequestDelete(entry)}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            ))
          )}
        </>
      ) : (
        <>
          <p className="px-3 pb-1 text-muted-foreground text-sm">Add to this message</p>
          <button type="button" className={SHEET_ROW_CLASS} onClick={run(props.onAddPhotos)}>
            <ImageIcon aria-hidden="true" />
            Photos
          </button>
          <button type="button" className={SHEET_ROW_CLASS} onClick={run(props.onTakePhoto)}>
            <CameraIcon aria-hidden="true" />
            Take photo
          </button>
          <button type="button" className={SHEET_ROW_CLASS} onClick={run(props.onAttachFiles)}>
            <FileUpIcon aria-hidden="true" />
            Files
          </button>
          {props.canReferenceProjectFiles ? (
            <button
              type="button"
              className={SHEET_ROW_CLASS}
              onClick={run(props.onReferenceProjectFile)}
            >
              <AtSignIcon aria-hidden="true" />
              Project file
            </button>
          ) : null}
          <div className="mx-3 my-1.5 h-px bg-border" />
          {canStash ? (
            <button type="button" className={SHEET_ROW_CLASS} onClick={run(onStash)}>
              <BookmarkPlusIcon aria-hidden="true" />
              Stash this prompt
            </button>
          ) : null}
          <button type="button" className={SHEET_ROW_CLASS} onClick={() => setShowStash(true)}>
            <BookmarkIcon aria-hidden="true" />
            Stashed prompts
            <span className="ms-auto flex items-center gap-1 font-mono text-muted-foreground text-sm tabular-nums">
              {entries.length > 0 ? entries.length : null}
              <ChevronRightIcon aria-hidden="true" className="size-4!" />
            </span>
          </button>
        </>
      )}
    </div>
  );
}
