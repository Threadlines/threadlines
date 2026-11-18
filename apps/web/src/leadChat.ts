/**
 * A project's lead chat on the client (docs/design/lead-chat.md): which
 * thread leads each project, what a thread's menu offers about it, and the
 * command that changes it. The rules themselves are the server's
 * (@threadlines/shared/projectLead); the client reads them first so a
 * disabled item can say why.
 */
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import {
  DEFAULT_NEW_THREAD_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@threadlines/contracts";
import { leadSetRefusal, projectLeadThreadId } from "@threadlines/shared/projectLead";
import { agentThreadsMode } from "@threadlines/shared/serverSettings";

import { addComputerNotConnectedNotice } from "./components/computerConnectionNotices";
import { failureNotice, toastManager } from "./components/ui/toast";
import { readEnvironmentApi } from "./environmentApi";
import { readEnvironmentDescriptor } from "./environments/runtime";
import { newCommandId, newThreadId } from "./lib/utils";
import {
  fallbackNewThreadModelSelection,
  lastUsedSelection,
  readComputerConfig,
  resolveNewThreadDefaults,
} from "./newThreadDefaults";
import {
  type AppState,
  selectProjectByRef,
  selectSidebarThreadSummaryByRef,
  selectThreadExistsByRef,
  useStore,
  waitForAppState,
} from "./store";
import type { Project, SidebarThreadSummary } from "./types";

/** Whether the computer a project lives on keeps a lead chat (capability `projectLead`). */
export function environmentSupportsProjectLead(environmentId: EnvironmentId): boolean {
  return readEnvironmentDescriptor(environmentId)?.capabilities.projectLead === true;
}

/** The project's lead thread, as a ref; null when it has none (or a ghost pointer). */
export function projectLeadRef(
  state: AppState,
  project: Pick<Project, "environmentId" | "id" | "leadThreadId">,
): ScopedThreadRef | null {
  const leadThreadId = projectLeadThreadId(project, (threadId) =>
    leadThreadFacts(
      selectSidebarThreadSummaryByRef(state, scopeThreadRef(project.environmentId, threadId)),
    ),
  );
  return leadThreadId === null ? null : scopeThreadRef(project.environmentId, leadThreadId);
}

/**
 * Scoped keys of every project's lead thread, on every computer in view.
 * Pure over what the caller already holds, so a memo can keep it.
 */
export function leadThreadKeysOf(
  projects: ReadonlyArray<Pick<Project, "environmentId" | "id" | "leadThreadId">>,
  threads: ReadonlyArray<SidebarThreadSummary>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!projects.some((project) => (project.leadThreadId ?? null) !== null)) return keys;
  const byKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  for (const project of projects) {
    const leadThreadId = projectLeadThreadId(project, (threadId) =>
      leadThreadFacts(byKey.get(scopedThreadKey(scopeThreadRef(project.environmentId, threadId)))),
    );
    if (leadThreadId !== null) {
      keys.add(scopedThreadKey(scopeThreadRef(project.environmentId, leadThreadId)));
    }
  }
  return keys;
}

const leadThreadFacts = (thread: SidebarThreadSummary | undefined | null) =>
  thread === undefined || thread === null
    ? null
    : {
        id: thread.id,
        projectId: thread.projectId,
        parentThreadId: thread.parentThreadId ?? null,
        attachedToParent: thread.attachedToParent ?? false,
        archivedAt: thread.archivedAt,
        remoteOrigin: thread.remoteOrigin ?? null,
        outsideOrigin: thread.outsideOrigin ?? null,
        move: thread.moveStatus ?? null,
      };

/**
 * What a thread's menu offers about the lead chat: stop using it, or make
 * it the lead (replacing another, and refused with a reason). Null when the
 * thread's computer doesn't keep a lead chat.
 */
export type LeadMenuState =
  | { readonly kind: "stop" }
  | {
      readonly kind: "make";
      readonly replacingTitle: string | null;
      readonly refusal: string | null;
    };

/**
 * Why no thread on this computer can lead right now, from that computer's own
 * settings: a lead with "Agents can start threads" off could start nothing.
 * Null when it can, or when the computer's settings aren't known yet.
 */
export function leadSettingRefusal(environmentId: EnvironmentId): string | null {
  const settings = readComputerConfig(environmentId)?.settings;
  return settings !== undefined && agentThreadsMode(settings) === "off"
    ? "Agents can't start threads. Turn it on in Settings › Threads."
    : null;
}

export function readLeadMenuState(
  state: AppState,
  thread: SidebarThreadSummary,
): LeadMenuState | null {
  if (!environmentSupportsProjectLead(thread.environmentId)) return null;
  const project = selectProjectByRef(
    state,
    scopeProjectRef(thread.environmentId, thread.projectId),
  );
  if (project === undefined) return null;
  const leadRef = projectLeadRef(state, project);
  if (leadRef !== null && leadRef.threadId === thread.id) return { kind: "stop" };
  const facts = leadThreadFacts(thread)!;
  const refusal =
    leadSetRefusal({ id: project.id, kind: project.kind, leadThreadId: null }, facts) ??
    leadSettingRefusal(thread.environmentId);
  return {
    kind: "make",
    replacingTitle:
      leadRef === null ? null : (selectSidebarThreadSummaryByRef(state, leadRef)?.title ?? null),
    refusal,
  };
}

