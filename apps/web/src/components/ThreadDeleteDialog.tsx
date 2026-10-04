import { useState } from "react";
import { create } from "zustand";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { formatChildThreadCount } from "./Sidebar.logic";

/** The user's answer: delete, and whether its threads go too. Null: keep it. */
export type ThreadDeleteAnswer = { readonly withChildren: boolean } | null;

interface ThreadDeleteRequest {
  /** Each ask starts with the box clear, even for the same thread twice. */
  readonly id: number;
  readonly title: string;
  /** The threads still in its family (child threads). */
  readonly childCount: number;
  readonly resolve: (answer: ThreadDeleteAnswer) => void;
}

const useThreadDeleteDialogStore = create<{ request: ThreadDeleteRequest | null }>(() => ({
  request: null,
}));

/**
 * Asks before deleting a thread that started threads of its own, with the
 * choice to delete those too. Without it they are separated and live on as
 * threads of their own, so leaving the box clear never loses work. A second
 * ask while one is open answers the first with "keep".
 */
export function confirmThreadDeleteWithChildren(input: {
  readonly title: string;
  readonly childCount: number;
}): Promise<ThreadDeleteAnswer> {
  return new Promise((resolve) => {
    const previous = useThreadDeleteDialogStore.getState().request;
    previous?.resolve(null);
    useThreadDeleteDialogStore.setState({
      request: { ...input, id: (previous?.id ?? 0) + 1, resolve },
    });
  });
}

function answer(value: ThreadDeleteAnswer) {
  const request = useThreadDeleteDialogStore.getState().request;
  if (request === null) return;
  useThreadDeleteDialogStore.setState({ request: null });
  request.resolve(value);
}

/** Mounted once at the root; shows whatever confirmThreadDeleteWithChildren asks. */
export function ThreadDeleteDialogHost() {
  const request = useThreadDeleteDialogStore((state) => state.request);
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) answer(null);
      }}
    >
      {request ? <ThreadDeleteDialogContent key={request.id} request={request} /> : null}
    </AlertDialog>
  );
}

function ThreadDeleteDialogContent({ request }: { request: ThreadDeleteRequest }) {
  const [withChildren, setWithChildren] = useState(false);
  const threads = formatChildThreadCount(request.childCount);
  return (
    <AlertDialogPopup className="max-w-md" data-testid="thread-delete-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>Delete “{request.title}”?</AlertDialogTitle>
        <AlertDialogDescription>
          This permanently clears its chat history. Its {threads} stay as threads of their own
          unless you delete them too.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <label className="flex cursor-pointer items-center gap-2 px-6 pb-4 text-sm text-muted-foreground">
        <Checkbox
          checked={withChildren}
          onCheckedChange={(checked) => setWithChildren(checked === true)}
          data-testid="thread-delete-with-children"
        />
        Also delete its {threads}
      </label>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
        <Button
          variant="destructive"
          data-testid="thread-delete-confirm"
          onClick={() => answer({ withChildren })}
        >
          Delete
        </Button>
      </AlertDialogFooter>
    </AlertDialogPopup>
  );
}
