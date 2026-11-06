/**
 * Answering an agent's settings change from this app
 * (docs/design/agent-settings-changes.md, "Answering"). Change sends a claim
 * to the thread's own computer; this app makes the device changes only once
 * that claim has won, learned from the answer or, when the answer was lost,
 * from the thread's live state settling with this app's claim. Each claim
 * makes them once, then reports what each did.
 *
 * Claims live in memory for the session: pressing Change again after a lost
 * answer sends the same claim, so the computer answers it as a retry. An app
 * that closes before its claim settles makes nothing, which the agent's note
 * says the same way as a missing report.
 */
import type {
  OrchestrationSettingsChangeRequest,
  ScopedThreadRef,
  SettingsChangeAnswer,
  SettingsChangeDeviceReport,
  SettingsChangeRequestId,
} from "@threadlines/contracts";
import { scopedThreadKey } from "@threadlines/client-runtime";
import { isOpenSettingsChange } from "@threadlines/shared/settingsChangeState";
import { type CheckedEdit, composeClientPatch } from "@threadlines/shared/settingsEdits";

import { readEnvironmentConnection } from "~/environments/runtime";
import { updateClientSettingsAndPersist } from "~/hooks/useSettings";
import { switchToTheme, themeTileByName } from "~/themeLibrary/themeCatalog";
import { currentLibraryThemes } from "~/themeLibrary/themeLibraryState";
import { randomUUID } from "~/lib/utils";
import {
  setPushAlertKind,
  setPushAlertsQuietAtComputer,
  usePushAlertsStore,
} from "~/pushAlerts/pushAlerts";
import { describeUnknownError } from "~/rpc/transportError";
import { selectEnvironmentState, useStore } from "~/store";
import { addComputerNotConnectedNotice } from "../computerConnectionNotices";
import { failureNotice, toastManager } from "../ui/toast";
import {
  type SettingsChangeLine,
  type SettingsChangeNotice,
  settingsChangeNothingNotice,
  settingsChangeResultNotice,
} from "./settingsChangeCard.logic";

type ComputerEnding = "changed" | "failed" | "uncertain";

interface SettingsChangeClaim {
  readonly threadRef: ScopedThreadRef;
  readonly requestId: SettingsChangeRequestId;
  readonly claimId: string;
  readonly deviceLabel: string;
  /** The device changes, checked with this app's catalog when Change was pressed. */
  readonly deviceEdits: ReadonlyArray<CheckedEdit>;
  /** The card's lines as they read then, for the notice. */
  readonly lines: ReadonlyArray<SettingsChangeLine>;
  /** Open until it wins (its device changes are made) or loses (nothing to make). */
  state: "open" | "won" | "lost";
  stopWatching: () => void;
}

const claims = new Map<string, SettingsChangeClaim>();

const claimKey = (threadRef: ScopedThreadRef, requestId: SettingsChangeRequestId) =>
  `${scopedThreadKey(threadRef)}\u0000${requestId}`;

const isComputerEnding = (status: string): status is ComputerEnding =>
  status === "changed" || status === "failed" || status === "uncertain";

function showNotice(notice: SettingsChangeNotice): void {
  toastManager.add({
    type: notice.type,
    title: notice.title,
    ...(notice.description !== undefined ? { description: notice.description } : {}),
    data: { hideCopyButton: true },
  });
}

/** A save that failed, in words for the agent's note. */
function failureDetail(error: unknown): string {
  const reason = describeUnknownError(error).trim();
  return reason.length > 0
    ? `Couldn't save it on this device: ${reason.slice(0, 200)}`
    : "Couldn't save it on this device";
}

/**
 * Makes the device changes, each store awaited on its own: the client
 * settings in one write, then the theme and alerts. Says which landed and which didn't.
 */
