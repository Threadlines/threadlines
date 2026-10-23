import type { ThreadId, WebhookEventDetail, WebhookEventRecord } from "@threadlines/contracts";
import {
  keepPreviousData,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { openExternalUrl } from "../../lib/externalLinks";
import { cn } from "../../lib/utils";
import { SETTINGS_GROUP_ROW_CLASS, SettingsSection } from "../settings/settingsLayout";
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
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import {
  describeLastEvent,
  describeWebhookEvent,
  describeWebhookEventOutcome,
  formatWhen,
  githubHookEventLabels,
  githubNewHookUrl,
  WEBHOOK_EVENT_DOT_CLASSES,
  WEBHOOK_EVENT_SOURCE_LABELS,
  webhookCadenceOfTask,
} from "./scheduled.logic";
import type { LocatedTask } from "./useScheduledPage";
import { useGitHubContext } from "./useScheduledPage";

const EVENT_PAGE = 20;

const errorText = (error: unknown) => (error instanceof Error ? error.message : undefined);

/** The client for a task's computer, or a toast saying it isn't connected. */
function clientFor(located: LocatedTask) {
  const connection = readEnvironmentConnection(located.environment.environmentId);
  if (!connection) {
    toastManager.add({ type: "error", title: `${located.environment.label} isn't connected.` });
    return null;
  }
  return connection.client;
}

/** Query keys for one task's event pieces, so an action can refresh the rest. */
const eventKeys = {
  events: (located: LocatedTask) =>
    [
      "scheduledTasks",
      "webhookEvents",
      located.environment.environmentId,
      located.task.id,
    ] as const,
  address: (located: LocatedTask) =>
    [
      "scheduledTasks",
      "webhookAddress",
      located.environment.environmentId,
      located.task.id,
    ] as const,
};

/** Reads a task's events again: after a test event or a run again, which the log records. */
export function refreshEventHistory(queryClient: QueryClient, located: LocatedTask): void {
  void queryClient.invalidateQueries({ queryKey: eventKeys.events(located) });
}

/** A solid Copy button for one value; says Copied for a moment after. */
function CopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      aria-label={label}
      onClick={() => copyToClipboard(value, undefined)}
    >
      {isCopied ? "Copied" : "Copy"}
    </Button>
  );
}

