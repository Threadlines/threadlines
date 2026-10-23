/**
 * Renaming a thread where it has no row to type in (a general chat, the
 * command palette). The sidebar's own rows rename in place. Every other entry
 * point asks through openThreadRenameDialog; the host mounted once at the
 * root shows it.
 */
import type { ScopedThreadRef } from "@threadlines/contracts";
import { useState } from "react";
import { create } from "zustand";

import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

interface ThreadRenameDialogRequest {
  /** Each ask starts fresh, even for the same thread twice. */
  readonly id: number;
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
}

const useThreadRenameDialogStore = create<{ request: ThreadRenameDialogRequest | null }>(() => ({
  request: null,
}));

/** Opens the rename dialog for a thread with its title as it is now. */
export function openThreadRenameDialog(threadRef: ScopedThreadRef, title: string): void {
  const previous = useThreadRenameDialogStore.getState().request;
  useThreadRenameDialogStore.setState({
    request: { id: (previous?.id ?? 0) + 1, threadRef, title },
  });
}

/** Closes the dialog; with `requestId`, only if it still shows that ask. */
export function closeThreadRenameDialog(requestId?: number): void {
  const { request } = useThreadRenameDialogStore.getState();
  if (requestId !== undefined && request?.id !== requestId) return;
  useThreadRenameDialogStore.setState({ request: null });
}

/** Mounted once at the root; shows whatever openThreadRenameDialog asks. */
export function ThreadRenameDialogHost() {
  const request = useThreadRenameDialogStore((state) => state.request);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) closeThreadRenameDialog();
      }}
    >
      {request ? <ThreadRenameDialogContent key={request.id} request={request} /> : null}
    </Dialog>
  );
}

function ThreadRenameDialogContent({ request }: { readonly request: ThreadRenameDialogRequest }) {
  const [title, setTitle] = useState(request.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = title.trim();
  const canSave = trimmed.length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    if (trimmed === request.title) {
      closeThreadRenameDialog(request.id);
      return;
    }
    const api = readEnvironmentApi(request.threadRef.environmentId);
    if (!api) {
      setError("This thread's computer isn't connected.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: request.threadRef.threadId,
        title: trimmed,
      });
      // A save that lands after the dialog moved on to another thread
      // leaves that one open.
      closeThreadRenameDialog(request.id);
    } catch (cause) {
      setSaving(false);
      setError(cause instanceof Error ? cause.message : "The thread couldn't be renamed.");
    }
  };

  return (
    <DialogPopup className="max-w-md" data-testid="thread-rename-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <Input
            aria-label="Thread name"
            data-testid="thread-rename-input"
            value={title}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => closeThreadRenameDialog()}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave} data-testid="thread-rename-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
