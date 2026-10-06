// @effect-diagnostics nodeBuiltinImport:off - reads and writes the agent's saved offers
/**
 * AcpRegistryAgentState — what Threadlines knows about one community agent
 * while it runs, kept apart in three parts:
 *
 * - **Installed**: the files on disk. Not here; ask the installer.
 * - **Offers**: what the agent said about itself (sign-in methods, models,
 *   its own version). Saved beside its files, since it costs a start of the
 *   agent to learn. The `initialize` half is kept even when the agent then
 *   refuses a session, so a signed-out agent still lists how to sign in.
 * - **Health**: ready, not signed in, or a problem, from a real start of
 *   the agent. Memory only: after a restart it reads "checking" until a
 *   fresh check has run.
 *
 * Every result is stamped with the recipe digest and the "auth generation"
 * it was made under. Sign-in, sign-out and an `auth_required` answer bump
 * the generation, and an update changes the digest, so a slow check that
 * started before either can't overwrite what came after.
 *
 * One state per agent per process, shared by every rebuild of its instance.
 *
 * @module provider/acpRegistry/AcpRegistryAgentState
 */
import { randomBytes } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { ServerProviderModel } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { type LaunchGate, makeLaunchGate } from "../managedRuntime/LaunchGate.ts";
import type { AcpRegistryInstalledAgent } from "./AcpRegistryInstaller.ts";

/** How long a health result stands before the next status check starts the agent again. */
export const ACP_REGISTRY_HEALTH_MAX_AGE_MS = 60 * 60 * 1000;

const OFFERS_FILE = "offers.json";
const MAX_REPORTED_TEXT = 2000;

const AcpRegistryOffers = Schema.Struct({
  /** The recipe these were read from. Offers of another recipe are not used. */
  recipeDigest: Schema.String,
  /** The agent's `authMethods`, as it sent them (bounded when read). */
  authMethods: Schema.Array(Schema.Unknown),
  canSignOut: Schema.Boolean,
  /** The version the agent reported the first time this recipe was checked, and now. */
  firstReportedVersion: Schema.NullOr(Schema.String),
  reportedVersion: Schema.NullOr(Schema.String),
  /** The catalog of the last session that opened; null until one has. */
  models: Schema.NullOr(Schema.Array(ServerProviderModel)),
  /**
   * The `agent` sign-in method a sign-in through Threadlines last completed
   * with. Later launches call `authenticate` with it first: some agents
   * load their saved sign-in only then.
   */
  verifiedAuthMethodId: Schema.NullOr(Schema.String),
});
export type AcpRegistryOffers = typeof AcpRegistryOffers.Type;

const AcpRegistryOffersJson = Schema.fromJsonString(AcpRegistryOffers);
const decodeOffers = Schema.decodeUnknownOption(AcpRegistryOffersJson);
const encodeOffers = Schema.encodeSync(AcpRegistryOffersJson);

export type AcpRegistryHealthStatus = "ready" | "signedOut" | "problem";

export interface AcpRegistryHealth {
  readonly status: AcpRegistryHealthStatus;
  /** `problem`: the agent's own first line, bounded. `signedOut`: what it said, if anything. */
  readonly message: string | null;
  readonly recipeDigest: string;
  readonly authGeneration: number;
  readonly checkedAtMs: number;
}

export interface AcpRegistryAgentState {
  readonly agentId: string;
  /** Closed by sign-in, sign-out and removal; held by every process of the agent. */
  readonly gate: LaunchGate;
  /** One real check at a time. */
  readonly checkLock: Semaphore.Semaphore;
  authGeneration: number;
  health: AcpRegistryHealth | undefined;
  offers: AcpRegistryOffers | undefined;
  /** Whether `offers` has been read from disk yet. */
  offersLoaded: boolean;
  /** The next status check starts the agent whatever the last result's age. */
  checkRequested: boolean;
  /** The registry's newer listing for this agent, if any. Memory only. */
  updateCandidate: { readonly version: string; readonly recipeDigest: string } | undefined;
  /** What the last status check found on disk, for the snapshot (built without I/O). */
  lastInstalled: AcpRegistryInstalledAgent | undefined;
  /** The recipe to name when installing again: the installed one, else the last confirmed. */
  confirmedRecipeDigest: string | undefined;
  /** The recipe a confirmed install or update is about to use; read when its action runs. */
  requestedRecipeDigest: string | undefined;
}

const states = new Map<string, AcpRegistryAgentState>();

