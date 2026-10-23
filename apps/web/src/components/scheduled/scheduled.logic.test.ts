import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_WEBHOOK_FORM,
  describeNextRun,
  describeScheduleCall,
  describeTaskSchedule,
  describeWebhookEventOutcome,
  emptyTaskForm,
  eventTaskAccessWarning,
  formDraft,
  formProblems,
  formatWhen,
  githubEventFields,
  parseScheduleCallResult,
  taskForm,
  webhookFormWithContext,
} from "./scheduled.logic";

const ENVIRONMENT = EnvironmentId.make("environment-mac");
const PROJECT = ProjectId.make("project-1");
const NOW = new Date("2026-10-21T08:00:00.000Z");

const form = () =>
  emptyTaskForm({
    environmentId: ENVIRONMENT,
    projectId: PROJECT,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    runtimeMode: "auto",
    timeZone: "UTC",
  });

const task = (patch: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: ScheduledTaskId.make("task-1"),
  name: "Morning review",
  prompt: "Review yesterday's commits.",
  projectId: PROJECT,
  checkout: "local",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  runtimeMode: "auto",
  interactionMode: "default",
  cadence: { kind: "weekdays", time: { hour: 9, minute: 0 } },
  timeZone: "UTC",
  target: { kind: "new_thread" },
  status: "active",
  error: null,
  nextRunAt: "2026-10-21T09:00:00.000Z",
  lastRun: null,
  workingRuns: 0,
  originThreadId: null,
  createdAt: "2026-10-20T08:00:00.000Z",
  updatedAt: "2026-10-20T08:00:00.000Z",
  ...patch,
});

describe("how a task reads", () => {
  it("names the task's zone only when it isn't the viewer's", () => {
    expect(describeTaskSchedule(task(), "UTC")).toMatch(/^Weekdays at 9:00/);
    expect(describeTaskSchedule(task({ timeZone: "Asia/Tokyo" }), "UTC")).toMatch(
      / · Asia\/Tokyo$/,
    );
    expect(describeTaskSchedule(task({ cadence: { kind: "manual" } }), "UTC")).toBe("Manual");
  });

  it("says when it runs next, or why it won't", () => {
    expect(describeNextRun(task(), NOW.getTime(), "UTC")).toMatch(/^Next run today at 9:00/);
    expect(
      describeNextRun(task({ nextRunAt: "2026-10-22T09:00:00.000Z" }), NOW.getTime(), "UTC"),
    ).toMatch(/^Next run tomorrow at 9:00/);
    expect(describeNextRun(task({ status: "paused" }), NOW.getTime(), "UTC")).toBe("Paused");
    expect(
      describeNextRun(
        task({
          status: "done",
          nextRunAt: null,
          cadence: { kind: "once", date: "2026-10-20", time: { hour: 9, minute: 0 } },
        }),
        NOW.getTime(),
        "UTC",
      ),
    ).toBe("Done");
    expect(describeNextRun(task({ cadence: { kind: "manual" } }), NOW.getTime(), "UTC")).toBe(
      "Runs when you start it",
    );
    expect(formatWhen("2026-10-20T07:00:00.000Z", NOW.getTime(), "UTC")).toMatch(/^Yesterday at/);
  });
});

describe("an agent's schedule calls in its chat", () => {
  const record = (
    output: string,
    live: {
      task?: ScheduledTask | null;
      waiting?: boolean;
      followed?: boolean;
      failed?: boolean;
    } = {},
  ) =>
    describeScheduleCall({
      tool: "schedule_create",
      result: parseScheduleCallResult(output),
      task: live.task ?? null,
      waiting: live.waiting ?? false,
      failed: live.failed ?? false,
      followed: live.followed ?? true,
      nowMs: NOW.getTime(),
      timeZone: "UTC",
    });
  // As a provider passes it along: JSON inside a string.
  const asked = JSON.stringify(
    JSON.stringify({
      outcome: "asked_user",
      requestId: "request-1",
      taskId: "task-1",
      name: "Morning review",
    }),
  );

  it("says the card waits, then how the user answered, from the task as it is now", () => {
    expect(record(asked, { waiting: true })).toEqual({
      heading: "Asked to schedule \u201cMorning review\u201d",
      outcome: "waiting for you",
      open: null,
    });
    const allowed = record(asked, { task: task() });
    expect(allowed.heading).toBe("Scheduled \u201cMorning review\u201d");
    expect(allowed.outcome).toMatch(/^Weekdays at 9:00.* · Next run today at 9:00/);
    expect(allowed.open).toBe("task-1");
    expect(record(asked).outcome).toBe("not scheduled");
    // A computer whose tasks this client doesn't follow: only what the call did.
    expect(record(asked, { followed: false }).outcome).toBe(null);
  });

  it("names a refusal in the user's words, and never claims a call that failed or said nothing", () => {
    expect(record('{"outcome":"off","detail":"Turned off."}')).toEqual({
      heading: "Tried to schedule a task",
      outcome: "turned off in Settings",
      open: null,
    });
    expect(record("", { failed: true })).toEqual({
      heading: "Tried to schedule a task",
      outcome: "failed",
      open: null,
    });
    expect(record("").heading).toBe("Asked to schedule a task");
  });
});

