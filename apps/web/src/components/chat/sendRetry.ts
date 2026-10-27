/**
 * Retry for a message whose send failed in transit (a dropped connection, a
 * timeout): no answer either way, so the server may or may not have it. Retry
 * sends the very command that failed again, unchanged: the same command id,
 * message, model, settings and target. The server keeps a receipt per command
 * id, so a message that did arrive is answered "already have it" instead of
 * running twice. A refusal is an answer, so it gets no Retry.
 *
 * Retry goes only while the composer still holds exactly what failed. Like a
 * send, it takes the message out of the box while it goes and the chat shows
 * it going out (the message, "Sending" or "Preparing worktree"); if it fails
 * again, the chat takes that back and the message goes back in the box. Only
 * the latest failure on a thread can be retried: any new send there, or a
 * retry already started, retires older buttons.
 *
 * @module sendRetry
 */
import type {
  ClientOrchestrationCommand,
  EnvironmentId,
  ScopedThreadRef,
} from "@threadlines/contracts";

import {
  useComposerDraftStore,
  type ComposerAttachment,
  type ComposerThreadDraftState,
  type DraftId,
} from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";
import { cloneComposerAttachmentForRetry } from "../ChatView.logic";

/** The latest retryable failure on each thread, by scoped thread key. */
const latestFailureByThread = new Map<string, number>();
/** Bumps with every send and failure on a thread, so a retry can tell it was overtaken. */
const sendGenerationByThread = new Map<string, number>();
let nextFailureId = 1;

function bumpGeneration(threadKey: string): void {
  sendGenerationByThread.set(threadKey, (sendGenerationByThread.get(threadKey) ?? 0) + 1);
}

/** Records a retryable failure; returns its id, which retires any older one. */
export function recordFailedSend(threadKey: string): number {
  const failureId = nextFailureId++;
  latestFailureByThread.set(threadKey, failureId);
  bumpGeneration(threadKey);
  return failureId;
}

/** A new send on the thread: an older failure's Retry no longer applies. */
export function forgetFailedSend(threadKey: string): void {
  latestFailureByThread.delete(threadKey);
  bumpGeneration(threadKey);
}

/**
 * What a composer would send, as one comparable value: the text, the
 * attachments by id, and every attached context in full (a highlight's note
 * can change under the same id).
 */
export function composerContentsKey(
  draft: Pick<
    ComposerThreadDraftState,
    | "prompt"
    | "attachments"
    | "terminalContexts"
    | "transcriptHighlightContexts"
    | "fileSelectionContexts"
    | "pickedElementContexts"
    | "drawingContexts"
  > | null,
): string {
  if (draft === null) return "";
  return JSON.stringify([
    draft.prompt,
    draft.attachments.map((attachment) => attachment.id),
    draft.terminalContexts,
    draft.transcriptHighlightContexts,
    draft.fileSelectionContexts,
    draft.pickedElementContexts,
    draft.drawingContexts,
  ]);
}

type ComposerContents = Pick<
  ComposerThreadDraftState,
  | "prompt"
  | "attachments"
  | "terminalContexts"
  | "transcriptHighlightContexts"
  | "fileSelectionContexts"
  | "pickedElementContexts"
  | "drawingContexts"
>;

function isComposerEmpty(draft: ComposerContents | null): boolean {
  return (
    draft === null ||
    (draft.prompt.length === 0 &&
      draft.attachments.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.transcriptHighlightContexts.length === 0 &&
      draft.fileSelectionContexts.length === 0 &&
      draft.pickedElementContexts.length === 0 &&
      draft.drawingContexts.length === 0)
  );
}

function putBackInComposer(target: ScopedThreadRef | DraftId, draft: ComposerContents): void {
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(target, draft.prompt);
  drafts.addAttachments(target, draft.attachments.map(cloneComposerAttachmentForRetry));
  drafts.setTerminalContexts(target, draft.terminalContexts);
  drafts.setTranscriptHighlightContexts(target, draft.transcriptHighlightContexts);
  for (const context of draft.fileSelectionContexts)
    drafts.addFileSelectionContext(target, context);
  drafts.setPickedElementContexts(target, draft.pickedElementContexts);
  drafts.setDrawingContexts(target, draft.drawingContexts);
}

export interface FailedSend {
  readonly failureId: number;
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  /** Exactly what was dispatched. */
  readonly command: ClientOrchestrationCommand;
  /** Where the message went back to, and what it looked like there. */
  readonly draftTarget: ScopedThreadRef | DraftId;
  readonly contents: string;
  /**
   * Shows the message going out again, as the send did, with the attachments
   * the composer held (the chat takes over their previews). Resolves to what
   * takes it back when the retry fails as well.
   */
  readonly showSending: (attachments: ReadonlyArray<ComposerAttachment>) => Promise<() => void>;
  /** What a send does once the server takes it (room memory, the thread's model). */
  readonly onAccepted: () => Promise<void> | void;
}

/**
 * Sends a failed command again. Resolves "skipped" when it no longer applies
 * (a later send replaced it, or the composer no longer holds it: what's there
 * now is the user's own next message), "sent" when the server took it, or the
 * error it failed with and whether it is still the thread's latest send.
 */
export async function retryFailedSend(
  failed: FailedSend,
): Promise<
  | { readonly outcome: "skipped" }
  | { readonly outcome: "sent" }
  | { readonly outcome: "failed"; readonly error: unknown; readonly latest: boolean }
> {
  const drafts = useComposerDraftStore.getState();
  const draft = drafts.getComposerDraft(failed.draftTarget);
  if (
    latestFailureByThread.get(failed.threadKey) !== failed.failureId ||
    draft === null ||
    composerContentsKey(draft) !== failed.contents
  ) {
    return { outcome: "skipped" };
  }
  latestFailureByThread.delete(failed.threadKey);
  const generation = sendGenerationByThread.get(failed.threadKey);
  // Out of the box while it goes, as a send does, so Send can't send it twice.
  drafts.clearComposerContent(failed.draftTarget);
  const takeBackSending = await failed.showSending(draft.attachments);
  try {
    const api = readEnvironmentApi(failed.environmentId);
    if (!api) throw new Error("That computer isn't connected.");
    await api.orchestration.dispatchCommand(failed.command);
  } catch (error) {
    takeBackSending();
    // Back in the box, unless something new went in meanwhile.
    if (isComposerEmpty(useComposerDraftStore.getState().getComposerDraft(failed.draftTarget))) {
      putBackInComposer(failed.draftTarget, draft);
    }
    return {
      outcome: "failed",
      error,
      latest: sendGenerationByThread.get(failed.threadKey) === generation,
    };
  }
  try {
    await failed.onAccepted();
  } catch {
    // The message went out; what follows it is housekeeping.
  }
  return { outcome: "sent" };
}
