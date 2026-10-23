/**
 * This phone's alerts (docs/design/push-alerts.md). The browser holds one
 * push subscription; this module keeps every paired computer registered for
 * it: the subscription's endpoint and the alerts the user wants go to that
 * computer's relay host, with this phone's own device secret, and the keys to
 * seal alerts with go to the computer itself over the end-to-end channel.
 * Endpoints change and computers come and go, so it registers again on every
 * launch and every (re)connection; the same subscription again changes nothing.
 */
import type { EnvironmentId, PushAlertKinds, RelayPushKeyResult } from "@threadlines/contracts";
import { create } from "zustand";

import { HOSTED_APP_CHANNEL } from "../branding";
import {
  getSavedEnvironmentRecord,
  listSavedEnvironmentRecords,
  type SavedEnvironmentRecord,
  readEnvironmentConnection,
  readEnvironmentDescriptor,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
// From its own module: the settings browser test replaces the runtime index.
import { readRelayDeviceCredentials } from "../environments/runtime/relayCredentials";

export const DEFAULT_ALERT_KINDS: PushAlertKinds = {
  needs_you: true,
  finished: true,
  failed: true,
};

const STORAGE_KEY = "threadlines:push-alerts:v1";
const WORKER_URL = "/push-sw.js";

/** Why one computer does or doesn't send this phone alerts. */
export type ComputerAlertStatus =
  | { readonly state: "on" }
  | { readonly state: "connecting" }
  /** Its Threadlines is older than alerts. */
  | { readonly state: "older" }
  /** Added by address or SSH, not paired with Connect a device: no relay to send through. */
  | { readonly state: "not-paired" }
  | { readonly state: "failed"; readonly detail: string };

export type PushAlertsSupport =
  | "supported"
  /** iPhone or iPad in a Safari tab: alerts need the Home Screen app. */
  | "needs-home-screen"
  | "unsupported";

interface PushAlertsState {
  readonly enabled: boolean;
  readonly kinds: PushAlertKinds;
  readonly permission: NotificationPermission | "unsupported";
  readonly statusByEnvironmentId: Readonly<Record<EnvironmentId, ComputerAlertStatus>>;
  /** A turn on, off or a switch change is in flight. */
  readonly busy: boolean;
  readonly error: string | null;
}

/** The saved switches; null when nothing is saved or storage can't be read. */
function readStoredIfAny(): Pick<PushAlertsState, "enabled" | "kinds"> | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as {
      enabled?: unknown;
      kinds?: Partial<Record<keyof PushAlertKinds, unknown>>;
    } | null;
    if (parsed === null) return null;
    return {
      enabled: parsed?.enabled === true,
      kinds: {
        needs_you: parsed?.kinds?.needs_you !== false,
        finished: parsed?.kinds?.finished !== false,
        failed: parsed?.kinds?.failed !== false,
      },
    };
  } catch {
    return null;
  }
}

function readStored(): Pick<PushAlertsState, "enabled" | "kinds"> {
  return readStoredIfAny() ?? { enabled: false, kinds: DEFAULT_ALERT_KINDS };
}

/** Off once a save failed: what's on disk is then older than what's in memory. */
let storageCurrent = true;

function writeStored(enabled: boolean, kinds: PushAlertKinds) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, kinds }));
  } catch {
    // Private mode and the like: alerts still work until the app reloads.
    storageCurrent = false;
  }
}

const REVISION_KEY = "threadlines:push-alerts:revision";
let lastRevision = 0;

/**
 * Numbers each change sent to a relay host, rising across reloads and this
 * app's windows (they share storage), even if the clock steps back.
 */
function nextRevision(): number {
  let stored = 0;
  try {
    stored = Number(localStorage.getItem(REVISION_KEY)) || 0;
  } catch {
    // Read below from memory alone.
  }
  lastRevision = Math.max(Date.now(), stored + 1, lastRevision + 1);
  try {
    localStorage.setItem(REVISION_KEY, String(lastRevision));
  } catch {
    // Still rises within this window.
  }
  return lastRevision;
}

function readPermission(): PushAlertsState["permission"] {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export const usePushAlertsStore = create<PushAlertsState>()(() => ({
  ...readStored(),
  permission: readPermission(),
  statusByEnvironmentId: {},
  busy: false,
  error: null,
}));

/** Whether this browser can get alerts, and if not, whether the Home Screen app could. */
export function pushAlertsSupport(): PushAlertsSupport {
  if (typeof window === "undefined" || window.desktopBridge) return "unsupported";
  const capable =
    "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
  if (capable) return "supported";
  const ios = /iPhone|iPad|iPod/u.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
  return ios && /Safari/u.test(navigator.userAgent) ? "needs-home-screen" : "unsupported";
}

/** The relay key channel this app's build subscribes with (dev builds use nightly's). */
const keyChannel = HOSTED_APP_CHANNEL === "latest" ? "stable" : "nightly";

const toBase64Url = (bytes: ArrayBuffer | Uint8Array) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const fromBase64Url = (text: string) => {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (char) =>
    char.charCodeAt(0),
  );
};

