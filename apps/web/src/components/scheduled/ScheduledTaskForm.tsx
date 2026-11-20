import {
  DEFAULT_NEW_THREAD_RUNTIME_MODE,
  RUNTIME_MODES,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  type ThreadId,
} from "@threadlines/contracts";
import { createModelSelection } from "@threadlines/shared/model";
import {
  PROVIDER_NOT_READY_FIX,
  providerAgentName,
  providerNotReady,
  providerNotReadySentence,
} from "@threadlines/shared/providerAuth";
import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentConnection } from "../../environments/runtime";
import { useEnvironmentProviders } from "../../hooks/useEnvironmentProviders";
import { useIsPhoneViewport } from "../../hooks/useMediaQuery";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { useSettings } from "../../hooks/useSettings";
import {
  useScheduledTaskEnvironments,
  useScheduledTasksStore,
} from "../../lib/scheduledTasksState";
import { cn } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { uses12HourClock } from "../../timestampFormat";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { deriveAccessLevel, runtimeModeConfig } from "../../runtimeModeOptions";
import {
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { type ComposerAccessControl, ComposerRunControls } from "../chat/ComposerRunControls";
import { COMPOSER_SURFACE_CLASS_NAME } from "../chat/composerSurface";
import { ModelPickerSettings, type ModelPickerTraitsTarget } from "../chat/ModelPickerSettings";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { modelPickerTriggerSummary, shouldRenderTraitsControls } from "../chat/traitControls";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { failureNotice, toastManager } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { addComputerNotConnectedNotice } from "../computerConnectionNotices";
import {
  EVENT_TASK_RUNTIME_MODE,
  emptyTaskForm,
  eventTaskAccessWarning,
  type FormProblems,
  formatWhen,
  formDraft,
  formProblems,
  previewRuns,
  type ScheduledTaskForm as FormState,
  taskForm,
  viewerTimeZone,
  type WebhookForm,
  webhookFormWithContext,
} from "./scheduled.logic";
import { ScheduleButton } from "./ScheduleButton";
import { ScheduledEventFields } from "./ScheduledEventFields";
import { FieldRow } from "./ScheduledFormRow";
import { TaskProjectHeading, TaskRunsSentence } from "./ScheduledTaskWhere";
import {
  type LocatedTask,
  taskRef,
  useContinuedAgents,
  useGitHubContext,
  useScheduledNavigation,
} from "./useScheduledPage";

/** Hover labels on the model and access buttons wait a moment, as on the composer's row. */
const ROW_TOOLTIP_DELAY_MS = 250;

/** The order problems are listed in under the editor, top of the editor first. */
const PROBLEM_ORDER = [
  "name",
  "prompt",
  "agent",
  "schedule",
  "project",
  "thread",
  "goesTo",
  "computer",
] as const satisfies ReadonlyArray<keyof FormProblems>;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The model a new task starts with on a computer: its new-thread default, else its first agent. */
function defaultModelFor(
  providers: ReadonlyArray<ServerProvider>,
  preferred: ModelSelection | null,
): ModelSelection | null {
  const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)).filter(
    (entry) => entry.enabled && entry.isAvailable,
  );
  if (preferred && entries.some((entry) => entry.instanceId === preferred.instanceId)) {
    return preferred;
  }
  const first = entries[0];
  const model = first?.models.find((candidate) => candidate.isHidden !== true) ?? first?.models[0];
  return first && model ? { instanceId: first.instanceId, model: model.slug } : null;
}

/**
 * The editor for a new task or an edited one (docs/design/fleet.md, Part 6),
 * laid out like the new-thread screen: "New task in [project]", then the
 * composer's box with the task's name and its schedule button on top, the
 * prompt, and the model and access buttons beside Create task. A sentence
 * under the box says where each run goes (a new thread or one to continue,
 * which checkout, which computer); an event task's settings follow it.
 */
