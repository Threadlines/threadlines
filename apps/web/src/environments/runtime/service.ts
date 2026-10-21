import {
  type AuthSessionRole,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type ScopedThreadRef,
  type ServerConfig,
  type TerminalEvent,
  ThreadId,
} from "@threadlines/contracts";
import {
  RELAY_CLOSE_CODE_ACCESS_REMOVED,
  RELAY_CLOSE_CODE_DAILY_LIMIT,
  RELAY_CLOSE_CODE_HOST_OFFLINE,
  RELAY_CLOSE_CODE_PEER_UNAVAILABLE,
  RELAY_CLOSE_CODE_RELAY_BUSY,
  RELAY_CLOSE_CODE_REPLACED,
  RELAY_CLOSE_CODE_SESSION_EXPIRED,
} from "@threadlines/contracts/relay";
import { type QueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";
import {
  createKnownEnvironment,
  getKnownEnvironmentWsBaseUrl,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";

import {
  markPromotedDraftThreadByRef,
  markPromotedDraftThreadsByRef,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { ensureLocalApi } from "~/localApi";
import { collectActiveTerminalThreadIds } from "~/lib/terminalStateCleanup";
import { settleComposerPullRequestDismissals } from "~/lib/composerPullRequestDismissals";
import {
  migrateLegacyInboxStateForEnvironment,
  resendUndeliveredThreadSeen,
} from "~/lib/threadInboxSync";
import {
  deriveOrchestrationBatchEffects,
  serverMergeSwitchTurnedOff,
} from "~/orchestrationEventEffects";
import { projectQueryKeys } from "~/lib/projectReactQuery";
import { providerQueryKeys } from "~/lib/providerReactQuery";
import { pullRequestQueryKeys } from "~/lib/pullRequestsReactQuery";
import { getPrimaryKnownEnvironment } from "../primary";
import { isLoopbackHostname } from "../primary/target";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError,
  isRemoteEnvironmentUnreachableError,
  resolveRemoteWebSocketConnectionUrl,
} from "../remote/api";
import { resolveRemotePairingTarget } from "../remote/target";
import {
  getSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated,
  listSavedEnvironmentRecords,
  persistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken,
  type SavedEnvironmentRecord,
  toPersistedSavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  waitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken,
} from "./catalog";
import { createEnvironmentConnection, type EnvironmentConnection } from "./connection";
import { isPendingRelayJoin } from "./relayJoins";
import {
  bindThreadRowIntentPrewarm as bindThreadRowIntentPrewarmTo,
  createThreadDetailSubscriptions,
  THREAD_INTENT_GRACE_MS,
} from "./threadDetailSubscriptions";
import {
  useStore,
  selectProjectsAcrossEnvironments,
  selectThreadByRef,
  selectThreadsAcrossEnvironments,
} from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";
import { useUiStateStore } from "~/uiStateStore";
import type { WsProtocolCloseContext } from "../../rpc/protocol";
import { applyServerConfigStreamEvent } from "../../rpc/serverConfigEvents";
import { getServerConfig } from "../../rpc/serverState";
import { TransportRequestRetriesExhaustedError } from "../../rpc/transportError";
import { getWsReconnectDelayMsForRetry } from "../../rpc/wsConnectionState";
import { WsTransport } from "../../rpc/wsTransport";
import { createWsRpcClient, type WsRpcClient } from "../../rpc/wsRpcClient";
import { relayWebSocketProtocols } from "../../relayTransport";
import {
  probeDirectRoutes,
  SECURE_CLOSE_CODE_NO_ROUTE,
  SECURE_CLOSE_CODE_PROTOCOL,
  SECURE_OPEN_TIMEOUT_MS,
  SecureRelaySocket,
  type SecureRelayTarget,
} from "../../rpc/secureRelaySocket";
import { readRelayDeviceCredentials } from "./relayCredentials";
import { appendVersionMismatchHint, resolveServerConfigVersionMismatch } from "../../versionSkew";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
} from "../../logicalProject";
import { getClientSettings } from "~/hooks/useSettings";
import { useOptimisticThreadMessagesStore } from "~/optimisticThreadMessages";

type EnvironmentServiceState = {
  readonly queryClient: QueryClient;
  readonly queryInvalidationThrottler: Throttler<() => void>;
  refCount: number;
  stop: () => void;
};

const environmentConnections = new Map<EnvironmentId, EnvironmentConnection>();
class SavedEnvironmentConnectionCancelledError extends Error {
  constructor(environmentId: EnvironmentId) {
    super(`Saved environment ${environmentId} connection was cancelled.`);
    this.name = "SavedEnvironmentConnectionCancelledError";
  }
}

function isSavedEnvironmentConnectionCancelledError(
  error: unknown,
): error is SavedEnvironmentConnectionCancelledError {
  return error instanceof SavedEnvironmentConnectionCancelledError;
}

interface PendingSavedEnvironmentConnection {
  cancelled: boolean;
  readonly promise: Promise<EnvironmentConnection>;
}

const pendingSavedEnvironmentConnections = new Map<
  EnvironmentId,
  PendingSavedEnvironmentConnection
>();
const environmentConnectionListeners = new Set<() => void>();
const lastAppliedProjectionVersionByEnvironment = new Map<
  EnvironmentId,
  {
    readonly sequence: number;
    readonly updatedAt: string | null;
  }
>();

let activeService: EnvironmentServiceState | null = null;
let needsProviderInvalidation = false;
let needsPullRequestInvalidation = false;
let lastBrowserHiddenAt: number | null = null;
let lastBrowserResumeReconnectAt = Number.NEGATIVE_INFINITY;

// Function declarations below are hoisted, so the registry can hold them now
// and call them once connections exist.
const threadDetails = createThreadDetailSubscriptions({
  readConnection: readEnvironmentConnection,
  subscribeConnections: subscribeEnvironmentConnections,
  applyThreadDetailEvent: applyEnvironmentThreadDetailEvent,
});

/** How many jump-hinted threads are prewarmed while the hints are on screen. */
const THREAD_JUMP_PREWARM_LIMIT = 4;
/**
 * How long the jump hints must stay up before their threads prewarm. The
 * hints appear 100ms into holding the modifier, which a slow Cmd+C or
 * Cmd+Tab also does; someone reading the numbers holds it longer.
 */
const THREAD_JUMP_PREWARM_DWELL_MS = 250;

/**
 * Keeps a thread's detail stream open for a mounted chat until the returned
 * release runs. Mounted chats always load first.
 */
export function retainThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): () => void {
  return threadDetails.retain(environmentId, threadId, "foreground");
}

/** Restarts a retained thread's stream to fetch a fresh snapshot; false if none is open. */
export function refreshThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return threadDetails.refresh(environmentId, threadId);
}

/**
 * Prewarms the threads behind the jump-hint numbers once they have been on
 * screen a moment (the first few only). The release lets loaded ones go
 * after a grace period and cancels the rest.
 */
export function prewarmThreadJumpTargets(refs: ReadonlyArray<ScopedThreadRef>): () => void {
  let endIntent: (() => void) | null = null;
  const timeoutId = setTimeout(() => {
    endIntent = threadDetails.holdIntent(refs.slice(0, THREAD_JUMP_PREWARM_LIMIT), {
      graceMs: THREAD_INTENT_GRACE_MS,
    });
  }, THREAD_JUMP_PREWARM_DWELL_MS);
  return () => {
    clearTimeout(timeoutId);
    endIntent?.();
    endIntent = null;
  };
}

/**
 * The environment whose server runs on this machine (reached over loopback),
 * if any: the desktop app's own, or a local `threadlines` opened in a
 * browser. A primary environment reached by hostname is remote like any
 * saved one.
 */
function readLocalEnvironmentId(): EnvironmentId | null {
  const primary = getPrimaryKnownEnvironment();
  if (!primary?.environmentId) {
    return null;
  }
  try {
    return isLoopbackHostname(new URL(primary.target.httpBaseUrl).hostname)
      ? primary.environmentId
      : null;
  } catch {
    return null;
  }
}

/**
 * Prewarms these threads one at a time when the page is idle and nothing in
 * the foreground is loading. They stay retained until the cancel runs. Only
 * this machine's own threads take part: over a network or relayed connection
 * a detail is too costly to fetch on speculation, so those load on intent.
 */
export function requestIdleThreadDetailPrewarm(refs: ReadonlyArray<ScopedThreadRef>): () => void {
  const localEnvironmentId = readLocalEnvironmentId();
  return threadDetails.requestIdlePrewarm(
    localEnvironmentId ? refs.filter((ref) => ref.environmentId === localEnvironmentId) : [],
  );
}

/**
 * Prewarms a thread when a pointer rests on its row, or a finger lands on it
 * (any element under `target` carrying `data-thread-key`). Returns the cleanup.
 */
export function bindThreadRowIntentPrewarm(
  target: Parameters<typeof bindThreadRowIntentPrewarmTo>[0],
): () => void {
  return bindThreadRowIntentPrewarmTo(target, (refs) =>
    threadDetails.holdIntent(refs, { graceMs: THREAD_INTENT_GRACE_MS }),
  );
}

const BROWSER_RESUME_RECONNECT_COOLDOWN_MS = 2_000;
const INITIAL_SERVER_CONFIG_SNAPSHOT_WAIT_MS = 150;
const NOOP = () => undefined;
const SSH_HTTP_STATUS_RE = /^\[ssh_http:(\d+)\]\s/u;