const relayKeys = new Map<string, Promise<RelayPushKeyResult>>();

/** Every relay request gives up after this, so turning alerts off never waits forever. */
const RELAY_REQUEST_TIMEOUT_MS = 10_000;

/** The public key phones of this channel subscribe with, from `relayOrigin`. */
function relayPushKey(relayOrigin: string): Promise<RelayPushKeyResult> {
  let key = relayKeys.get(relayOrigin);
  if (!key) {
    key = fetch(new URL(`/v2/push/key?channel=${keyChannel}`, relayOrigin), {
      signal: AbortSignal.timeout(RELAY_REQUEST_TIMEOUT_MS),
    }).then(async (response) => {
      if (!response.ok) throw new Error("This relay doesn't send alerts.");
      return (await response.json()) as RelayPushKeyResult;
    });
    key.catch(() => relayKeys.delete(relayOrigin));
    relayKeys.set(relayOrigin, key);
  }
  return key;
}

interface PhoneSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly keyId: string;
  readonly registrationId: string;
}

async function describeSubscription(
  subscription: PushSubscription,
  keyId: string,
): Promise<PhoneSubscription | null> {
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (!p256dh || !auth) return null;
  const fields = {
    endpoint: subscription.endpoint,
    p256dh: toBase64Url(p256dh),
    auth: toBase64Url(auth),
    keyId,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${fields.endpoint}\n${fields.p256dh}\n${fields.auth}\n${keyId}`),
  );
  return { ...fields, registrationId: toBase64Url(digest).slice(0, 32) };
}

type RelayLink = Extract<NonNullable<SavedEnvironmentRecord["relay"]>, { readonly version: 2 }>;

/** A computer's pairing through Connect a device; null for one added another way. */
export function relayLinkOf(record: SavedEnvironmentRecord | null | undefined): RelayLink | null {
  const relay = record?.relay;
  return relay && "version" in relay && relay.version === 2 ? relay : null;
}

/** Relay-paired computers, the only ones that can send this phone alerts. */
function pairedComputers() {
  return listSavedEnvironmentRecords().flatMap((record) => {
    const relay = relayLinkOf(record);
    return relay ? [{ record, relay }] : [];
  });
}

/** The subscription to register, made (or replaced, after a key change) when needed. */
async function currentSubscription(subscribe: boolean): Promise<PhoneSubscription | null> {
  const relayOrigin = pairedComputers()[0]?.relay.relayOrigin;
  if (!relayOrigin) return null;
  const key = await relayPushKey(relayOrigin);
  const registration = await navigator.serviceWorker.register(WORKER_URL, { scope: "/" });
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  const subscribedKey = subscription?.options.applicationServerKey;
  if (subscription && subscribedKey && toBase64Url(subscribedKey) !== key.publicKey) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    if (!subscribe || !stillEnabled()) return null;
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(key.publicKey),
    });
  }
  return describeSubscription(subscription, key.keyId);
}

function setStatus(environmentId: EnvironmentId, status: ComputerAlertStatus) {
  usePushAlertsStore.setState((state) => ({
    statusByEnvironmentId: { ...state.statusByEnvironmentId, [environmentId]: status },
  }));
}

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * One change to this phone's row on a computer's relay host. Its revision is
 * taken when the change is made, so the relay can ignore one that arrives
 * after a newer change.
 */
async function relayDeviceRequest(
  environmentId: EnvironmentId,
  method: "PUT" | "DELETE",
  fields?: object,
): Promise<void> {
  const body = { ...fields, revision: nextRevision() };
  const relay = relayLinkOf(getSavedEnvironmentRecord(environmentId));
  const credentials = await readRelayDeviceCredentials(environmentId);
  if (!relay || !credentials) throw new Error("This computer isn't paired.");
  const response = await fetch(
    new URL(
      `/v2/hosts/${encodeURIComponent(relay.hostId)}/devices/${encodeURIComponent(relay.deviceId)}/push`,
      relay.relayOrigin,
    ),
    {
      method,
      headers: {
        authorization: `Bearer ${credentials.deviceSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RELAY_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const answer = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      typeof answer?.error === "string" ? answer.error : "The relay didn't take the change.",
    );
  }
}

