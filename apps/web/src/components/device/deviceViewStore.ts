/**
 * What each thread's Device tab shows (docs/design/devices.md, "Round 2"):
 * the chip order, the names the user gave chips, which chip is on screen
 * (null: the picker), and the device floating over the chat. Keyed by thread
 * key (`<environment>:<thread>`).
 *
 * Order, names and the shown chip are kept in localStorage like the browser
 * panel's tabs. The float is not: reopening the app to a device streaming
 * over the chat would start a stream nobody asked for.
 */
import type { DeviceSession } from "@threadlines/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

const DEVICE_VIEWS_STORAGE_KEY = "threadlines:device-views:v1";
/** Longest chip name; a longer one is cut there. */
export const DEVICE_CHIP_NAME_MAX_CHARS = 60;

export interface ThreadDeviceViews {
  /** Device ids in chip order. Sessions not listed follow in the order they opened. */
  readonly order: ReadonlyArray<string>;
  /** Names the user gave chips, by device id. */
  readonly names: Readonly<Record<string, string>>;
  /** The chip on screen in the tab, or null for the picker. */
  readonly selected: string | null;
}

/** The device floating over a thread's chat, and where. */
export interface DeviceFloat {
  readonly deviceId: string;
  /** Top-left corner in window pixels; null until first placed. */
  readonly position: { readonly x: number; readonly y: number } | null;
  /** Width in px; null for the default. */
  readonly width: number | null;
}

const EMPTY_VIEWS: ThreadDeviceViews = { order: [], names: {}, selected: null };

interface DeviceViewStoreState {
  readonly byThreadKey: Readonly<Record<string, ThreadDeviceViews>>;
  readonly floatByThreadKey: Readonly<Record<string, DeviceFloat>>;
}

export const useDeviceViewStore = create<DeviceViewStoreState>()(
  persist((): DeviceViewStoreState => ({ byThreadKey: {}, floatByThreadKey: {} }), {
    name: DEVICE_VIEWS_STORAGE_KEY,
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    merge: (persisted, current) => ({
      ...current,
      byThreadKey:
        (persisted as Partial<DeviceViewStoreState> | undefined)?.byThreadKey ??
        current.byThreadKey,
    }),
  }),
);

function updateViews(threadKey: string, update: (views: ThreadDeviceViews) => ThreadDeviceViews) {
  useDeviceViewStore.setState((state) => {
    const current = state.byThreadKey[threadKey] ?? EMPTY_VIEWS;
    const next = update(current);
    if (next === current) return state;
    return { byThreadKey: { ...state.byThreadKey, [threadKey]: next } };
  });
}

export function readThreadDeviceViews(threadKey: string): ThreadDeviceViews {
  return useDeviceViewStore.getState().byThreadKey[threadKey] ?? EMPTY_VIEWS;
}

export function useThreadDeviceViews(threadKey: string | null): ThreadDeviceViews {
  return useDeviceViewStore((state) =>
    threadKey === null ? EMPTY_VIEWS : (state.byThreadKey[threadKey] ?? EMPTY_VIEWS),
  );
}

/** Shows a chip in the tab (adding it to the end of the row if new), or the picker (null). */
export function selectDeviceChip(threadKey: string, deviceId: string | null) {
  updateViews(threadKey, (views) => {
    const order =
      deviceId === null || views.order.includes(deviceId)
        ? views.order
        : [...views.order, deviceId];
    if (views.selected === deviceId && order === views.order) return views;
    return { ...views, order, selected: deviceId };
  });
}

/** Names a chip; an empty name goes back to the device's own. */
export function renameDeviceChip(threadKey: string, deviceId: string, name: string) {
  const trimmed = name.replace(/\s+/g, " ").trim().slice(0, DEVICE_CHIP_NAME_MAX_CHARS);
  updateViews(threadKey, (views) => {
    if ((views.names[deviceId] ?? "") === trimmed) return views;
    const { [deviceId]: _previous, ...names } = views.names;
    return { ...views, names: trimmed ? { ...names, [deviceId]: trimmed } : names };
  });
}