/** A row of the address panel: a label over a value (an address, a status) and its actions. */
function AddressRow({
  label,
  hint,
  children,
  actions,
  testId,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <div
      className={cn(
        SETTINGS_GROUP_ROW_CLASS,
        "flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between",
      )}
      data-testid={testId}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <h3 className="text-[13.5px] leading-[19px] font-medium text-foreground">{label}</h3>
        {children}
        {hint ? <p className="text-[12.5px] leading-[18px] text-muted-foreground">{hint}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** An address as text the user can select, or why there isn't one yet. */
function AddressValue({ url, testId }: { readonly url: string | null; readonly testId: string }) {
  return url === null ? (
    <p className="text-[12.5px] leading-[18px] text-muted-foreground" data-testid={testId}>
      Getting this task&apos;s address from the relay…
    </p>
  ) : (
    <p
      className="font-mono text-[11.5px] leading-[17px] break-all text-foreground select-text"
      data-testid={testId}
    >
      {url}
    </p>
  );
}

/**
 * The secret an event's signature is checked with: write-only. Reveal asks
 * the computer for it on purpose; Generate makes a new one and shows it once;
 * Set takes one the sender gave. Replacing a set secret asks first, since a
 * sender still using the old one stops getting through.
 */
function SigningSecretRow({
  located,
  label,
  hint,
}: {
  readonly located: LocatedTask;
  readonly label: string;
  readonly hint?: ReactNode;
}) {
  const isSet = located.task.webhook?.signingSecretSet === true;
  const [shown, setShown] = useState<{ readonly secret: string; readonly fresh: boolean } | null>(
    null,
  );
  const [typing, setTyping] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"generate" | "set" | null>(null);
  const [busy, setBusy] = useState(false);

  const reveal = async () => {
    const client = clientFor(located);
    if (!client) return;
    setBusy(true);
    try {
      const result = await client.scheduledTasks.revealWebhookSigningSecret({
        id: located.task.id,
      });
      setShown(result.secret === null ? null : { secret: result.secret, fresh: false });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't show the secret",
        description: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const save = async (secret: string) => {
    const client = clientFor(located);
    if (!client) return;
    setBusy(true);
    try {
      const result = await client.scheduledTasks.setWebhookSigningSecret({
        id: located.task.id,
        secret,
      });
      setTyping(null);
      setShown(result.secret === null ? null : { secret: result.secret, fresh: true });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't set the secret",
        description: errorText(error),
      });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const generate = () => {
    if (isSet) setConfirm("generate");
    else void save("generate");
  };
  const typed = typing?.trim() ?? "";

  return (
    <>
      <AddressRow
        label={label}
        testId="scheduled-event-secret"
        hint={
          shown?.fresh
            ? "The new secret. Copy it into the sender now."
            : shown
              ? undefined
              : isSet
                ? hint
                : "No secret yet. Generate one, or set the one the sender gives you."
        }
        actions={
          typing === null ? (
            <>
              {shown ? (
                <>
                  <CopyButton value={shown.secret} label="Copy the secret" />
                  <Button type="button" size="xs" variant="outline" onClick={() => setShown(null)}>
                    Hide
                  </Button>
                </>
              ) : isSet ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void reveal()}
                >
                  Reveal
                </Button>
              ) : null}
              <Button type="button" size="xs" variant="outline" disabled={busy} onClick={generate}>
                {isSet ? "New secret" : "Generate"}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => setTyping("")}
              >
                Set
              </Button>
            </>
          ) : null
        }
      >
        {shown ? (
          <p
            className="font-mono text-[11.5px] leading-[17px] break-all text-foreground select-text"
            data-testid="scheduled-event-secret-value"
          >
            {shown.secret}
          </p>
        ) : isSet ? (
          <p className="font-mono text-[11.5px] leading-[17px] text-muted-foreground">
            ••••••••••••
          </p>
        ) : null}
        {typing !== null ? (
          <form
            className="flex flex-wrap items-center gap-2 pt-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed.length === 0) return;
              if (isSet) setConfirm("set");
              else void save(typed);
            }}
          >
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              className="w-full min-w-0 font-mono sm:w-64"
              value={typing}
              placeholder="The sender's secret"
              aria-label="Signing secret"
              onChange={(event) => setTyping(event.target.value)}
            />
            <Button type="submit" size="xs" variant="outline" disabled={busy || typed.length === 0}>
              Save
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setTyping(null)}>
              Cancel
            </Button>
          </form>
        ) : null}
      </AddressRow>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the secret?</AlertDialogTitle>
            <AlertDialogDescription>
              {located.task.webhook?.github
                ? "Threadlines gives GitHub the new one."
                : "A sender still using the old secret stops getting through until it has the new one."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void save(confirm === "set" ? typed : "generate")}
            >
              Replace
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * Where an event task's events go (docs/design/event-tasks.md, Address
 * panel). A GitHub task is connected through Add to GitHub, or set up by
 * hand from the steps here; any other service gets the address and its
 * signing secret. Every task also has an address on this computer, and can
 * get a new one.
 */
