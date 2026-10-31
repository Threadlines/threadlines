/**
 * Add and Edit for a web address assistants' alerts go to
 * (docs/design/assistants.md, step 4): the address, an optional
 * Authorization header, the kinds of alert, the projects, and whether to skip
 * threads the user is looking at. The header is write-only: Edit says
 * whether one is set and offers to replace or clear it, never its value.
 * The server checks the address on save (https, and not a private one) and
 * its refusal shows here in its own words. Rendered inside the Dialog root
 * of Settings' alerts group (AssistantAlertsSection).
 */
import { AssistantAlertKind, type AssistantAlertTarget } from "@threadlines/contracts";
import { useId, useState } from "react";

import {
  createAssistantAlertTarget,
  describeOutsideAgentFailure,
  updateAssistantAlertTarget,
  useThisComputerProjects,
} from "../../environments/outsideAgents/outsideAgents";
import {
  ASSISTANT_ALERT_KIND_LABELS,
  type AssistantAlertAuthorizationDraft,
  assistantAlertTargetCreateInput,
  type AssistantAlertTargetDraft,
  assistantAlertTargetUpdateInput,
  initialAssistantAlertTargetDraft,
} from "../../environments/outsideAgents/outsideAgents.logic";
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
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  OUTSIDE_AGENT_FIELD_LABEL_CLASS as FIELD_LABEL_CLASS,
  OUTSIDE_AGENT_HINT_CLASS as HINT_CLASS,
  OutsideAgentErrorLine,
  OutsideAgentProjectsField,
} from "./OutsideAgentFields";