describe("the task form", () => {
  it("names what keeps it from saving", () => {
    const problems = formProblems(
      { ...form(), cadenceKind: "custom", cron: "0 0 9 * * *", target: "thread" },
      NOW,
    );
    expect(Object.keys(problems).toSorted()).toEqual(["name", "prompt", "schedule", "thread"]);
    expect(problems.schedule).toMatch(/5 fields/);
  });

  it("saves the cadence the chosen kind makes, and a continued thread as the target", () => {
    const draft = formDraft({
      ...form(),
      name: " Weekly audit ",
      prompt: "Check dependencies.",
      cadenceKind: "weekly",
      weekday: 4,
      time: { hour: 17, minute: 30 },
      target: "thread",
      threadId: ThreadId.make("thread-7"),
    });
    expect(draft).toMatchObject({
      name: "Weekly audit",
      cadence: { kind: "weekly", weekday: 4, time: { hour: 17, minute: 30 } },
      target: { kind: "thread", threadId: "thread-7" },
    });
    expect(formProblems({ ...form(), name: "x", prompt: "y" }, NOW)).toEqual({});
  });

  it("keeps a one-time task's day and time, and refuses one already past", () => {
    const once = { kind: "once", date: "2026-10-22", time: { hour: 8, minute: 30 } } as const;
    const opened = taskForm(task({ cadence: once }), ENVIRONMENT);
    expect(formDraft(opened)?.cadence).toEqual(once);
    expect(
      formProblems({ ...opened, date: "2026-10-21", time: { hour: 7, minute: 0 } }, NOW).schedule,
    ).toMatch(/already passed/);
    // One that ran keeps its past time through a rename.
    const ran = task({
      status: "done",
      nextRunAt: null,
      cadence: { kind: "once", date: "2026-10-20", time: { hour: 8, minute: 30 } },
    });
    expect(formProblems({ ...taskForm(ran, ENVIRONMENT), name: "Renamed" }, NOW, ran)).toEqual({});
  });

  it("opens an existing task with its cadence's parts", () => {
    const opened = taskForm(
      task({ cadence: { kind: "hourly", minute: 15 }, target: { kind: "new_thread" } }),
      ENVIRONMENT,
    );
    expect(opened.cadenceKind).toBe("hourly");
    expect(opened.minute).toBe(15);
    expect(formDraft(opened)?.cadence).toEqual({ kind: "hourly", minute: 15 });
    // A room agent's continued thread stays that agent's through an edit.
    const forAgent = {
      kind: "thread",
      threadId: ThreadId.make("thread-7"),
      participantId: ThreadParticipantId.make("room-claude"),
    } as const;
    expect(formDraft(taskForm(task({ target: forAgent }), ENVIRONMENT))?.target).toEqual(forAgent);
  });
});