export function EventAddressSection({ located }: { readonly located: LocatedTask }) {
  const { environment, task } = located;
  const cadence = webhookCadenceOfTask(task);
  const state = task.webhook;
  const github = cadence?.source === "github" ? (cadence.github ?? null) : null;
  const connected = state?.github === true;
  const queryClient = useQueryClient();
  const address = useQuery({
    // Read again when the relay gives the task an address or a new one.
    queryKey: [...eventKeys.address(located), state?.address, state?.addressChanged],
    queryFn: async () => {
      const connection = readEnvironmentConnection(environment.environmentId);
      if (!connection) throw new Error(`${environment.label} isn't connected.`);
      return connection.client.scheduledTasks.webhookAddress({ id: task.id });
    },
    placeholderData: keepPreviousData,
  });
  const context = useGitHubContext(
    environment.environmentId,
    task.projectId,
    github !== null && !connected,
  );
  const [busy, setBusy] = useState<"connect" | "disconnect" | "rotate" | null>(null);
  const [connectFailed, setConnectFailed] = useState(false);
  const [byHand, setByHand] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const nowMs = useRelativeTimeTick(30_000);
  if (cadence === null) return null;

  const relayUrl = state?.address === "waiting_for_relay" ? null : (address.data?.relayUrl ?? null);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: eventKeys.address(located) });

  const act = async (
    kind: "connect" | "disconnect" | "rotate",
    run: () => Promise<unknown>,
    failure: string,
  ) => {
    setBusy(kind);
    try {
      await run();
      refresh();
      return true;
    } catch (error) {
      toastManager.add({ type: "error", title: failure, description: errorText(error) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    const client = clientFor(located);
    if (!client) return;
    const ok = await act(
      "connect",
      () => client.scheduledTasks.connectGitHub({ id: task.id }),
      "Couldn't add it to GitHub",
    );
    // Without admin rights on the repository, the steps by hand still work.
    if (!ok) setConnectFailed(true);
  };
  const disconnect = async () => {
    const client = clientFor(located);
    if (!client) return;
    await act(
      "disconnect",
      () => client.scheduledTasks.disconnectGitHub({ id: task.id }),
      "Couldn't remove it from GitHub",
    );
  };
  const rotate = async () => {
    const client = clientFor(located);
    if (!client) return;
    await act(
      "rotate",
      () => client.scheduledTasks.rotateWebhookAddress({ id: task.id }),
      "Couldn't give it a new address",
    );
    setRotateOpen(false);
  };

  const canConnect = github !== null && !connected && context?.canConnect === true;
  const showSteps = github !== null && !connected && (!canConnect || connectFailed || byHand);
  const lastEvent = state?.lastEventAt ?? null;

  return (
    <SettingsSection
      title="Address"
      description="Events reach this computer through the Threadlines relay. If it's off, they wait up to a day."
      headerAction={
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy !== null}
          onClick={() => setRotateOpen(true)}
          data-testid="scheduled-event-rotate"
        >
          New address
        </Button>
      }
      data-testid="scheduled-event-address"
    >
      {state?.addressChanged && !connected ? (
        <AddressRow
          label="This task's address changed"
          hint="A sender you set up by hand needs the new one."
          testId="scheduled-event-address-changed"
          actions={relayUrl ? <CopyButton value={relayUrl} label="Copy the new address" /> : null}
        >
          <AddressValue url={relayUrl} testId="scheduled-event-address-changed-url" />
        </AddressRow>
      ) : null}

      {github !== null ? (
        connected ? (
          <AddressRow
            label="Connected to GitHub"
            testId="scheduled-event-github-connected"
            hint={
              lastEvent === null
                ? "Waiting for GitHub's first event."
                : `${describeLastEvent(lastEvent, nowMs)}.`
            }
            actions={
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void disconnect()}
                data-testid="scheduled-event-disconnect"
              >
                Disconnect
              </Button>
            }
          >
            <p className="font-mono text-[11.5px] text-muted-foreground">{github.repository}</p>
          </AddressRow>
        ) : canConnect ? (
          <AddressRow
            label="Add to GitHub"
            testId="scheduled-event-github-connect"
            hint={`Threadlines adds the webhook to ${github.repository} with your GitHub sign-in.`}
            actions={
              <>
                {byHand ? null : (
                  <Button type="button" size="xs" variant="ghost" onClick={() => setByHand(true)}>
                    Set it up by hand
                  </Button>
                )}
                <Button
                  type="button"
                  size="xs"
                  disabled={busy !== null}
                  onClick={() => void connect()}
                  data-testid="scheduled-event-connect"
                >
                  Add to GitHub
                </Button>
              </>
            }
          />
        ) : null
      ) : (
        <AddressRow
          label="Address"
          testId="scheduled-event-relay-address"
          hint="Send events here with POST."
          actions={relayUrl ? <CopyButton value={relayUrl} label="Copy the address" /> : null}
        >
          <AddressValue url={relayUrl} testId="scheduled-event-relay-url" />
        </AddressRow>
      )}

      {showSteps && github !== null ? (
        <>
          <AddressRow
            label="Add it on GitHub"
            testId="scheduled-event-github-steps"
            hint={
              connectFailed
                ? "Threadlines couldn't add it. Add it on the repository's webhook page with these settings."
                : "Add a webhook on the repository's webhook page with these settings."
            }
            actions={
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => openExternalUrl(githubNewHookUrl(github.repository))}
              >
                <ExternalLinkIcon aria-hidden="true" className="size-3" />
                Open on GitHub
              </Button>
            }
          />
          <AddressRow
            label="Payload URL"
            testId="scheduled-event-relay-address"
            actions={relayUrl ? <CopyButton value={relayUrl} label="Copy the payload URL" /> : null}
          >
            <AddressValue url={relayUrl} testId="scheduled-event-relay-url" />
          </AddressRow>
          <AddressRow label="Content type">
            <p className="font-mono text-[11.5px] text-foreground">application/json</p>
          </AddressRow>
          <SigningSecretRow located={located} label="Secret" />
          <AddressRow label="Events" hint="Pick “Let me select individual events” and tick these.">
            <p
              className="text-[12.5px] text-foreground"
              data-testid="scheduled-event-github-events"
            >
              {githubHookEventLabels(cadence)}
            </p>
          </AddressRow>
        </>
      ) : null}

      {cadence.source === "any" ? (
        cadence.signature ? (
          <SigningSecretRow
            located={located}
            label="Signing secret"
            hint={`Checked in the ${cadence.signature.header} header.`}
          />
        ) : (
          <AddressRow
            label="Signature"
            hint="Not checked. Anyone who has the address can start a run. Edit the task to add one."
          />
        )
      ) : null}

      <AddressRow
        label="On this computer"
        hint="For a sender on this computer, or on your network if Threadlines is open to it."
        testId="scheduled-event-local-address"
        actions={
          address.data ? (
            <CopyButton value={address.data.localUrl} label="Copy the address on this computer" />
          ) : null
        }
      >
        {address.data ? (
          <p
            className="font-mono text-[11.5px] leading-[17px] break-all text-foreground select-text"
            data-testid="scheduled-event-local-url"
          >
            {address.data.localUrl}
          </p>
        ) : address.isError ? (
          <p className="text-[12.5px] text-muted-foreground">
            Couldn&apos;t get its address: {errorText(address.error) ?? "unknown error"}
          </p>
        ) : null}
      </AddressRow>

      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Give this task a new address?</AlertDialogTitle>
            <AlertDialogDescription>
              Senders using the old address stop working.
              {connected ? " Threadlines gives GitHub the new one." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={busy === "rotate"}
              onClick={() => void rotate()}
              data-testid="scheduled-event-rotate-confirm"
            >
              New address
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/** A labelled block of an opened event: its headers, body or message. */
function EventBlock({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h4 className="text-[12px] leading-4 font-medium text-muted-foreground">{label}</h4>
      {children}
    </div>
  );
}

const PRE_CLASS =
  "max-h-64 overflow-auto font-mono text-[11.5px] leading-[17px] break-all whitespace-pre-wrap text-foreground select-text";

/** What an event was sent with and what it made: headers, the body's start, and the agent's message. */
function EventDetailBody({
  detail,
  messageLabel,
}: {
  readonly detail: WebhookEventDetail;
  readonly messageLabel: string;
}) {
  const headers = Object.entries(detail.headers);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <EventBlock label={messageLabel}>
        {detail.message === null ? (
          <p className="text-[12.5px] text-muted-foreground">None: it stopped before a run.</p>
        ) : (
          <pre className={PRE_CLASS} data-testid="scheduled-event-message">
            {detail.message}
          </pre>
        )}
        {detail.missingFields.length > 0 ? (
          <p className="text-[12px] text-muted-foreground">
            Filled in empty: <span className="font-mono">{detail.missingFields.join(", ")}</span>
          </p>
        ) : null}
      </EventBlock>
      {headers.length > 0 ? (
        <EventBlock label="Headers">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11.5px] leading-[17px]">
            {headers.map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="break-all text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </EventBlock>
      ) : null}
      <EventBlock label={detail.bodyTruncated ? "Body (the start of it)" : "Body"}>
        {detail.body.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">Empty.</p>
        ) : (
          <pre className={PRE_CLASS} data-testid="scheduled-event-body">
            {detail.body}
          </pre>
        )}
      </EventBlock>
    </div>
  );
}

