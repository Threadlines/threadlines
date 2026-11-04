/**
 * The body of the dialog an agent outside Threadlines is approved in
 * (docs/design/outside-agents.md, "The dialog"), and changed in later; and
 * the same for assistants in their makers' clouds (docs/design/assistants.md).
 *
 * For a sign-in it shows who asks and what it would replace: a local agent's
 * name is its own word for itself, with the code its browser page shows too;
 * an assistant's comes with what the relay could tell about it (where it
 * signs in from, whether Threadlines knows it, roughly where its sign-in page
 * was opened). Then what it may do, in which projects and with how much
 * access, with Deny and Allow. Change opens the same choices on a
 * connection, with Save. Create a key opens them for a new key-signed
 * assistant connection, then shows the key once.
 *
 * A chunk of its own (outsideAgentDialog.tsx): the host at the root and
 * Settings' Agents and Assistants groups render it inside their own Dialog
 * root.
 */
import {
  OutsideAgentAccess,
  type OutsideAgentAssistantSignIn,
  type OutsideAgentConnection,
  type OutsideAgentCreateKeyResult,
  type OutsideAgentPendingRequest,
  type ProjectId,
  RUNTIME_MODES,
  type RuntimeMode,
} from "@threadlines/contracts";
import { KNOWN_ASSISTANT_NAMES, KNOWN_ASSISTANTS } from "@threadlines/shared/knownAssistants";
import { TriangleAlertIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import {
  approveOutsideAgent,
  createAssistantKey,
  denyAllOutsideAgents,
  denyOutsideAgent,
  describeOutsideAgentFailure,
  updateOutsideAgent,
  useThisComputerProjects,
} from "../../environments/outsideAgents/outsideAgents";
import {
  type AssistantChoice,
  choiceDisplayName,
  describeAssistantIdentity,
  describeOutsideAgentsWaiting,
  initialOutsideAgentDraft,
  OUTSIDE_AGENT_ACCESS_CHOICES,
  outsideAgentAccessAllowed,
  outsideAgentGrantFromDraft,
  type OutsideAgentGrantDraft,
  pickedAssistant,
} from "../../environments/outsideAgents/outsideAgents.logic";
import { cn } from "../../lib/utils";
import { runtimeModeConfig } from "../../runtimeModeOptions";
import { CopyButton } from "../CopyButton";
import { Button } from "../ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AssistantMark } from "./AssistantMark";
import {
  OUTSIDE_AGENT_FIELD_LABEL_CLASS as FIELD_LABEL_CLASS,
  OUTSIDE_AGENT_HINT_CLASS as HINT_CLASS,
  OutsideAgentErrorLine as ErrorLine,
  OutsideAgentProjectsField,
} from "./OutsideAgentFields";

/**
 * What the dialog is about: a sign-in waiting for the user (a local agent's
 * or an assistant's), a connection to change, or a new assistant key.
 */
export type OutsideAgentDialogSubject =
  | {
      readonly kind: "request";
      readonly request: OutsideAgentPendingRequest;
      /** Sign-ins waiting behind this one, of both kinds. */
      readonly waitingBehind: number;
    }
  | {
      readonly kind: "assistant";
      readonly signIn: OutsideAgentAssistantSignIn;
      readonly waitingBehind: number;
    }
  | { readonly kind: "change"; readonly connection: OutsideAgentConnection }
  | { readonly kind: "key" };

type GrantSubject = Exclude<OutsideAgentDialogSubject, { readonly kind: "key" }>;

const ACCESS_DETAILS: Record<OutsideAgentAccess, string> = {
  see: "Projects, agents, and every thread's status and messages.",
  start: "All of that, and start threads of its own.",
  work: "Can also message, stop and answer questions in any thread in its projects. Never approvals.",
};

/** What the highest access means at each level that has one. */
const CEILING_HINTS: Record<Exclude<OutsideAgentAccess, "see">, string> = {
  start:
    "It can start threads, and send to or stop the ones it started. It can't answer their approvals. You do that here.",
  work: "It can message, stop and answer questions in threads at or under this access, and only read the rest. It can't answer approvals. You do that here.",
};

/** A key's name, as the server takes it. */
const KEY_NAME_MAX_LENGTH = 60;

/**
 * The dialog's popup. `onClose` closes a Change or a new key (a sign-in's
 * dialog closes when its answer leaves the waiting list).
 */
export function OutsideAgentDialogContent({
  subject,
  onClose,
}: {
  readonly subject: OutsideAgentDialogSubject;
  readonly onClose: () => void;
}) {
  return subject.kind === "key" ? (
    <CreateKeyContent onClose={onClose} />
  ) : (
    <GrantContent subject={subject} onClose={onClose} />
  );
}

/** What it says about a connection being changed: whose word its name is, and when the change lands. */
function describeChange(connection: OutsideAgentConnection, givenName: string | null): string {
  const lands = "It gets the change on its next call.";
  if (connection.kind === "local") return `Name given by the agent. ${lands}`;
  if (connection.signIn === "key" || connection.identity === null) return lands;
  return `${describeAssistantIdentity(connection.identity, givenName)} ${lands}`;
}

/**
 * The assistant a sign-in or connection is about, for its picker: the name
 * it gave, and Threadlines' guess (or the user's earlier pick). Null for a
 * local agent's.
 */
function assistantOf(subject: GrantSubject) {
  if (subject.kind === "assistant") {
    return {
      givenName: subject.signIn.givenName ?? subject.signIn.name,
      initial: subject.signIn.assistant,
      keepsLabel: false,
    };
  }
  if (subject.kind === "change" && subject.connection.kind === "assistant") {
    return {
      givenName: subject.connection.givenName ?? subject.connection.name,
      initial: subject.connection.assistant,
      // A key keeps the label the user typed ("Muse work"); the pick only sets its mark.
      keepsLabel: subject.connection.signIn === "key",
    };
  }
  return null;
}

/** A sign-in to answer, or a connection to change. */
function GrantContent({
  subject,
  onClose,
}: {
  readonly subject: GrantSubject;
  readonly onClose: () => void;
}) {
  const projects = useThisComputerProjects();
  const signIn =
    subject.kind === "request"
      ? subject.request
      : subject.kind === "assistant"
        ? subject.signIn
        : null;
  const assistant = assistantOf(subject);
  const [choice, setChoice] = useState<AssistantChoice>(() => assistant?.initial ?? "none");
  // An assistant is named as the picker says: "Grok Bot", or the name it gave.
  const name =
    assistant !== null && !assistant.keepsLabel
      ? choiceDisplayName(choice, assistant.givenName)
      : (signIn?.name ?? (subject.kind === "change" ? subject.connection.name : ""));
  const givenName = assistant !== null && assistant.givenName !== name ? assistant.givenName : null;
  const assistantInput = assistant !== null ? { assistant: pickedAssistant(choice) } : {};
  const requestedAccess: OutsideAgentAccess = signIn?.requestedAccess ?? "start";
  const [draft, setDraft] = useState<OutsideAgentGrantDraft>(() =>
    initialOutsideAgentDraft(subject.kind === "change" ? subject.connection : null),
  );
  const [busy, setBusy] = useState<"allow" | "deny" | "deny-all" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Focus lands on the dialog itself: it opens on its own, often while the
  // user types elsewhere, and a key meant for that must not answer it.
  const focusRef = useRef<HTMLDivElement>(null);

  const grant = outsideAgentGrantFromDraft(draft, {
    requestedAccess,
    availableProjectIds: projects.map((project) => project.id),
  });
  const update = (change: Partial<OutsideAgentGrantDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
    setError(null);
  };
  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(describeOutsideAgentFailure(cause, "Threadlines didn't answer. Try again."));
    } finally {
      setBusy(null);
    }
  };
  const disabled = busy !== null;
  const waitingBehind = subject.kind === "change" ? 0 : subject.waitingBehind;

  return (
    <DialogPopup
      showCloseButton={subject.kind === "change"}
      initialFocus={focusRef}
      data-testid="outside-agent-dialog"
    >
      <DialogHeader>
        <div ref={focusRef} tabIndex={-1} className="flex flex-col gap-2 outline-none">
          <div className="flex items-start justify-between gap-3">
            <DialogTitle className="flex items-center gap-2">
              <AssistantMark assistant={pickedAssistant(choice)} className="size-4" />
              <span>
                {signIn !== null
                  ? `${name} wants to use Threadlines`
                  : `Change what ${name} can do`}
              </span>
            </DialogTitle>
            {subject.kind === "request" ? (
              <span
                className="surface-group shrink-0 rounded-lg px-2 py-1 font-mono text-[14px] leading-5 tracking-wider text-foreground"
                aria-label={`Code ${subject.request.code}`}
                data-testid="outside-agent-code"
              >
                {subject.request.code}
              </span>
            ) : null}
          </div>
          <DialogDescription
            className="text-[12.5px] leading-[18px]"
            data-testid="outside-agent-identity"
          >
            {subject.kind === "request"
              ? `Name given by the agent. It signs in on this computer (port ${subject.request.callbackPort}).`
              : subject.kind === "assistant"
                ? describeAssistantIdentity(subject.signIn.identity, givenName)
                : describeChange(subject.connection, givenName)}
          </DialogDescription>
          {subject.kind === "assistant" && !subject.signIn.identity.known ? (
            <p
              className="flex items-start gap-1.5 text-[12.5px] leading-[18px] text-warning-foreground"
              data-testid="outside-agent-unknown"
            >
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Threadlines doesn&apos;t know this assistant. Only allow it if you added it yourself.
            </p>
          ) : null}
          {subject.kind === "assistant" && subject.signIn.place !== null ? (
            <p className={HINT_CLASS} data-testid="outside-agent-place">
              The sign-in page was opened near {subject.signIn.place}.
            </p>
          ) : null}
          {signIn !== null && signIn.replaces !== null ? (
            <p className={HINT_CLASS} data-testid="outside-agent-replaces">
              Replaces your earlier {signIn.replaces.name} connection.
            </p>
          ) : null}
        </div>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {assistant !== null ? (
          <AssistantField
            choice={choice}
            givenName={assistant.givenName}
            disabled={disabled}
            onChange={(next) => {
              setChoice(next);
              setError(null);
            }}
          />
        ) : null}
        <GrantFields
          projects={projects}
          draft={draft}
          requestedAccess={requestedAccess}
          disabled={disabled}
          onChange={update}
        />
        <ErrorLine error={error} />
      </DialogPanel>
      <DialogFooter>
        {signIn !== null ? (
          <>
            {waitingBehind > 0 ? (
              <div className="flex items-center gap-2 sm:me-auto">
                <span className="text-[12.5px] text-muted-foreground">
                  {describeOutsideAgentsWaiting(waitingBehind)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void run("deny-all", denyAllOutsideAgents)}
                  data-testid="outside-agent-deny-all"
                >
                  {busy === "deny-all" ? "Denying…" : "Deny all"}
                </Button>
              </div>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => void run("deny", () => denyOutsideAgent(signIn.requestId))}
              data-testid="outside-agent-deny"
            >
              {busy === "deny" ? "Denying…" : "Deny"}
            </Button>
            <Button
              size="sm"
              disabled={disabled || grant === null}
              onClick={() => {
                if (grant === null) return;
                void run("allow", () =>
                  approveOutsideAgent({ requestId: signIn.requestId, ...grant, ...assistantInput }),
                );
              }}
              data-testid="outside-agent-allow"
            >
              {busy === "allow" ? "Allowing…" : "Allow"}
            </Button>
          </>
        ) : subject.kind === "change" ? (
          <>
            <Button variant="outline" size="sm" disabled={disabled} onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={disabled || grant === null}
              onClick={() => {
                if (grant === null) return;
                void run("save", async () => {
                  await updateOutsideAgent({
                    connectionId: subject.connection.connectionId,
                    ...grant,
                    ...assistantInput,
                  });
                  onClose();
                });
              }}
              data-testid="outside-agent-save"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
          </>
        ) : null}
      </DialogFooter>
    </DialogPopup>
  );
}