describe("event tasks", () => {
  const CONTEXT = { repository: "acme/app", login: "badcuban", canConnect: true };
  const eventForm = (patch: Partial<ReturnType<typeof form>["webhook"]> = {}) => ({
    ...form(),
    name: "Triage",
    prompt: "Read the issue.",
    cadenceKind: "webhook" as const,
    webhook: webhookFormWithContext({ ...DEFAULT_WEBHOOK_FORM, ...patch }, CONTEXT),
  });

  it("starts from the project's repository and the signed-in user until they're set", () => {
    const filled = webhookFormWithContext(DEFAULT_WEBHOOK_FORM, CONTEXT);
    expect(filled).toMatchObject({
      source: "github",
      repository: "acme/app",
      logins: ["badcuban"],
    });
    // A project with no GitHub repository listens to any service instead.
    expect(
      webhookFormWithContext(DEFAULT_WEBHOOK_FORM, { ...CONTEXT, repository: null }).source,
    ).toBe("any");
    // What the user set stays.
    const chosen = { ...DEFAULT_WEBHOOK_FORM, repository: "me/fork", repositoryChosen: true };
    expect(webhookFormWithContext(chosen, CONTEXT).repository).toBe("me/fork");
  });

  it("saves the GitHub trigger the form makes, and opens it again the same", () => {
    const draft = formDraft({
      ...eventForm({ label: " agent ", onePerSubject: true }),
      target: "thread",
      threadId: ThreadId.make("thread-7"),
    });
    // A thread every event goes to has no per-issue threads.
    expect(draft?.cadence).toEqual({
      kind: "webhook",
      source: "github",
      github: {
        repository: "acme/app",
        when: "issue_labeled",
        label: "agent",
        from: { kind: "people", logins: ["badcuban"] },
        ignoreBots: true,
        onePerSubject: false,
      },
      filters: [],
      includeEvent: true,
      maxLateMinutes: 1440,
      dailyRunLimit: 20,
    });
    const saved = task({ cadence: draft!.cadence });
    expect(formDraft(taskForm(saved, ENVIRONMENT))?.cadence).toEqual(draft!.cadence);
  });

  it("names what keeps an event task from saving", () => {
    expect(formProblems(eventForm({ label: "agent" }), NOW)).toEqual({});
    expect(formProblems(eventForm(), NOW).schedule).toBe("Name the label to wait for.");
    expect(
      formProblems(eventForm({ label: "agent", logins: [], loginsChosen: true }), NOW).schedule,
    ).toBe("Add at least one GitHub username, or choose Anyone.");
    expect(
      formProblems(
        eventForm({
          label: "agent",
          filters: [{ path: "issue..title", op: "equals", value: "x" }],
        }),
        NOW,
      ).schedule,
    ).toMatch(/^Filter 1/);
    expect(
      formProblems({ ...eventForm({ label: "agent" }), prompt: "Look at {{headers.cookie}}" }, NOW)
        .schedule,
    ).toMatch(/cookie/);
  });

  it("warns before full access reaches anyone who can send an event", () => {
    const full = (patch: Parameters<typeof eventForm>[0]) => ({
      ...eventForm({ label: "agent", ...patch }),
      runtimeMode: "full-access" as const,
    });
    expect(eventTaskAccessWarning(full({ anyone: true }))).toBe(
      "Anyone who can comment on acme/app can start a run with full access.",
    );
    expect(eventTaskAccessWarning(full({ sourceChosen: true, source: "any" }))).toBe(
      "Anyone who has this task's address can start a run with full access.",
    );
    expect(eventTaskAccessWarning(full({}))).toBeNull();
    expect(
      eventTaskAccessWarning({ ...eventForm({ anyone: true }), runtimeMode: "approval-required" }),
    ).toBeNull();
  });

  it("reads as what starts it and when its last event came", () => {
    const eventTask = task({
      cadence: formDraft(eventForm({ label: "agent" }))!.cadence,
      timeZone: "Asia/Tokyo",
      nextRunAt: null,
    });
    expect(describeTaskSchedule(eventTask, "UTC")).toBe(
      "When an issue in acme/app gets the label agent",
    );
    expect(describeNextRun(eventTask, NOW.getTime(), "UTC")).toBe("No events yet");
    const heard = {
      ...eventTask,
      webhook: {
        address: "ready" as const,
        addressChanged: false,
        github: true,
        signingSecretSet: true,
        lastEventAt: "2026-10-21T07:30:00.000Z",
      },
    };
    expect(describeNextRun(heard, NOW.getTime(), "UTC")).toMatch(/^Last event today at 7:30/);
  });

  it("says how an event ended in words", () => {
    expect(
      describeWebhookEventOutcome({
        status: "skipped",
        reason: "The task is paused.",
        eventName: "issues.labeled",
      }),
    ).toBe("Skipped. The task is paused.");
    expect(describeWebhookEventOutcome({ status: "ran", reason: null, eventName: null })).toBe(
      "Started a run",
    );
    expect(
      describeWebhookEventOutcome({
        status: "skipped",
        reason: "GitHub connected",
        eventName: "ping",
      }),
    ).toBe("GitHub checked the address. Nothing to run.");
  });

  it("offers each chosen event's fields to filter on, once each", () => {
    const fields = githubEventFields(["issues", "issue_comment"]);
    expect(fields).toContain("issue.labels[].name");
    expect(fields).toContain("comment.body");
    expect(fields.filter((field) => field === "action")).toHaveLength(1);
    expect(fields.at(-1)).toBe("repository.full_name");
  });
});