function createDeferredPromise<T>() {
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value);
      resolve = null;
    },
  };
}

async function waitForConfigSnapshot(
  promise: Promise<ServerConfig>,
  timeoutMs: number,
): Promise<ServerConfig | null> {
  return await new Promise<ServerConfig | null>((resolve) => {
    const timeoutId = globalThis.setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (config) => {
        clearTimeout(timeoutId);
        resolve(config);
      },
      () => {
        clearTimeout(timeoutId);
        resolve(null);
      },
    );
  });
}

function createSavedEnvironmentSyncScheduler() {
  let activeSync: Promise<void> | null = null;
  let queued = false;

  const run = async (): Promise<void> => {
    do {
      queued = false;
      await syncSavedEnvironmentConnections(listSavedEnvironmentRecords());
    } while (queued);
  };

  return () => {
    if (activeSync) {
      queued = true;
      return activeSync;
    }

    activeSync = run()
      .catch(() => undefined)
      .finally(() => {
        activeSync = null;
      });

    return activeSync;
  };
}
function compareAppliedProjectionVersion(
  left: { readonly sequence: number; readonly updatedAt: string | null },
  right: { readonly sequence: number; readonly updatedAt: string | null },
): number {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }

  const leftUpdatedAt = left.updatedAt ?? "";
  const rightUpdatedAt = right.updatedAt ?? "";
  if (leftUpdatedAt === rightUpdatedAt) {
    return 0;
  }

  return leftUpdatedAt < rightUpdatedAt ? -1 : 1;
}

function toAppliedProjectionVersion(
  snapshot: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">,
): {
  readonly sequence: number;
  readonly updatedAt: string;
} {
  return {
    sequence: snapshot.snapshotSequence,
    updatedAt: snapshot.updatedAt,
  };
}

export function shouldApplyProjectionSnapshot(input: {
  readonly current: {
    readonly sequence: number;
    readonly updatedAt: string | null;
  } | null;
  readonly next: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">;
}): boolean {
  if (input.current === null) {
    return true;
  }

  return compareAppliedProjectionVersion(input.current, toAppliedProjectionVersion(input.next)) < 0;
}

export function shouldApplyProjectionEvent(input: {
  readonly current: {
    readonly sequence: number;
    readonly updatedAt: string | null;
  } | null;
  readonly sequence: number;
}): boolean {
  if (input.current === null) {
    return true;
  }

  return input.sequence > input.current.sequence;
}

function readLastAppliedProjectionVersion(environmentId: EnvironmentId): {
  readonly sequence: number;
  readonly updatedAt: string | null;
} | null {
  return lastAppliedProjectionVersionByEnvironment.get(environmentId) ?? null;
}

function markAppliedProjectionSnapshot(
  environmentId: EnvironmentId,
  snapshot: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">,
): void {
  const nextVersion = toAppliedProjectionVersion(snapshot);
  const currentVersion = readLastAppliedProjectionVersion(environmentId);
  if (
    currentVersion !== null &&
    compareAppliedProjectionVersion(currentVersion, nextVersion) >= 0
  ) {
    return;
  }

  lastAppliedProjectionVersionByEnvironment.set(environmentId, nextVersion);
}

function markAppliedProjectionEvent(environmentId: EnvironmentId, sequence: number): void {
  const currentVersion = readLastAppliedProjectionVersion(environmentId);
  if (currentVersion !== null && sequence <= currentVersion.sequence) {
    return;
  }

  lastAppliedProjectionVersionByEnvironment.set(environmentId, {
    sequence,
    updatedAt: currentVersion?.updatedAt ?? null,
  });
}
function emitEnvironmentConnectionRegistryChange() {
  for (const listener of environmentConnectionListeners) {
    listener();
  }
}

function getRuntimeErrorFields(error: unknown) {
  return {
    lastError: error instanceof Error ? error.message : String(error),
    lastErrorAt: new Date().toISOString(),
  } as const;
}

function isoNow(): string {
  return new Date().toISOString();
}

function readSshHttpErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = SSH_HTTP_STATUS_RE.exec(error.message);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function isSshHttpAuthError(error: unknown, status: number): boolean {
  return readSshHttpErrorStatus(error) === status;
}

function isDesktopSshTargetEqual(
  left: DesktopSshEnvironmentTarget | undefined,
  right: DesktopSshEnvironmentTarget | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.alias === right.alias &&
    left.hostname === right.hostname &&
    left.username === right.username &&
    left.port === right.port
  );
}

function findSavedEnvironmentRecordByDesktopSshTarget(
  target: DesktopSshEnvironmentTarget | undefined,
): SavedEnvironmentRecord | null {
  if (!target) {
    return null;
  }

  return (
    listSavedEnvironmentRecords().find((record) =>
      isDesktopSshTargetEqual(record.desktopSsh, target),
    ) ?? null
  );
}

function buildSavedEnvironmentRegistryById(
  records: ReadonlyArray<SavedEnvironmentRecord>,
): Record<EnvironmentId, SavedEnvironmentRecord> {
  return Object.fromEntries(records.map((record) => [record.environmentId, record])) as Record<
    EnvironmentId,
    SavedEnvironmentRecord
  >;
}

type SavedEnvironmentRegistrySnapshot = ReadonlyMap<EnvironmentId, SavedEnvironmentRecord | null>;

function snapshotSavedEnvironmentRegistry(
  environmentIds: ReadonlyArray<EnvironmentId>,
): SavedEnvironmentRegistrySnapshot {
  return new Map(
    environmentIds.map((environmentId) => [
      environmentId,
      getSavedEnvironmentRecord(environmentId) ?? null,
    ]),
  );
}

async function persistSavedEnvironmentRegistryRollback(
  snapshot: SavedEnvironmentRegistrySnapshot,
): Promise<void> {
  const byId = buildSavedEnvironmentRegistryById(listSavedEnvironmentRecords());
  for (const [environmentId, record] of snapshot) {
    if (record) {
      byId[environmentId] = record;
      continue;
    }
    delete byId[environmentId];
  }
  const records = Object.values(byId);
  await ensureLocalApi().persistence.setSavedEnvironmentRegistry(
    records.map((entry) => toPersistedSavedEnvironmentRecord(entry)),
  );
  useSavedEnvironmentRegistryStore.setState({
    byId,
  });
}

async function resolveDesktopSshEnvironmentBootstrap(
  target: DesktopSshEnvironmentTarget,
  options?: { readonly issuePairingToken?: boolean },
): Promise<DesktopSshEnvironmentBootstrap> {
  const desktopBridge = window.desktopBridge;
  if (!desktopBridge) {
    throw new Error("SSH launch is only available in the desktop app.");
  }

  return await desktopBridge.ensureSshEnvironment(target, options);
}

function getDesktopSshBridge() {
  const desktopBridge = window.desktopBridge;
  if (!desktopBridge) {
    throw new Error("SSH launch is only available in the desktop app.");
  }
  return desktopBridge;
}

async function fetchDesktopSshEnvironmentDescriptor(httpBaseUrl: string) {
  return await getDesktopSshBridge().fetchSshEnvironmentDescriptor(httpBaseUrl);
}

async function bootstrapDesktopSshBearerSession(httpBaseUrl: string, credential: string) {
  return await getDesktopSshBridge().bootstrapSshBearerSession(httpBaseUrl, credential);
}

async function fetchDesktopSshSessionState(httpBaseUrl: string, bearerToken: string) {
  return await getDesktopSshBridge().fetchSshSessionState(httpBaseUrl, bearerToken);
}

async function resolveDesktopSshWebSocketConnectionUrl(
  wsBaseUrl: string,
  httpBaseUrl: string,
  bearerToken: string,
) {
  const issued = await getDesktopSshBridge().issueSshWebSocketToken(httpBaseUrl, bearerToken);
  const url = new URL(wsBaseUrl, window.location.origin);
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}

async function prepareSavedEnvironmentRecordForConnection(
  record: SavedEnvironmentRecord,
  options?: { readonly issuePairingToken?: boolean },
): Promise<{
  readonly record: SavedEnvironmentRecord;
  readonly pairingToken: string | null;
  readonly remotePort: number | null;
  readonly remoteServerKind: "external" | "managed" | null;
}> {
  if (!record.desktopSsh) {
    return {
      record,
      pairingToken: null,
      remotePort: null,
      remoteServerKind: null,
    };
  }

  const bootstrap = await resolveDesktopSshEnvironmentBootstrap(record.desktopSsh, options);
  const nextRecord: SavedEnvironmentRecord = {
    ...record,
    httpBaseUrl: bootstrap.httpBaseUrl,
    wsBaseUrl: bootstrap.wsBaseUrl,
    desktopSsh: bootstrap.target,
  };

  if (
    nextRecord.httpBaseUrl !== record.httpBaseUrl ||
    nextRecord.wsBaseUrl !== record.wsBaseUrl ||
    !isDesktopSshTargetEqual(nextRecord.desktopSsh, record.desktopSsh)
  ) {
    await persistSavedEnvironmentRecord(nextRecord);
    useSavedEnvironmentRegistryStore.getState().upsert(nextRecord);
  }

  return {
    record: nextRecord,
    pairingToken: bootstrap.pairingToken,
    remotePort: bootstrap.remotePort ?? null,
    remoteServerKind: bootstrap.remoteServerKind ?? null,
  };
}

