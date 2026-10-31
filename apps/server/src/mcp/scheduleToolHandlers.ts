/**
 * What the schedule tools do (scheduleTools.ts, docs/design/fleet.md,
 * Part 6). The caller comes from its credential: a thread's main runtime,
 * never a side one, and never a thread another computer's agent started here
 * (the fence, docs/design/fleet.md "Fence"). Tasks are the caller's
 * project's. A task an agent creates runs with the caller's access at that
 * moment, never more. Changes are checked before anyone is asked, and made
 * by ScheduledTasks.
 */
import type {
  AgentThreadsMode,
  ModelSelection,
  OrchestrationThread,
  ScheduledTask,
  ScheduledTaskUpdateInput,
  ServerProvider,
  ThreadId,
} from "@threadlines/contracts";
import { placeMarkdownLink } from "@threadlines/shared/appPlaces";
import { ProviderInstanceId, ScheduledTaskId } from "@threadlines/contracts";
import { describeCadence, formatWallTime } from "@threadlines/shared/scheduledTasks";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { derivedUuid } from "../orchestration/childRequestIds.ts";
import {
  providerModelReasoning,
  reasoningLevel,
  settleChildReasoning,
} from "../orchestration/childThreadAgents.ts";
import { modelLabel } from "../threads/threadOperations.ts";
import type { ScheduledTasksShape } from "../scheduled/ScheduledTasks.ts";
import type { ScheduledTaskChange } from "../scheduled/ScheduledTaskRepository.ts";
import { latchCallerTurn } from "./callerTurn.ts";
import { callerModelSelection, reasoningSources } from "./threadToolHandlers.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import type { RoomToolName } from "./roomToolAccess.ts";
import type {
  AgentScheduledTask,
  ScheduleChangeResult,
  ScheduledRunFinishResult,
  ScheduleListResult,
} from "./scheduleTools.ts";

export interface ScheduleToolDeps {
  /** Absent on a server without scheduled tasks. */
  readonly scheduledTasks: ScheduledTasksShape | undefined;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  /** "Agents can start threads", read afresh on every call. */
  readonly threadsMode: Effect.Effect<AgentThreadsMode>;
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  /** The user's default for new threads (Settings): the last reasoning a task follows. */
  readonly userDefaultModel: Effect.Effect<ModelSelection | null>;
  /** This computer's time zone, for a task created without one. */
  readonly localTimeZone: string;
}

const SIDE_REFUSAL = "Only the agent working in this thread can use the schedule tools.";
const SCHEDULES_OFF = `Agents changing scheduled tasks is turned off: ${placeMarkdownLink("threads.agentThreads")} is Off.`;
const NO_SCHEDULES = "This computer doesn't run scheduled tasks.";
const REMOTE_ORIGIN_REFUSAL =
  "This thread was started by an agent on another computer, so it has no schedule tools.";
const GONE = "This thread is gone.";
const NOT_YOUR_TURN = "Scheduled tasks can only be changed during your own turn.";
const ASKED_USER =
  "A card in this thread asks the user. The change is made when they allow it: tell the user it waits for their OK. You'll hear their answer at your next turn; don't ask again.";

/** A task as an agent reads it. */
const forAgent = (task: ScheduledTask, callerThreadId: ThreadId): AgentScheduledTask => ({
  id: task.id,
  name: task.name,
  schedule: describeCadence(task.cadence),
  cadence: task.cadence,
  timeZone: task.timeZone,
  status: task.status,
  ...(task.error !== null ? { error: task.error } : {}),
  nextRun: task.nextRunAt,
  lastRun:
    task.lastRun === null
      ? null
      : {
          at: task.lastRun.slotUtc,
          status: task.lastRun.status,
          ...(task.lastRun.reason !== null ? { reason: task.lastRun.reason } : {}),
          ...(task.lastRun.threadId !== null ? { threadId: task.lastRun.threadId } : {}),
        },
  eachRun:
    task.target.kind === "new_thread"
      ? "new_thread"
      : task.target.threadId === callerThreadId
        ? "this_thread"
        : "another_thread",
  runsIn: task.checkout,
  agent: {
    instanceId: task.modelSelection.instanceId,
    model: task.modelSelection.model,
    ...(reasoningLevel(task.modelSelection) !== undefined
      ? { reasoning: reasoningLevel(task.modelSelection) }
      : {}),
  },
  prompt: task.prompt,
});

