import {
  DEFAULT_NEW_THREAD_RUNTIME_MODE,
  RUNTIME_MODES,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@threadlines/contracts";
import {
  PROVIDER_NOT_READY_FIX,
  providerAgentName,
  providerNotReady,
  providerNotReadySentence,
} from "@threadlines/shared/providerAuth";
import { roomAgentKey } from "@threadlines/shared/threadParticipants";
import { MessagesSquareIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentConnection } from "../../environments/runtime";
import { useEnvironmentProviders } from "../../hooks/useEnvironmentProviders";
import { useSettings } from "../../hooks/useSettings";
import {
  useScheduledTaskEnvironments,
  useScheduledTasksStore,
} from "../../lib/scheduledTasksState";
import { cn } from "../../lib/utils";
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
import type { Project } from "../../types";
import { ProjectFavicon } from "../ProjectFavicon";
import { SETTINGS_GROUP_ROW_CLASS, SettingsSection } from "../settings/settingsLayout";
import { ModelSelectionControl } from "../settings/TextGenerationModelControl";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { DatePicker } from "../ui/date-picker";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { TimePicker } from "../ui/time-picker";
import { TimeZonePicker } from "../ui/time-zone-picker";
import { failureNotice, toastManager } from "../ui/toast";
import {
  CADENCE_KIND_LABELS,
  type CadenceKind,
  cadenceKindsFor,
  EVENT_TASK_RUNTIME_MODE,
  emptyTaskForm,
  eventTaskAccessWarning,
  formatWhen,
  formDraft,
  formProblems,
  previewRuns,
  type ScheduledTaskForm as FormState,
  taskForm,
  todayIn,
  viewerTimeZone,
  WEEKDAY_LABELS,
  type WebhookForm,
  webhookFormWithContext,
} from "./scheduled.logic";
import { ScheduledEventFields } from "./ScheduledEventFields";
import { FieldRow } from "./ScheduledFormRow";
import {
  type LocatedTask,
  taskRef,
  useContinuedAgents,
  useGitHubContext,
  useScheduledNavigation,
} from "./useScheduledPage";

const HOURLY_MINUTES = Array.from({ length: 12 }, (_, index) => index * 5);

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** A project as the app's other project pickers show it: its logo (General Chats its own glyph) and name. */
function ProjectLabel({ project }: { readonly project: Project }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {project.kind === "general-chat" ? (
        <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ProjectFavicon
          cwd={project.cwd}
          environmentId={project.environmentId}
          name={project.name}
        />
      )}
      <span className="truncate">
        {project.kind === "general-chat" ? "General Chats" : project.name}
      </span>
    </span>
  );
}

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
 * The form for a new task or an edited one (docs/design/fleet.md, Part 6):
 * name and instructions; the computer that keeps and runs it, its project
 * and where each run works; the agent, model and access; the schedule; and
 * whether each run starts a new thread or continues one.
 */