async function issueDesktopSshBearerSession(record: SavedEnvironmentRecord): Promise<{
  readonly record: SavedEnvironmentRecord;
  readonly bearerToken: string;
  readonly role: AuthSessionRole | null;
}> {
  const registrySnapshot = snapshotSavedEnvironmentRegistry([record.environmentId]);
  const prepared = await prepareSavedEnvironmentRecordForConnection(record, {
    issuePairingToken: true,
  });
  if (!prepared.pairingToken) {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    throw new Error("Desktop SSH launch did not return a pairing token.");
  }

  const bearerSession = await bootstrapDesktopSshBearerSession(
    prepared.record.httpBaseUrl,
    prepared.pairingToken,
  ).catch(async (error) => {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    const detail = [
      `local ${prepared.record.httpBaseUrl}`,
      `remote port ${prepared.remotePort ?? "unknown"}`,
      prepared.remoteServerKind ? `remote server ${prepared.remoteServerKind}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (${detail})`);
  });
  const didPersistBearerToken = await writeSavedEnvironmentBearerToken(
    prepared.record.environmentId,
    bearerSession.sessionToken,
  );
  if (!didPersistBearerToken) {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    throw new Error("Unable to persist saved environment credentials.");
  }

  return {
    record: prepared.record,
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role ?? null,
  };
}

export const RELAY_LINK_EXPIRED_MESSAGE =
  "This phone link no longer works. On your computer, open Settings › Connections › Connect a device and scan the new QR code.";

/**
 * Marks a relay-paired environment as permanently unpairable (relay session
 * expired or deleted) and tears down its connection so the transport stops
 * retrying a handshake that can never succeed.
 */
export async function markRelaySavedEnvironmentLinkExpired(
  environmentId: EnvironmentId,
): Promise<void> {
  await disconnectSavedEnvironment(environmentId).catch(() => undefined);
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    authState: "requires-auth",
    connectionState: "disconnected",
    role: null,
    lastError: RELAY_LINK_EXPIRED_MESSAGE,
    lastErrorAt: isoNow(),
  });
}

function setRuntimeConnecting(environmentId: EnvironmentId) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connecting",
    lastError: null,
    lastErrorAt: null,
  });
}

function setRuntimeConnected(environmentId: EnvironmentId) {
  const connectedAt = isoNow();
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connected",
    authState: "authenticated",
    connectedAt,
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
  });
  useSavedEnvironmentRegistryStore.getState().markConnected(environmentId, connectedAt);
}

function setRuntimeDisconnected(environmentId: EnvironmentId, reason?: string | null) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "disconnected",
    disconnectedAt: isoNow(),
    ...(reason && reason.trim().length > 0
      ? {
          lastError: reason,
          lastErrorAt: isoNow(),
        }
      : {}),
  });
}

function isRelayV2Record(record: SavedEnvironmentRecord | null | undefined): boolean {
  const relay = record?.relay;
  return Boolean(relay && "version" in relay && relay.version === 2);
}

/**
 * Relay ("Connect a device") computers the client should leave alone for a
 * while. Every connect attempt costs the shared free relay allowance, so an
 * offline host is retried slowly, a used-up allowance waits, and a removed
 * device waits until it pairs again. Cleared by an explicit Connect.
 */
const relayHolds = new Map<
  EnvironmentId,
  {
    until: number;
    timer: ReturnType<typeof setTimeout> | null;
    /** While the relay route is held, its direct routes are still tried now and then. */
    probe: ReturnType<typeof setInterval> | null;
  }
>();
const RELAY_HOLD_DIRECT_PROBE_MS = 60_000;
const relayOfflineAttempts = new Map<EnvironmentId, number>();
const RELAY_OFFLINE_RETRY_MS = [30_000, 60_000, 120_000, 300_000] as const;
const RELAY_LIMIT_RETRY_MS = 15 * 60_000;

function isRelayHeld(environmentId: EnvironmentId): boolean {
  const hold = relayHolds.get(environmentId);
  return hold !== undefined && hold.until > Date.now();
}

function clearRelayHold(environmentId: EnvironmentId): void {
  const hold = relayHolds.get(environmentId);
  if (hold?.timer) clearTimeout(hold.timer);
  if (hold?.probe) clearInterval(hold.probe);
  relayHolds.delete(environmentId);
}

function cantReachComputerMessage(label: string): string {
  return `Can't reach ${label}. It may be asleep, off, or offline. Threadlines will connect when it's back.`;
}

interface UnreachableSavedEnvironment {
  readonly attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Direct computers (not relay, not SSH) whose connection could not be made
 * because they did not answer, most often a computer that was asleep when
 * this app started. Each is checked now and then with one unauthenticated
 * request and reconnected as soon as it answers. Relay computers have their
 * own holds; SSH ones wait for the user, since every attempt starts an SSH
 * session.
 */
const unreachableSavedEnvironments = new Map<EnvironmentId, UnreachableSavedEnvironment>();

/** See `SavedEnvironmentRuntimeState.disconnectedByUser`. */
function isDisconnectedByUser(environmentId: EnvironmentId): boolean {
  return (
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.disconnectedByUser === true
  );
}

function liftUserDisconnect(environmentId: EnvironmentId): void {
  if (isDisconnectedByUser(environmentId)) {
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, { disconnectedByUser: false });
  }
}

/** The computer did not answer, which can clear up on its own. */
function isUnreachableConnectFailure(error: unknown): boolean {
  return (
    isRemoteEnvironmentUnreachableError(error) ||
    error instanceof TransportRequestRetriesExhaustedError
  );
}

/**
 * After a connect failed: a direct computer that did not answer is checked
 * again until it does. Any other failure, like a refused or missing
 * credential, waits for the user.
 */
function waitForUnreachableSavedEnvironment(record: SavedEnvironmentRecord, error: unknown): void {
  if (isSavedEnvironmentConnectionCancelledError(error)) {
    return;
  }
  if (
    activeService === null ||
    record.relay ||
    record.desktopSsh ||
    isDisconnectedByUser(record.environmentId) ||
    !isUnreachableConnectFailure(error)
  ) {
    stopWaitingForUnreachableSavedEnvironment(record.environmentId);
    return;
  }
  const previous = unreachableSavedEnvironments.get(record.environmentId);
  scheduleUnreachableSavedEnvironmentCheck(
    record.environmentId,
    previous === undefined ? 0 : previous.attempt + 1,
  );
  setRuntimeDisconnected(record.environmentId, cantReachComputerMessage(record.label));
  useSavedEnvironmentRuntimeStore
    .getState()
    .patch(record.environmentId, { waitingToReconnect: true });
}

function scheduleUnreachableSavedEnvironmentCheck(
  environmentId: EnvironmentId,
  attempt: number,
  delayMs = getWsReconnectDelayMsForRetry(attempt),
): void {
  const previous = unreachableSavedEnvironments.get(environmentId);
  if (previous?.timer) clearTimeout(previous.timer);
  const entry: UnreachableSavedEnvironment = { attempt, timer: null };
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void checkUnreachableSavedEnvironment(environmentId, entry);
  }, delayMs);
  unreachableSavedEnvironments.set(environmentId, entry);
}

function stopWaitingForUnreachableSavedEnvironment(environmentId: EnvironmentId): void {
  const entry = unreachableSavedEnvironments.get(environmentId);
  if (entry === undefined) return;
  if (entry.timer) clearTimeout(entry.timer);
  unreachableSavedEnvironments.delete(environmentId);
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, { waitingToReconnect: false });
}

/**
 * Check every computer waiting to answer right away, starting its backoff
 * over. One whose check is already out is left to finish it.
 */
function checkUnreachableSavedEnvironmentsNow(): void {
  for (const [environmentId, entry] of unreachableSavedEnvironments) {
    if (entry.timer !== null) {
      scheduleUnreachableSavedEnvironmentCheck(environmentId, 0, 0);
    }
  }
}

async function checkUnreachableSavedEnvironment(
  environmentId: EnvironmentId,
  entry: UnreachableSavedEnvironment,
): Promise<void> {
  const isCurrent = () => unreachableSavedEnvironments.get(environmentId) === entry;
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record || environmentConnections.has(environmentId)) {
    if (isCurrent()) stopWaitingForUnreachableSavedEnvironment(environmentId);
    return;
  }
  const answers = await fetchRemoteEnvironmentDescriptor({ httpBaseUrl: record.httpBaseUrl }).then(
    () => true,
    (error: unknown) => !isRemoteEnvironmentUnreachableError(error),
  );
  // Stopped, or rescheduled from elsewhere, while the check was out.
  if (!isCurrent()) return;
  if (!answers) {
    scheduleUnreachableSavedEnvironmentCheck(environmentId, entry.attempt + 1);
    return;
  }
  // It answers, so connect the way Reconnect does. If that still finds it
  // unreachable, the failure schedules the next check.
  await reconnectSavedEnvironment(environmentId).then(
    () => {
      if (isCurrent()) stopWaitingForUnreachableSavedEnvironment(environmentId);
    },
    () => undefined,
  );
}

/**
 * Everything a secure connection to a "Connect a device" computer needs: its
 * pinned key, this device's key, the direct routes it last reported, and the
 * relay route unless that is on hold.
 */