/** The popup: Add for `target` null, Edit for one. `onClose` closes it, after a save too. */
export function AssistantAlertTargetDialogContent({
  target,
  onClose,
}: {
  readonly target: AssistantAlertTarget | null;
  readonly onClose: () => void;
}) {
  const projects = useThisComputerProjects();
  const [draft, setDraft] = useState<AssistantAlertTargetDraft>(() =>
    initialAssistantAlertTargetDraft(target),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  const availableProjectIds = projects.map((project) => project.id);
  const createInput =
    target === null ? assistantAlertTargetCreateInput(draft, availableProjectIds) : null;
  const updateInput =
    target === null
      ? null
      : assistantAlertTargetUpdateInput(target.targetId, draft, availableProjectIds);
  const canSave = !busy && (createInput !== null || updateInput !== null);

  const update = (change: Partial<AssistantAlertTargetDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
    setError(null);
  };
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      if (createInput !== null) await createAssistantAlertTarget(createInput);
      else if (updateInput !== null) await updateAssistantAlertTarget(updateInput);
      onClose();
    } catch (cause) {
      setError(describeOutsideAgentFailure(cause, "Threadlines didn't answer. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogPopup data-testid="assistant-alert-dialog">
      <DialogHeader>
        <DialogTitle>{target === null ? "Add a web address" : "Edit web address"}</DialogTitle>
        <DialogDescription className="text-[12.5px] leading-[18px]">
          An alert carries the kind, the project, this computer and a link. Never a thread&apos;s
          title or what its agents wrote.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <div className="grid gap-1.5">
          <label className={FIELD_LABEL_CLASS} htmlFor={`${fieldId}-url`}>
            Web address
          </label>
          <Input
            id={`${fieldId}-url`}
            type="url"
            inputMode="url"
            value={draft.url}
            placeholder="https://"
            disabled={busy}
            autoFocus={target === null}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update({ url: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
            data-testid="assistant-alert-url"
          />
          <p className={HINT_CLASS}>Only https addresses work.</p>
        </div>

        <AuthorizationField
          inputId={`${fieldId}-authorization`}
          authorization={draft.authorization}
          saved={target?.hasAuthorization === true}
          disabled={busy}
          onChange={(authorization) => update({ authorization })}
          onSubmit={() => void save()}
        />

        <div className="grid gap-1.5">
          <span className={FIELD_LABEL_CLASS} id={`${fieldId}-kinds`}>
            Alerts
          </span>
          <div
            role="group"
            aria-labelledby={`${fieldId}-kinds`}
            className="flex flex-wrap items-center gap-x-5 gap-y-1.5"
          >
            {AssistantAlertKind.literals.map((kind) => (
              <label
                key={kind}
                className="flex min-h-7 cursor-pointer items-center gap-2 text-[13px] text-foreground"
              >
                <Checkbox
                  checked={draft.kinds.has(kind)}
                  disabled={busy}
                  onCheckedChange={(checked) => {
                    const kinds = new Set(draft.kinds);
                    if (checked) kinds.add(kind);
                    else kinds.delete(kind);
                    update({ kinds });
                  }}
                  data-testid={`assistant-alert-kind-${kind}`}
                />
                {ASSISTANT_ALERT_KIND_LABELS[kind]}
              </label>
            ))}
          </div>
          {draft.kinds.size === 0 ? <p className={HINT_CLASS}>Tick at least one.</p> : null}
        </div>

        <OutsideAgentProjectsField
          labelId={`${fieldId}-projects`}
          projects={projects}
          choice={draft}
          disabled={busy}
          onChange={update}
        />

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <span className={FIELD_LABEL_CLASS} id={`${fieldId}-skip`}>
              Skip threads I&apos;m looking at
            </span>
            <p className={HINT_CLASS}>
              Grok and others run a model for every alert, so you aren&apos;t billed for threads you
              already have open.
            </p>
          </div>
          <Switch
            checked={draft.skipViewed}
            disabled={busy}
            aria-labelledby={`${fieldId}-skip`}
            onCheckedChange={(checked) => update({ skipViewed: checked })}
            data-testid="assistant-alert-skip-viewed"
          />
        </div>

        <OutsideAgentErrorLine error={error} />
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canSave}
          onClick={() => void save()}
          data-testid="assistant-alert-save"
        >
          {target === null ? (busy ? "Adding…" : "Add") : busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

/**
 * The Authorization header, write-only. A field to type one in; or, in Edit
 * with one saved, "Unchanged" with Replace and Clear, and after Clear, Undo.
 */
function AuthorizationField({
  inputId,
  authorization,
  saved,
  disabled,
  onChange,
  onSubmit,
}: {
  readonly inputId: string;
  readonly authorization: AssistantAlertAuthorizationDraft;
  /** One is saved: an empty field keeps it. */
  readonly saved: boolean;
  readonly disabled: boolean;
  readonly onChange: (authorization: AssistantAlertAuthorizationDraft) => void;
  readonly onSubmit: () => void;
}) {
  const words = (
    <>
      Authorization header <span className="font-normal text-muted-foreground">(optional)</span>
    </>
  );
  if (authorization.kind !== "set") {
    const cleared = authorization.kind === "clear";
    return (
      <div className="grid gap-1.5" role="group" aria-labelledby={`${inputId}-label`}>
        <span className={FIELD_LABEL_CLASS} id={`${inputId}-label`}>
          {words}
        </span>
        <div className="surface-group flex items-center gap-3 rounded-lg px-3 py-1.5">
          <span
            className="min-w-0 flex-1 text-[13px] leading-[18px] text-foreground"
            data-testid="assistant-alert-authorization-state"
          >
            {cleared ? "Cleared when you save" : "Unchanged"}
          </span>
          {cleared ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => onChange({ kind: "keep" })}
            >
              Undo
            </Button>
          ) : (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => onChange({ kind: "set", value: "" })}
                data-testid="assistant-alert-authorization-replace"
              >
                Replace
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => onChange({ kind: "clear" })}
                data-testid="assistant-alert-authorization-clear"
              >
                Clear
              </Button>
            </>
          )}
        </div>
        <p className={HINT_CLASS}>
          {cleared
            ? "Alerts go out without one after you save."
            : "Sent with every alert. Threadlines doesn't show it once it's saved."}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      <label className={FIELD_LABEL_CLASS} htmlFor={inputId}>
        {words}
      </label>
      <Input
        id={inputId}
        value={authorization.value}
        placeholder="Bearer crsr_…"
        disabled={disabled}
        autoFocus={saved}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange({ kind: "set", value: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
        }}
        data-testid="assistant-alert-authorization"
      />
      <p className={HINT_CLASS}>
        {saved
          ? "Leave it empty to keep the one saved."
          : "Sent with every alert. Threadlines doesn't show it once it's saved."}
      </p>
    </div>
  );
}
