/**
 * Settings › Connections › Assistants (docs/design/assistants.md, "What the
 * user does"): always-on assistants in their makers' clouds that use this
 * computer through the relay's public door. The address to paste into an
 * assistant while the door is open (or why it isn't), Connect an assistant
 * (a sign-in code to type into the page the assistant opened, with how long
 * it lasts; once that page signs in, the approval dialog takes over), and
 * Create a key for assistants that take a key instead. Below it, in a group
 * of their own, the assistants connected (OutsideAgentConnectionList). Owner
 * only, never on a phone: ConnectionsSettings shows it beside the Agents
 * group, under the same gate.
 */
import { displayAssistantSignInCode } from "@threadlines/shared/assistantCredentials";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelAssistantCode,
  describeOutsideAgentFailure,
  startAssistantCode,
  useAssistantCodeAsk,
  useOutsideAgentsSnapshot,
  useOutsideAgentsSync,
  useShownAssistantCode,
} from "../../environments/outsideAgents/outsideAgents";
import type { AssistantSignInCode } from "../../environments/outsideAgents/outsideAgents.logic";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { CopyButton } from "../CopyButton";
import { formatCountdown } from "../settings/connections/useRelayAccess";
import { SETTINGS_GROUP_ROW_CLASS, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { OutsideAgentConnectionList } from "./OutsideAgentConnectionList";
import { OutsideAgentsQuietRow } from "./OutsideAgentsQuietRow";
import { OutsideAgentDialog } from "./outsideAgentDialog";

const ROW_CLASS = cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5");
const ERROR_CLASS = "pt-1.5 text-[12.5px] leading-[18px] text-destructive";
/** A SettingsRow with children leaves the bottom padding to them. */
const ROW_ERROR_CLASS = cn(ERROR_CLASS, "pb-2.5");

/**
 * The group, holding this computer's agents stream open while it shows.
 * `revealOnArrival` scrolls it into view: the command palette's "Connect an
 * assistant" opens the page for it, having asked for a code already.
 */
export function AssistantsSection({ revealOnArrival }: { readonly revealOnArrival: boolean }) {
  useOutsideAgentsSync(true);
  const snapshot = useOutsideAgentsSnapshot();
  const assistants = snapshot?.assistants ?? null;
  const ready = assistants?.status === "ready" && assistants.address !== null;
  const shownCode = useShownAssistantCode();
  const ask = useAssistantCodeAsk();
  const sectionRef = useRef<HTMLDivElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);

  const cancelCode = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelAssistantCode();
    } catch (cause) {
      setCancelError(describeOutsideAgentFailure(cause, "Couldn't cancel the code. Try again."));
    } finally {
      setCancelling(false);
    }
  };
  const newCode = () => {
    setCancelError(null);
    void startAssistantCode();
  };
  const busy = ask.busy ? "start" : cancelling ? "cancel" : null;
  const error = ask.error ?? cancelError;

  // Once as the page opens, and once more when the group has its rows.
  const revealStep = revealOnArrival ? (snapshot === null ? "opening" : "settled") : null;
  useEffect(() => {
    if (revealStep !== null) sectionRef.current?.scrollIntoView({ block: "start" });
  }, [revealStep]);

  const assistantConnections = useMemo(
    () => snapshot?.connections.filter((connection) => connection.kind === "assistant") ?? [],
    [snapshot],
  );

  return (
    <div
      ref={sectionRef}
      // Two groups, spaced as the page spaces its own sections.
      className="flex scroll-mt-4 flex-col gap-7"
      data-testid="assistants-section"
    >
      <SettingsSection
        title="Assistants"
        description="Always-on assistants like Grok Bot, dots, Muse and Claude Duet can use Threadlines from their own cloud."
      >
        {snapshot === null || assistants === null ? (
          <div className={ROW_CLASS} role="status" aria-label="Loading assistants">
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-3.5 w-36 max-w-full rounded-full" />
              <Skeleton className="h-3 w-64 max-w-full rounded-full" />
            </div>
          </div>
        ) : (
          <>
            <OutsideAgentsQuietRow
              quietUntil={snapshot.quietUntil}
              who="assistant"
              testId="assistants-quiet"
            />
            <SettingsRow
              data-testid="assistants-address-row"
              title="Address for assistants"
              description={
                ready ? (
                  <>
                    <span
                      className="block font-mono text-[11.5px] leading-[17px] break-all text-foreground select-text"
                      data-testid="assistants-address"
                    >
                      {assistants.address}
                    </span>
                    <span className="block">
                      Paste this into your assistant as a custom connector.
                    </span>
                  </>
                ) : assistants.status === "unreachable" ? (
                  "Can't reach the relay right now. Threadlines keeps trying."
                ) : assistants.status === "ready" ? (
                  "Asking the relay for the address."
                ) : (
                  "Assistants are turned off on this computer's relay."
                )
              }
              control={
                ready && assistants.address !== null ? (
                  <CopyButton value={assistants.address} label="Copy the address for assistants" />
                ) : null
              }
            />
            {shownCode !== null ? (
              <AssistantCodeRow
                code={shownCode}
                busy={busy}
                canStart={ready}
                error={error}
                onCancel={() => void cancelCode()}
                onNewCode={newCode}
              />
            ) : (
              <SettingsRow
                data-testid="assistants-connect-row"
                title="Add an assistant"
                description="Most assistants sign in with a code, and Muse takes a key instead."
                control={
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!ready}
                      onClick={() => setCreatingKey(true)}
                      data-testid="assistants-create-key"
                    >
                      Create a key
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!ready || busy !== null}
                      onClick={newCode}
                      data-testid="assistants-connect"
                    >
                      {busy === "start" ? "Getting a code…" : "Connect an assistant"}
                    </Button>
                  </>
                }
              >
                {error !== null ? (
                  <p role="alert" className={ROW_ERROR_CLASS} data-testid="assistants-error">
                    {error}
                  </p>
                ) : null}
              </SettingsRow>
            )}
          </>
        )}
      </SettingsSection>

      <OutsideAgentConnectionList
        connections={assistantConnections}
        heading={{ title: "Assistants that can use this computer" }}
        testId="assistants-connections"
      />

      {/* A stray click mustn't close it: its last view is a key shown once. */}
      <Dialog
        open={creatingKey}
        onOpenChange={(open) => {
          if (!open) setCreatingKey(false);
        }}
        disablePointerDismissal
      >
        {creatingKey ? (
          <Suspense fallback={null}>
            <OutsideAgentDialog.Component
              subject={{ kind: "key" }}
              onClose={() => setCreatingKey(false)}
            />
          </Suspense>
        ) : null}
      </Dialog>
    </div>
  );
}

