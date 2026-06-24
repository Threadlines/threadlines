import {
  type EnvironmentId,
  ProjectId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderDriverKind,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@threadlines/contracts";
import {
  isProviderAuthErrorMessage,
  providerAuthReconnectCommand,
} from "@threadlines/shared/providerAuth";
import type { DesktopCapturedScreenshot } from "@threadlines/contracts";
import { type ChatMessage, type SessionPhase, type Thread, type ThreadSession } from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { selectThreadByRef, useStore } from "../store";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "threadlines:last-invoked-script-by-project";
export const LEGACY_LAST_INVOKED_SCRIPT_BY_PROJECT_KEYS = [
  "t3code:last-invoked-script-by-project",
] as const;
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
export const DEFAULT_SCROLL_END_TOLERANCE_PX = 2;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function isScrollMetricsAtEnd(input: {
  readonly scrollOffset: number;
  readonly viewportLength: number;
  readonly contentLength: number;
  readonly contentInsetEnd?: number | null;
  readonly tolerancePx?: number;
}): boolean {
  const scrollOffset = Number.isFinite(input.scrollOffset) ? input.scrollOffset : 0;
  const viewportLength = Number.isFinite(input.viewportLength) ? input.viewportLength : 0;
  const contentLength = Number.isFinite(input.contentLength) ? input.contentLength : 0;
  const contentInsetEnd =
    input.contentInsetEnd !== null &&
    input.contentInsetEnd !== undefined &&
    Number.isFinite(input.contentInsetEnd)
      ? input.contentInsetEnd
      : 0;
  const tolerancePx =
    input.tolerancePx !== undefined && Number.isFinite(input.tolerancePx)
      ? Math.max(0, input.tolerancePx)
      : DEFAULT_SCROLL_END_TOLERANCE_PX;

  if (viewportLength <= 0 || contentLength <= 0) {
    return true;
  }

  return contentLength - scrollOffset - viewportLength - contentInsetEnd <= tolerancePx;
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    archivedAt: null,
    pinnedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function mergeLocalDraftThreadWithServerThread(
  localDraftThread: Thread | undefined,
  serverThread: Thread | undefined,
): Thread | undefined {
  if (!localDraftThread || !serverThread) {
    return localDraftThread;
  }
  if (
    localDraftThread.id !== serverThread.id ||
    localDraftThread.environmentId !== serverThread.environmentId
  ) {
    return localDraftThread;
  }

  return {
    ...localDraftThread,
    codexThreadId: serverThread.codexThreadId,
    title: serverThread.title,
    modelSelection: serverThread.modelSelection,
    runtimeMode: serverThread.runtimeMode,
    interactionMode: serverThread.interactionMode,
    session: serverThread.session,
    messages: serverThread.messages,
    proposedPlans: serverThread.proposedPlans,
    error: serverThread.error,
    createdAt: serverThread.createdAt,
    archivedAt: serverThread.archivedAt,
    pinnedAt: serverThread.pinnedAt,
    updatedAt: serverThread.updatedAt,
    latestTurn: serverThread.latestTurn,
    pendingSourceProposedPlan: serverThread.pendingSourceProposedPlan,
    branch: serverThread.branch,
    worktreePath: serverThread.worktreePath,
    turnDiffSummaries: serverThread.turnDiffSummaries,
    activities: serverThread.activities,
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function shouldConfirmTerminalKill(input: {
  runningTerminalIds: ReadonlyArray<string>;
  terminalId: string;
  sessionExited: boolean;
}): boolean {
  if (input.sessionExited) {
    return false;
  }
  return input.runningTerminalIds.includes(input.terminalId);
}

export interface ProviderBackgroundRunState {
  id: string;
  source: "provider" | "mentioned-preview";
  label: string;
  detail: string | null;
  statusLabel: string;
  urls: ReadonlyArray<string>;
  pids: ReadonlyArray<number>;
  commandHints: ReadonlyArray<string>;
}

export interface DetectedBackgroundRunState {
  urls: ReadonlyArray<string>;
  pids?: ReadonlyArray<number> | undefined;
}

export function filterUnresolvedProviderBackgroundRuns<
  T extends ProviderBackgroundRunState,
>(input: {
  providerBackgroundRuns: ReadonlyArray<T>;
  detectedBackgroundRuns: ReadonlyArray<DetectedBackgroundRunState>;
}): T[] {
  const detectedUrlSet = new Set(input.detectedBackgroundRuns.flatMap((run) => run.urls));
  const detectedPidSet = new Set(input.detectedBackgroundRuns.flatMap((run) => run.pids ?? []));
  return input.providerBackgroundRuns.filter((run) => {
    if (run.source === "mentioned-preview" && run.urls.length === 0 && run.pids.length > 0) {
      return false;
    }
    if (run.urls.length > 0) {
      return !run.urls.every((url) => detectedUrlSet.has(url));
    }
    if (run.pids.length > 0) {
      return !run.pids.every((pid) => detectedPidSet.has(pid));
    }
    return true;
  });
}

function asBackgroundRunRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asBackgroundRunString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function humanizeTaskType(taskType: string | null): string | null {
  if (!taskType) {
    return null;
  }
  return taskType
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function extractLocalPreviewUrls(text: string | null): string[] {
  if (!text) {
    return [];
  }
  const matches = text.match(
    /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s`<>)\]}]*/gi,
  );
  if (!matches) {
    return [];
  }
  return [...new Set(matches.map((url) => url.replace(/[.,;:]+$/, "")))];
}

function extractBackgroundCommandHints(text: string | null): string[] {
  if (!text) {
    return [];
  }
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return [];
  }
  const hasBackgroundCommandSignal =
    /\bStart-Process\b/i.test(text) ||
    /\bTHREADLINES_PORT_OFFSET\b/i.test(text) ||
    /\bthreadlines-activity-preview-\d+\b/i.test(text) ||
    /\bscripts[\\/]+dev-runner\.ts\b/i.test(text) ||
    /\b(?:node|bun|npm|pnpm|yarn|vp)\b.{0,120}\bdev\b/i.test(text);
  if (!hasBackgroundCommandSignal) {
    return [];
  }
  return [normalized.length <= 600 ? normalized : normalized.slice(0, 600)];
}

function extractBackgroundPidHints(text: string | null): number[] {
  if (!text) {
    return [];
  }
  if (!/\b(?:background|running|started|active|live|process|pid|stop)\b/i.test(text)) {
    return [];
  }

  const pids = new Set<number>();
  const patterns = [/\bPID\s*[:=]?\s*(\d{1,10})\b/gi, /\bProcessId\s*[:=]?\s*(\d{1,10})\b/gi];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const pidText = match[1];
      const pid = pidText ? Number.parseInt(pidText, 10) : Number.NaN;
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
  }
  return [...pids].slice(0, 8);
}

function collectBackgroundCommandHintsFromPayload(value: unknown, limit = 8): string[] {
  const hints: string[] = [];
  const visit = (next: unknown, depth: number) => {
    if (hints.length >= limit || depth > 4) {
      return;
    }
    if (typeof next === "string") {
      for (const hint of extractBackgroundCommandHints(next)) {
        if (!hints.includes(hint)) {
          hints.push(hint);
        }
        if (hints.length >= limit) return;
      }
      return;
    }
    if (Array.isArray(next)) {
      for (const item of next) {
        visit(item, depth + 1);
        if (hints.length >= limit) return;
      }
      return;
    }
    if (next && typeof next === "object") {
      for (const item of Object.values(next as Record<string, unknown>)) {
        visit(item, depth + 1);
        if (hints.length >= limit) return;
      }
    }
  };
  visit(value, 0);
  return hints;
}

function collectBackgroundPidHintsFromPayload(value: unknown, limit = 8): number[] {
  const pids: number[] = [];
  const visit = (next: unknown, depth: number) => {
    if (pids.length >= limit || depth > 4) {
      return;
    }
    if (typeof next === "string") {
      for (const pid of extractBackgroundPidHints(next)) {
        if (!pids.includes(pid)) {
          pids.push(pid);
        }
        if (pids.length >= limit) return;
      }
      return;
    }
    if (Array.isArray(next)) {
      for (const item of next) {
        visit(item, depth + 1);
        if (pids.length >= limit) return;
      }
      return;
    }
    if (next && typeof next === "object") {
      for (const item of Object.values(next as Record<string, unknown>)) {
        visit(item, depth + 1);
        if (pids.length >= limit) return;
      }
    }
  };
  visit(value, 0);
  return pids;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    return left.sequence - right.sequence;
  }
  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  return createdAtComparison === 0 ? left.id.localeCompare(right.id) : createdAtComparison;
}

export function deriveProviderBackgroundRuns(input: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  messages: ReadonlyArray<ChatMessage>;
  pendingBackgroundTaskCount: number;
  activeSubagentCount?: number | undefined;
}): ProviderBackgroundRunState[] {
  const activeRunsByTaskId = new Map<string, ProviderBackgroundRunState>();
  const suppressedSubagentTaskIds = new Set<string>();

  for (const activity of [...input.activities].toSorted(compareActivitiesByOrder)) {
    const payload = asBackgroundRunRecord(activity.payload);
    const taskId = asBackgroundRunString(payload?.taskId);
    if (!payload || !taskId) {
      continue;
    }

    if (activity.kind === "task.completed") {
      activeRunsByTaskId.delete(taskId);
      suppressedSubagentTaskIds.delete(taskId);
      continue;
    }

    if (activity.kind !== "task.started" && activity.kind !== "task.progress") {
      continue;
    }

    const previous = activeRunsByTaskId.get(taskId);
    const detail =
      asBackgroundRunString(payload?.detail) ??
      asBackgroundRunString(payload?.summary) ??
      previous?.detail ??
      null;
    const taskType = asBackgroundRunString(payload?.taskType);
    const urls = [...new Set([...(previous?.urls ?? []), ...extractLocalPreviewUrls(detail)])];
    const commandHints = [
      ...new Set([
        ...(previous?.commandHints ?? []),
        ...extractBackgroundCommandHints(activity.summary),
        ...extractBackgroundCommandHints(detail),
        ...collectBackgroundCommandHintsFromPayload(payload),
      ]),
    ].slice(0, 8);
    const pids = [
      ...new Set([
        ...(previous?.pids ?? []),
        ...extractBackgroundPidHints(activity.summary),
        ...extractBackgroundPidHints(detail),
        ...collectBackgroundPidHintsFromPayload(payload),
      ]),
    ].slice(0, 8);
    if (
      isSubagentProviderTask({
        payload,
        activitySummary: activity.summary,
        urls,
        pids,
        commandHints,
        activeSubagentCount: input.activeSubagentCount ?? 0,
      })
    ) {
      activeRunsByTaskId.delete(taskId);
      suppressedSubagentTaskIds.add(taskId);
      continue;
    }

    const label =
      detail ??
      (taskType ? `${humanizeTaskType(taskType) ?? taskType} task` : null) ??
      previous?.label ??
      "Provider background task";

    activeRunsByTaskId.set(taskId, {
      id: `provider:${taskId}`,
      source: "provider",
      label,
      detail: taskType
        ? `${humanizeTaskType(taskType) ?? taskType} task`
        : (previous?.detail ?? "Provider-managed"),
      statusLabel: "Running",
      urls,
      pids,
      commandHints,
    });
  }

  const runs = [...activeRunsByTaskId.values()];
  const hiddenSubagentTaskCount = Math.max(
    suppressedSubagentTaskIds.size,
    input.activeSubagentCount ?? 0,
  );
  const missingProviderCount = Math.max(
    0,
    input.pendingBackgroundTaskCount - runs.length - hiddenSubagentTaskCount,
  );
  for (let index = 0; index < missingProviderCount; index += 1) {
    runs.push({
      id: `provider:unknown:${index + 1}`,
      source: "provider",
      label:
        missingProviderCount === 1
          ? "Provider background task"
          : `Provider background task ${index + 1}`,
      detail: "Provider-managed; stop handle not exposed.",
      statusLabel: "Tracked",
      urls: [],
      pids: [],
      commandHints: [],
    });
  }

  const knownUrls = new Set(runs.flatMap((run) => run.urls));
  const knownPids = new Set(runs.flatMap((run) => run.pids));
  const previewMessage = input.messages
    .toReversed()
    .find(
      (message) =>
        message.role === "assistant" &&
        ((/\b(localhost|127\.0\.0\.1|\[::1\])\b/i.test(message.text) &&
          /\b(started|running|preview|server|localhost)\b/i.test(message.text)) ||
          extractBackgroundPidHints(message.text).length > 0),
    );
  const mentionedUrls = previewMessage
    ? extractLocalPreviewUrls(previewMessage.text).filter((url) => !knownUrls.has(url))
    : [];
  const mentionedPids = previewMessage
    ? extractBackgroundPidHints(previewMessage.text).filter((pid) => !knownPids.has(pid))
    : [];
  if (mentionedUrls.length > 0 || mentionedPids.length > 0) {
    const commandHints = previewMessage ? extractBackgroundCommandHints(previewMessage.text) : [];
    runs.push({
      id: `mentioned-preview:${[...mentionedUrls, ...mentionedPids.map(String)].join("|")}`,
      source: "mentioned-preview",
      label: mentionedUrls.length > 0 ? "Mentioned local preview" : "Mentioned background process",
      detail:
        mentionedUrls.length > 0
          ? "Mentioned only; no process handle."
          : "Mentioned PID; resolving process handle.",
      statusLabel: "No handle",
      urls: mentionedUrls,
      pids: mentionedPids,
      commandHints,
    });
  }

  return runs;
}

function isSubagentProviderTask(input: {
  payload: Record<string, unknown>;
  activitySummary: string;
  urls: ReadonlyArray<string>;
  pids: ReadonlyArray<number>;
  commandHints: ReadonlyArray<string>;
  activeSubagentCount: number;
}): boolean {
  const taskType = asBackgroundRunString(input.payload.taskType);
  const text = [
    taskType,
    asBackgroundRunString(input.payload.description),
    asBackgroundRunString(input.payload.detail),
    asBackgroundRunString(input.payload.summary),
    asBackgroundRunString(input.payload.lastToolName),
    input.activitySummary,
  ]
    .filter((part): part is string => part !== null)
    .join(" ")
    .toLowerCase();

  if (/\bsub[-\s]?agent\b/u.test(text) || /\bteammate\b/u.test(text)) {
    return true;
  }

  const normalizedTaskType = taskType?.toLowerCase() ?? "";
  const explicitBackgroundTask =
    /\bbackground\b/u.test(normalizedTaskType) ||
    /\bpreview\b/u.test(normalizedTaskType) ||
    /\bserver\b/u.test(normalizedTaskType) ||
    /\bcommand\b/u.test(normalizedTaskType);
  if (explicitBackgroundTask || input.pids.length > 0) {
    return false;
  }

  return (
    input.activeSubagentCount > 0 &&
    input.urls.length === 0 &&
    input.commandHints.length === 0 &&
    normalizedTaskType.length > 0
  );
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function desktopCapturedScreenshotToFile(
  screenshot: DesktopCapturedScreenshot,
): File | null {
  const commaIndex = screenshot.dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }

  const header = screenshot.dataUrl.slice(0, commaIndex).toLowerCase();
  if (!header.startsWith("data:image/png;") || !header.includes(";base64")) {
    return null;
  }

  try {
    const binary = atob(screenshot.dataUrl.slice(commaIndex + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], screenshot.name || "screenshot.png", {
      type: screenshot.mimeType,
      lastModified: Date.parse(screenshot.capturedAt) || Date.now(),
    });
  } catch {
    return null;
  }
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 || options.imageCount > 0 || sendableTerminalContexts.length > 0,
  };
}

export interface ProviderAuthReconnectPrompt {
  readonly provider: ProviderDriverKind;
  readonly command: string;
  readonly message: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function authMessageFromActivity(activity: OrchestrationThreadActivity): string | null {
  if (activity.kind !== "runtime.error") {
    return null;
  }

  const payload = asRecord(activity.payload);
  const message = asString(payload?.message);
  const errorClass = asString(payload?.class);
  if (errorClass === "authentication_error") {
    return message ?? activity.summary;
  }
  return isProviderAuthErrorMessage(message) ? message : null;
}

export function deriveProviderAuthReconnectPrompt(input: {
  readonly provider: ProviderDriverKind | null | undefined;
  readonly threadError?: string | null | undefined;
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity> | null | undefined;
  readonly messages?: ReadonlyArray<Pick<ChatMessage, "role" | "text">> | null | undefined;
}): ProviderAuthReconnectPrompt | null {
  const provider = input.provider ?? null;
  if (!provider) {
    return null;
  }

  const command = providerAuthReconnectCommand(provider);
  if (!command) {
    return null;
  }

  const threadError = input.threadError?.trim();
  if (threadError && isProviderAuthErrorMessage(threadError)) {
    return {
      provider,
      command,
      message: threadError,
    };
  }

  const activities = input.activities ?? [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) {
      continue;
    }
    const authMessage = authMessageFromActivity(activity);
    if (authMessage) {
      return {
        provider,
        command,
        message: authMessage,
      };
    }
  }

  const messages = input.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const text = message.text.trim();
    if (!isProviderAuthErrorMessage(text)) {
      continue;
    }
    return {
      provider,
      command,
      message: text,
    };
  }

  return null;
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

export function threadHasPromotableServerActivity(thread: Thread | null | undefined): boolean {
  if (!thread) {
    return false;
  }
  if (thread.latestTurn !== null || thread.activities.length > 0) {
    return true;
  }
  if (thread.proposedPlans.length > 0 || thread.turnDiffSummaries.length > 0) {
    return true;
  }
  if (thread.error) {
    return true;
  }
  return (
    thread.session?.status === "error" ||
    thread.session?.orchestrationStatus === "error" ||
    thread.session?.orchestrationStatus === "interrupted"
  );
}

// Callers resolve provider instance ids to driver kinds before invoking this
// helper, so custom instances like `codex_personal` lock as `codex`.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: ProviderDriverKind | null;
  threadProvider: ProviderDriverKind | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.session?.provider ?? null;
  if (sessionProvider) {
    return sessionProvider;
  }
  return input.threadProvider ?? input.selectedProvider ?? null;
}

export type ModelSwitchClassification =
  | "apply"
  | "confirm-cross-driver"
  | "blocked-incompatible-instance";

/**
 * Decide what should happen when the user picks `pickedDriverKind` for a thread
 * currently bound to `boundProvider`.
 *
 * - Different driver → `confirm-cross-driver`: allowed, but the server hands off
 *   by rehydrating the new driver from a transcript recap (not the outgoing
 *   model's full internal state), so the UI confirms the context-loss first.
 * - Same driver but a different *known* continuation group →
 *   `blocked-incompatible-instance`: native resume state cannot be reconciled
 *   across those instances, and the server rejects it.
 * - Otherwise (`apply`): a plain in-driver model swap, or the thread has no
 *   binding yet.
 */
export function classifyModelSwitch(input: {
  boundProvider: ProviderDriverKind | null;
  pickedDriverKind: ProviderDriverKind | null;
  boundContinuationGroupKey: string | null;
  pickedContinuationGroupKey: string | null;
}): ModelSwitchClassification {
  if (input.boundProvider === null || input.pickedDriverKind === null) {
    return "apply";
  }
  if (input.pickedDriverKind !== input.boundProvider) {
    return "confirm-cross-driver";
  }
  if (
    input.boundContinuationGroupKey !== null &&
    input.pickedContinuationGroupKey !== null &&
    input.boundContinuationGroupKey !== input.pickedContinuationGroupKey
  ) {
    return "blocked-incompatible-instance";
  }
  return "apply";
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getThread = () => selectThreadByRef(useStore.getState(), threadRef);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!threadHasStarted(selectThreadByRef(state, threadRef))) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: ThreadSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== undefined &&
      session.activeTurnId !== null &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}

export type SteeringHandoffStatus = "queued" | "read";

export interface SteeringHandoffState {
  readonly id: string;
  readonly threadKey: string;
  readonly createdAt: string;
  readonly status: SteeringHandoffStatus;
}

export function reconcileSteeringHandoffStatuses<T extends SteeringHandoffState>(input: {
  readonly messagesById: Record<string, T>;
  readonly activeThreadKey: string | null | undefined;
  readonly latestTurn: Pick<NonNullable<Thread["latestTurn"]>, "requestedAt"> | null | undefined;
  readonly serverMessageIds: ReadonlySet<string>;
}): Record<string, T> {
  const { activeThreadKey } = input;
  if (!activeThreadKey) {
    return input.messagesById;
  }

  let changed = false;
  const next = { ...input.messagesById };
  for (const [id, message] of Object.entries(input.messagesById)) {
    if (message.threadKey !== activeThreadKey || message.status !== "queued") {
      continue;
    }
    const hasAcceptedTurn = input.latestTurn?.requestedAt === message.createdAt;
    const hasVisibleServerMessage = input.serverMessageIds.has(message.id);
    if (!hasAcceptedTurn && !hasVisibleServerMessage) {
      continue;
    }
    next[id] = { ...message, status: "read" };
    changed = true;
  }

  return changed ? next : input.messagesById;
}
