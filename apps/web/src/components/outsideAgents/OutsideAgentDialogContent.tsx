/**
 * The body of the dialog an agent outside Threadlines is approved in
 * (docs/design/outside-agents.md, "The dialog"), and changed in later. For a
 * sign-in it shows who asks (the name is the agent's own word for itself),
 * the code its browser page shows too, and what it would replace; then what
 * it may do, in which projects and with how much access, with Deny and
 * Allow. Change opens the same choices on a connection, with Save.
 *
 * A chunk of its own (outsideAgentDialog.tsx): the host at the root and
 * Settings' Agents group render it inside their own Dialog root.
 */
import {
  type OutsideAgentConnection,
  type OutsideAgentPendingRequest,
  type ProjectId,
  RUNTIME_MODES,
  type RuntimeMode,
} from "@threadlines/contracts";
import { useId, useRef, useState } from "react";

import {
  approveOutsideAgent,
  denyAllOutsideAgents,
  denyOutsideAgent,
  describeOutsideAgentFailure,
  updateOutsideAgent,
  useThisComputerProjects,
} from "../../environments/outsideAgents/outsideAgents";
import {
  describeOutsideAgentsWaiting,
  initialOutsideAgentDraft,
  OUTSIDE_AGENT_ACCESS_CHOICES,
  outsideAgentGrantFromDraft,
  type OutsideAgentGrantDraft,
} from "../../environments/outsideAgents/outsideAgents.logic";
import { cn } from "../../lib/utils";
import { runtimeModeConfig } from "../../runtimeModeOptions";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** What the dialog is about: a sign-in waiting for the user, or a connection to change. */
export type OutsideAgentDialogSubject =
  | {
      readonly kind: "request";
      readonly request: OutsideAgentPendingRequest;
      /** Sign-ins waiting behind this one. */
      readonly waitingBehind: number;
    }
  | { readonly kind: "change"; readonly connection: OutsideAgentConnection };

const FIELD_LABEL_CLASS = "text-xs font-medium text-foreground";
const HINT_CLASS = "text-[12.5px] leading-[18px] text-muted-foreground";

const ACCESS_DETAILS = {
  see: "Projects, agents, and every thread's status and messages.",
  start: "All of that, and start threads of its own.",
} as const;

/**
 * The dialog's popup. `onClose` closes a Change (a sign-in's dialog closes
 * when its answer leaves the waiting list).
 */
