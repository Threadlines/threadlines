/**
 * The device state of each computer on the web side (docs/design/devices.md):
 * one `subscribeDeviceState` stream per computer, shared by every view that
 * follows it (the Device tab, Settings → Devices, the thread route watching
 * for an agent opening a device) and dropped when the last one leaves. The
 * stream follows a reconnect on its own; the last state stays until then.
 *
 * Also the device a thread's Device tab shows, and the calls the tab makes,
 * each naming the computer the device is on.
 */
import type {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceDetail,
  DeviceOpenInput,
  DeviceServiceState,
  DeviceSession,
  DeviceShutdownInput,
  DeviceToolName,
  EnvironmentApi,
  EnvironmentId,
  ServerSettingsPatch,
} from "@threadlines/contracts";
import type { DeviceChannelApi } from "@threadlines/client-runtime/device";
import { newAgentDeviceSessions } from "@threadlines/client-runtime/deviceState";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { isEnvironmentApiAvailable, readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import {
  readEnvironmentConnection,
  readEnvironmentDescriptor,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import {
  resetDeviceViewsForTests,
  selectDeviceChip,
  useThreadDeviceViews,
} from "./deviceViewStore";

/** Whether a computer's server has devices (capability `devices`), as it last said. */
export function environmentSupportsDevices(environmentId: EnvironmentId): boolean {
  return readEnvironmentDescriptor(environmentId)?.capabilities.devices === true;
}

/** `environmentSupportsDevices`, again whenever a computer's descriptor changes. */
export function useDevicesSupported(environmentId: EnvironmentId | null): boolean {
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const linked = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null
      ? undefined
      : state.byId[environmentId]?.descriptor?.capabilities.devices,
  );
  if (environmentId === null) return false;
  return primaryDescriptor?.environmentId === environmentId
    ? primaryDescriptor.capabilities.devices === true
    : linked === true;
}

interface Followed {
  refs: number;
  /** What the subscription runs on: the connection, or a stand-in API in tests. */
  connection: object | null;
  unsubscribe: (() => void) | null;
}

const STAND_IN_CONNECTION = {};
let stopWatchingConnections: (() => void) | null = null;

const followed = new Map<EnvironmentId, Followed>();
let states: Readonly<Record<string, DeviceServiceState>> = {};
const listeners = new Set<() => void>();
const agentOpenListeners = new Set<
  (environmentId: EnvironmentId, session: DeviceSession) => void
>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Takes a state from the stream (always: it is in order, and a restarted
 * server starts its revision again) or from a call's answer (only when it is
 * not older than the one held).
 */
function receive(environmentId: EnvironmentId, next: DeviceServiceState, fromStream: boolean) {
  const previous = states[environmentId];
  if (!fromStream && previous !== undefined && next.revision < previous.revision) return;
  states = { ...states, [environmentId]: next };
  emit();
  if (previous === undefined) return;
  for (const threadId of new Set(next.sessions.map((session) => session.threadId))) {
    for (const session of newAgentDeviceSessions(previous, next, threadId)) {
      for (const listener of agentOpenListeners) listener(environmentId, session);
    }
  }
}

/** Subscribes each followed computer on its current connection, once. */
function syncConnections() {
  for (const [environmentId, entry] of followed) {
    const connection =
      readEnvironmentConnection(environmentId) ??
      (isEnvironmentApiAvailable(environmentId) ? STAND_IN_CONNECTION : null);
    if (entry.connection === connection) continue;
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    entry.connection = connection;
    const api = connection === null ? undefined : readEnvironmentApi(environmentId);
    if (api === undefined) continue;
    entry.unsubscribe = api.device.subscribeState((state) => {
      // A late answer from a subscription already dropped is not this one's.
      if (followed.get(environmentId) !== entry || entry.connection !== connection) return;
      receive(environmentId, state, true);
    });
  }
}

function follow(environmentId: EnvironmentId): () => void {
  let entry = followed.get(environmentId);
  if (entry === undefined) {
    entry = { refs: 0, connection: null, unsubscribe: null };
    followed.set(environmentId, entry);
  }
  stopWatchingConnections ??= subscribeEnvironmentConnections(syncConnections);
  syncConnections();
  entry.refs += 1;
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs -= 1;
    if (held.refs > 0) return;
    held.unsubscribe?.();
    followed.delete(environmentId);
    if (followed.size === 0) {
      stopWatchingConnections?.();
      stopWatchingConnections = null;
    }
  };
}