/**
 * The code to type into the assistant's sign-in page, how long it has left
 * and the warning to keep it to that page, with Cancel; once it runs out,
 * says so and offers a new one.
 */
function AssistantCodeRow({
  code,
  busy,
  canStart,
  error,
  onCancel,
  onNewCode,
}: {
  readonly code: AssistantSignInCode;
  readonly busy: "start" | "cancel" | null;
  readonly canStart: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onNewCode: () => void;
}) {
  const nowMs = useRelativeTimeTick(1_000);
  const countdown = formatCountdown(code.expiresAt, nowMs);
  const errorLine = (className: string) =>
    error !== null ? (
      <p role="alert" className={className} data-testid="assistants-error">
        {error}
      </p>
    ) : null;
  const cancelButton = (
    <Button
      size="xs"
      variant="outline"
      disabled={busy !== null}
      onClick={onCancel}
      data-testid="assistant-code-cancel"
    >
      {busy === "cancel" ? "Cancelling…" : "Cancel"}
    </Button>
  );

  if (countdown === null) {
    return (
      <SettingsRow
        data-testid="assistant-code-expired"
        title="This code expired."
        description="Codes last 10 minutes and work once."
        control={
          <>
            {cancelButton}
            <Button
              size="xs"
              variant="outline"
              disabled={!canStart || busy !== null}
              onClick={onNewCode}
              data-testid="assistant-code-new"
            >
              {busy === "start" ? "Getting a code…" : "Show a new code"}
            </Button>
          </>
        }
      >
        {errorLine(ROW_ERROR_CLASS)}
      </SettingsRow>
    );
  }
  const shown = displayAssistantSignInCode(code.code);
  return (
    <div className={ROW_CLASS} data-testid="assistant-code-row">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className="font-mono text-[15px] leading-5 font-medium tracking-[0.08em] text-foreground select-text"
              aria-label={`Code ${code.code.split("").join(" ")}`}
              data-testid="assistant-code"
            >
              {shown}
            </span>
            <span
              className="font-mono text-[11px] text-muted-foreground"
              data-testid="assistant-code-countdown"
            >
              Expires in {countdown}
            </span>
          </div>
          <p className="text-[12.5px] leading-[18px] text-muted-foreground">
            Type this only into the Threadlines page your assistant just opened. Never give it to
            anyone.
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <CopyButton value={shown} label="Copy the code" />
          {cancelButton}
        </div>
      </div>
      {errorLine(ERROR_CLASS)}
    </div>
  );
}