/** The menu words for a lead state. */
export function leadMenuLabel(state: LeadMenuState): string {
  if (state.kind === "stop") return "Stop using as lead chat";
  const base =
    state.replacingTitle === null
      ? "Make this the lead chat"
      : `Make this the lead chat instead of ${state.replacingTitle}`;
  return state.refusal === null
    ? base
    : `${base}: ${state.refusal.charAt(0).toLowerCase()}${state.refusal.slice(1).replace(/\.$/, "")}`;
}

/**
 * Makes `threadId` the project's lead chat, or (null) stops having one, on
 * the project's own computer. Says so when that computer can't be reached
 * or is too old to keep a lead. Every way of making a lead (the thread menus,
 * the palette, "New lead chat") comes through here.
 */
export async function setProjectLead(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
}): Promise<boolean> {
  const failure =
    input.threadId === null
      ? "Couldn't stop using the lead chat"
      : "Couldn't make it the lead chat";
  const api = readEnvironmentApi(input.environmentId);
  if (!api) {
    addComputerNotConnectedNotice({ environmentId: input.environmentId, failure });
    return false;
  }
  if (!environmentSupportsProjectLead(input.environmentId)) {
    const label = readEnvironmentDescriptor(input.environmentId)?.label ?? "that computer";
    toastManager.add({
      type: "warning",
      title: failure,
      description: `Update Threadlines on ${label} to use this there.`,
    });
    return false;
  }
  try {
    await api.orchestration.dispatchCommand({
      type: "project.lead.set",
      commandId: newCommandId(),
      projectId: input.projectId,
      threadId: input.threadId,
    });
    return true;
  } catch (error) {
    toastManager.add(failureNotice({ title: failure, error }));
    return false;
  }
}

/** Reads the store now: the lead of the project a thread belongs to. */
export function readProjectLeadRefForThread(threadRef: ScopedThreadRef): ScopedThreadRef | null {
  const state = useStore.getState();
  const thread = selectSidebarThreadSummaryByRef(state, threadRef);
  if (!thread) return null;
  const project = selectProjectByRef(
    state,
    scopeProjectRef(thread.environmentId, thread.projectId),
  );
  return project === undefined ? null : projectLeadRef(state, project);
}

/**
 * "New lead chat": makes a thread in the project's own folder (no worktree),
 * with the agent a new thread there would get, makes it the lead and returns
 * it once this app has it, ready to open. Null when it couldn't, or when the
 * thread hasn't reached this app in time, having said so either way.
 */
export async function createLeadChat(
  project: Pick<Project, "environmentId" | "id">,
): Promise<ScopedThreadRef | null> {
  const failure = "Couldn't start a lead chat";
  const api = readEnvironmentApi(project.environmentId);
  if (!api) {
    addComputerNotConnectedNotice({ environmentId: project.environmentId, failure });
    return null;
  }
  const settingRefusal = leadSettingRefusal(project.environmentId);
  if (settingRefusal !== null) {
    toastManager.add({ type: "warning", title: failure, description: settingRefusal });
    return null;
  }
  const config = readComputerConfig(project.environmentId);
  // The same agent a new thread here would get, down to the composer's own
  // fallback when nothing is chosen, so the two never disagree. Not the
  // project's stored `defaultModelSelection`: new threads ignore that old pin.
  const modelSelection =
    (config === null ? null : resolveNewThreadDefaults(config).modelSelection) ??
    lastUsedSelection() ??
    fallbackNewThreadModelSelection(config);
  const threadId = newThreadId();
  try {
    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: project.id,
      title: "Lead chat",
      modelSelection,
      runtimeMode: DEFAULT_NEW_THREAD_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    toastManager.add(failureNotice({ title: failure, error }));
    return null;
  }
  const made = await setProjectLead({
    environmentId: project.environmentId,
    projectId: project.id,
    threadId,
  });
  if (!made) return null;
  // Opened once this app has it: before that its page finds no thread there
  // and goes home.
  const ref = scopeThreadRef(project.environmentId, threadId);
  const arrived = await waitForAppState(
    (state) => selectThreadExistsByRef(state, ref),
    THREAD_ARRIVAL_TIMEOUT_MS,
  );
  if (!arrived) {
    toastManager.add({
      type: "info",
      title: "Lead chat started",
      description: "It shows in the sidebar once this window catches up.",
    });
    return null;
  }
  return ref;
}

/** How long "New lead chat" waits for its thread to reach this app before opening it anyway. */
const THREAD_ARRIVAL_TIMEOUT_MS = 10_000;

/**
 * The project's name when `threadRef` is its lead chat, else null. A
 * primitive, so a store selector built on it redraws only when it changes.
 */
export function readLeadProjectName(state: AppState, threadRef: ScopedThreadRef): string | null {
  const thread = selectSidebarThreadSummaryByRef(state, threadRef);
  if (!thread) return null;
  const project = selectProjectByRef(
    state,
    scopeProjectRef(thread.environmentId, thread.projectId),
  );
  if (project === undefined) return null;
  const leadRef = projectLeadRef(state, project);
  return leadRef !== null && leadRef.threadId === thread.id ? project.name : null;
}