async function resolveSecureRelayTarget(environmentId: EnvironmentId): Promise<SecureRelayTarget> {
  const record = getSavedEnvironmentRecord(environmentId);
  const relay = record?.relay;
  if (!record || !relay || !("version" in relay) || relay.version !== 2 || !relay.hostPublicKey) {
    throw new Error("This computer was connected before encryption and has to be connected again.");
  }
  const credentials = await readRelayDeviceCredentials(environmentId);
  if (!credentials) {
    throw new Error("This computer's keys are missing. Connect it again.");
  }
  return {
    hostId: relay.hostId,
    deviceId: relay.deviceId,
    hostPublicKey: relay.hostPublicKey,
    deviceKey: credentials.deviceKey,
    directRoutes: relay.directRoutes ?? [],
    relay: isRelayHeld(environmentId)
      ? null
      : { url: record.wsBaseUrl, protocols: relayWebSocketProtocols(credentials.deviceSecret) },
  };
}

/** Saves the host's latest direct routes on its record (used from the next connection on). */
async function saveDirectRoutes(
  environmentId: EnvironmentId,
  routes: ReadonlyArray<string>,
): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  const relay = record?.relay;
  if (!record || !relay || !("version" in relay) || relay.version !== 2) return;
  const current = relay.directRoutes ?? [];
  if (
    current.length === routes.length &&
    current.every((route, index) => route === routes[index])
  ) {
    return;
  }
  const next: SavedEnvironmentRecord = {
    ...record,
    relay: { ...relay, directRoutes: [...routes] },
  };
  await persistSavedEnvironmentRecord(next);
  useSavedEnvironmentRegistryStore.getState().upsert(next);
}

function holdRelayEnvironment(environmentId: EnvironmentId, delayMs: number, reason: string): void {
  clearRelayHold(environmentId);
  const timer = Number.isFinite(delayMs)
    ? setTimeout(() => {
        relayHolds.delete(environmentId);
        if (getSavedEnvironmentRecord(environmentId)) {
          void reconnectSavedEnvironment(environmentId).catch(() => undefined);
        }
      }, delayMs)
    : null;
  // A held relay route doesn't stop a computer on the same network: keep
  // checking its direct routes and come back as soon as one answers.
  const record = getSavedEnvironmentRecord(environmentId);
  const hasDirectRoutes =
    record?.relay !== undefined &&
    "version" in record.relay &&
    record.relay.version === 2 &&
    (record.relay.directRoutes?.length ?? 0) > 0;
  const probe = hasDirectRoutes
    ? setInterval(() => {
        void resolveSecureRelayTarget(environmentId)
          .then((target) => probeDirectRoutes(target))
          .then((route) => {
            if (!route || !relayHolds.has(environmentId)) return;
            clearRelayHold(environmentId);
            void reconnectSavedEnvironment(environmentId).catch(() => undefined);
          })
          .catch(() => undefined);
      }, RELAY_HOLD_DIRECT_PROBE_MS)
    : null;
  relayHolds.set(environmentId, { until: Date.now() + delayMs, timer, probe });
  void disconnectSavedEnvironment(environmentId)
    .catch(() => undefined)
    .then(() => {
      setRuntimeDisconnected(environmentId, reason);
    });
}

/** Maps a relay v2 close code to what the client does next. Returns true if handled. */
function handleRelayV2Close(environmentId: EnvironmentId, code: number): boolean {
  const label = getSavedEnvironmentRecord(environmentId)?.label ?? "That computer";
  switch (code) {
    case RELAY_CLOSE_CODE_ACCESS_REMOVED:
      holdRelayEnvironment(
        environmentId,
        Number.POSITIVE_INFINITY,
        `${label} removed this computer's access. Connect again with a new code.`,
      );
      useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
        authState: "requires-auth",
        role: null,
      });
      return true;
    case RELAY_CLOSE_CODE_DAILY_LIMIT:
      holdRelayEnvironment(
        environmentId,
        RELAY_LIMIT_RETRY_MS,
        `Today's relay allowance for ${label} is used up. It resets at midnight UTC. On the same network? Turn on Same network on that computer for unlimited use.`,
      );
      return true;
    case RELAY_CLOSE_CODE_RELAY_BUSY:
      holdRelayEnvironment(
        environmentId,
        RELAY_LIMIT_RETRY_MS,
        "The relay is busy today. Threadlines will try again later.",
      );
      return true;
    case RELAY_CLOSE_CODE_HOST_OFFLINE:
    case SECURE_CLOSE_CODE_NO_ROUTE: {
      const attempt = relayOfflineAttempts.get(environmentId) ?? 0;
      relayOfflineAttempts.set(environmentId, attempt + 1);
      holdRelayEnvironment(
        environmentId,
        RELAY_OFFLINE_RETRY_MS[Math.min(attempt, RELAY_OFFLINE_RETRY_MS.length - 1)]!,
        cantReachComputerMessage(label),
      );
      return true;
    }
    case SECURE_CLOSE_CODE_PROTOCOL: {
      // A broken or tampered connection; retrying at once would only spend
      // the relay allowance on the same failure.
      const attempt = relayOfflineAttempts.get(environmentId) ?? 0;
      relayOfflineAttempts.set(environmentId, attempt + 1);
      holdRelayEnvironment(
        environmentId,
        RELAY_OFFLINE_RETRY_MS[Math.min(attempt, RELAY_OFFLINE_RETRY_MS.length - 1)]!,
        `The secure connection to ${label} failed. Threadlines will try again shortly.`,
      );
      return true;
    }
    case RELAY_CLOSE_CODE_REPLACED:
      holdRelayEnvironment(
        environmentId,
        Number.POSITIVE_INFINITY,
        `This computer connected to ${label} from another window.`,
      );
      return true;
    default:
      return false;
  }
}

function setRuntimeError(environmentId: EnvironmentId, error: unknown) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "error",
    ...getRuntimeErrorFields(error),
  });
}

function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          // Only the write that created the message carries its stamps.
          ...(previous.payload.agentModels !== undefined
            ? { agentModels: previous.payload.agentModels }
            : {}),
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

function syncProjectUiFromStore() {
  const projects = selectProjectsAcrossEnvironments(useStore.getState());
  const clientSettings = getClientSettings();
  useUiStateStore.getState().syncProjects(
    projects.map((project) => ({
      key: derivePhysicalProjectKey(project),
      logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
      cwd: project.cwd,
    })),
  );
}

function syncThreadUiFromStore() {
  const appState = useStore.getState();
  const threads = selectThreadsAcrossEnvironments(appState);
  useUiStateStore.getState().syncThreads(
    threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      seedVisitedAt: thread.updatedAt ?? thread.createdAt,
      serverLastSeenAt: thread.lastSeenAt,
      serverDoneOverrideAt: thread.doneOverride?.at ?? null,
    })),
    {
      // A remote computer still connecting has not listed its threads yet;
      // its saved choices wait for it.
      loadedEnvironmentIds: new Set(
        Object.entries(appState.environmentStateById)
          .filter(([, environmentState]) => environmentState.bootstrapComplete)
          .map(([environmentId]) => environmentId),
      ),
    },
  );
  markPromotedDraftThreadsByRef(
    threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
  );
}

function reconcileSnapshotDerivedState() {
  syncProjectUiFromStore();
  syncThreadUiFromStore();

  const threads = selectThreadsAcrossEnvironments(useStore.getState());
  const activeThreadKeys = collectActiveTerminalThreadIds({
    snapshotThreads: threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      deletedAt: null,
      archivedAt: thread.archivedAt,
    })),
    draftThreadKeys: useComposerDraftStore.getState().listDraftThreadKeys(),
  });
  useTerminalStateStore.getState().removeOrphanedTerminalStates(activeThreadKeys);
}

export function shouldApplyTerminalEvent(input: {
  serverThreadArchivedAt: string | null | undefined;
  hasDraftThread: boolean;
}): boolean {
  if (input.serverThreadArchivedAt !== undefined) {
    return input.serverThreadArchivedAt === null;
  }

  return input.hasDraftThread;
}

function applyRecoveredEventBatch(
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
) {
  if (events.length === 0) {
    return;
  }

  const batchEffects = deriveOrchestrationBatchEffects(events);
  const uiEvents = coalesceOrchestrationUiEvents(events);
  const needsProjectUiSync = events.some(
    (event) =>
      event.type === "project.created" ||
      event.type === "project.meta-updated" ||
      event.type === "project.deleted",
  );

  if (batchEffects.needsProviderInvalidation) {
    needsProviderInvalidation = true;
    void activeService?.queryInvalidationThrottler.maybeExecute();
  }
  if (batchEffects.needsPullRequestInvalidation) {
    needsPullRequestInvalidation = true;
    void activeService?.queryInvalidationThrottler.maybeExecute();
  }

  useStore.getState().applyOrchestrationEvents(uiEvents, environmentId);
  if (needsProjectUiSync) {
    const projects = selectProjectsAcrossEnvironments(useStore.getState());
    const clientSettings = getClientSettings();
    useUiStateStore.getState().syncProjects(
      projects.map((project) => ({
        key: derivePhysicalProjectKey(project),
        logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
        cwd: project.cwd,
      })),
    );
  }

  const needsThreadUiSync = events.some(
    (event) =>
      event.type === "thread.created" ||
      event.type === "thread.deleted" ||
      // Retires the optimistic overlay these events confirm or supersede.
      event.type === "thread.seen-set" ||
      event.type === "thread.done-override-set",
  );
  if (needsThreadUiSync) {
    syncThreadUiFromStore();
  }

  const draftStore = useComposerDraftStore.getState();
  for (const threadId of batchEffects.promoteDraftThreadIds) {
    markPromotedDraftThreadByRef(scopeThreadRef(environmentId, threadId));
  }
  for (const threadId of batchEffects.clearDeletedThreadIds) {
    const threadRef = scopeThreadRef(environmentId, threadId);
    useOptimisticThreadMessagesStore.getState().clearThread(threadRef);
    draftStore.clearDraftThread(threadRef);
    useUiStateStore.getState().clearThreadUi(scopedThreadKey(threadRef));
  }
  for (const event of events) {
    if (event.type === "project.deleted") {
      draftStore.clearProjectDraftThreadId(scopeProjectRef(environmentId, event.payload.projectId));
    }
  }
  for (const threadId of batchEffects.removeTerminalStateThreadIds) {
    useTerminalStateStore.getState().removeTerminalState(scopeThreadRef(environmentId, threadId));
  }

  threadDetails.reconcileEvictionForEnvironment(environmentId);
}