export function OutsideAgentDialogContent({
  subject,
  onClose,
}: {
  readonly subject: OutsideAgentDialogSubject;
  readonly onClose: () => void;
}) {
  const projects = useThisComputerProjects();
  const name = subject.kind === "request" ? subject.request.name : subject.connection.name;
  const requestedAccess = subject.kind === "request" ? subject.request.requestedAccess : "start";
  const [draft, setDraft] = useState<OutsideAgentGrantDraft>(() =>
    initialOutsideAgentDraft(subject.kind === "change" ? subject.connection : null),
  );
  const [busy, setBusy] = useState<"allow" | "deny" | "deny-all" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Focus lands on the dialog itself: it opens on its own, often while the
  // user types elsewhere, and a key meant for that must not answer it.
  const focusRef = useRef<HTMLDivElement>(null);
  const fieldId = useId();

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
  // What it may do as the dialog shows it: never more than it asked for.
  const shownAccess = requestedAccess === "see" ? "see" : draft.access;

  return (
    <DialogPopup
      showCloseButton={subject.kind === "change"}
      initialFocus={focusRef}
      data-testid="outside-agent-dialog"
    >
      <DialogHeader>
        <div ref={focusRef} tabIndex={-1} className="flex flex-col gap-2 outline-none">
          <div className="flex items-start justify-between gap-3">
            <DialogTitle>
              {subject.kind === "request"
                ? `${name} wants to use Threadlines`
                : `Change what ${name} can do`}
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
          <DialogDescription className="text-[12.5px] leading-[18px]">
            {subject.kind === "request"
              ? `Name given by the agent. It signs in on this computer (port ${subject.request.callbackPort}).`
              : "Name given by the agent. It gets the change on its next call."}
          </DialogDescription>
          {subject.kind === "request" && subject.request.replaces !== null ? (
            <p className={HINT_CLASS} data-testid="outside-agent-replaces">
              Replaces your earlier {subject.request.replaces.name} connection.
            </p>
          ) : null}
        </div>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <div className="grid gap-1.5">
          <span className={FIELD_LABEL_CLASS} id={`${fieldId}-access`}>
            It can
          </span>
          <RadioGroup
            value={shownAccess}
            onValueChange={(value) => update({ access: value as OutsideAgentGrantDraft["access"] })}
            aria-labelledby={`${fieldId}-access`}
            disabled={disabled}
            className="gap-1"
          >
            {(["see", "start"] as const).map((access) => {
              const unavailable = access === "start" && requestedAccess === "see";
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

        <ProjectsField
          labelId={`${fieldId}-projects`}
          projects={projects}
          draft={draft}
          disabled={disabled}
          onChange={(change) => update(change)}
        />

        {shownAccess === "start" ? (
          <div className="grid gap-1.5">
            <span className={FIELD_LABEL_CLASS} id={`${fieldId}-ceiling`}>
              Highest access
            </span>
            <Select
              value={draft.maxRuntimeMode}
              disabled={disabled}
              onValueChange={(value) => update({ maxRuntimeMode: value as RuntimeMode })}
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
            <p className={HINT_CLASS}>
              It can start threads, and send to or stop the ones it started. It can&apos;t answer
              their approvals. You do that here.
            </p>
          </div>
        ) : null}

        {error !== null ? (
          <p
            role="alert"
            className="text-[12.5px] text-destructive"
            data-testid="outside-agent-error"
          >
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {subject.kind === "request" ? (
          <>
            {subject.waitingBehind > 0 ? (
              <div className="flex items-center gap-2 sm:me-auto">
                <span className="text-[12.5px] text-muted-foreground">
                  {describeOutsideAgentsWaiting(subject.waitingBehind)}
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
              onClick={() => void run("deny", () => denyOutsideAgent(subject.request.requestId))}
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
                  approveOutsideAgent({ requestId: subject.request.requestId, ...grant }),
                );
              }}
              data-testid="outside-agent-allow"
            >
              {busy === "allow" ? "Allowing…" : "Allow"}
            </Button>
          </>
        ) : (
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
                  });
                  onClose();
                });
              }}
              data-testid="outside-agent-save"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}

/** All of this computer's projects, or the ones ticked. */
function ProjectsField({
  labelId,
  projects,
  draft,
  disabled,
  onChange,
}: {
  readonly labelId: string;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly name: string }>;
  readonly draft: OutsideAgentGrantDraft;
  readonly disabled: boolean;
  readonly onChange: (change: Partial<OutsideAgentGrantDraft>) => void;
}) {
  const noneTicked = projects.every((project) => !draft.projectIds.has(project.id));
  return (
    <div className="grid gap-1.5">
      <span className={FIELD_LABEL_CLASS} id={labelId}>
        Projects
      </span>
      <SegmentedControl
        value={draft.allProjects ? "all" : "some"}
        onValueChange={(value) => onChange({ allProjects: value === "all" })}
        aria-labelledby={labelId}
        disabled={disabled}
      >
        <SegmentedControlItem value="all" data-testid="outside-agent-projects-all">
          All projects
        </SegmentedControlItem>
        <SegmentedControlItem value="some" data-testid="outside-agent-projects-some">
          Only some
        </SegmentedControlItem>
      </SegmentedControl>
      {draft.allProjects ? (
        <p className={HINT_CLASS}>Including projects you add later.</p>
      ) : projects.length === 0 ? (
        <p className={HINT_CLASS}>This computer has no projects yet.</p>
      ) : (
        <>
          <div
            className="surface-group max-h-44 overflow-y-auto py-1"
            data-testid="outside-agent-projects"
          >
            {projects.map((project) => {
              const checked = draft.projectIds.has(project.id);
              return (
                <label
                  key={project.id}
                  className="flex min-h-8 cursor-pointer items-center gap-2.5 px-3 py-1"
                >
                  <Checkbox
                    checked={checked}
                    disabled={disabled}
                    aria-label={project.name}
                    onCheckedChange={(next) => {
                      const projectIds = new Set(draft.projectIds);
                      if (next) projectIds.add(project.id);
                      else projectIds.delete(project.id);
                      onChange({ projectIds });
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {project.name}
                  </span>
                </label>
              );
            })}
          </div>
          {noneTicked ? <p className={HINT_CLASS}>Tick at least one.</p> : null}
        </>
      )}
    </div>
  );
}