export function makeScheduleToolHandlers(deps: ScheduleToolDeps) {
  type Gate =
    | {
        readonly refusal: {
          readonly outcome: "off" | "not_allowed" | "refused";
          readonly detail: string;
        };
      }
    | {
        readonly mode: "ask" | "auto";
        readonly thread: OrchestrationThread;
        readonly service: ScheduledTasksShape;
      };

  /** Main runtime, setting on, this computer has schedules, thread still there. */
  const gate = (scope: McpInvocationScope, tool: RoomToolName): Effect.Effect<Gate> =>
    Effect.gen(function* () {
      if (!scope.roomTools.has(tool) || scope.side !== undefined) {
        return { refusal: { outcome: "not_allowed" as const, detail: SIDE_REFUSAL } };
      }
      const service = deps.scheduledTasks;
      if (service === undefined) {
        return { refusal: { outcome: "not_allowed" as const, detail: NO_SCHEDULES } };
      }
      const mode = yield* deps.threadsMode;
      if (mode === "off") {
        return { refusal: { outcome: "off" as const, detail: SCHEDULES_OFF } };
      }
      const thread = yield* deps.readThread(scope.threadId);
      if (thread === undefined || thread.deletedAt !== null) {
        return { refusal: { outcome: "refused" as const, detail: GONE } };
      }
      // The fence: its runtime has no Threadlines tools; this guards a stale credential.
      if ((thread.remoteOrigin ?? null) !== null) {
        return { refusal: { outcome: "not_allowed" as const, detail: REMOTE_ORIGIN_REFUSAL } };
      }
      return { mode, thread, service };
    });

  /** The project's tasks; a failed read is an empty list with why. */
  const projectTasks = (service: ScheduledTasksShape, thread: OrchestrationThread) =>
    service.snapshot.pipe(
      Effect.map((snapshot) =>
        snapshot.tasks.filter((task) => task.projectId === thread.projectId),
      ),
      Effect.result,
    );

  const schedule_list = (
    scope: McpInvocationScope,
    _input: Record<string, never>,
  ): Effect.Effect<ScheduleListResult> =>
    Effect.gen(function* () {
      const gated = yield* gate(scope, "schedule_list");
      if ("refusal" in gated) return { ...gated.refusal, tasks: [] };
      const tasks = yield* projectTasks(gated.service, gated.thread);
      if (Result.isFailure(tasks)) {
        return { outcome: "refused" as const, detail: tasks.failure.detail, tasks: [] };
      }
      const now = yield* Clock.currentTimeMillis;
      return {
        outcome: "ok" as const,
        tasks: tasks.success.map((task) => forAgent(task, scope.threadId)),
        now: {
          localTime: formatWallTime(new Date(now), deps.localTimeZone),
          timeZone: deps.localTimeZone,
        },
      };
    });

  /**
   * Proposes a change for the caller's turn: the same call (a provider's
   * retry) is one request, and one task.
   */
  const proposeChange = (
    scope: McpInvocationScope,
    gated: Extract<Gate, { readonly mode: "ask" | "auto" }>,
    tool: "schedule_create" | "schedule_update",
    input: unknown,
    change: ScheduledTaskChange,
  ): Effect.Effect<ScheduleChangeResult> =>
    Effect.gen(function* () {
      const latched = yield* latchCallerTurn(deps.readThread, scope);
      if ("gone" in latched) return { outcome: "refused" as const, detail: GONE };
      if ("notYours" in latched) return { outcome: "not_allowed" as const, detail: NOT_YOUR_TURN };
      const requestId = derivedUuid(
        scope.threadId,
        scope.participantId ?? "primary",
        latched.turnId,
        tool,
        JSON.stringify(input),
      );
      const proposed = yield* gated.service
        .propose({
          requestId,
          threadId: scope.threadId,
          participantId: scope.participantId,
          // Read live by the service right before it writes: a setting
          // changed while the change was being checked wins.
          mode: deps.threadsMode,
          callerRuntimeMode: gated.thread.runtimeMode,
          change,
        })
        .pipe(Effect.result);
      if (Result.isFailure(proposed)) {
        return { outcome: "refused" as const, detail: proposed.failure.detail };
      }
      if (proposed.success.outcome === "off") {
        return { outcome: "off" as const, detail: SCHEDULES_OFF };
      }
      if (proposed.success.outcome === "asked_user") {
        return {
          outcome: "asked_user" as const,
          detail: ASKED_USER,
          requestId: proposed.success.requestId,
          taskId: proposed.success.taskId,
          name: proposed.success.name,
        };
      }
      return {
        outcome: tool === "schedule_create" ? ("created" as const) : ("updated" as const),
        task: forAgent(proposed.success.task, scope.threadId),
      };
    });

  const schedule_create = (
    scope: McpInvocationScope,
    input: {
      readonly name: string;
      readonly prompt: string;
      readonly schedule: ScheduledTask["cadence"];
      readonly time_zone?: string | undefined;
      readonly each_run?: "new_thread" | "this_thread" | undefined;
      readonly runs_in?: "local" | "worktree" | undefined;
      readonly agent?:
        | {
            readonly instanceId: string;
            readonly model: string;
            readonly reasoning?: string | undefined;
          }
        | undefined;
    },
  ): Effect.Effect<ScheduleChangeResult> =>
    Effect.gen(function* () {
      const gated = yield* gate(scope, "schedule_create");
      if ("refusal" in gated) return gated.refusal;
      const { thread } = gated;
      const name = input.name.trim();
      const prompt = input.prompt.trim();
      if (name.length === 0 || prompt.length === 0) {
        return { outcome: "refused" as const, detail: "A task needs a name and a prompt." };
      }
      // In a room, the calling agent's own model, not the thread's.
      let modelSelection = callerModelSelection(thread, scope.participantId);
      if (input.agent !== undefined) {
        const all = yield* deps.providers;
        const provider = all.find((entry) => entry.instanceId === input.agent?.instanceId);
        if (
          provider === undefined ||
          !provider.models.some((model) => model.slug === input.agent?.model)
        ) {
          return {
            outcome: "refused" as const,
            detail: "That agent or model isn't on this computer. thread_agents lists them.",
          };
        }
        // Each run follows the reasoning the user set for that model here,
        // like a thread an agent starts (settleChildReasoning).
        const named: ModelSelection = {
          instanceId: ProviderInstanceId.make(input.agent.instanceId),
          model: input.agent.model,
        };
        const settled = settleChildReasoning({
          selection: named,
          reasoning: input.agent.reasoning,
          driver: provider.driver,
          setting: providerModelReasoning(provider, named.model),
          sources: reasoningSources(thread, scope.participantId, all, yield* deps.userDefaultModel),
          name: modelLabel(named, all),
        });
        if ("refused" in settled) {
          return { outcome: "refused" as const, detail: settled.refused };
        }
        modelSelection = settled;
      }
      return yield* proposeChange(scope, gated, "schedule_create", input, {
        kind: "create",
        draft: {
          name,
          prompt,
          projectId: thread.projectId,
          checkout: input.runs_in ?? "local",
          modelSelection,
          // Never more access than the thread asking for it has.
          runtimeMode: thread.runtimeMode,
          interactionMode: "default",
          cadence: input.schedule,
          timeZone: input.time_zone ?? deps.localTimeZone,
          // In a room, each run's message is for the agent that set it up.
          target:
            input.each_run === "this_thread"
              ? {
                  kind: "thread",
                  threadId: thread.id,
                  ...(scope.participantId !== null ? { participantId: scope.participantId } : {}),
                }
              : { kind: "new_thread" },
        },
      });
    });

  const schedule_update = (
    scope: McpInvocationScope,
    input: {
      readonly id: string;
      readonly name?: string | undefined;
      readonly prompt?: string | undefined;
      readonly schedule?: ScheduledTask["cadence"] | undefined;
      readonly time_zone?: string | undefined;
      readonly runs_in?: "local" | "worktree" | undefined;
      readonly paused?: boolean | undefined;
    },
  ): Effect.Effect<ScheduleChangeResult> =>
    Effect.gen(function* () {
      const gated = yield* gate(scope, "schedule_update");
      if ("refusal" in gated) return gated.refusal;
      const tasks = yield* projectTasks(gated.service, gated.thread);
      const task = Result.isSuccess(tasks)
        ? tasks.success.find((entry) => entry.id === input.id)
        : undefined;
      if (task === undefined) {
        return {
          outcome: "refused" as const,
          detail: "No scheduled task with that id is in this project. schedule_list shows them.",
        };
      }
      const name = input.name?.trim();
      const prompt = input.prompt?.trim();
      const patch: ScheduledTaskUpdateInput = {
        id: ScheduledTaskId.make(task.id),
        ...(name !== undefined && name.length > 0 ? { name } : {}),
        ...(prompt !== undefined && prompt.length > 0 ? { prompt } : {}),
        ...(input.schedule !== undefined ? { cadence: input.schedule } : {}),
        ...(input.time_zone !== undefined ? { timeZone: input.time_zone } : {}),
        ...(input.runs_in !== undefined ? { checkout: input.runs_in } : {}),
        ...(input.paused !== undefined ? { status: input.paused ? "paused" : "active" } : {}),
      };
      return yield* proposeChange(scope, gated, "schedule_update", input, {
        kind: "update",
        input: patch,
      });
    });

  const scheduled_run_finish = (
    scope: McpInvocationScope,
    input: { readonly nothing_to_report: boolean; readonly summary?: string | undefined },
  ): Effect.Effect<ScheduledRunFinishResult> =>
    Effect.gen(function* () {
      // Granted only to a scheduled run's thread; not gated by the setting.
      if (!scope.roomTools.has("scheduled_run_finish") || scope.side !== undefined) {
        return {
          outcome: "not_allowed" as const,
          detail: "Only a scheduled run's own agent can finish it.",
        };
      }
      const service = deps.scheduledTasks;
      if (service === undefined) {
        return { outcome: "not_a_run" as const, detail: NO_SCHEDULES };
      }
      const thread = yield* deps.readThread(scope.threadId);
      if (thread === undefined || (thread.remoteOrigin ?? null) !== null) {
        return { outcome: "not_allowed" as const, detail: REMOTE_ORIGIN_REFUSAL };
      }
      const latched = yield* latchCallerTurn(deps.readThread, scope);
      if ("gone" in latched) return { outcome: "not_a_run" as const, detail: GONE };
      if ("notYours" in latched) {
        return { outcome: "not_this_turn" as const, detail: "Only from the run's own turn." };
      }
      const summary = input.summary?.trim();
      const recorded = yield* service.recordFinish({
        threadId: scope.threadId,
        turnId: latched.turnId,
        nothingToReport: input.nothing_to_report,
        summary: summary !== undefined && summary.length > 0 ? summary : null,
      });
      switch (recorded) {
        case "recorded":
          return {
            outcome: "recorded" as const,
            detail: input.nothing_to_report
              ? "Recorded. When your turn ends this thread is filed away as read."
              : "Recorded. The run ends with your turn.",
          };
        case "not_a_run":
          return { outcome: "not_a_run" as const, detail: "This thread isn't a scheduled run." };
        case "not_this_turn":
          return {
            outcome: "not_this_turn" as const,
            detail:
              "This turn isn't the run's own: the run already ended, or a later message started it.",
          };
        case "already_ended":
          return { outcome: "already_ended" as const, detail: "The run already ended." };
      }
    });

  return { schedule_list, schedule_create, schedule_update, scheduled_run_finish };
}