export function applyEnvironmentThreadDetailEvent(
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
) {
  applyRecoveredEventBatch([event], environmentId);
}

function applyShellEvent(event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) {
  if (
    !shouldApplyProjectionEvent({
      current: readLastAppliedProjectionVersion(environmentId),
      sequence: event.sequence,
    })
  ) {
    return;
  }

  const threadId =
    event.kind === "thread-upserted"
      ? event.thread.id
      : event.kind === "thread-removed"
        ? event.threadId
        : null;
  const threadRef = threadId ? scopeThreadRef(environmentId, threadId) : null;
  const previousThread = threadRef ? selectThreadByRef(useStore.getState(), threadRef) : undefined;

  useStore.getState().applyShellEvent(event, environmentId);
  markAppliedProjectionEvent(environmentId, event.sequence);

  switch (event.kind) {
    case "project-upserted":
    case "project-removed":
      syncProjectUiFromStore();
      return;
    case "thread-upserted":
      syncThreadUiFromStore();
      settleComposerPullRequestDismissals({
        environmentId,
        threadId: event.thread.id,
        sequence: event.sequence,
      });
      if (!previousThread && threadRef) {
        markPromotedDraftThreadByRef(threadRef);
      }
      threadDetails.warmNonIdle(environmentId, [event.thread]);
      if (previousThread?.archivedAt === null && event.thread.archivedAt !== null && threadRef) {
        useTerminalStateStore.getState().removeTerminalState(threadRef);
      }
      // The shell carries every thread, including ones with no detail stream
      // open, so a server-held merge that ends off screen is seen here too.
      if (serverMergeSwitchTurnedOff(previousThread, event.thread)) {
        needsPullRequestInvalidation = true;
        void activeService?.queryInvalidationThrottler.maybeExecute();
      }
      threadDetails.reconcileEvictionForThread(environmentId, event.thread.id);
      threadDetails.evictIdleToCapacity();
      return;
    case "thread-removed":
      settleComposerPullRequestDismissals({
        environmentId,
        threadId: event.threadId,
        sequence: event.sequence,
        removed: true,
      });
      if (threadRef) {
        threadDetails.disposeThread(environmentId, threadRef.threadId);
        useOptimisticThreadMessagesStore.getState().clearThread(threadRef);
        useComposerDraftStore.getState().clearDraftThread(threadRef);
        useUiStateStore.getState().clearThreadUi(scopedThreadKey(threadRef));
        useTerminalStateStore.getState().removeTerminalState(threadRef);
      }
      syncThreadUiFromStore();
      return;
  }
}

function createEnvironmentConnectionHandlers() {
  return {
    applyShellEvent,
    syncShellSnapshot: (snapshot: OrchestrationShellSnapshot, environmentId: EnvironmentId) => {
      if (
        shouldApplyProjectionSnapshot({
          current: readLastAppliedProjectionVersion(environmentId),
          next: snapshot,
        })
      ) {
        useStore.getState().syncServerShellSnapshot(snapshot, environmentId);
        markAppliedProjectionSnapshot(environmentId, snapshot);
        settleComposerPullRequestDismissals({
          environmentId,
          sequence: snapshot.snapshotSequence,
        });
        threadDetails.warmNonIdle(environmentId, snapshot.threads);
        threadDetails.reconcileForEnvironment(
          environmentId,
          snapshot.threads.map((thread) => thread.id),
        );
        threadDetails.noteShellLoaded(environmentId);
        threadDetails.reconcileEvictionForEnvironment(environmentId);
        reconcileSnapshotDerivedState();
        // Deferred inside; the first snapshot is what makes the environment's
        // threads (and their server-held lifecycle state) knowable.
        migrateLegacyInboxStateForEnvironment(environmentId);
      }
      // Any thread list means the environment is answering, including one
      // that carries nothing new after a reconnect.
      resendUndeliveredThreadSeen(environmentId);
    },
    applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => {
      const threadRef = scopeThreadRef(environmentId, ThreadId.make(event.threadId));
      const serverThread = selectThreadByRef(useStore.getState(), threadRef);
      const hasDraftThread =
        useComposerDraftStore.getState().getDraftThreadByRef(threadRef) !== null;
      if (
        !shouldApplyTerminalEvent({
          serverThreadArchivedAt: serverThread?.archivedAt,
          hasDraftThread,
        })
      ) {
        return;
      }
      useTerminalStateStore.getState().applyTerminalEvent(threadRef, event);
    },
  };
}

function createPrimaryEnvironmentClient(
  knownEnvironment: ReturnType<typeof getPrimaryKnownEnvironment>,
) {
  const wsBaseUrl = getKnownEnvironmentWsBaseUrl(knownEnvironment);
  if (!wsBaseUrl) {
    throw new Error(
      `Unable to resolve websocket URL for ${knownEnvironment?.label ?? "primary environment"}.`,
    );
  }
  const connectionLabel = knownEnvironment?.label ?? null;

  return createWsRpcClient(
    new WsTransport(wsBaseUrl, {
      getConnectionLabel: () => connectionLabel,
      getVersionMismatchHint: () =>
        resolveServerConfigVersionMismatch(getServerConfig())?.hint ?? null,
    }),
  );
}

function createSavedEnvironmentClient(
  environmentId: EnvironmentId,
  bearerToken: string,
): WsRpcClient {
  useSavedEnvironmentRuntimeStore.getState().ensure(environmentId);
  const isRelay = Boolean(getSavedEnvironmentRecord(environmentId)?.relay);
  const isSecureRelay = isRelayV2Record(getSavedEnvironmentRecord(environmentId));

  return createWsRpcClient(
    new WsTransport(
      async () => {
        const record = getSavedEnvironmentRecord(environmentId);
        if (!record) {
          throw new Error(`Saved environment ${environmentId} not found.`);
        }
        if (record.relay) {
          return record.wsBaseUrl;
        }
        return record.desktopSsh
          ? await resolveDesktopSshWebSocketConnectionUrl(
              record.wsBaseUrl,
              record.httpBaseUrl,
              bearerToken,
            )
          : await resolveRemoteWebSocketConnectionUrl({
              wsBaseUrl: record.wsBaseUrl,
              httpBaseUrl: record.httpBaseUrl,
              bearerToken,
            });
      },
      {
        getConnectionLabel: () => getSavedEnvironmentRecord(environmentId)?.label ?? null,
        getVersionMismatchHint: () =>
          resolveServerConfigVersionMismatch(
            useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig,
          )?.hint ?? null,
        onAttempt: () => {
          setRuntimeConnecting(environmentId);
        },
        onOpen: () => {
          // A secure connection only opens once the computer itself answered
          // the handshake, so it is connected now.
          if (isSecureRelay) {
            relayOfflineAttempts.delete(environmentId);
            setRuntimeConnected(environmentId);
            return;
          }
          // The relay accepts device sockets whether or not the desktop is
          // bridged behind it, so an open relay socket proves nothing about
          // the desktop. Stay "connecting" until the first inbound frame —
          // in raw mode the relay only forwards desktop frames to devices.
          if (isRelay) {
            setRuntimeConnecting(environmentId);
            return;
          }
          setRuntimeConnected(environmentId);
        },
        onFirstMessage: () => {
          if (isRelay) {
            relayOfflineAttempts.delete(environmentId);
            setRuntimeConnected(environmentId);
          }
        },
        onError: (message: string) => {
          const mismatch = resolveServerConfigVersionMismatch(
            useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig,
          );
          useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
            connectionState: "error",
            lastError: appendVersionMismatchHint(message, mismatch),
            lastErrorAt: isoNow(),
          });
        },
        onClose: (
          details: { readonly code: number; readonly reason: string },
          context: WsProtocolCloseContext,
        ) => {
          if (context.intentional) {
            return;
          }
          if (
            isRelayV2Record(getSavedEnvironmentRecord(environmentId)) &&
            handleRelayV2Close(environmentId, details.code)
          ) {
            return;
          }
          if (
            details.code === RELAY_CLOSE_CODE_SESSION_EXPIRED &&
            getSavedEnvironmentRecord(environmentId)?.relay
          ) {
            // The relay deleted the session; reconnecting can never succeed.
            void markRelaySavedEnvironmentLinkExpired(environmentId);
            return;
          }
          if (
            details.code === RELAY_CLOSE_CODE_PEER_UNAVAILABLE &&
            getSavedEnvironmentRecord(environmentId)?.relay
          ) {
            // The relay closes device sockets when the far end of the pipe goes
            // away; surface that instead of the raw close reason.
            setRuntimeDisconnected(
              environmentId,
              isRelayV2Record(getSavedEnvironmentRecord(environmentId))
                ? "Reconnecting to the other computer."
                : "The desktop app is not connected to the relay.",
            );
            return;
          }
          setRuntimeDisconnected(
            environmentId,
            appendVersionMismatchHint(
              details.reason,
              resolveServerConfigVersionMismatch(
                useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig,
              ),
            ),
          );
        },
      },
      isSecureRelay
        ? {
            preservePath: true,
            openTimeoutMs: SECURE_OPEN_TIMEOUT_MS,
            secureSocket: (socketUrl) =>
              new SecureRelaySocket(socketUrl, {
                resolveTarget: () => resolveSecureRelayTarget(environmentId),
                onRoute: (route) =>
                  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, { route }),
              }),
          }
        : isRelay
          ? {
              preservePath: true,
              protocols: relayWebSocketProtocols(bearerToken),
              chunkFrames: true,
            }
          : undefined,
    ),
  );
}