/**
 * "Send a test event" (docs/design/event-tasks.md): a sample event for the
 * task's trigger, sent through every check as a dry run, with the outcome
 * and the exact message its agent would get. "Start a run with it" sends one
 * for real.
 */
export function EventTestSection({
  located,
  result,
  onResult,
  onClose,
}: {
  readonly located: LocatedTask;
  readonly result: { readonly detail: WebhookEventDetail; readonly started: boolean };
  readonly onResult: (detail: WebhookEventDetail, started: boolean) => void;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { detail, started } = result;
  const startRun = async () => {
    const client = clientFor(located);
    if (!client) return;
    setBusy(true);
    try {
      const next = await client.scheduledTasks.testWebhook({ id: located.task.id, startRun: true });
      onResult(next, true);
      refreshEventHistory(queryClient, located);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't start a run",
        description: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  };
  const threadId = detail.event.threadId;
  return (
    <SettingsSection
      title="Test event"
      description={
        started
          ? "A sample event went through every check, and ran."
          : "A sample event went through every check. Nothing started."
      }
      headerAction={
        <Button type="button" size="xs" variant="outline" onClick={onClose}>
          Close
        </Button>
      }
      data-testid="scheduled-event-test"
    >
      <div className={cn(SETTINGS_GROUP_ROW_CLASS, "flex min-w-0 flex-col gap-0.5 px-3.5 py-2.5")}>
        <p className="text-[13.5px] leading-[19px] font-medium text-foreground">
          {describeWebhookEvent(detail.event)}
        </p>
        <p
          className="flex min-w-0 items-baseline gap-2 text-[12.5px] leading-[18px] text-muted-foreground"
          data-testid="scheduled-event-test-outcome"
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-[7px] shrink-0 translate-y-[-1px] rounded-full",
              WEBHOOK_EVENT_DOT_CLASSES[detail.event.status],
            )}
          />
          <span className="min-w-0">
            {started ? describeWebhookEventOutcome(detail.event) : dryRunOutcome(detail.event)}
          </span>
        </p>
      </div>
      <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")}>
        <EventDetailBody
          detail={detail}
          messageLabel={started ? "The message the agent got" : "The message the agent would get"}
        />
      </div>
      <div
        className={cn(SETTINGS_GROUP_ROW_CLASS, "flex flex-wrap items-center gap-2 px-3.5 py-2.5")}
      >
        {started && threadId !== null ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: located.environment.environmentId, threadId },
              })
            }
          >
            Open thread
          </Button>
        ) : null}
        {started ? null : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy || detail.message === null}
            onClick={() => void startRun()}
            data-testid="scheduled-event-test-start"
          >
            Start a run with it
          </Button>
        )}
      </div>
    </SettingsSection>
  );
}