/**
 * Takes the switches another window of this app saved since: they share one
 * browser subscription, so one window turning alerts off turns them off here.
 */
function syncFromStorage() {
  if (!storageCurrent) return;
  const stored = readStoredIfAny();
  if (!stored) return;
  const { enabled, kinds } = usePushAlertsStore.getState();
  if (
    stored.enabled !== enabled ||
    (Object.keys(kinds) as Array<keyof PushAlertKinds>).some(
      (kind) => stored.kinds[kind] !== kinds[kind],
    )
  ) {
    usePushAlertsStore.setState(stored);
  }
}

const stillEnabled = () => {
  syncFromStorage();
  return usePushAlertsStore.getState().enabled;
};

/** A computer that never answers can't hold up the others, or the next pass. */
const REGISTER_TIMEOUT_MS = 15_000;

const withTimeout = <A>(promise: Promise<A>, ms: number, message: string): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * Puts this phone's endpoint and current switches on one computer's relay
 * host. False when that relay signs with another key than this phone's.
 */
async function putRelayRow(
  environmentId: EnvironmentId,
  relayOrigin: string,
  phone: PhoneSubscription,
): Promise<boolean> {
  const relayKey = await relayPushKey(relayOrigin);
  if (relayKey.keyId !== phone.keyId) return false;
  // Turned off meanwhile: put nothing back.
  if (!stillEnabled()) return true;
  await relayDeviceRequest(environmentId, "PUT", {
    registrationId: phone.registrationId,
    endpoint: phone.endpoint,
    keyId: phone.keyId,
    kinds: usePushAlertsStore.getState().kinds,
  });
  return true;
}

/** The subscription the last pass registered, for switch changes that can't wait for the next. */
let lastPhone: PhoneSubscription | null = null;

/**
 * Registers this phone with one computer: its relay host first, which takes
 * the endpoint and the switches even while the computer is offline (so a
 * switch turned off holds there at once), then the computer itself.
 */
async function registerWith(environmentId: EnvironmentId, phone: PhoneSubscription) {
  const relay = relayLinkOf(getSavedEnvironmentRecord(environmentId));
  if (!relay) return setStatus(environmentId, { state: "not-paired" });
  try {
    if (!(await putRelayRow(environmentId, relay.relayOrigin, phone))) {
      return setStatus(environmentId, {
        state: "failed",
        detail: "It uses a different relay than this phone's other computers.",
      });
    }
    const connection = readEnvironmentConnection(environmentId);
    const descriptor = readEnvironmentDescriptor(environmentId);
    if (!connection || !descriptor) return setStatus(environmentId, { state: "connecting" });
    if (descriptor.capabilities.pushAlerts !== true) {
      return setStatus(environmentId, { state: "older" });
    }
    if (!stillEnabled()) return;
    await withTimeout(
      connection.client.push.register({
        registrationId: phone.registrationId,
        p256dh: phone.p256dh,
        auth: phone.auth,
        keyId: phone.keyId,
        appOrigin: window.location.origin,
      }),
      REGISTER_TIMEOUT_MS,
      "That computer didn't answer.",
    );
    setStatus(environmentId, { state: "on" });
  } catch (error) {
    setStatus(environmentId, {
      state: "failed",
      detail: errorText(error, "Couldn't turn alerts on there."),
    });
  }
}

let reconciling: Promise<void> | null = null;
let reconcileAgain = false;

/** Brings every paired computer up to date with this phone's subscription and switches. */
export function reconcilePushAlerts(): Promise<void> {
  if (reconciling) {
    reconcileAgain = true;
    return reconciling;
  }
  reconciling = (async () => {
    do {
      reconcileAgain = false;
      const { enabled } = usePushAlertsStore.getState();
      if (!enabled || readPermission() !== "granted" || pushAlertsSupport() !== "supported") {
        return;
      }
      const phone = await currentSubscription(true).catch((error: unknown) => {
        usePushAlertsStore.setState({ error: errorText(error, "Couldn't set up alerts.") });
        return null;
      });
      if (!phone || !stillEnabled()) return;
      lastPhone = phone;
      await Promise.all(
        pairedComputers().map(({ record }) => registerWith(record.environmentId, phone)),
      );
    } while (reconcileAgain);
  })().finally(() => {
    reconciling = null;
  });
  return reconciling;
}

/**
 * Turns alerts on. Call straight from the tap: iOS asks for permission only
 * in answer to one.
 */
