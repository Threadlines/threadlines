/**
 * The quiet row the timeline draws for the message that told an agent how
 * its request for a key ended (`secret-answer:<requestId>`,
 * docs/design/secret-requests.md, "Telling the agent"): "You saved
 * STRIPE_SECRET_KEY to .env.local", not a chat bubble. A key kept for the
 * agent's commands says when its file goes and has Remove now while it is
 * there. The row reads the request from the thread, never the message text.
 */
import type { EnvironmentId, OrchestrationSecretRequest, ThreadId } from "@threadlines/contracts";
import type { TimestampFormat } from "@threadlines/contracts/settings";
import {
  isFailedSecretMessage,
  secretRequestIdOfAnswerMessage,
} from "@threadlines/shared/secretRequests";
import { KeyRoundIcon } from "lucide-react";
import { memo, useState } from "react";

import { useRelativeTimeTick } from "~/hooks/useRelativeTimeTick";
import { selectEnvironmentState, useStore } from "~/store";
import { formatTimeWithDay } from "~/timestampFormat";
import { secretAnswerRow } from "./secretRequestCard.logic";
import { removeSecretNow } from "./secretRequestClaims";

/** Whether a user message is the one that told an agent how its request for a key ended. */
export function isSecretAnswerMessage(messageId: string): boolean {
  return secretRequestIdOfAnswerMessage(messageId) !== null;
}

const NO_REQUESTS: ReadonlyArray<OrchestrationSecretRequest> = [];

export const SecretAnswerRow = memo(function SecretAnswerRow(props: {
  readonly messageId: string;
  /** What the agent was told: the outcome when the request itself was pruned. */
  readonly messageText: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly timestampFormat: TimestampFormat;
}) {
  const { environmentId, threadId } = props;
  const requestId = secretRequestIdOfAnswerMessage(props.messageId);
  const requests = useStore((state) =>
    threadId === null
      ? NO_REQUESTS
      : (selectEnvironmentState(state, environmentId).secretRequestsByThreadId?.[threadId] ??
        NO_REQUESTS),
  );
  const request = requests.find((candidate) => candidate.requestId === requestId);
  const row = secretAnswerRow(request);
  const nowMs = useRelativeTimeTick(60_000);
  const [removing, setRemoving] = useState(false);

  const remove = async () => {
    if (threadId === null || request === undefined || removing) return;
    setRemoving(true);
    try {
      await removeSecretNow({ environmentId, threadId }, request.requestId);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex justify-end py-1" data-secret-answer-row={requestId ?? undefined}>
      <p className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 pr-1 text-xs leading-4 text-muted-foreground">
        <KeyRoundIcon aria-hidden className="size-3 shrink-0" />
        {row.kind === "unknown" ? (
          <span data-secret-answer-text>
            {isFailedSecretMessage(props.messageText) ? "Couldn't save a key" : "Saved a key"}
          </span>
        ) : row.kind === "failed" ? (
          <span className="min-w-0 break-words" data-secret-answer-text>
            Couldn't save <span className="font-mono text-foreground">{row.name}</span>:{" "}
            {row.detail}
          </span>
        ) : (
          <span className="min-w-0 break-words" data-secret-answer-text>
            You saved <span className="font-mono text-foreground">{row.name}</span> {row.where}
            {row.removal === null
              ? null
              : row.removal.kind === "removed"
                ? ". Removed."
                : `. Removed at ${formatTimeWithDay(row.removal.iso, nowMs, props.timestampFormat)}.`}
          </span>
        )}
        {row.kind === "saved" && row.removable ? (
          <button
            type="button"
            className="shrink-0 rounded px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none"
            disabled={removing}
            data-secret-answer-remove
            onClick={() => void remove()}
          >
            Remove now
          </button>
        ) : null}
      </p>
    </div>
  );
});