/**
 * Which assistant this is. Several sign in through someone else's service
 * (Grok Bot signs in as Cursor), so Threadlines can only guess; the user
 * picks, and Settings names it and shows its mark by that.
 */
function AssistantField({
  choice,
  givenName,
  disabled,
  onChange,
}: {
  readonly choice: AssistantChoice;
  readonly givenName: string;
  readonly disabled: boolean;
  readonly onChange: (choice: AssistantChoice) => void;
}) {
  const labelId = useId();
  const otherLabel = `Its own name (${givenName})`;
  return (
    <div className="grid gap-1.5">
      <span className={FIELD_LABEL_CLASS} id={labelId}>
        Assistant
      </span>
      <Select
        value={choice}
        disabled={disabled}
        onValueChange={(value) => onChange(value as AssistantChoice)}
      >
        <SelectTrigger
          size="sm"
          className="w-56"
          aria-labelledby={labelId}
          data-testid="outside-agent-assistant"
        >
          <SelectValue>
            <span className="flex items-center gap-1.5">
              <AssistantMark assistant={pickedAssistant(choice)} />
              {choice === "none" ? otherLabel : KNOWN_ASSISTANT_NAMES[choice]}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {KNOWN_ASSISTANTS.map((known) => (
            <SelectItem key={known} value={known}>
              <span className="flex items-center gap-1.5">
                <AssistantMark assistant={known} />
                {KNOWN_ASSISTANT_NAMES[known]}
              </span>
            </SelectItem>
          ))}
          <SelectItem value="none">{otherLabel}</SelectItem>
        </SelectPopup>
      </Select>
      <p className={HINT_CLASS} data-testid="outside-agent-assistant-hint">
        Threadlines guesses from how it signs in. Pick another if it&apos;s wrong.
      </p>
    </div>
  );
}