function subscribeStates(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A computer's device state, followed while mounted. Null until its first
 * state arrives, and always for a computer whose server lacks `devices`
 * (pass `supported` false).
 */
export function useDeviceState(
  environmentId: EnvironmentId | null,
  supported: boolean,
): DeviceServiceState | null {
  const following = supported && environmentId !== null;
  useEffect(
    () => (following && environmentId !== null ? follow(environmentId) : undefined),
    [environmentId, following],
  );
  const read = useCallback(
    () => (environmentId === null ? undefined : states[environmentId]),
    [environmentId],
  );
  const state = useSyncExternalStore(subscribeStates, read, read);
  return following ? (state ?? null) : null;
}

/** Calls `listener` whenever an agent opens a device for a thread on a followed computer. */
export function onAgentOpenedDevice(
  listener: (environmentId: EnvironmentId, session: DeviceSession) => void,
): () => void {
  agentOpenListeners.add(listener);
  return () => {
    agentOpenListeners.delete(listener);
  };
}

// ── The device each thread's tab shows ─────────────────────────────────

/** Points a thread's Device tab at a device, or back at the picker (null). */
export function selectThreadDevice(threadKey: string, deviceId: string | null) {
  selectDeviceChip(threadKey, deviceId);
}

export function useSelectedThreadDevice(threadKey: string | null): string | null {
  return useThreadDeviceViews(threadKey).selected;
}

// ── Calls ──────────────────────────────────────────────────────────────

function deviceApi(environmentId: EnvironmentId): EnvironmentApi["device"] {
  const api = readEnvironmentApi(environmentId);
  if (api === undefined) {
    throw new Error("That computer is offline. Try again when it is back.");
  }
  return api.device;
}

/** What went wrong with a device call, in words the panel can show. */
export function deviceErrorText(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | null)?.message === "string"
        ? (error as { message: string }).message
        : "";
  return message.trim().length > 0 ? message : "That did not work. Try again.";
}

export async function refreshDevices(environmentId: EnvironmentId): Promise<void> {
  receive(environmentId, await deviceApi(environmentId).list({ refresh: true }), false);
}

export async function updateDeviceTool(
  environmentId: EnvironmentId,
  tool: DeviceToolName,
): Promise<void> {
  receive(environmentId, await deviceApi(environmentId).updateTool({ tool }), false);
}

export function openDevice(environmentId: EnvironmentId, input: DeviceOpenInput) {
  return deviceApi(environmentId).open(input);
}

export function closeDevice(environmentId: EnvironmentId, input: DeviceCloseInput) {
  return deviceApi(environmentId).close(input);
}

export function shutdownDevice(environmentId: EnvironmentId, input: DeviceShutdownInput) {
  return deviceApi(environmentId).shutdown(input);
}

export function readDeviceDetail(
  environmentId: EnvironmentId,
  deviceId: string,
): Promise<DeviceDetail> {
  return deviceApi(environmentId).detail({ deviceId });
}

export function runDeviceAction(
  environmentId: EnvironmentId,
  input: DeviceActionInput,
): Promise<DeviceDetail> {
  return deviceApi(environmentId).action(input);
}

/** "Use devices" and "Agents can use devices" on that computer, through its settings. */
export async function updateDeviceSettings(
  environmentId: EnvironmentId,
  patch: Pick<ServerSettingsPatch, "enableDevices" | "agentDeviceAccess">,
): Promise<void> {
  const api = readEnvironmentApi(environmentId);
  if (api === undefined) {
    throw new Error("That computer is offline. Try again when it is back.");
  }
  await api.settings.update(patch);
}

/**
 * The device channel of a computer, read again for every channel opened, so
 * a channel opened after a reconnect goes over the new connection.
 */
export function deviceChannelApi(environmentId: EnvironmentId): DeviceChannelApi {
  return {
    open: (input, listener, onClosed) => {
      const api = readEnvironmentApi(environmentId);
      if (api === undefined) {
        queueMicrotask(() => onClosed(new Error("That computer is offline.")));
        return () => {};
      }
      return api.device.channel.open(input, listener, onClosed);
    },
    send: (input) => deviceApi(environmentId).channel.send(input),
    credit: (input) => deviceApi(environmentId).channel.credit(input),
  };
}

export function resetDeviceStateForTests() {
  for (const entry of followed.values()) entry.unsubscribe?.();
  followed.clear();
  stopWatchingConnections?.();
  stopWatchingConnections = null;
  states = {};
  resetDeviceViewsForTests();
  emit();
}