/**
 * Drops a closed device's chip. The tab moves to the chip beside it, or to
 * the picker when it was the last. Its name is kept for the next time it opens.
 */
export function removeDeviceChip(
  threadKey: string,
  deviceId: string,
  sessions: ReadonlyArray<DeviceSession>,
) {
  updateViews(threadKey, (views) => {
    const chips = orderDeviceChips(views, sessions);
    const index = chips.findIndex((session) => session.deviceId === deviceId);
    const remaining = chips.filter((session) => session.deviceId !== deviceId);
    const selected =
      views.selected === deviceId
        ? (remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.deviceId ?? null)
        : views.selected;
    return { ...views, order: views.order.filter((id) => id !== deviceId), selected };
  });
  if (readDeviceFloat(threadKey)?.deviceId === deviceId) dockDeviceFloat(threadKey);
}

/**
 * A thread's open sessions in chip order: by when they opened, except that
 * the remembered ones keep their remembered order among the places they
 * hold. A device remembered only because it was selected never jumps ahead
 * of older ones the client had not seen yet.
 */
export function orderDeviceChips(
  views: ThreadDeviceViews,
  sessions: ReadonlyArray<DeviceSession>,
): ReadonlyArray<DeviceSession> {
  const byOpening = sessions.toSorted((a, b) => a.openedAt.localeCompare(b.openedAt));
  const rank = new Map(views.order.map((id, index) => [id, index]));
  const remembered = byOpening
    .filter((session) => rank.has(session.deviceId))
    .toSorted((a, b) => rank.get(a.deviceId)! - rank.get(b.deviceId)!);
  let next = 0;
  return byOpening.map((session) => (rank.has(session.deviceId) ? remembered[next++]! : session));
}

// ── The floating device ────────────────────────────────────────────────

export function readDeviceFloat(threadKey: string): DeviceFloat | null {
  return useDeviceViewStore.getState().floatByThreadKey[threadKey] ?? null;
}

export function useDeviceFloat(threadKey: string | null): DeviceFloat | null {
  return useDeviceViewStore((state) =>
    threadKey === null ? null : (state.floatByThreadKey[threadKey] ?? null),
  );
}

/** Floats a device over the thread's chat, replacing any other floating there. */
export function floatDevice(threadKey: string, deviceId: string) {
  useDeviceViewStore.setState((state) => {
    const current = state.floatByThreadKey[threadKey];
    if (current?.deviceId === deviceId) return state;
    return {
      floatByThreadKey: {
        ...state.floatByThreadKey,
        // A new float keeps where the last one was put, so it lands where the user expects.
        [threadKey]: {
          deviceId,
          position: current?.position ?? null,
          width: current?.width ?? null,
        },
      },
    };
  });
}

/** Ends the float; the device keeps running and its chip stays. */
export function dockDeviceFloat(threadKey: string) {
  useDeviceViewStore.setState((state) => {
    if (!(threadKey in state.floatByThreadKey)) return state;
    const { [threadKey]: _docked, ...floatByThreadKey } = state.floatByThreadKey;
    return { floatByThreadKey };
  });
}

export function placeDeviceFloat(
  threadKey: string,
  deviceId: string,
  placement: { readonly position: { x: number; y: number }; readonly width: number },
) {
  useDeviceViewStore.setState((state) => {
    const current = state.floatByThreadKey[threadKey];
    if (current?.deviceId !== deviceId) return state;
    if (
      current.width === placement.width &&
      current.position?.x === placement.position.x &&
      current.position.y === placement.position.y
    ) {
      return state;
    }
    return {
      floatByThreadKey: {
        ...state.floatByThreadKey,
        [threadKey]: { ...current, ...placement },
      },
    };
  });
}

export function resetDeviceViewsForTests() {
  useDeviceViewStore.setState({ byThreadKey: {}, floatByThreadKey: {} });
}
