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
  readRelayDeviceCredentials,
  subscribeEnvironmentConnections,
} from "../environments/runtime";

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

function readStored(): Pick<PushAlertsState, "enabled" | "kinds"> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as {
      enabled?: unknown;
      kinds?: Partial<Record<keyof PushAlertKinds, unknown>>;
    } | null;
    return {
      enabled: parsed?.enabled === true,
      kinds: {
        needs_you: parsed?.kinds?.needs_you !== false,
        finished: parsed?.kinds?.finished !== false,
        failed: parsed?.kinds?.failed !== false,
      },
    };
  } catch {
    return { enabled: false, kinds: DEFAULT_ALERT_KINDS };
  }
}

function writeStored(enabled: boolean, kinds: PushAlertKinds) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, kinds }));
  } catch {
    // Private mode and the like: alerts still work until the app reloads.
  }
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

/** The public key phones of this channel subscribe with, from `relayOrigin`. */
function relayPushKey(relayOrigin: string): Promise<RelayPushKeyResult> {
  let key = relayKeys.get(relayOrigin);
  if (!key) {
    key = fetch(new URL(`/v2/push/key?channel=${keyChannel}`, relayOrigin)).then(
      async (response) => {
        if (!response.ok) throw new Error("This relay doesn't send alerts.");
        return (await response.json()) as RelayPushKeyResult;
      },
    );
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
    if (!subscribe) return null;
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

async function relayDeviceRequest(
  environmentId: EnvironmentId,
  method: "PUT" | "DELETE",
  body?: object,
): Promise<void> {
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
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!response.ok) {
    const answer = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      typeof answer?.error === "string" ? answer.error : "The relay didn't take the change.",
    );
  }
}

/** Registers this phone with one computer: its relay host first, then the computer. */
async function registerWith(environmentId: EnvironmentId, phone: PhoneSubscription) {
  const relay = relayLinkOf(getSavedEnvironmentRecord(environmentId));
  if (!relay) return setStatus(environmentId, { state: "not-paired" });
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) return setStatus(environmentId, { state: "connecting" });
  const descriptor = readEnvironmentDescriptor(environmentId);
  if (!descriptor) return setStatus(environmentId, { state: "connecting" });
  if (descriptor.capabilities.pushAlerts !== true) {
    return setStatus(environmentId, { state: "older" });
  }
  try {
    const relayKey = await relayPushKey(relay.relayOrigin);
    if (relayKey.keyId !== phone.keyId) {
      return setStatus(environmentId, {
        state: "failed",
        detail: "It uses a different relay than this phone's other computers.",
      });
    }
    await relayDeviceRequest(environmentId, "PUT", {
      registrationId: phone.registrationId,
      endpoint: phone.endpoint,
      keyId: phone.keyId,
      kinds: usePushAlertsStore.getState().kinds,
    });
    await connection.client.push.register({
      registrationId: phone.registrationId,
      p256dh: phone.p256dh,
      auth: phone.auth,
      keyId: phone.keyId,
      appOrigin: window.location.origin,
    });
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
      if (!phone) return;
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
  const { kinds } = usePushAlertsStore.getState();
  writeStored(false, kinds);
  usePushAlertsStore.setState({ enabled: false, busy: true, error: null });
  try {
    await Promise.all(
      pairedComputers().map(async ({ record }) => {
        await relayDeviceRequest(record.environmentId, "DELETE").catch(() => undefined);
        await readEnvironmentConnection(record.environmentId)
          ?.client.push.unregister()
          .catch(() => undefined);
      }),
    );
    const registration = await navigator.serviceWorker.getRegistration(WORKER_URL);
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
    usePushAlertsStore.setState({ statusByEnvironmentId: {} });
  } finally {
    usePushAlertsStore.setState({ busy: false });
  }
}

/** Switches one kind of alert on or off on every computer. */
export async function setPushAlertKind(kind: keyof PushAlertKinds, on: boolean): Promise<void> {
  const kinds = { ...usePushAlertsStore.getState().kinds, [kind]: on };
  writeStored(usePushAlertsStore.getState().enabled, kinds);
  usePushAlertsStore.setState({ kinds });
  await reconcilePushAlerts();
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
  const stop = subscribeEnvironmentConnections(schedule);
  return () => {
    started = false;
    if (timer) clearTimeout(timer);
    stop();
  };
}