/** The agent's state in this process, created on first use. */
export function acpRegistryAgentState(agentId: string): AcpRegistryAgentState {
  let state = states.get(agentId);
  if (!state) {
    state = {
      agentId,
      gate: makeLaunchGate(),
      checkLock: Semaphore.makeUnsafe(1),
      authGeneration: 0,
      health: undefined,
      offers: undefined,
      offersLoaded: false,
      checkRequested: true,
      updateCandidate: undefined,
      lastInstalled: undefined,
      confirmedRecipeDigest: undefined,
      requestedRecipeDigest: undefined,
    };
    states.set(agentId, state);
  }
  return state;
}

/** Forgets an agent that was removed. */
export function forgetAcpRegistryAgentState(agentId: string): void {
  states.delete(agentId);
}

/** Agent-supplied text, cut to what is safe to store and show: one line, bounded. */
export function boundAgentText(value: unknown, max = MAX_REPORTED_TEXT): string | null {
  if (typeof value !== "string") return null;
  const line = value
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ? line.slice(0, max) : null;
}

/** The offers that apply to `recipeDigest`: the saved ones, read once, if they are of that recipe. */
export const readAcpRegistryOffers = (
  state: AcpRegistryAgentState,
  agentRoot: string,
  recipeDigest: string,
): Effect.Effect<AcpRegistryOffers | undefined> =>
  Effect.promise(async () => {
    if (!state.offersLoaded) {
      state.offersLoaded = true;
      const raw = await NodeFS.readFile(NodePath.join(agentRoot, OFFERS_FILE), "utf8").catch(
        () => undefined,
      );
      const decoded = raw === undefined ? undefined : Option.getOrUndefined(decodeOffers(raw));
      // What a check in this run already learned is newer than the file.
      state.offers ??= decoded;
    }
    return state.offers?.recipeDigest === recipeDigest ? state.offers : undefined;
  });

/**
 * Records what a start of the agent learned, unless the recipe or the auth
 * generation has moved on since it began. Best effort on disk: the copy in
 * memory is what this run uses.
 */
export const writeAcpRegistryOffers = (
  state: AcpRegistryAgentState,
  agentRoot: string,
  stamp: { readonly recipeDigest: string; readonly authGeneration: number },
  update: (
    current: AcpRegistryOffers | undefined,
  ) => Omit<AcpRegistryOffers, "recipeDigest" | "firstReportedVersion">,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (stamp.authGeneration !== state.authGeneration) return;
    const current = state.offers?.recipeDigest === stamp.recipeDigest ? state.offers : undefined;
    const next = update(current);
    state.offers = {
      ...next,
      recipeDigest: stamp.recipeDigest,
      firstReportedVersion: current?.firstReportedVersion ?? next.reportedVersion,
    };
    state.offersLoaded = true;
    const target = NodePath.join(agentRoot, OFFERS_FILE);
    // A name of its own, so two writers at the same moment don't share one.
    const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await NodeFS.writeFile(temp, `${encodeOffers(state.offers)}\n`, { mode: 0o600 })
      .then(() => NodeFS.rename(temp, target))
      .catch(() => NodeFS.rm(temp, { force: true }).catch(() => undefined));
  });

/** Records a check's verdict, unless the recipe or the auth generation moved on while it ran. */
export function recordAcpRegistryHealth(
  state: AcpRegistryAgentState,
  health: AcpRegistryHealth,
): void {
  if (health.authGeneration !== state.authGeneration) return;
  state.health = health;
}

/**
 * The agent answered `auth_required`, or a sign-in or sign-out ran: whatever
 * was known about its sign-in is out of date. Results from processes started
 * before this are dropped when they arrive.
 */
export function bumpAcpRegistryAuthGeneration(
  state: AcpRegistryAgentState,
  health?: { readonly status: AcpRegistryHealthStatus; readonly message: string | null },
  recipeDigest?: string,
  nowMs: number = Date.now(),
): void {
  state.authGeneration += 1;
  state.health =
    health && recipeDigest
      ? { ...health, recipeDigest, authGeneration: state.authGeneration, checkedAtMs: nowMs }
      : undefined;
  if (!health) state.checkRequested = true;
}

/** The health to answer a status check with, or undefined when the agent has to be started to know. */
export function currentAcpRegistryHealth(
  state: AcpRegistryAgentState,
  recipeDigest: string,
  nowMs: number,
): AcpRegistryHealth | undefined {
  const health = state.health;
  if (!health || state.checkRequested) return undefined;
  if (health.recipeDigest !== recipeDigest || health.authGeneration !== state.authGeneration) {
    return undefined;
  }
  return nowMs - health.checkedAtMs <= ACP_REGISTRY_HEALTH_MAX_AGE_MS ? health : undefined;
}
