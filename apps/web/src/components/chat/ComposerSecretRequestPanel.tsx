import type { OrchestrationSecretRequest, ScopedThreadRef } from "@threadlines/contracts";
import {
  checkSecretValue,
  COMMANDS_SECRET_TTL_MS,
  hasEdgeWhitespace,
  withoutEdgeWhitespace,
  secretDestinationLines,
} from "@threadlines/shared/secretRequests";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { type ClipboardEvent, memo, type KeyboardEvent, useEffect, useRef, useState } from "react";

import {
  isPrimaryEnvironmentOnThisComputer,
  usePrimaryEnvironmentDescriptor,
} from "~/environments/primary";
import { useConnectionProtected } from "~/environments/connectionProtection";
import { useRelativeTimeTick } from "~/hooks/useRelativeTimeTick";
import { useSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { describeThisBrowser } from "~/relayDevice";
import { selectEnvironmentState, useStore } from "~/store";
import { formatTimeWithDay } from "~/timestampFormat";
import { useComputerLabel } from "../sidebar/linkedComputers";
import { Button } from "../ui/button";
import { Input, MASKED_TEXT_FONT } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { settingsChangeDeviceLabel } from "./settingsChangeCard.logic";
import {
  secretAnswerEffect,
  secretCardEndedNotice,
  secretCardPhase,
  type SecretRequestNotice,
} from "./secretRequestCard.logic";
import {
  answerSecretRequest,
  readSecretClaimId,
  type SecretAnswerResult,
} from "./secretRequestClaims";

function showNotice(notice: SecretRequestNotice): void {
  toastManager.add({
    type: notice.type,
    title: notice.title,
    ...(notice.description !== undefined ? { description: notice.description } : {}),
    data: { hideCopyButton: true },
  });
}

/**
 * An agent asks the user for a key (`secret_request`,
 * docs/design/secret-requests.md). Docked above the message box like the
 * settings card: the name, the agent's reason in its own words, a masked
 * field, and Threadlines' own two lines about where the value goes. Save
 * sends it once to the thread's computer; Not now saves nothing.
 *
 * The typed text lives only in this component's state. ChatComposer keys the
 * card by computer, thread and request, so it never moves to another card,
 * and it is cleared the moment the request leaves waiting. It survives only
 * a `rejected` answer and an answer that never came back.
 */
export const ComposerSecretRequestPanel = memo(function ComposerSecretRequestPanel(props: {
  threadRef: ScopedThreadRef;
  request: OrchestrationSecretRequest;
  /** What the chat calls the agent that asked. */
  agentName: string;
  /** "1 of 2" when several cards wait. */
  position: number;
  count: number;
}) {
  const { request, threadRef, agentName } = props;
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const sendingRef = useRef(false);

  const computerLabel = useComputerLabel();
  const computer = computerLabel(threadRef.environmentId, "its computer");
  const protectedConnection = useConnectionProtected(threadRef.environmentId);
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  const nowMs = useRelativeTimeTick(30_000);
  const phase = secretCardPhase(request, readSecretClaimId(threadRef, request.requestId));

  // The request left waiting (claimed here or elsewhere): the text goes now.
  if (phase.kind !== "typing" && value !== "") {
    setValue("");
  }

  // Gone while the user had typed into it (replaced, cancelled, answered on
  // another device, gone from a fresh snapshot): say why the text went.
  const typedRef = useRef(false);
  useEffect(() => {
    typedRef.current = value.length > 0;
  }, [value]);
  const { environmentId, threadId } = threadRef;
  const { name, requestId } = request;
  useEffect(
    () => () => {
      // An answer still on its way says why itself.
      if (!typedRef.current || sendingRef.current) return;
      const requests = selectEnvironmentState(useStore.getState(), environmentId)
        .secretRequestsByThreadId?.[threadId];
      // The thread's detail unloaded (the user left it): nothing to say.
      if (requests === undefined) return;
      const notice = secretCardEndedNotice(
        requests.find((candidate) => candidate.requestId === requestId),
        name,
        readSecretClaimId({ environmentId, threadId }, requestId),
      );
      if (notice !== null) showNotice(notice);
    },
    [environmentId, name, requestId, threadId],
  );

  const lines = secretDestinationLines(request, {
    computerLabel: computer,
    removedAtLabel: formatTimeWithDay(
      new Date(nowMs + COMMANDS_SECRET_TTL_MS).toISOString(),
      nowMs,
      timestampFormat,
    ),
  });
  const multiline = request.use.kind === "commands" && request.use.multiline === true;
  const typing = phase.kind === "typing" && ended === null;
  const busy = sending || !typing;

  const applyResult = (result: SecretAnswerResult) => {
    if (result.kind === "offline") {
      setProblem(`This app isn't connected to ${computer}. Try again once it's back.`);
      return;
    }
    if (result.kind === "failed") {
      setProblem(result.detail ?? `Couldn't reach ${computer}. Try again.`);
      return;
    }
    const effect = secretAnswerEffect(result.answer, request.name);
    if (effect.kind === "retry") {
      setProblem(effect.detail);
      return;
    }
    setValue("");
    setProblem(null);
    if (effect.kind === "ended") {
      setEnded(effect.notice.title);
      showNotice(effect.notice);
    }
  };

  const answer = async (
    choice: { readonly type: "save"; readonly value: string } | { readonly type: "decline" },
  ) => {
    // One send per press, however fast the clicks.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      applyResult(
        await answerSecretRequest({
          threadRef,
          requestId: request.requestId,
          deviceLabel: settingsChangeDeviceLabel({
            desktopApp: isPrimaryEnvironmentOnThisComputer(),
            thisComputerName: primaryDescriptor?.label ?? null,
            browserLabel: describeThisBrowser().label,
          }),
          answer: choice,
        }),
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const save = () => {
    if (!protectedConnection || value.length === 0 || busy) return;
    const check = checkSecretValue(request.use, value);
    if (!check.ok) {
      setProblem(check.detail);
      return;
    }
    setProblem(null);
    void answer({ type: "save", value });
  };

  const onFieldChange = (next: string) => {
    setValue(next);
    setProblem(null);
  };
  // A one-line field drops a pasted key's line breaks before onChange sees
  // them, which would save an altered key. A break inside the key is refused
  // here instead; a single closing break (a copied line) is harmless to drop.
  const onFieldPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (!/[\r\n]/.test(pasted.replace(/\r?\n$/, ""))) return;
    event.preventDefault();
    const check = checkSecretValue(request.use, pasted);
    setProblem(check.ok ? null : check.detail);
  };
  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    save();
  };

  // Not tied to the message box's form, so Enter never sends the chat and
  // the browser never sees the key as part of a submitted form.
  const detachedForm = `secret-request-${request.requestId}`;
  const fieldProps = {
    form: detachedForm,
    value,
    disabled: busy || !protectedConnection,
    spellCheck: false,
    autoCapitalize: "off",
    autoCorrect: "off",
    "aria-label": `Value for ${request.name}`,
    "aria-invalid": problem !== null ? true : undefined,
    "data-1p-ignore": true,
    "data-lpignore": "true",
    "data-form-type": "other",
    "data-testid": "secret-request-panel-field",
  } as const;

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4" data-testid="secret-request-panel">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm tracking-[0.2em] uppercase">Agent request</span>
          <span className="text-sm font-medium" data-testid="secret-request-panel-heading">
            {agentName} is asking for a key
          </span>
          {props.count > 1 ? (
            <span
              className="ms-auto font-mono text-[11px] text-muted-foreground"
              data-testid="secret-request-panel-position"
            >
              {props.position} of {props.count}
            </span>
          ) : null}
        </div>
        <p className="font-mono text-sm break-all" data-testid="secret-request-panel-name">
          {request.name}
        </p>
        <p className="text-sm break-words" data-testid="secret-request-panel-reason">
          <span className="text-muted-foreground">{agentName} says:</span> {request.reason}
        </p>
        {typing ? (
          <div className="flex items-start gap-1.5">
            {multiline ? (
              <Textarea
                {...fieldProps}
                size="sm"
                autoComplete="off"
                // Masked like a password field until shown.
                className={cn(
                  // Shown text reads in mono; masked dots sit centered (see MASKED_TEXT_FONT).
                  shown ? "font-mono" : MASKED_TEXT_FONT,
                  !shown && "[&_textarea]:[-webkit-text-security:disc]",
                )}
                onChange={(event) => onFieldChange(event.target.value)}
              />
            ) : (
              <Input
                {...fieldProps}
                nativeInput
                size="sm"
                type={shown ? "text" : "password"}
                autoComplete="new-password"
                className="font-mono"
                onChange={(event) => onFieldChange(event.target.value)}
                onKeyDown={onFieldKeyDown}
                onPaste={onFieldPaste}
              />
            )}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={shown ? "Hide key" : "Show key"}
              aria-pressed={shown}
              disabled={!protectedConnection}
              onClick={() => setShown((current) => !current)}
            >
              {shown ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="secret-request-panel-status">
            {ended ?? (phase.kind === "elsewhere" ? `Answered on ${phase.deviceLabel}` : "Saving…")}
          </p>
        )}
        {typing && problem !== null ? (
          <p className="text-xs text-destructive" data-testid="secret-request-panel-problem">
            {problem}
          </p>
        ) : null}
        {typing && hasEdgeWhitespace(value, multiline) ? (
          <p className="text-xs text-muted-foreground" data-testid="secret-request-panel-spaces">
            This starts or ends with a space.{" "}
            <button
              type="button"
              className="text-foreground underline-offset-2 hover:underline"
              onClick={() => onFieldChange(withoutEdgeWhitespace(value, multiline))}
            >
              Remove spaces
            </button>
          </p>
        ) : null}
        <div className="space-y-0.5 text-xs text-muted-foreground">
          {lines.replaces !== null ? (
            <p data-testid="secret-request-panel-replaces">{lines.replaces}</p>
          ) : null}
          <p data-testid="secret-request-panel-destination">{lines.destination}</p>
          {!protectedConnection ? (
            <p data-testid="secret-request-panel-unprotected">
              The connection to {computer} isn't encrypted, so a key can't be sent from here. Answer
              on that computer.
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void answer({ type: "decline" })}
        >
          Not now
        </Button>
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={busy || value.length === 0 || !protectedConnection}
          onClick={save}
        >
          {phase.kind === "saving" || sending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
});