/** A dry run's outcome: what would have happened, since nothing did. */
function dryRunOutcome(event: WebhookEventRecord): string {
  if (event.status === "ran" || event.status === "joined" || event.status === "waiting") {
    return event.status === "joined"
      ? "It passes every check, and would continue its thread."
      : "It passes every check, and would start a run.";
  }
  return describeWebhookEventOutcome(event);
}

/** One event in the list: what it was and how it ended; opens to its headers, body and message. */
function EventRow({
  located,
  event,
  nowMs,
  onOpenThread,
}: {
  readonly located: LocatedTask;
  readonly event: WebhookEventRecord;
  readonly nowMs: number;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: [
      "scheduledTasks",
      "webhookEvent",
      located.environment.environmentId,
      located.task.id,
      event.eventId,
      event.status,
    ],
    queryFn: async () => {
      const connection = readEnvironmentConnection(located.environment.environmentId);
      if (!connection) throw new Error(`${located.environment.label} isn't connected.`);
      return connection.client.scheduledTasks.webhookEvent({
        id: located.task.id,
        eventId: event.eventId,
      });
    },
    enabled: open,
  });
  const source = WEBHOOK_EVENT_SOURCE_LABELS[event.source];
  const replay = async () => {
    const client = clientFor(located);
    if (!client) return;
    setReplaying(true);
    try {
      const record = await client.scheduledTasks.runWithWebhookEvent({
        id: located.task.id,
        eventId: event.eventId,
      });
      toastManager.add({
        type: record.status === "skipped" || record.status === "failed" ? "warning" : "success",
        title: describeWebhookEventOutcome(record),
      });
      refreshEventHistory(queryClient, located);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't run it again",
        description: errorText(error),
      });
    } finally {
      setReplaying(false);
    }
  };
  return (
    <li className={SETTINGS_GROUP_ROW_CLASS} data-testid={`scheduled-event-${event.eventId}`}>
      <div className="flex min-w-0 flex-col gap-0.5 px-3.5 py-2.5">
        <button
          type="button"
          className="flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md text-left focus-ring"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "mt-[3px] size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1 text-[13.5px] leading-[19px] font-medium text-foreground">
            {describeWebhookEvent(event)}
          </span>
        </button>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 ps-[22px] font-mono text-[11px] text-muted-foreground">
          <span>{formatWhen(event.receivedAt, nowMs)}</span>
          {source ? <span>{source}</span> : null}
        </div>
        <p
          className="flex min-w-0 items-baseline gap-2 ps-[22px] text-[12.5px] leading-[18px] text-muted-foreground"
          data-testid={`scheduled-event-outcome-${event.eventId}`}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-[7px] shrink-0 translate-y-[-1px] rounded-full",
              WEBHOOK_EVENT_DOT_CLASSES[event.status],
            )}
          />
          <span className="min-w-0">
            {describeWebhookEventOutcome(event)}
            {event.threadId !== null ? (
              <>
                {" · "}
                <button
                  type="button"
                  className="cursor-pointer text-primary-readable underline-offset-2 hover:underline focus-ring"
                  onClick={() => onOpenThread(event.threadId!)}
                >
                  Open thread
                </button>
              </>
            ) : null}
          </span>
        </p>
      </div>
      {open ? (
        <div className="flex flex-col gap-3 ps-9 pe-3.5 pb-3" data-testid="scheduled-event-detail">
          {detail.data ? (
            <EventDetailBody detail={detail.data} messageLabel="The message the agent got" />
          ) : (
            <p className="text-[12.5px] text-muted-foreground">
              {detail.isError
                ? `Couldn't load it: ${errorText(detail.error) ?? "unknown error"}`
                : "Loading…"}
            </p>
          )}
          {event.canReplay ? (
            <div>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={replaying}
                onClick={() => void replay()}
                data-testid="scheduled-event-replay"
              >
                Run with this event
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** An event task's events, newest first, a page at a time; follows the task as events arrive. */
export function EventHistory({ located }: { readonly located: LocatedTask }) {
  const nowMs = useRelativeTimeTick(30_000);
  const navigate = useNavigate();
  const { environment, task } = located;
  // Read again when an event arrives or a run starts or ends.
  const version = `${task.webhook?.lastEventAt ?? ""}:${task.lastRun?.slotUtc ?? ""}:${task.lastRun?.status ?? ""}:${task.workingRuns}`;
  const events = useInfiniteQuery({
    queryKey: [...eventKeys.events(located), version],
    queryFn: async ({ pageParam }) => {
      const connection = readEnvironmentConnection(environment.environmentId);
      if (!connection) throw new Error(`${environment.label} isn't connected.`);
      return connection.client.scheduledTasks.listWebhookEvents({
        id: task.id,
        limit: EVENT_PAGE,
        ...(pageParam !== null ? { before: pageParam } : {}),
      });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => (page.hasMore ? (page.events.at(-1)?.receivedAt ?? null) : null),
    placeholderData: keepPreviousData,
  });
  const list = events.data?.pages.flatMap((page) => page.events) ?? [];
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: environment.environmentId, threadId },
    });
  return (
    <SettingsSection title="Events" bare={list.length === 0} data-testid="scheduled-event-history">
      {list.length === 0 ? (
        <p className="px-1 text-[12.5px] text-muted-foreground">
          {events.isError
            ? `Couldn't load its events: ${errorText(events.error) ?? "unknown error"}`
            : events.isPending
              ? "Loading events…"
              : "No events yet."}
        </p>
      ) : (
        <>
          <ul className="flex flex-col">
            {list.map((event) => (
              <EventRow
                key={event.eventId}
                located={located}
                event={event}
                nowMs={nowMs}
                onOpenThread={openThread}
              />
            ))}
          </ul>
          {events.hasNextPage ? (
            <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2")}>
              <Button
                size="xs"
                variant="ghost"
                disabled={events.isFetchingNextPage}
                onClick={() => void events.fetchNextPage()}
                data-testid="scheduled-event-history-more"
              >
                Show more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