export function ScheduledTaskForm({ editing }: { readonly editing: LocatedTask | null }) {
  const navigation = useScheduledNavigation();
  const environments = useScheduledTaskEnvironments();
  const providersOn = useEnvironmentProviders();
  const settings = useSettings();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));

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
  // A computer, project or agent the page didn't have yet when the form
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
          environments.find((entry) => entry.environmentId === form.environmentId)?.label ??
            "this computer",
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

  const now = new Date();
  const problems = {
    ...formProblems(form, now, editing?.task, goesTo?.left === true),
    // The computer stopped offering event tasks (an older Threadlines took its place).
    ...(isEvent && !eventTasks
      ? { schedule: "This computer doesn't run event tasks. Update Threadlines on it first." }
      : {}),
  };
  const shownProblems = submitted ? problems : {};
  const upcoming = form.cadenceKind === "manual" || isEvent ? [] : previewRuns(form, now, 3);
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

  const save = async () => {
    setSubmitted(true);
    const draft = formDraft(form);
    if (Object.keys(problems).length > 0 || draft === null || form.environmentId === null) return;
    const environment = environments.find((entry) => entry.environmentId === form.environmentId);
    const connection = readEnvironmentConnection(form.environmentId);
    if (!connection || !environment) {
      toastManager.add({ type: "error", title: "That computer isn't connected" });
      return;
    }
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
      setSaving(false);
    }
  };

  const cancel = () => {
    if (editing) navigation.openTask(taskRef(editing), { replace: true });
    else navigation.showAll({ replace: true });
  };

  const timeField = (
    <TimePicker
      size="sm"
      className="w-32 min-w-0"
      aria-label="Time"
      value={form.time}
      hour12={uses12HourClock(settings.timestampFormat)}
      onChange={(time) => update({ time })}
      data-testid="scheduled-form-time"
    />
  );

  return (
    <form
      className="flex flex-col gap-7"
      data-testid="scheduled-task-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className="space-y-1 px-1">
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em] text-foreground">
          {editing ? `Edit ${editing.task.name}` : "New task"}
        </h1>
        <p className="text-[13px] leading-[18px] text-muted-foreground">
          {isEvent
            ? "It runs when an event arrives, while Threadlines is running on its computer. Events wait up to a day while it's off."
            : "It runs while Threadlines is running on its computer. A time missed while the computer was off or asleep gets one catch-up run."}
        </p>
      </header>

      <SettingsSection title="Task">
        <FieldRow label="Name" problem={shownProblems.name} stacked>
          <Input
            size="sm"
            value={form.name}
            placeholder="Morning review"
            aria-label="Name"
            data-testid="scheduled-form-name"
            onChange={(event) => update({ name: event.target.value })}
          />
        </FieldRow>
        <FieldRow
          label="Instructions"
          hint="Each run starts with only these words, so say everything it needs."
          problem={shownProblems.prompt}
          stacked
        >
          <Textarea
            size="sm"
            value={form.prompt}
            placeholder="Review yesterday's commits on main and list anything risky."
            aria-label="Instructions"
            data-testid="scheduled-form-prompt"
            onChange={(event) => update({ prompt: event.target.value })}
          />
        </FieldRow>
      </SettingsSection>

      <SettingsSection title="Where it runs">
        <FieldRow
          label="Computer"
          hint="It keeps the task and runs it."
          problem={shownProblems.computer}
        >
          <Select
            value={form.environmentId ?? ""}
            disabled={editing !== null}
            onValueChange={(value) => {
              if (value) chooseEnvironment(value as EnvironmentId);
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-52" aria-label="Computer">
              <SelectValue>
                {environments.find((entry) => entry.environmentId === form.environmentId)?.label ??
                  "Choose a computer"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {environments.map((environment) => (
                <SelectItem key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </FieldRow>
        <FieldRow label="Project" problem={shownProblems.project}>
          <Select
            value={form.projectId ?? ""}
            onValueChange={(value) => {
              if (!value) return;
              const project = environmentProjects.find((entry) => entry.id === value);
              update({
                projectId: value as ProjectId,
                threadId: null,
                threadParticipantId: null,
                ...(project?.kind === "general-chat" ? { checkout: "local" as const } : {}),
              });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-52" aria-label="Project">
              <SelectValue>
                {selectedProject ? <ProjectLabel project={selectedProject} /> : "Choose a project"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {environmentProjects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <ProjectLabel project={project} />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </FieldRow>
        <FieldRow
          label={isEvent ? "Each event" : "Each run"}
          hint={
            form.target === "thread"
              ? "Goes to that thread as a message, run with the agent and access below, never more access than the thread has then."
              : undefined
          }
          problem={shownProblems.thread}
        >
          <SegmentedControl
            value={form.target}
            onValueChange={(value) => update({ target: value })}
            aria-label={isEvent ? "Each event" : "Each run"}
          >
            <SegmentedControlItem value="new_thread">New thread</SegmentedControlItem>
            <SegmentedControlItem value="thread">Continue a thread</SegmentedControlItem>
          </SegmentedControl>
          {form.target === "thread" ? (
            <Select
              value={form.threadId ?? ""}
              onValueChange={(value) => {
                if (!value || form.environmentId === null) return;
                // Another thread: its runs are for that thread's own agent, and
                // start from its model and access.
                const shell = selectEnvironmentState(useStore.getState(), form.environmentId)
                  .threadShellById[value as ThreadId];
                update({
                  threadId: value as ThreadId,
                  threadParticipantId: null,
                  ...(shell !== undefined
                    ? { modelSelection: shell.modelSelection, runtimeMode: shell.runtimeMode }
                    : {}),
                });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-52" aria-label="Thread">
                <SelectValue>
                  {projectThreads.find((thread) => thread.id === form.threadId)?.title ??
                    "Choose a thread"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {projectThreads.length === 0 ? (
                  <SelectItem value="" disabled>
                    No open threads in this project
                  </SelectItem>
                ) : (
                  projectThreads.slice(0, 50).map((thread) => (
                    <SelectItem key={thread.id} value={thread.id}>
                      {thread.title}
                    </SelectItem>
                  ))
                )}
              </SelectPopup>
            </Select>
          ) : null}
        </FieldRow>
        {isEvent && form.webhook.source === "github" && form.target === "new_thread" ? (
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
        {form.target === "thread" && continuedAgents.length > 0 ? (
          <FieldRow
            label="Goes to"
            hint="Which agent in that thread gets each run."
            problem={shownProblems.goesTo ?? (goesTo?.left === true ? problems.goesTo : undefined)}
          >
            <Select
              value={roomAgentKey(form.threadParticipantId)}
              onValueChange={(value) => {
                const agent = continuedAgents.find((entry) => roomAgentKey(entry.id) === value);
                if (agent === undefined || agent.left) return;
                // Its runs start from that agent's model.
                update({ threadParticipantId: agent.id, modelSelection: agent.modelSelection });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-52" aria-label="Goes to">
                <SelectValue>
                  {goesTo === undefined
                    ? "Choose an agent"
                    : goesTo.left
                      ? `${goesTo.name} (left)`
                      : goesTo.name}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {continuedAgents.map((agent) => (
                  <SelectItem
                    key={roomAgentKey(agent.id)}
                    value={roomAgentKey(agent.id)}
                    disabled={agent.left}
                  >
                    {agent.left ? `${agent.name} (left the thread)` : agent.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </FieldRow>
        ) : null}
        {form.target === "new_thread" && !isGeneralChats ? (
          <FieldRow
            label="Runs in"
            hint={
              form.checkout === "worktree"
                ? "A new git worktree for each run, so runs never touch your checkout."
                : "The project folder as it is, your uncommitted changes included."
            }
          >
            <SegmentedControl
              value={form.checkout}
              onValueChange={(value) => update({ checkout: value })}
              aria-label="Runs in"
            >
              <SegmentedControlItem value="local">Local checkout</SegmentedControlItem>
              <SegmentedControlItem value="worktree">New worktree</SegmentedControlItem>
            </SegmentedControl>
          </FieldRow>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Agent">
        <FieldRow label="Model" problem={shownProblems.agent} warning={agentWarning}>
          {form.modelSelection && instanceEntries.length > 0 ? (
            <ModelSelectionControl
              selection={form.modelSelection}
              settings={settings}
              serverProviders={providers}
              instanceEntries={instanceEntries}
              onSelectionChange={(selection) => update({ modelSelection: selection })}
            />
          ) : (
            <span className="text-[12.5px] text-muted-foreground">
              No agent is ready on this computer.
            </span>
          )}
        </FieldRow>
        <FieldRow
          label="Access"
          hint={
            access?.options.find((option) => option.mode === access.shown)?.description ??
            "What the agent may do without asking."
          }
          warning={accessWarning}
        >
          <Select
            value={form.runtimeMode}
            onValueChange={(value) => {
              if (value) update({ runtimeMode: value as RuntimeMode, runtimeModeChosen: true });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Access">
              <SelectValue>
                {access?.options.find((option) => option.mode === form.runtimeMode)?.label ??
                  runtimeModeConfig[form.runtimeMode].label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(
                access?.options ??
                RUNTIME_MODES.map((mode) => ({
                  mode,
                  label: runtimeModeConfig[mode].label,
                  disabled: false,
                }))
              ).map((option) => (
                <SelectItem
                  key={option.mode}
                  value={option.mode}
                  disabled={option.disabled === true}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </FieldRow>
      </SettingsSection>

      <SettingsSection title="Schedule">
        <FieldRow
          label="Runs"
          problem={form.cadenceKind === "custom" || isEvent ? undefined : shownProblems.schedule}
        >
          <Select
            value={form.cadenceKind}
            onValueChange={(value) => {
              if (value) update({ cadenceKind: value as CadenceKind });
            }}
          >
            <SelectTrigger
              size="sm"
              className={cn("w-full", isEvent ? "sm:w-56" : "sm:w-36")}
              aria-label="Runs"
              data-testid="scheduled-form-runs"
            >
              <SelectValue>{CADENCE_KIND_LABELS[form.cadenceKind]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {cadenceKindsFor(eventTasks || isEvent).map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {CADENCE_KIND_LABELS[kind]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {form.cadenceKind === "hourly" ? (
            <Select
              value={String(form.minute)}
              onValueChange={(value) => {
                if (value !== null) update({ minute: Number(value) });
              }}
            >
              <SelectTrigger size="sm" className="w-28" aria-label="Minute past the hour">
                <SelectValue>{`at :${String(form.minute).padStart(2, "0")}`}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {[...new Set([...HOURLY_MINUTES, form.minute])]
                  .toSorted((a, b) => a - b)
                  .map((minute) => (
                    <SelectItem key={minute} value={String(minute)}>
                      {`at :${String(minute).padStart(2, "0")}`}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
          ) : null}
          {form.cadenceKind === "weekly" ? (
            <Select
              value={String(form.weekday)}
              onValueChange={(value) => {
                if (value !== null) update({ weekday: Number(value) });
              }}
            >
              <SelectTrigger size="sm" className="w-32" aria-label="Day">
                <SelectValue>{WEEKDAY_LABELS[form.weekday]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {WEEKDAY_LABELS.map((label, index) => (
                  <SelectItem key={label} value={String(index)}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          {form.cadenceKind === "once" ? (
            <DatePicker
              size="sm"
              className="w-44 min-w-0"
              aria-label="Date"
              value={form.date}
              // Days are the task's own: today and earlier are as its zone sees them.
              today={todayIn(form.timeZone)}
              min={todayIn(form.timeZone)}
              onChange={(date) => update({ date })}
              data-testid="scheduled-form-date"
            />
          ) : null}
          {form.cadenceKind === "daily" ||
          form.cadenceKind === "weekdays" ||
          form.cadenceKind === "weekly" ||
          form.cadenceKind === "once"
            ? timeField
            : null}
        </FieldRow>
        {form.cadenceKind === "custom" ? (
          <FieldRow
            label="Cron expression"
            hint="Five fields: minute, hour, day of month, month, day of week. Every 15 minutes is */15 * * * *."
            problem={shownProblems.schedule}
            stacked
          >
            <Input
              size="sm"
              className="font-mono"
              value={form.cron}
              aria-label="Cron expression"
              data-testid="scheduled-form-cron"
              onChange={(event) => update({ cron: event.target.value })}
            />
          </FieldRow>
        ) : null}
        {isEvent ? (
          <ScheduledEventFields
            webhook={form.webhook}
            onChange={updateWebhook}
            context={gitHubContext}
            problem={shownProblems.schedule}
          />
        ) : null}
        {form.cadenceKind !== "manual" && !isEvent ? (
          <FieldRow
            label="Time zone"
            hint="Times use this zone wherever you are. When clocks skip ahead, a skipped time runs right after. When they fall back, a set time runs once and hourly tasks still run every hour."
          >
            <TimeZonePicker
              value={form.timeZone}
              onChange={(timeZone) => update({ timeZone, timeZoneChosen: true })}
              suggestions={timeZoneSuggestions}
              className="w-full sm:w-52"
              aria-label="Time zone"
              data-testid="scheduled-form-time-zone"
            />
          </FieldRow>
        ) : null}
        {upcoming.length > 0 ? (
          <div
            className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")}
            data-testid="scheduled-form-preview"
          >
            <p className="text-[12.5px] leading-[18px] text-muted-foreground">
              {form.cadenceKind === "once" ? "Your time:" : "Next runs, your time:"}{" "}
              {upcoming.map((slot) => formatWhen(slot.toISOString(), now.getTime())).join(", ")}
            </p>
          </div>
        ) : form.cadenceKind === "manual" ? (
          <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")}>
            <p className="text-[12.5px] leading-[18px] text-muted-foreground">
              It runs only when you press Run now.
            </p>
          </div>
        ) : null}
      </SettingsSection>

      <div className="flex items-center justify-end gap-2 px-1">
        <Button type="button" size="sm" variant="outline" onClick={cancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving} data-testid="scheduled-form-save">
          {editing ? "Save" : "Create task"}
        </Button>
      </div>
    </form>
  );
}
