/**
 * Renaming a thread where it has no row to type in (a general chat, the
 * command palette). The sidebar's own rows rename in place. Every other entry
 * point asks through openThreadRenameDialog; the host mounted once at the
 * root shows it.
 */
import type { ScopedThreadRef } from "@threadlines/contracts";
import { create } from "zustand";

import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "../lib/utils";
import { RenameDialogForm } from "./RenameDialogForm";
import { Dialog } from "./ui/dialog";

interface ThreadRenameDialogRequest {
  /** Each ask starts fresh, even for the same thread twice. */
  readonly id: number;
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
}

const useThreadRenameDialogStore = create<{ request: ThreadRenameDialogRequest | null }>(() => ({
  request: null,
}));

/** Never reused, so a save that lands late can't close a later ask. */
let lastRequestId = 0;

/** Opens the rename dialog for a thread with its title as it is now. */
export function openThreadRenameDialog(threadRef: ScopedThreadRef, title: string): void {
  lastRequestId += 1;
  useThreadRenameDialogStore.setState({
    request: { id: lastRequestId, threadRef, title },
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
  return (
    <RenameDialogForm
      title="Rename thread"
      inputLabel="Thread name"
      initialValue={request.title}
      failure="The thread couldn't be renamed."
      testId="thread-rename"
      onClose={() => closeThreadRenameDialog()}
      onSave={async (title) => {
        const api = readEnvironmentApi(request.threadRef.environmentId);
        if (!api) throw new Error("This thread's computer isn't connected.");
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: request.threadRef.threadId,
          title,
        });
        // A save that lands after the dialog moved on to another thread
        // leaves that one open.
        closeThreadRenameDialog(request.id);
      }}
    />
  );
}