async function makeDeviceChanges(
  edits: ReadonlyArray<CheckedEdit>,
): Promise<SettingsChangeDeviceReport> {
  const applied: string[] = [];
  const failed: Array<{ place: string; detail: string }> = [];
  const clientEdits = edits.filter(({ edit }) => edit.lands === "device" && "patch" in edit);
  if (clientEdits.length > 0) {
    try {
      await updateClientSettingsAndPersist(composeClientPatch(clientEdits));
      applied.push(...clientEdits.map(({ place }) => place));
    } catch (error) {
      const detail = failureDetail(error);
      failed.push(...clientEdits.map(({ place }) => ({ place, detail })));
    }
  }
  for (const { place, edit, value } of edits) {
    if (!(edit.lands === "device" && "store" in edit)) continue;
    try {
      if (edit.store === "theme") {
        const tile =
          typeof value === "string" ? themeTileByName(value, currentLibraryThemes()) : null;
        if (tile === null) throw new Error(`there's no theme called "${String(value)}" here`);
        // A theme new to this device starts its trial: the user keeps it on the bar.
        await switchToTheme(tile);
      } else {
        // Another window may have turned them off since Change was pressed.
        const alerts = usePushAlertsStore.getState();
        if (!alerts.enabled || alerts.permission !== "granted") {
          throw new Error("alerts are off on this device");
        }
        await (edit.alert === "quietAtComputer"
          ? setPushAlertsQuietAtComputer(value === true)
          : setPushAlertKind(edit.alert, value === true));
      }
      applied.push(place);
    } catch (error) {
      failed.push({ place, detail: failureDetail(error) });
    }
  }
  return { applied, failed };
}

/** Tells the thread's computer what the device changes did, for the agent's note. */
async function reportDeviceChanges(
  claim: SettingsChangeClaim,
  device: SettingsChangeDeviceReport,
): Promise<void> {
  const connection = readEnvironmentConnection(claim.threadRef.environmentId);
  if (!connection) return;
  try {
    await connection.client.settingsChange.reportDevice({
      threadId: claim.threadRef.threadId,
      requestId: claim.requestId,
      claimId: claim.claimId,
      device,
    });
  } catch (error) {
    // The note then says the device changes weren't confirmed.
    console.warn("[SETTINGS_CHANGE] device report failed", error);
  }
}

/**
 * The claim won: makes its device changes (unless the computer says not to),
 * reports them, and says what changed and what didn't. Once per claim,
 * whichever of the answer and the live state comes first.
 */
async function finishWonClaim(
  claim: SettingsChangeClaim,
  computer: { readonly ending: ComputerEnding; readonly detail?: string | undefined },
  makeDevice: boolean,
): Promise<void> {
  if (claim.state !== "open") return;
  claim.state = "won";
  claim.stopWatching();
  const device =
    makeDevice && claim.deviceEdits.length > 0 ? await makeDeviceChanges(claim.deviceEdits) : null;
  if (device !== null) void reportDeviceChanges(claim, device);
  showNotice(settingsChangeResultNotice({ lines: claim.lines, computer, device }));
}

/** Read through a call: an await in between may have settled it. */
const hasWon = (claim: SettingsChangeClaim): boolean => claim.state === "won";

/** The claim lost, or there is nothing left to claim: it does nothing more. */
function dropClaim(claim: SettingsChangeClaim): void {
  if (claim.state !== "open") return;
  claim.state = "lost";
  claim.stopWatching();
}

/**
 * Follows the request in the thread's live state while the claim is open:
 * settled with this claim means it won, even if its answer never arrives.
 * Anything else that ends it (another app's claim, Not now elsewhere, the
 * thread archived, the request gone) means this app makes nothing.
 */