export async function enablePushAlerts(): Promise<void> {
  const permission = await Notification.requestPermission();
  usePushAlertsStore.setState({ permission });
  if (permission !== "granted") {
    usePushAlertsStore.setState({ error: "Alerts are blocked for this app in Settings." });
    return;
  }
  syncFromStorage();
  const { kinds } = usePushAlertsStore.getState();
  writeStored(true, kinds);
  usePushAlertsStore.setState({ enabled: true, busy: true, error: null });
  try {
    await reconcilePushAlerts();
  } finally {
    usePushAlertsStore.setState({ busy: false });
  }
}

/** Turns alerts off: every computer forgets this phone, and the browser drops the subscription. */
export async function disablePushAlerts(): Promise<void> {
  syncFromStorage();
  const { kinds } = usePushAlertsStore.getState();
  writeStored(false, kinds);
  usePushAlertsStore.setState({ enabled: false, busy: true, error: null });
  try {
    // A registration still in flight sees "off" at its next step and stops;
    // wait for it, so no relay change it makes lands after the removal below.
    // Its relay steps time out, so this only stops waiting early on a stuck
    // computer, whose late answer can't reach the phone without the relay.
    if (reconciling) {
      await Promise.race([
        reconciling.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3 * RELAY_REQUEST_TIMEOUT_MS)),
      ]);
    }
    await Promise.all(
      pairedComputers().map(async ({ record }) => {
        await relayDeviceRequest(record.environmentId, "DELETE").catch(() => undefined);
        const connection = readEnvironmentConnection(record.environmentId);
        if (!connection) return;
        // Bounded: a computer that never answers forgets the phone when it
        // next sends, since its relay host no longer has it.
        await withTimeout(
          connection.client.push.unregister(),
          REGISTER_TIMEOUT_MS,
          "That computer didn't answer.",
        ).catch(() => undefined);
      }),
    );
    lastPhone = null;
    const registration = await navigator.serviceWorker.getRegistration(WORKER_URL);
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
    usePushAlertsStore.setState({ statusByEnvironmentId: {} });
  } finally {
    usePushAlertsStore.setState({ busy: false });
  }
}

/** Switches one kind of alert on or off on every computer. */
export async function setPushAlertKind(kind: keyof PushAlertKinds, on: boolean): Promise<void> {
  // Another window may have turned alerts off: don't save its old "on" back.
  syncFromStorage();
  const kinds = { ...usePushAlertsStore.getState().kinds, [kind]: on };
  writeStored(usePushAlertsStore.getState().enabled, kinds);
  usePushAlertsStore.setState({ kinds });
  // Straight to every relay host, even while a pass is still waiting on a
  // computer: the relay is what holds a switch that's off.
  const phone = lastPhone;
  if (phone && stillEnabled()) {
    await Promise.all(
      pairedComputers().map(({ record, relay }) =>
        putRelayRow(record.environmentId, relay.relayOrigin, phone).catch(() => undefined),
      ),
    );
  }
  void reconcilePushAlerts();
}

/** Asks one computer to send this phone a test alert. */
export async function sendTestPushAlert(environmentId: EnvironmentId): Promise<string> {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) return "That computer isn't connected right now.";
  try {
    const { outcome } = await connection.client.push.sendTest();
    switch (outcome) {
      case "sent":
        return "Sent. It should show in a moment.";
      case "limited":
        return "Today's alerts are used up. Try again tomorrow.";
      case "stale":
      case "gone":
        await reconcilePushAlerts();
        return "This phone's subscription changed. Try again.";
      default:
        return "The alert didn't go out. Try turning alerts off and on.";
    }
  } catch (error) {
    return errorText(error, "Couldn't send a test alert.");
  }
}

let started = false;

/** Keeps registrations current while the app runs: now, and on every connection change. */
export function startPushAlerts(): () => void {
  if (started || pushAlertsSupport() !== "supported") return () => undefined;
  started = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reconcilePushAlerts(), 1_000);
  };
  schedule();
  const stopConnections = subscribeEnvironmentConnections(schedule);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    syncFromStorage();
    schedule();
  };
  window.addEventListener("storage", onStorage);
  // A socket that reconnects keeps its connection object: watch its state too.
  const stopRuntime = useSavedEnvironmentRuntimeStore.subscribe((state, previous) => {
    for (const [environmentId, runtime] of Object.entries(state.byId)) {
      const before = previous.byId[environmentId as EnvironmentId];
      if (runtime?.connectionState === "connected" && before?.connectionState !== "connected") {
        schedule();
        return;
      }
    }
  });
  return () => {
    started = false;
    if (timer) clearTimeout(timer);
    stopConnections();
    stopRuntime();
    window.removeEventListener("storage", onStorage);
  };
}