export function ScheduledTaskForm({ editing }: { readonly editing: LocatedTask | null }) {
  const navigation = useScheduledNavigation();
  const environments = useScheduledTaskEnvironments();
  const providersOn = useEnvironmentProviders();
  const settings = useSettings();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const isPhone = useIsPhoneViewport();
  const nowMs = useRelativeTimeTick(30_000);
  const nameRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const [draftForm, setForm] = useState<FormState>(() => {
    if (editing) return taskForm(editing.task, editing.environment.environmentId);
    const environmentId = environments[0]?.environmentId ?? null;
    const project =
      environmentId === null
        ? undefined
        : projects.find(
            (entry) => entry.environmentId === environmentId && entry.kind !== "general-chat",
          );
    return emptyTaskForm({
      environmentId,
      projectId: project?.id ?? null,
      modelSelection:
        environmentId === null
          ? null
          : defaultModelFor(
              providersOn(environmentId),
              environments[0]?.isPrimary === true ? settings.newThreadModelSelection : null,
            ),
      runtimeMode: DEFAULT_NEW_THREAD_RUNTIME_MODE,
      timeZone: viewerTimeZone(),
    });
  });
  const computerZones = useScheduledTasksStore((state) => state.byEnvironment);
  // A computer, project or agent the page didn't have yet when the editor
  // opened (right after a reload) is filled in once it arrives; a choice the
  // user made is never replaced. Until the user picks a time zone, a new task
  // is in the chosen computer's own: it runs there, by that computer's clock.
  const baseForm = useMemo((): FormState => {
    if (editing) return draftForm;
    const environmentId = draftForm.environmentId ?? environments[0]?.environmentId ?? null;
    if (environmentId === null) return draftForm;
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    return {
      ...draftForm,
      environmentId,
      timeZone: draftForm.timeZoneChosen
        ? draftForm.timeZone
        : (computerZones[environmentId]?.timeZone ?? draftForm.timeZone),
      projectId:
        draftForm.projectId ??
        projects.find(
          (entry) => entry.environmentId === environmentId && entry.kind !== "general-chat",
        )?.id ??
        null,
      modelSelection:
        draftForm.modelSelection ??
        defaultModelFor(
          providersOn(environmentId),
          environment?.isPrimary === true ? settings.newThreadModelSelection : null,
        ),
    };
  }, [
    computerZones,
    draftForm,
    editing,
    environments,
    projects,
    providersOn,
    settings.newThreadModelSelection,
  ]);
  const chosenEnvironment = environments.find(
    (entry) => entry.environmentId === baseForm.environmentId,
  );
  const eventTasks = chosenEnvironment?.eventTasks === true;
  const isEvent = baseForm.cadenceKind === "webhook";
  // An event task's GitHub repository and sender come from the project, until
  // the user sets them; a new one asks before changes until access is picked.
  const gitHubContext = useGitHubContext(
    baseForm.environmentId,
    baseForm.projectId,
    isEvent && eventTasks,
  );
  const form = useMemo(
    (): FormState => ({
      ...baseForm,
      runtimeMode:
        isEvent && !baseForm.runtimeModeChosen ? EVENT_TASK_RUNTIME_MODE : baseForm.runtimeMode,
      webhook: webhookFormWithContext(baseForm.webhook, gitHubContext),
    }),
    [baseForm, gitHubContext, isEvent],
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));
  const updateWebhook = (patch: Partial<WebhookForm>) =>
    setForm((current) => ({ ...current, webhook: { ...current.webhook, ...patch } }));

  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === form.environmentId),
    [form.environmentId, projects],
  );
  const selectedProject = environmentProjects.find((project) => project.id === form.projectId);
  const isGeneralChats = selectedProject?.kind === "general-chat";
  const projectThreads = useMemo(
    () =>
      threads
        .filter(
          (thread) =>
            thread.environmentId === form.environmentId &&
            thread.projectId === form.projectId &&
            thread.archivedAt === null,
        )
        .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    [form.environmentId, form.projectId, threads],
  );
  const providers = form.environmentId === null ? [] : providersOn(form.environmentId);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)).filter(
        (entry) => entry.enabled && entry.isAvailable,
      ),
    [providers],
  );
  const selectedEntry = instanceEntries.find(
    (entry) => entry.instanceId === form.modelSelection?.instanceId,
  );
  const access = selectedEntry
    ? deriveAccessLevel({
        providers,
        provider: selectedEntry.driverKind,
        snapshot: selectedEntry.snapshot,
        models: selectedEntry.models,
        model: form.modelSelection?.model,
        mode: form.runtimeMode,
      })
    : null;

  // In a room, which of its agents gets each run.
  const continuedAgents = useContinuedAgents(
    form.environmentId,
    form.target === "thread" ? form.threadId : null,
    form.threadParticipantId,
  );
  const goesTo = continuedAgents.find((agent) => agent.id === form.threadParticipantId);

  // The chosen agent can't run on the chosen computer as things are: said
  // before saving, though saving is still fine (it may be fixed by then).
  const chosenProvider = providers.find(
    (provider) => provider.instanceId === form.modelSelection?.instanceId,
  );
  const agentNotReady = providerNotReady(chosenProvider);
  const agentWarning =
    agentNotReady === null || form.modelSelection === null
      ? null
      : `${providerNotReadySentence(
          agentNotReady,
          providerAgentName(chosenProvider, form.modelSelection.instanceId),
          chosenEnvironment?.label ?? "this computer",
        )} Its runs will fail until you ${lowerFirst(PROVIDER_NOT_READY_FIX[agentNotReady])}.`;

  // The zones the picker leads with: where the task runs, where you are, UTC.
  const computerTimeZone =
    form.environmentId === null ? undefined : computerZones[form.environmentId]?.timeZone;
  const timeZoneSuggestions = useMemo(() => {
    const viewer = viewerTimeZone();
    return [
      ...(computerTimeZone !== undefined
        ? [{ timeZone: computerTimeZone, note: "This computer" }]
        : []),
      ...(viewer !== computerTimeZone ? [{ timeZone: viewer, note: "You" }] : []),
      { timeZone: "UTC" },
    ];
  }, [computerTimeZone]);

  const now = new Date(nowMs);
  const problems: FormProblems = {
    ...formProblems(form, now, editing?.task, goesTo?.left === true),
    // The computer stopped offering event tasks (an older Threadlines took its place).
    ...(isEvent && !eventTasks
      ? { schedule: "This computer doesn't run event tasks. Update Threadlines on it first." }
      : {}),
  };
  const shownProblems: FormProblems = submitted
    ? problems
    : // An agent that left the continued thread is said at once.
      goesTo?.left === true && problems.goesTo !== undefined
      ? { goesTo: problems.goesTo }
      : {};
  // An event task's schedule problem is said with its settings, below.
  const listedProblems = PROBLEM_ORDER.filter(
    (key) => shownProblems[key] !== undefined && !(key === "schedule" && isEvent),
  ).map((key) => shownProblems[key]!);
  const nextRun =
    form.cadenceKind === "manual" || isEvent ? undefined : previewRuns(form, now, 1)[0];
  const accessWarning = eventTaskAccessWarning(form);

  const chooseEnvironment = (environmentId: EnvironmentId) => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    const project = projects.find(
      (entry) => entry.environmentId === environmentId && entry.kind !== "general-chat",
    );
    update({
      environmentId,
      projectId: project?.id ?? null,
      threadId: null,
      threadParticipantId: null,
      // A computer without event tasks can't take one: back to a clock.
      ...(form.cadenceKind === "webhook" && environment?.eventTasks !== true
        ? { cadenceKind: "weekdays" as const }
        : {}),
      modelSelection: defaultModelFor(
        providersOn(environmentId),
        environment?.isPrimary === true ? settings.newThreadModelSelection : null,
      ),
    });
  };

  const continueThread = (threadId: ThreadId) => {
    if (form.environmentId === null) return;
    // Back to the thread it continued: its agent, model and access stay as set.
    if (threadId === form.threadId) {
      update({ target: "thread" });
      return;
    }
    // Another thread: its runs are for that thread's own agent, and start
    // from its model and access.
    const shell = selectEnvironmentState(useStore.getState(), form.environmentId).threadShellById[
      threadId
    ];
    update({
      target: "thread",
      threadId,
      threadParticipantId: null,
      ...(shell !== undefined
        ? { modelSelection: shell.modelSelection, runtimeMode: shell.runtimeMode }
        : {}),
    });
  };

  // One save at a time: the button is off while it runs, but the keyboard
  // shortcut can submit again before it re-renders.
  const savingRef = useRef(false);
  const save = async () => {
    if (savingRef.current) return;
    setSubmitted(true);
    const draft = formDraft(form);
    if (Object.keys(problems).length > 0 || draft === null || form.environmentId === null) {
      // Back to the first field that needs words.
      if (problems.name !== undefined) nameRef.current?.focus();
      else if (problems.prompt !== undefined) promptRef.current?.focus();
      return;
    }
    const environment = environments.find((entry) => entry.environmentId === form.environmentId);
    const connection = readEnvironmentConnection(form.environmentId);
    if (!connection || !environment) {
      addComputerNotConnectedNotice({
        environmentId: form.environmentId,
        ...(environment ? { fallbackLabel: environment.label } : {}),
      });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      if (editing) {
        await connection.client.scheduledTasks.update({ id: editing.task.id, ...draft });
        navigation.openTask(taskRef(editing), { replace: true });
      } else {
        const created = await connection.client.scheduledTasks.create(draft);
        navigation.openTask(
          { environmentId: environment.environmentId, taskId: created.id },
          { replace: true },
        );
      }
    } catch (error) {
      toastManager.add(
        failureNotice({
          title: editing ? "Couldn't save the task" : "Couldn't create the task",
          error,
        }),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const cancel = () => {
    if (editing) navigation.openTask(taskRef(editing), { replace: true });
    else navigation.showAll({ replace: true });
  };

  // The model button and its panel, as the composer has them: effort and the
  // model's other options in the panel, and on phones the access level too.
  const selection = form.modelSelection;
  const traitsTarget: ModelPickerTraitsTarget | null =
    selection !== null && selectedEntry !== undefined
      ? {
          provider: selectedEntry.driverKind,
          instanceId: selection.instanceId,
          models: selectedEntry.models,
          model: selection.model,
          modelOptions: selection.options,
          onModelOptionsChange: (options) =>
            update({
              modelSelection: createModelSelection(selection.instanceId, selection.model, options),
            }),
        }
      : null;
  const hasModelPicker = selection !== null && instanceEntries.length > 0;
  const shownTraits =
    traitsTarget !== null && shouldRenderTraitsControls(traitsTarget) ? traitsTarget : null;
  // The level the task saves, not the one its agent would run at today: a
  // task runs later, unattended, at whatever its agent offers then.
  const accessControl: ComposerAccessControl = {
    value: form.runtimeMode,
    options:
      access?.options ??
      RUNTIME_MODES.map((mode) => ({ mode, ...runtimeModeConfig[mode], disabled: false })),
    onChange: (mode) => update({ runtimeMode: mode, runtimeModeChosen: true }),
    planning: false,
  };

  return (
    <form
      className="flex flex-col items-center gap-3 pt-2 sm:pt-6"
      data-testid="scheduled-task-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <TaskProjectHeading
        editing={editing !== null}
        projects={environmentProjects}
        selected={selectedProject}
        onSelect={(project) =>
          update({
            projectId: project.id,
            threadId: null,
            threadParticipantId: null,
            ...(project.kind === "general-chat" ? { checkout: "local" as const } : {}),
          })
        }
      />

      <div className={cn(COMPOSER_SURFACE_CLASS_NAME, "mt-2 w-full border-border")}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 pt-2.5 sm:px-3 sm:pt-3">
          <input
            ref={nameRef}
            className="h-8 min-w-[10rem] flex-1 rounded-md bg-transparent px-2 text-[16px] font-semibold text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground/60 focus-visible:bg-accent/40 sm:text-[14px]"
            value={form.name}
            placeholder="Task name"
            aria-label="Name"
            aria-invalid={shownProblems.name !== undefined ? true : undefined}
            data-testid="scheduled-form-name"
            onChange={(event) => update({ name: event.target.value })}
          />
          <ScheduleButton
            form={form}
            onChange={update}
            eventsOffered={eventTasks || isEvent}
            problem={isEvent ? undefined : shownProblems.schedule}
            computerTimeZone={computerTimeZone}
            timeZoneSuggestions={timeZoneSuggestions}
            hour12={uses12HourClock(settings.timestampFormat)}
            nowMs={nowMs}
          />
        </div>
        <textarea
          ref={promptRef}
          className="field-sizing-content block max-h-[50vh] min-h-24 w-full resize-none bg-transparent px-4.5 py-1.5 text-[16px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 sm:px-5 sm:text-[14px]"
          value={form.prompt}
          placeholder="What should each run do? It starts with only these words, so say everything it needs."
          aria-label="Instructions"
          aria-invalid={shownProblems.prompt !== undefined ? true : undefined}
          data-testid="scheduled-form-prompt"
          onChange={(event) => update({ prompt: event.target.value })}
          onKeyDown={(event) => {
            // As the composer sends: Cmd or Ctrl with Enter saves.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="flex min-w-0 items-center gap-1.5 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
          <div className="group/composer-left @container/composer-left -m-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TooltipProvider delay={ROW_TOOLTIP_DELAY_MS}>
              {hasModelPicker ? (
                <ProviderModelPicker
                  compact={isPhone}
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={getCustomModelOptionsByInstance(
                    settings,
                    providers,
                    selection.instanceId,
                    selection.model,
                  )}
                  summary={modelPickerTriggerSummary(shownTraits, false)}
                  settings={
                    <ModelPickerSettings
                      traits={shownTraits}
                      mode={null}
                      access={isPhone ? accessControl : null}
                    />
                  }
                  onInstanceModelChange={(instanceId, model) =>
                    update({ modelSelection: createModelSelection(instanceId, model) })
                  }
                />
              ) : (
                <span className="px-2 text-[12.5px] text-muted-foreground">
                  No agent is ready on this computer.
                </span>
              )}
              {/* On phones access lives in the model button's panel, as on the
                  composer; with no model button it stays on the row. */}
              {isPhone && hasModelPicker ? null : (
                <ComposerRunControls
                  mode={null}
                  access={accessControl}
                  focusComposer={() => promptRef.current?.focus()}
                />
              )}
            </TooltipProvider>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving} data-testid="scheduled-form-save">
              {editing ? "Save" : "Create task"}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex w-full flex-col items-center gap-1 px-2">
        <TaskRunsSentence
          isEvent={isEvent}
          target={form.target}
          threadId={form.threadId}
          threadParticipantId={form.threadParticipantId}
          checkout={form.checkout}
          showCheckout={!isGeneralChats}
          threads={projectThreads}
          keptThread={
            form.threadId === null
              ? null
              : {
                  id: form.threadId,
                  title:
                    threads.find((thread) => thread.id === form.threadId)?.title ??
                    "The thread it continued",
                }
          }
          agents={continuedAgents}
          environments={environments}
          environmentId={form.environmentId}
          // A draft on a computer that disconnected can still move to another.
          computerFixed={
            editing !== null || (environments.length < 2 && chosenEnvironment !== undefined)
          }
          onNewThread={() => update({ target: "new_thread" })}
          onContinueThread={continueThread}
          onAgent={(agent) =>
            // Its runs start from that agent's model.
            update({ threadParticipantId: agent.id, modelSelection: agent.modelSelection })
          }
          onCheckout={(checkout) => update({ checkout })}
          onComputer={chooseEnvironment}
        />
        {form.target === "thread" ? (
          <p className="max-w-md text-center text-[12px] leading-4 text-muted-foreground">
            Each run goes to that thread as a message, run with the agent and access above, never
            more access than the thread has then.
          </p>
        ) : null}
        {nextRun !== undefined ? (
          <p
            className="font-mono text-[11px] text-muted-foreground"
            data-testid="scheduled-form-next-run"
          >
            Next: {formatWhen(nextRun.toISOString(), nowMs)}
          </p>
        ) : form.cadenceKind === "manual" ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            Runs only when you press Run now
          </p>
        ) : null}
        {[agentWarning, accessWarning].map((warning) =>
          warning === null ? null : (
            <p key={warning} className="text-center text-[12px] text-warning-foreground">
              {warning}
            </p>
          ),
        )}
        {listedProblems.length > 0 ? (
          <ul className="flex flex-col items-center gap-0.5" data-testid="scheduled-form-problems">
            {listedProblems.map((problem) => (
              <li key={problem} className="text-center text-[12px] text-destructive-foreground">
                {problem}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {isEvent ? (
        <SettingsSection
          className="mt-4 w-full"
          title="When it runs"
          description="It runs when an event arrives, while Threadlines is running on its computer. Events wait up to a day while it's off."
          data-testid="scheduled-event-section"
        >
          {form.webhook.source === "github" && form.target === "new_thread" ? (
            <FieldRow
              label="Same issue, same thread"
              hint="Later events about an issue or pull request continue its thread."
            >
              <Switch
                checked={form.webhook.onePerSubject}
                aria-label="Same issue, same thread"
                data-testid="scheduled-event-one-per-subject"
                onCheckedChange={(checked) => updateWebhook({ onePerSubject: Boolean(checked) })}
              />
            </FieldRow>
          ) : null}
          <ScheduledEventFields
            webhook={form.webhook}
            onChange={updateWebhook}
            context={gitHubContext}
            problem={shownProblems.schedule}
          />
        </SettingsSection>
      ) : null}
    </form>
  );
}