function watchClaim(claim: SettingsChangeClaim): () => void {
  let seen: ReadonlyArray<OrchestrationSettingsChangeRequest> | undefined;
  const check = () => {
    const requests = selectEnvironmentState(useStore.getState(), claim.threadRef.environmentId)
      .settingsRequestsByThreadId?.[claim.threadRef.threadId];
    if (requests === seen || claim.state !== "open") return;
    seen = requests;
    // Not loaded (the detail feed ended): wait for its next snapshot.
    if (requests === undefined) return;
    const request = requests.find((candidate) => candidate.requestId === claim.requestId);
    if (request === undefined) return dropClaim(claim);
    if (request.claim !== undefined && request.claim.claimId !== claim.claimId) {
      return dropClaim(claim);
    }
    if (isOpenSettingsChange(request)) return;
    if (request.claim?.claimId === claim.claimId && isComputerEnding(request.status)) {
      void finishWonClaim(claim, { ending: request.status, detail: request.detail }, true);
      return;
    }
    dropClaim(claim);
  };
  const unsubscribe = useStore.subscribe(check);
  // Checked on the next turn, once the claim holds its `stopWatching`.
  queueMicrotask(check);
  return unsubscribe;
}

/** This app's claim on a request: made on the first Change, the same one after. */
function claimFor(input: {
  readonly threadRef: ScopedThreadRef;
  readonly requestId: SettingsChangeRequestId;
  readonly deviceLabel: string;
  readonly deviceEdits: ReadonlyArray<CheckedEdit>;
  readonly lines: ReadonlyArray<SettingsChangeLine>;
}): SettingsChangeClaim {
  const key = claimKey(input.threadRef, input.requestId);
  const existing = claims.get(key);
  if (existing !== undefined) return existing;
  const claim: SettingsChangeClaim = {
    threadRef: input.threadRef,
    requestId: input.requestId,
    claimId: randomUUID(),
    deviceLabel: input.deviceLabel,
    deviceEdits: input.deviceEdits,
    lines: input.lines,
    state: "open",
    stopWatching: () => undefined,
  };
  claims.set(key, claim);
  claim.stopWatching = watchClaim(claim);
  return claim;
}

/** Applies an answer to a claim: it won (make the device changes) or it didn't. */
function applyAnswer(claim: SettingsChangeClaim, answer: SettingsChangeAnswer): void {
  if (isComputerEnding(answer.outcome)) {
    void finishWonClaim(
      claim,
      { ending: answer.outcome, detail: answer.detail },
      answer.makeDeviceChanges,
    );
    return;
  }
  dropClaim(claim);
  if (claim.state === "lost") showNotice(settingsChangeNothingNotice(answer));
}

/**
 * Answers the card on the thread's own computer. Change claims it for this
 * app; Not now changes nothing anywhere. Resolves once the answer is in (or
 * has failed, which a notice says).
 */
export async function answerSettingsChange(input: {
  readonly threadRef: ScopedThreadRef;
  readonly requestId: SettingsChangeRequestId;
  readonly allow: boolean;
  /** Change only: how this app names its device in the claim. */
  readonly deviceLabel: string;
  /** Change only: the device changes, checked with this app's catalog. */
  readonly deviceEdits: ReadonlyArray<CheckedEdit>;
  readonly lines: ReadonlyArray<SettingsChangeLine>;
}): Promise<void> {
  const connection = readEnvironmentConnection(input.threadRef.environmentId);
  if (!connection) {
    addComputerNotConnectedNotice({
      environmentId: input.threadRef.environmentId,
      fallbackLabel: "This computer",
    });
    return;
  }
  if (!input.allow) {
    try {
      const answer = await connection.client.settingsChange.respond({
        threadId: input.threadRef.threadId,
        requestId: input.requestId,
        allow: false,
      });
      showNotice(settingsChangeNothingNotice(answer));
    } catch (error) {
      toastManager.add(failureNotice({ title: "Couldn't answer the agent", error }));
    }
    return;
  }
  const claim = claimFor(input);
  if (claim.state !== "open") return;
  try {
    const answer = await connection.client.settingsChange.respond({
      threadId: input.threadRef.threadId,
      requestId: input.requestId,
      allow: true,
      claim: { claimId: claim.claimId, deviceLabel: claim.deviceLabel },
    });
    applyAnswer(claim, answer);
  } catch (error) {
    // Its live state may already have settled it with this claim; if not,
    // the claim stays for the next Change, and keeps watching.
    if (hasWon(claim)) return;
    toastManager.add(failureNotice({ title: "Couldn't make the change", error }));
  }
}