async function refreshSavedEnvironmentMetadata(
  environmentId: EnvironmentId,
  bearerToken: string,
  client: WsRpcClient,
  roleHint?: AuthSessionRole | null,
  configHint?: ServerConfig | null,
): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new Error(`Saved environment ${environmentId} not found.`);
  }

  if (record.relay) {
    const serverConfig = configHint ?? (await client.server.getConfig());
    useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
      authState: "authenticated",
      descriptor: serverConfig.environment,
      serverConfig,
      // Old phone links rode the desktop's own owner session; devices that
      // joined with a code get their own client session.
      role: roleHint ?? (isRelayV2Record(record) ? "client" : "owner"),
    });
    if (isRelayV2Record(record)) {
      // Where to reach the computer without the relay next time. Older
      // servers don't have this; their computers just stay on the relay.
      void client.relay
        .directRoutes()
        .then(({ routes }) => saveDirectRoutes(record.environmentId, routes))
        .catch(() => undefined);
    }
    useSavedEnvironmentRegistryStore
      .getState()
      .rename(record.environmentId, serverConfig.environment.label);
    return;
  }

  const [serverConfig, sessionState] = await Promise.all([
    configHint ? Promise.resolve(configHint) : client.server.getConfig(),
    record.desktopSsh
      ? fetchDesktopSshSessionState(record.httpBaseUrl, bearerToken)
      : fetchRemoteSessionState({
          httpBaseUrl: record.httpBaseUrl,
          bearerToken,
        }),
  ]);

  useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
    authState: sessionState.authenticated ? "authenticated" : "requires-auth",
    descriptor: serverConfig.environment,
    serverConfig,
    role: sessionState.authenticated ? (sessionState.role ?? roleHint ?? null) : null,
  });
  useSavedEnvironmentRegistryStore
    .getState()
    .rename(record.environmentId, serverConfig.environment.label);
}

function registerConnection(connection: EnvironmentConnection): EnvironmentConnection {
  const existing = environmentConnections.get(connection.environmentId);
  if (existing && existing !== connection) {
    throw new Error(`Environment ${connection.environmentId} already has an active connection.`);
  }
  environmentConnections.set(connection.environmentId, connection);
  if (connection.kind === "saved") {
    stopWaitingForUnreachableSavedEnvironment(connection.environmentId);
    liftUserDisconnect(connection.environmentId);
  }
  threadDetails.attachForEnvironment(connection.environmentId);
  emitEnvironmentConnectionRegistryChange();
  return connection;
}

async function removeConnection(environmentId: EnvironmentId): Promise<boolean> {
  const connection = environmentConnections.get(environmentId);
  if (!connection) {
    return false;
  }

  lastAppliedProjectionVersionByEnvironment.delete(environmentId);
  environmentConnections.delete(environmentId);
  emitEnvironmentConnectionRegistryChange();
  threadDetails.detachForEnvironment(environmentId);
  await connection.dispose();
  return true;
}

function createPrimaryEnvironmentConnection(): EnvironmentConnection {
  const knownEnvironment = getPrimaryKnownEnvironment();
  if (!knownEnvironment?.environmentId) {
    throw new Error("Unable to resolve the primary environment.");
  }

  const existing = environmentConnections.get(knownEnvironment.environmentId);
  if (existing) {
    return existing;
  }

  return registerConnection(
    createEnvironmentConnection({
      kind: "primary",
      knownEnvironment,
      client: createPrimaryEnvironmentClient(knownEnvironment),
      ...createEnvironmentConnectionHandlers(),
    }),
  );
}

function maybeCreatePrimaryEnvironmentConnection(): EnvironmentConnection | null {
  return getPrimaryKnownEnvironment()?.environmentId ? createPrimaryEnvironmentConnection() : null;
}

async function ensureSavedEnvironmentConnection(
  record: SavedEnvironmentRecord,
  options?: {
    readonly client?: WsRpcClient;
    readonly bearerToken?: string;
    readonly role?: AuthSessionRole | null;
    readonly serverConfig?: ServerConfig | null;
  },
): Promise<EnvironmentConnection> {
  const existing = environmentConnections.get(record.environmentId);
  if (existing) {
    return existing;
  }

  const pending = pendingSavedEnvironmentConnections.get(record.environmentId);
  if (pending) {
    return pending.promise;
  }

  if (isPendingRelayJoin(record)) {
    throw new Error("This computer is still waiting to be allowed.");
  }

  const pendingEntry: PendingSavedEnvironmentConnection = {
    cancelled: false,
    promise: Promise.resolve().then(async () => {
      let activeRecord = record;
      let roleHint = options?.role ?? null;
      let bearerToken =
        options?.bearerToken ?? (await readSavedEnvironmentBearerToken(record.environmentId));
      if (!bearerToken) {
        if (record.relay) {
          useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
            authState: "requires-auth",
            role: null,
            connectionState: "disconnected",
            lastError: isRelayV2Record(record)
              ? `This computer's key for ${record.label} is missing. Connect again with a new code.`
              : RELAY_LINK_EXPIRED_MESSAGE,
            lastErrorAt: isoNow(),
          });
          throw new Error("Saved relay connection is missing its device token.");
        } else if (record.desktopSsh) {
          const issued = await issueDesktopSshBearerSession(record);
          activeRecord = issued.record;
          bearerToken = issued.bearerToken;
          roleHint = issued.role;
        } else {
          useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
            authState: "requires-auth",
            role: null,
            connectionState: "disconnected",
            lastError: "Saved environment is missing its saved credential. Pair it again.",
            lastErrorAt: isoNow(),
          });
          throw new Error("Saved environment is missing its saved credential.");
        }
      } else {
        const prepared = await prepareSavedEnvironmentRecordForConnection(record);
        activeRecord = prepared.record;
      }

      const activeBearerToken = bearerToken;
      const client =
        options?.client ??
        createSavedEnvironmentClient(activeRecord.environmentId, activeBearerToken);
      const initialConfigSnapshot = createDeferredPromise<ServerConfig>();
      const knownEnvironment = createKnownEnvironment({
        id: activeRecord.environmentId,
        label: activeRecord.label,
        source: "manual",
        target: {
          httpBaseUrl: activeRecord.httpBaseUrl,
          wsBaseUrl: activeRecord.wsBaseUrl,
        },
      });
      const connection = createEnvironmentConnection({
        kind: "saved",
        knownEnvironment: {
          ...knownEnvironment,
          environmentId: activeRecord.environmentId,
        },
        client,
        refreshMetadata: async () => {
          await refreshSavedEnvironmentMetadata(
            activeRecord.environmentId,
            activeBearerToken,
            client,
          );
        },
        onConfigEvent: (event) => {
          if (event.type === "snapshot") {
            initialConfigSnapshot.resolve(event.config);
            useSavedEnvironmentRuntimeStore.getState().patch(activeRecord.environmentId, {
              descriptor: event.config.environment,
              serverConfig: event.config,
            });
            return;
          }
          const currentConfig =
            useSavedEnvironmentRuntimeStore.getState().byId[activeRecord.environmentId]
              ?.serverConfig ?? null;
          const nextConfig = applyServerConfigStreamEvent(currentConfig, event);
          if (!nextConfig) {
            return;
          }
          useSavedEnvironmentRuntimeStore
            .getState()
            .patch(activeRecord.environmentId, { serverConfig: nextConfig });
        },
        onWelcome: (payload) => {
          useSavedEnvironmentRuntimeStore.getState().patch(activeRecord.environmentId, {
            descriptor: payload.environment,
          });
        },
        ...createEnvironmentConnectionHandlers(),
      });

      try {
        try {
          const initialServerConfig =
            options?.serverConfig ??
            (await waitForConfigSnapshot(
              initialConfigSnapshot.promise,
              INITIAL_SERVER_CONFIG_SNAPSHOT_WAIT_MS,
            ));
          await refreshSavedEnvironmentMetadata(
            activeRecord.environmentId,
            activeBearerToken,
            client,
            roleHint,
            initialServerConfig,
          );
        } catch (error) {
          const isAuthError = activeRecord.desktopSsh
            ? isSshHttpAuthError(error, 401)
            : isRemoteEnvironmentAuthHttpError(error) && error.status === 401;
          if (!isAuthError) {
            throw error;
          }
          if (!activeRecord.desktopSsh) {
            await removeSavedEnvironmentBearerToken(activeRecord.environmentId);
            throw new Error("Saved environment credential expired. Pair it again.", {
              cause: error,
            });
          }

          const issued = await issueDesktopSshBearerSession(activeRecord);
          activeRecord = issued.record;
          bearerToken = issued.bearerToken;
          roleHint = issued.role;
          await connection.dispose().catch(() => undefined);
          pendingSavedEnvironmentConnections.delete(activeRecord.environmentId);
          return await ensureSavedEnvironmentConnection(activeRecord, {
            bearerToken,
            role: roleHint,
            serverConfig: options?.serverConfig ?? null,
          });
        }
        if (
          pendingEntry.cancelled ||
          pendingSavedEnvironmentConnections.get(activeRecord.environmentId) !== pendingEntry
        ) {
          await connection.dispose().catch(() => undefined);
          throw new SavedEnvironmentConnectionCancelledError(activeRecord.environmentId);
        }
        registerConnection(connection);
        return connection;
      } catch (error) {
        if (error instanceof SavedEnvironmentConnectionCancelledError) {
          throw error;
        }
        if (!pendingEntry.cancelled) {
          setRuntimeError(activeRecord.environmentId, error);
        }
        // Only this attempt's own connection: a newer attempt may have
        // connected the computer in the meantime.
        const removed =
          environmentConnections.get(activeRecord.environmentId) === connection &&
          (await removeConnection(activeRecord.environmentId).catch(() => false));
        if (!removed) {
          await connection.dispose().catch(() => undefined);
        }
        // Disconnected while this attempt was out or cleaning up, so its
        // failure no longer says anything about the computer.
        if (pendingEntry.cancelled) {
          throw new SavedEnvironmentConnectionCancelledError(activeRecord.environmentId);
        }
        throw error;
      }
    }),
  };

  pendingSavedEnvironmentConnections.set(record.environmentId, pendingEntry);
  return await pendingEntry.promise.finally(() => {
    if (pendingSavedEnvironmentConnections.get(record.environmentId) === pendingEntry) {
      pendingSavedEnvironmentConnections.delete(record.environmentId);
    }
  });
}

