import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  ThreadId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeNextRun,
  describeTaskSchedule,
  emptyTaskForm,
  formDraft,
  formProblems,
  formatWhen,
  parseScheduledSearch,
  scheduledTaskEnvironmentsOf,
  taskForm,
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

describe("scheduledTaskEnvironmentsOf", () => {
  const runs = { repositoryIdentity: true, scheduledTasks: true };
  const older = { repositoryIdentity: true };

  it("lists only connected computers whose server runs scheduled tasks, this one first", () => {
    const listed = scheduledTaskEnvironmentsOf({
      primaryEnvironmentId: ENVIRONMENT,
      primaryDescriptor: { label: "Studio Mac", capabilities: runs },
      runtimeById: {
        [EnvironmentId.make("environment-old")]: {
          connectionState: "connected",
          descriptor: { label: "Old laptop", capabilities: older },
        },
        [EnvironmentId.make("environment-off")]: {
          connectionState: "disconnected",
          descriptor: { label: "Asleep desktop", capabilities: runs },
        },
        [EnvironmentId.make("environment-pc")]: {
          connectionState: "connected",
          descriptor: { label: "Basement PC", capabilities: runs },
        },
      },
      savedLabelOf: () => null,
    });
    expect(listed.map((environment) => environment.label)).toEqual(["Studio Mac", "Basement PC"]);
    expect(listed[0]?.isPrimary).toBe(true);
  });

  it("lists nothing when no server runs them, so Scheduled stays hidden", () => {
    expect(
      scheduledTaskEnvironmentsOf({
        primaryEnvironmentId: ENVIRONMENT,
        primaryDescriptor: { label: "Studio Mac", capabilities: older },
        runtimeById: {},
        savedLabelOf: () => null,
      }),
    ).toEqual([]);
  });
});

describe("parseScheduledSearch", () => {
  it("keeps a task only with its computer, and only the views it knows", () => {
    expect(parseScheduledSearch({ environment: "env", task: "task-1", view: "edit" })).toEqual({
      environment: "env",
      task: "task-1",
      view: "edit",
    });
    expect(parseScheduledSearch({ task: "task-1", view: "delete" })).toEqual({});
    expect(parseScheduledSearch({ view: "new" })).toEqual({ view: "new" });
  });
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
  });

  it("opens an existing task with its cadence's parts", () => {
    const opened = taskForm(
      task({ cadence: { kind: "hourly", minute: 15 }, target: { kind: "new_thread" } }),
      ENVIRONMENT,
    );
    expect(opened.cadenceKind).toBe("hourly");
    expect(opened.minute).toBe(15);
    expect(formDraft(opened)?.cadence).toEqual({ kind: "hourly", minute: 15 });
  });
});