/**
 * A key for an assistant that can't sign in (Muse): its name and the same
 * choices as a sign-in, then the key and the address, once. The key lives in
 * this view's state only; closing the dialog lets it go for good.
 */
function CreateKeyContent({ onClose }: { readonly onClose: () => void }) {
  const projects = useThisComputerProjects();
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<OutsideAgentGrantDraft>(() => initialOutsideAgentDraft(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<OutsideAgentCreateKeyResult | null>(null);
  const nameId = useId();

  const grant = outsideAgentGrantFromDraft(draft, {
    requestedAccess: "start",
    availableProjectIds: projects.map((project) => project.id),
  });
  const trimmedName = name.trim();
  const canCreate = !busy && trimmedName.length > 0 && grant !== null;
  const update = (change: Partial<OutsideAgentGrantDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
    setError(null);
  };
  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      setMade(await createAssistantKey({ name: trimmedName, ...grant }));
    } catch (cause) {
      setError(describeOutsideAgentFailure(cause, "Threadlines didn't answer. Try again."));
    } finally {
      setBusy(false);
    }
  };

  if (made !== null) {
    return (
      <DialogPopup showCloseButton={false} data-testid="assistant-key-made">
        <DialogHeader>
          <DialogTitle>Key for {made.connection.name}</DialogTitle>
          <DialogDescription className="text-[12.5px] leading-[18px]">
            You won&apos;t see this key again. Give both to your assistant, the key only where it
            asks for one (Muse has its own box), never in a chat.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <SecretField label="Key" value={made.key} testId="assistant-key-value" />
          <SecretField label="Address" value={made.address} testId="assistant-key-address" />
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" onClick={onClose} data-testid="assistant-key-done">
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    );
  }

  return (
    <DialogPopup data-testid="assistant-key-dialog">
      <DialogHeader>
        <DialogTitle>Create a key</DialogTitle>
        <DialogDescription className="text-[12.5px] leading-[18px]">
          For an assistant that takes a key instead of signing in, like Muse.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <div className="grid gap-1.5">
          <label className={FIELD_LABEL_CLASS} htmlFor={nameId}>
            Name
          </label>
          <Input
            id={nameId}
            value={name}
            maxLength={KEY_NAME_MAX_LENGTH}
            placeholder="e.g. Muse"
            disabled={busy}
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
            }}
            data-testid="assistant-key-name"
          />
        </div>
        <GrantFields
          projects={projects}
          draft={draft}
          requestedAccess="start"
          disabled={busy}
          onChange={update}
        />
        <ErrorLine error={error} />
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canCreate}
          onClick={() => void create()}
          data-testid="assistant-key-create"
        >
          {busy ? "Creating…" : "Create key"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

/** One value to paste elsewhere: its label, the value in full, and Copy. */
function SecretField({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}) {
  return (
    <div className="grid gap-1.5">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <div className="surface-group flex items-center gap-3 rounded-lg px-3 py-2">
        <code
          className="min-w-0 flex-1 font-mono text-[12px] leading-[18px] break-all text-foreground select-text"
          data-testid={testId}
        >
          {value}
        </code>
        <CopyButton value={value} label={`Copy the ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

/**
 * What a connection may do (See only, if that's all it asked for), in which
 * projects, and the highest access a thread may have for it to start, send
 * or answer there.
 */
function GrantFields({
  projects,
  draft,
  requestedAccess,
  disabled,
  onChange,
}: {
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly name: string }>;
  readonly draft: OutsideAgentGrantDraft;
  readonly requestedAccess: OutsideAgentAccess;
  readonly disabled: boolean;
  readonly onChange: (change: Partial<OutsideAgentGrantDraft>) => void;
}) {
  const fieldId = useId();
  // What it may do as the dialog shows it: only a level the sign-in allows.
  const shownAccess = outsideAgentAccessAllowed(draft.access, requestedAccess)
    ? draft.access
    : "see";
  return (
    <>
      <div className="grid gap-1.5">
        <span className={FIELD_LABEL_CLASS} id={`${fieldId}-access`}>
          It can
        </span>
        <RadioGroup
          value={shownAccess}
          onValueChange={(value) => onChange({ access: value as OutsideAgentGrantDraft["access"] })}
          aria-labelledby={`${fieldId}-access`}
          disabled={disabled}
          className="gap-1"
        >
          {OutsideAgentAccess.literals.map((access) => {
            const unavailable = !outsideAgentAccessAllowed(access, requestedAccess);
            return (
              <label
                key={access}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg px-1 py-1",
                  unavailable ? "cursor-default" : "cursor-pointer",
                )}
              >
                <Radio
                  value={access}
                  disabled={unavailable}
                  className="mt-0.5"
                  data-testid={`outside-agent-access-${access}`}
                />
                <span className="min-w-0">
                  <span
                    className={cn(
                      "block text-[13.5px] leading-[19px] font-medium",
                      unavailable ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {OUTSIDE_AGENT_ACCESS_CHOICES[access]}
                  </span>
                  <span className={cn("block", HINT_CLASS)}>
                    {unavailable ? "It only asked to see threads." : ACCESS_DETAILS[access]}
                  </span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </div>

      <OutsideAgentProjectsField
        labelId={`${fieldId}-projects`}
        projects={projects}
        choice={draft}
        disabled={disabled}
        onChange={onChange}
      />

      {shownAccess !== "see" ? (
        <div className="grid gap-1.5">
          <span className={FIELD_LABEL_CLASS} id={`${fieldId}-ceiling`}>
            Highest access
          </span>
          <Select
            value={draft.maxRuntimeMode}
            disabled={disabled}
            onValueChange={(value) => onChange({ maxRuntimeMode: value as RuntimeMode })}
          >
            <SelectTrigger
              size="sm"
              className="w-48"
              aria-labelledby={`${fieldId}-ceiling`}
              data-testid="outside-agent-ceiling"
            >
              <SelectValue>{runtimeModeConfig[draft.maxRuntimeMode].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {RUNTIME_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {runtimeModeConfig[mode].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className={HINT_CLASS} data-testid="outside-agent-ceiling-hint">
            {CEILING_HINTS[shownAccess]}
          </p>
        </div>
      ) : null}
    </>
  );
}