async function syncSavedEnvironmentConnections(
  records: ReadonlyArray<SavedEnvironmentRecord>,
): Promise<void> {
  const expectedEnvironmentIds = new Set(records.map((record) => record.environmentId));
  const staleEnvironmentIds = [...environmentConnections.values()]
    .filter((connection) => connection.kind === "saved")
    .map((connection) => connection.environmentId)
    .filter((environmentId) => !expectedEnvironmentIds.has(environmentId));

  await Promise.all(
    staleEnvironmentIds.map((environmentId) => disconnectSavedEnvironment(environmentId)),
  );
  await Promise.all(
    records
      .filter(
        (record) =>
          !isPendingRelayJoin(record) &&
          !isRelayHeld(record.environmentId) &&
          !unreachableSavedEnvironments.has(record.environmentId) &&
          !isDisconnectedByUser(record.environmentId),
      )
      .map((record) =>
        ensureSavedEnvironmentConnection(record).catch((error: unknown) =>
          waitForUnreachableSavedEnvironment(record, error),
        ),
      ),
  );
}

function stopActiveService() {
  activeService?.stop();
  activeService = null;
}

function reconnectEnvironmentConnectionsAfterBrowserResume(reason: string): void {
  const now = Date.now();
  if (now - lastBrowserResumeReconnectAt < BROWSER_RESUME_RECONNECT_COOLDOWN_MS) {
    return;
  }
  checkUnreachableSavedEnvironmentsNow();

  for (const connection of environmentConnections.values()) {
    if (connection.client.isHeartbeatFresh()) {
      continue;
    }
    lastBrowserResumeReconnectAt = now;
    void connection.reconnect().catch((error) => {
      console.warn("Environment reconnect after browser resume failed", {
        environmentId: connection.environmentId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

function subscribeBrowserResumeReconnects(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return NOOP;
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      lastBrowserHiddenAt = Date.now();
      return;
    }
    if (document.visibilityState === "visible" && lastBrowserHiddenAt !== null) {
      lastBrowserHiddenAt = null;
      reconnectEnvironmentConnectionsAfterBrowserResume("visibilitychange");
    }
  };

  const handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted || lastBrowserHiddenAt !== null) {
      lastBrowserHiddenAt = null;
      reconnectEnvironmentConnectionsAfterBrowserResume("pageshow");
    }
  };

  // Back on a network: a computer that was out of reach may answer now.
  const handleOnline = () => checkUnreachableSavedEnvironmentsNow();

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("online", handleOnline);
  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pageshow", handlePageShow);
    window.removeEventListener("online", handleOnline);
  };
}

export function subscribeEnvironmentConnections(listener: () => void): () => void {
  environmentConnectionListeners.add(listener);
  return () => {
    environmentConnectionListeners.delete(listener);
  };
}

export function listEnvironmentConnections(): ReadonlyArray<EnvironmentConnection> {
  return [...environmentConnections.values()];
}

export function readEnvironmentConnection(
  environmentId: EnvironmentId,
): EnvironmentConnection | null {
  return environmentConnections.get(environmentId) ?? null;
}

export function requireEnvironmentConnection(environmentId: EnvironmentId): EnvironmentConnection {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    throw new Error(`No websocket client registered for environment ${environmentId}.`);
  }
  return connection;
}

export function getPrimaryEnvironmentConnection(): EnvironmentConnection {
  return createPrimaryEnvironmentConnection();
}

/**
 * The connection that answers app-level ("this computer") backend calls.
 *
 * Desktop and self-hosted builds serve the app from their own backend, so that
 * is the primary environment. The hosted app has no backend of its own — a
 * phone opens it and pairs with a computer — so the environment the user is
 * looking at stands in as the backend for settings, providers, and extensions.
 */
export function readBackendEnvironmentConnection(): EnvironmentConnection | null {
  if (getPrimaryKnownEnvironment()?.environmentId) {
    return createPrimaryEnvironmentConnection();
  }
  const activeEnvironmentId = useStore.getState().activeEnvironmentId;
  return activeEnvironmentId ? readEnvironmentConnection(activeEnvironmentId) : null;
}

export async function disconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const wasWaiting = unreachableSavedEnvironments.has(environmentId);
  stopWaitingForUnreachableSavedEnvironment(environmentId);
  const record = getSavedEnvironmentRecord(environmentId);
  const pendingConnection = pendingSavedEnvironmentConnections.get(environmentId);
  if (pendingConnection) {
    pendingConnection.cancelled = true;
    pendingSavedEnvironmentConnections.delete(environmentId);
  }
  const connection = environmentConnections.get(environmentId);

  if (connection?.kind === "saved") {
    await removeConnection(environmentId).catch(() => false);
  }
  setRuntimeDisconnected(environmentId);
  if (wasWaiting) {
    // It no longer connects when it's back, so stop saying it will.
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      lastError: null,
      lastErrorAt: null,
    });
  }

  if (record?.desktopSsh && typeof window !== "undefined") {
    await window.desktopBridge?.disconnectSshEnvironment(record.desktopSsh);
    await removeSavedEnvironmentBearerToken(environmentId);
  }
}

/**
 * Disconnect, or Stop trying, from Settings: disconnect and stay disconnected
 * until the user connects it again, instead of being picked up by the next
 * sync or check.
 */
export async function disconnectSavedEnvironmentByUser(
  environmentId: EnvironmentId,
): Promise<void> {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, { disconnectedByUser: true });
  clearRelayHold(environmentId);
  await disconnectSavedEnvironment(environmentId);
}

export async function reconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new Error("Saved environment not found.");
  }
  liftUserDisconnect(environmentId);
  clearRelayHold(environmentId);

  const connection = environmentConnections.get(environmentId);
  if (!connection) {
    setRuntimeConnecting(environmentId);
    try {
      await ensureSavedEnvironmentConnection(record);
      return;
    } catch (error) {
      if (isSavedEnvironmentConnectionCancelledError(error)) {
        return;
      }
      setRuntimeError(environmentId, error);
      waitForUnreachableSavedEnvironment(record, error);
      throw error;
    }
  }

  setRuntimeConnecting(environmentId);
  try {
    if (record.desktopSsh) {
      await prepareSavedEnvironmentRecordForConnection(record);
    }
    await connection.reconnect();
  } catch (error) {
    if (record.desktopSsh) {
      try {
        const issued = await issueDesktopSshBearerSession(
          getSavedEnvironmentRecord(environmentId) ?? record,
        );
        await removeConnection(environmentId).catch(() => false);
        await ensureSavedEnvironmentConnection(issued.record, {
          bearerToken: issued.bearerToken,
          role: issued.role,
        });
        return;
      } catch (recoveryError) {
        if (isSavedEnvironmentConnectionCancelledError(recoveryError)) {
          return;
        }
        setRuntimeError(environmentId, recoveryError);
        throw recoveryError;
      }
    }
    setRuntimeError(environmentId, error);
    throw error;
  }
}

export async function removeSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  clearRelayHold(environmentId);
  relayOfflineAttempts.delete(environmentId);
  await disconnectSavedEnvironment(environmentId);
  threadDetails.disposeForEnvironment(environmentId);
  useSavedEnvironmentRegistryStore.getState().remove(environmentId);
  useSavedEnvironmentRuntimeStore.getState().clear(environmentId);
  useStore.getState().removeEnvironmentState(environmentId);
  await removeSavedEnvironmentBearerToken(environmentId);
}

type ResolvedRelayPairingTarget = Extract<
  ReturnType<typeof resolveRemotePairingTarget>,
  { readonly kind: "relay" }
>;

async function addRelaySavedEnvironment(input: {
  readonly label: string;
  readonly target: ResolvedRelayPairingTarget;
}): Promise<SavedEnvironmentRecord> {
  const client = createWsRpcClient(
    new WsTransport(
      input.target.wsBaseUrl,
      {
        getConnectionLabel: () => input.label.trim() || "Desktop app",
      },
      {
        preservePath: true,
        protocols: relayWebSocketProtocols(input.target.credential),
        chunkFrames: true,
      },
    ),
  );
  let connectionRegistered = false;

  try {
    const serverConfig = await client.server.getConfig();
    const descriptor = serverConfig.environment;
    const environmentId = descriptor.environmentId;
    const registrySnapshot = snapshotSavedEnvironmentRegistry([environmentId]);
    const existingRecord = getSavedEnvironmentRecord(environmentId);
    const record: SavedEnvironmentRecord = {
      environmentId,
      label: input.label.trim() || existingRecord?.label || descriptor.label,
      wsBaseUrl: input.target.wsBaseUrl,
      httpBaseUrl: input.target.httpBaseUrl,
      createdAt: existingRecord?.createdAt ?? isoNow(),
      lastConnectedAt: isoNow(),
      relay: {
        relayOrigin: input.target.relayOrigin,
        sessionId: input.target.sessionId,
      },
    };

    await persistSavedEnvironmentRecord(record);
    const didPersistRelayToken = await writeSavedEnvironmentBearerToken(
      environmentId,
      input.target.credential,
    );
    if (!didPersistRelayToken) {
      await persistSavedEnvironmentRegistryRollback(registrySnapshot);
      throw new Error("Unable to persist mobile connection credentials.");
    }

    useSavedEnvironmentRegistryStore.getState().upsert(record);
    await removeConnection(environmentId).catch(() => false);
    await ensureSavedEnvironmentConnection(record, {
      bearerToken: input.target.credential,
      role: "owner",
      serverConfig,
      client,
    });
    connectionRegistered = true;
    return record;
  } catch (error) {
    if (!connectionRegistered) {
      await client.dispose().catch(() => undefined);
    }
    throw error;
  }
}

export async function addSavedEnvironment(input: {
  readonly label: string;
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  readonly desktopSsh?: DesktopSshEnvironmentTarget;
}): Promise<SavedEnvironmentRecord> {
  const resolvedTarget = resolveRemotePairingTarget({
    ...(input.pairingUrl !== undefined ? { pairingUrl: input.pairingUrl } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.pairingCode !== undefined ? { pairingCode: input.pairingCode } : {}),
  });
  if (resolvedTarget.kind === "relay") {
    return addRelaySavedEnvironment({
      label: input.label,
      target: resolvedTarget,
    });
  }
  const descriptor = input.desktopSsh
    ? await fetchDesktopSshEnvironmentDescriptor(resolvedTarget.httpBaseUrl)
    : await fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: resolvedTarget.httpBaseUrl,
      });
  const environmentId = descriptor.environmentId;
  const registrySnapshot = snapshotSavedEnvironmentRegistry([environmentId]);
  const existingRecord =
    getSavedEnvironmentRecord(environmentId) ??
    findSavedEnvironmentRecordByDesktopSshTarget(input.desktopSsh);
  const staleDesktopSshRecord =
    existingRecord && existingRecord.environmentId !== environmentId ? existingRecord : null;

  const bearerSession = input.desktopSsh
    ? await bootstrapDesktopSshBearerSession(resolvedTarget.httpBaseUrl, resolvedTarget.credential)
    : await bootstrapRemoteBearerSession({
        httpBaseUrl: resolvedTarget.httpBaseUrl,
        credential: resolvedTarget.credential,
      });

  const record: SavedEnvironmentRecord = {
    environmentId,
    label: input.label.trim() || existingRecord?.label || descriptor.label,
    wsBaseUrl: resolvedTarget.wsBaseUrl,
    httpBaseUrl: resolvedTarget.httpBaseUrl,
    createdAt: existingRecord?.createdAt ?? isoNow(),
    lastConnectedAt: isoNow(),
    ...((input.desktopSsh ?? existingRecord?.desktopSsh)
      ? { desktopSsh: input.desktopSsh ?? existingRecord?.desktopSsh }
      : {}),
  };

  await persistSavedEnvironmentRecord(record);
  const didPersistBearerToken = await writeSavedEnvironmentBearerToken(
    environmentId,
    bearerSession.sessionToken,
  );
  if (!didPersistBearerToken) {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    throw new Error("Unable to persist saved environment credentials.");
  }
  useSavedEnvironmentRegistryStore.getState().upsert(record);
  if (staleDesktopSshRecord) {
    await removeSavedEnvironment(staleDesktopSshRecord.environmentId);
  }
  await removeConnection(environmentId).catch(() => false);
  await ensureSavedEnvironmentConnection(record, {
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role,
  });
  return record;
}

export async function connectDesktopSshEnvironment(
  target: DesktopSshEnvironmentTarget,
  options?: { label?: string },
): Promise<SavedEnvironmentRecord> {
  const bootstrap = await resolveDesktopSshEnvironmentBootstrap(target, {
    issuePairingToken: true,
  });
  if (!bootstrap.pairingToken) {
    throw new Error("Desktop SSH launch did not return a pairing token.");
  }

  return await addSavedEnvironment({
    label: options?.label?.trim() || bootstrap.target.alias,
    host: bootstrap.httpBaseUrl,
    pairingCode: bootstrap.pairingToken,
    desktopSsh: bootstrap.target,
  }).catch((error) => {
    const detail = [
      `local ${bootstrap.httpBaseUrl}`,
      `remote port ${bootstrap.remotePort ?? "unknown"}`,
      bootstrap.remoteServerKind ? `remote server ${bootstrap.remoteServerKind}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (${detail})`);
  });
}

export async function ensureEnvironmentConnectionBootstrapped(
  environmentId: EnvironmentId,
): Promise<void> {
  await environmentConnections.get(environmentId)?.ensureBootstrapped();
}

export interface EnvironmentConnectionServiceOptions {
  /**
   * The chat this page load opens into, if any: the routed thread, or the
   * one the launch restores. Its detail is requested before any warm thread.
   * Only the first start of a page load uses it.
   */
  readonly foregroundThreadRef?: ScopedThreadRef | null;
}

export function startEnvironmentConnectionService(
  queryClient: QueryClient,
  options?: EnvironmentConnectionServiceOptions,
): () => void {
  threadDetails.beginBoot(options?.foregroundThreadRef ?? null);
  if (activeService?.queryClient === queryClient) {
    activeService.refCount += 1;
    return () => {
      if (!activeService || activeService.queryClient !== queryClient) {
        return;
      }
      activeService.refCount -= 1;
      if (activeService.refCount === 0) {
        stopActiveService();
      }
    };
  }

  stopActiveService();
  needsProviderInvalidation = false;
  needsPullRequestInvalidation = false;
  const queryInvalidationThrottler = new Throttler(
    () => {
      if (needsProviderInvalidation) {
        needsProviderInvalidation = false;
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      }
      if (needsPullRequestInvalidation) {
        needsPullRequestInvalidation = false;
        void queryClient.invalidateQueries({ queryKey: pullRequestQueryKeys.all });
      }
    },
    {
      wait: 100,
      leading: false,
      trailing: true,
    },
  );
  const requestSavedEnvironmentSync = createSavedEnvironmentSyncScheduler();

  maybeCreatePrimaryEnvironmentConnection();

  const unsubscribeSavedEnvironments = useSavedEnvironmentRegistryStore.subscribe(() => {
    if (!hasSavedEnvironmentRegistryHydrated()) {
      return;
    }
    void requestSavedEnvironmentSync();
  });

  void waitForSavedEnvironmentRegistryHydration()
    .then(() => requestSavedEnvironmentSync())
    .catch(() => undefined);

  const unsubscribeBrowserResumeReconnects = subscribeBrowserResumeReconnects();

  activeService = {
    queryClient,
    queryInvalidationThrottler,
    refCount: 1,
    stop: () => {
      unsubscribeSavedEnvironments();
      unsubscribeBrowserResumeReconnects();
      queryInvalidationThrottler.cancel();
      for (const environmentId of unreachableSavedEnvironments.keys()) {
        stopWaitingForUnreachableSavedEnvironment(environmentId);
      }
    },
  };

  return () => {
    if (!activeService || activeService.queryClient !== queryClient) {
      return;
    }
    activeService.refCount -= 1;
    if (activeService.refCount === 0) {
      stopActiveService();
    }
  };
}

export async function resetEnvironmentServiceForTests(): Promise<void> {
  stopActiveService();
  lastBrowserHiddenAt = null;
  lastBrowserResumeReconnectAt = Number.NEGATIVE_INFINITY;
  lastAppliedProjectionVersionByEnvironment.clear();
  pendingSavedEnvironmentConnections.clear();
  threadDetails.resetForTests();
  await Promise.all(
    [...environmentConnections.keys()].map((environmentId) => removeConnection(environmentId)),
  );
}
