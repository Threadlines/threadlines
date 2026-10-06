// @effect-diagnostics nodeBuiltinImport:off - a scratch folder for the health check, and file tests for sign-in commands
/**
 * AcpRegistrySupport — the descriptor for a community agent: one of the
 * agents from the ACP registry, which Threadlines installs and runs without
 * having tested it.
 *
 * What that means for the descriptor, against a tested agent's:
 * - it is driven through its own controls (`sessionControls: "native"`):
 *   its mode is the user's to pick, never mapped from the runtime mode;
 * - it starts from what the installer put on disk, with no shell, holding a
 *   lease on those files and a place in the agent's launch gate;
 * - whether it works is only known by starting it, so the status check is a
 *   real `initialize` + `session/new` in an empty folder, rationed (see
 *   `AcpRegistryAgentState`), and "ready" never claims "signed in";
 * - it is told about both forms of terminal sign-in an agent may describe.
 *
 * @module provider/acp/AcpRegistrySupport
 */
import { lstatSync, realpathSync } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ACP_REGISTRY_DRIVER_KIND,
  type AcpRegistryCatalogAgent,
  AcpRegistrySettings,
  type ServerProviderCommunity,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  type AcpRegistryAgentState,
  type AcpRegistryHealth,
  boundAgentText,
  bumpAcpRegistryAuthGeneration,
  currentAcpRegistryHealth,
  readAcpRegistryOffers,
  recordAcpRegistryHealth,
  writeAcpRegistryOffers,
} from "../acpRegistry/AcpRegistryAgentState.ts";
import type {
  AcpRegistryInstalledAgent,
  AcpRegistryInstaller,
} from "../acpRegistry/AcpRegistryInstaller.ts";
import { planAcpRegistryLaunch } from "../acpRegistry/AcpRegistryLaunch.ts";
import {
  type AcpRegistrySignInPlan,
  planAcpRegistrySignIn,
  selectAcpRegistrySignIn,
} from "../acpRegistry/AcpRegistrySignIn.ts";
import { holdLaunchGate } from "../managedRuntime/LaunchGate.ts";
import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "../providerMaintenance.ts";
import { isAcpAuthRequiredError } from "./AcpAdapterSupport.ts";
import type { AcpProviderDescriptor, AcpProviderProbeOutcome } from "./AcpProviderDescriptor.ts";
import {
  buildAcpModelsFromConfigOptions,
  NATIVE_ACP_MODEL_OPTION_MAPPING,
} from "./AcpProviderModels.ts";
import { makeAcpProviderRuntime } from "./AcpProviderRuntime.ts";

/** Some listed agents take a minute to answer their first `session/new`. */
const HEALTH_CHECK_TIMEOUT = "90 seconds";
/** A saved sign-in loads in moments; a browser sign-in would not finish in this. */
const SILENT_AUTHENTICATE_TIMEOUT_MS = 30_000;

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const NO_MAINTENANCE: ProviderMaintenanceCapabilities = {
  provider: ACP_REGISTRY_DRIVER_KIND,
  packageName: null,
  update: null,
  install: null,
  manualUpdateCommand: null,
  advisoryMessage: null,
};

/** What the Providers page shows about where an agent came from. Saved when it is added. */
export type AcpRegistryListing = Pick<
  AcpRegistryCatalogAgent,
  "authors" | "website" | "repository" | "iconSvg" | "source" | "packageSpec" | "host"
>;

/** Why a launch is for something other than a chat. */
export type AcpRegistryLaunchPurpose =
  /** A chat, a status check, a recovery: takes its place in the gate. */
  | { readonly kind: "session" }
  /**
   * A sign-in or sign-out, which has closed the gate itself. `args` and
   * `env` are a terminal method's, in place of the registry's.
   */
  | {
      readonly kind: "signIn";
      readonly args?: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
    };

export interface AcpRegistryDescriptorInput {
  readonly agentId: string;
  /** The agent's name as the registry gave it, bounded. */
  readonly displayName: string;
  /** The agent's folder under `<stateDir>/tools/acp`. */
  readonly agentRoot: string;
  readonly installer: AcpRegistryInstaller;
  readonly state: AcpRegistryAgentState;
  /** Names of the instance's own environment variables: they win over the registry's. */
  readonly instanceVariableNames: ReadonlySet<string>;
  /** Null when the agent was added before its listing could be saved. */
  readonly listing: AcpRegistryListing | null;
  /** The sign-in method the user picked, or "". */
  readonly authMethodId: string;
  readonly purpose?: AcpRegistryLaunchPurpose;
  /** Whether the registry may set this variable for an agent. */
  readonly allowsEnvName: (name: string) => boolean;
  /** Runs when the status should be looked at again (a result came in off the usual schedule). */
  readonly requestRefresh?: Effect.Effect<void>;
}

const isRegularFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

const realPath = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
};

/** The sign-in methods an installed agent offers, each with how Threadlines can run it. */
export function acpRegistrySignInPlans(input: {
  readonly installed: AcpRegistryInstalledAgent;
  readonly authMethods: ReadonlyArray<unknown>;
  readonly allowsEnvName: (name: string) => boolean;
}): ReadonlyArray<AcpRegistrySignInPlan> {
  return planAcpRegistrySignIn({
    // Saved as the agent sent them; `planAcpRegistrySignIn` reads defensively.
    authMethods: input.authMethods.filter(
      (method): method is EffectAcpSchema.AuthMethod =>
        typeof method === "object" &&
        method !== null &&
        typeof (method as { id?: unknown }).id === "string" &&
        typeof (method as { name?: unknown }).name === "string",
    ),
    install: {
      payloadDir: input.installed.payloadDir,
      launch: input.installed.launch,
      nodeProgram: input.installed.node?.node ?? null,
    },
    isFile: isRegularFile,
    realPath,
    allowsEnvName: input.allowsEnvName,
  });
}

const authMethodsOf = (
  initialize: EffectAcpSchema.InitializeResponse | undefined,
): ReadonlyArray<unknown> => (initialize?.authMethods ?? []).slice(0, 16);

export function makeAcpRegistryDescriptor(
  input: AcpRegistryDescriptorInput,
): AcpProviderDescriptor<AcpRegistrySettings> {
  const { installer, state, displayName } = input;
  const purpose = input.purpose ?? { kind: "session" };

  const spawnFailure = (cause: unknown) =>
    new EffectAcpErrors.AcpSpawnError({ command: displayName, cause });

  const maintenanceAction = (verb: "Install" | "Update"): ProviderMaintenanceCommandAction => ({
    command: `${verb} ${displayName} (Threadlines downloads it)`,
    executable: "threadlines",
    args: [],
    lockKey: `acp-registry-${input.agentId}`,
    run: Effect.suspend(() => {
      const recipeDigest = state.requestedRecipeDigest;
      if (!recipeDigest) {
        return Effect.fail({ message: `Look at ${displayName} again before installing it.` });
      }
      return installer.install(recipeDigest).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // Whatever was known belongs to the old files.
            state.checkRequested = true;
            state.updateCandidate = undefined;
          }),
        ),
        Effect.map((installed) => ({
          output: `${displayName} ${installed.receipt.recipe.version} is installed.`,
        })),
        Effect.mapError((error) => ({ message: error.message })),
      );
    }),
  });

  const descriptor: AcpProviderDescriptor<AcpRegistrySettings> = {
    driverKind: ACP_REGISTRY_DRIVER_KIND,
    presentation: { displayName, showInteractionModeToggle: false },
    settingsSchema: AcpRegistrySettings,
    defaultSettings: () => decodeSettings({}),
    maintenance: NO_MAINTENANCE,
    resolveMaintenance: () =>
      Effect.gen(function* () {
        const installed = yield* installer.installed;
        const confirmed = yield* installer.confirmed;
        state.lastInstalled = installed;
        state.confirmedRecipeDigest =
          installed?.receipt.recipeDigest ?? confirmed.at(-1)?.recipeDigest;
        if (!installed) {
          return confirmed.length > 0
            ? { ...NO_MAINTENANCE, install: maintenanceAction("Install") }
            : NO_MAINTENANCE;
        }
        return state.updateCandidate
          ? { ...NO_MAINTENANCE, update: maintenanceAction("Update") }
          : NO_MAINTENANCE;
      }),
    sessionControls: "native",
    spawn: (_settings, cwd, environment) =>
      Effect.gen(function* () {
        // Checked and taken in one step, and held for the process's lifetime,
        // so a sign-in or a removal can wait this process out.
        if (purpose.kind === "session") {
          yield* holdLaunchGate(state.gate, () =>
            spawnFailure(
              new Error(
                `${displayName} is signing in, signing out or being removed. Try again when that's done.`,
              ),
            ),
          );
        }
        const installed = yield* installer.acquire.pipe(Effect.mapError(spawnFailure));
        const plan = planAcpRegistryLaunch({
          launch: installed.launch,
          args:
            purpose.kind === "signIn" && purpose.args
              ? purpose.args
              : installed.receipt.recipe.args,
          recipeEnv: installed.receipt.recipe.env,
          environment: environment ?? process.env,
          instanceVariableNames: input.instanceVariableNames,
          nodeBinDir: installed.node?.binDir ?? null,
          ...(purpose.kind === "signIn" && purpose.env ? { extraEnv: purpose.env } : {}),
        });
        if (!plan.ok) return yield* spawnFailure(new Error(plan.reason));
        return {
          command: plan.command,
          args: [...plan.args],
          cwd,
          env: plan.env,
          inheritEnv: false,
          shell: plan.shell,
        };
      }),
    // Both forms of terminal sign-in: several listed agents describe theirs
    // only in the older one, and two list no method at all without it.
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      auth: { terminal: true },
      // A page to open is only ever shown by the sign-in panel, which asks
      // first. A chat has nowhere to ask, so it doesn't offer to.
      ...(purpose.kind === "signIn" ? { elicitation: { url: {} } } : {}),
      _meta: { "terminal-auth": true },
    },
    // Some agents load a saved sign-in only when asked to authenticate.
    resolveAuthMethodId: () => state.offers?.verifiedAuthMethodId ?? undefined,
    authenticateTimeoutMs: SILENT_AUTHENTICATE_TIMEOUT_MS,
    onAuthRequired: () =>
      Effect.gen(function* () {
        const installed = yield* installer.installed;
        if (!installed) return;
        const stamp = {
          recipeDigest: installed.receipt.recipeDigest,
          authGeneration: state.authGeneration + 1,
        };
        bumpAcpRegistryAuthGeneration(
          state,
          { status: "signedOut", message: null },
          installed.receipt.recipeDigest,
        );
        // A saved sign-in that no longer works is not tried again by itself.
        yield* writeAcpRegistryOffers(state, input.agentRoot, stamp, (current) => ({
          authMethods: current?.authMethods ?? [],
          canSignOut: current?.canSignOut ?? false,
          reportedVersion: current?.reportedVersion ?? null,
          models: current?.models ?? null,
          verifiedAuthMethodId: null,
        }));
        if (input.requestRefresh) yield* input.requestRefresh;
      }),
    notInstalledMessage: `${displayName} isn't installed.`,
    detect: () =>
      installer.installed.pipe(
        Effect.map((installed) =>
          installed
            ? { status: "found" as const, path: installed.launch.program }
            : { status: "notFound" as const },
        ),
      ),
    probe: (settings, environment) =>
      Effect.gen(function* () {
        const installed = yield* installer.installed;
        state.lastInstalled = installed;
        if (!installed) {
          return {
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: `${displayName} isn't installed.`,
            models: [],
          } satisfies AcpProviderProbeOutcome;
        }
        const { recipeDigest } = installed.receipt;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const known = () => currentAcpRegistryHealth(state, recipeDigest, Date.now());
        let health = known();
        if (!health) {
          // One start of the agent at a time; a check that waited takes the
          // result of the one it waited for.
          health = yield* state.checkLock.withPermit(
            Effect.suspend(() => {
              const settled = known();
              return settled
                ? Effect.succeed<AcpRegistryHealth | undefined>(settled)
                : checkHealth(installed, settings, environment, spawner);
            }),
          );
        }
        const offers = yield* readAcpRegistryOffers(state, input.agentRoot, recipeDigest);
        const version = installed.receipt.recipe.version;
        const latest = state.updateCandidate
          ? { latestVersion: state.updateCandidate.version }
          : {};
        const models = offers?.models ?? [];
        if (!health) {
          // Signing in or being removed right now: nothing new to say.
          return {
            installed: true,
            version,
            status: "warning",
            statusReason: "provider_probe_pending",
            auth: { status: "unknown" },
            message: `Checking ${displayName}...`,
            models,
            ...latest,
          } satisfies AcpProviderProbeOutcome;
        }
        switch (health.status) {
          case "ready":
            // Ready, not "signed in": an agent that needs no sign-in looks the same.
            return {
              installed: true,
              version,
              status: "ready",
              auth: { status: "unknown" },
              models,
              ...latest,
            } satisfies AcpProviderProbeOutcome;
          case "signedOut":
            return {
              installed: true,
              version,
              status: "error",
              auth: { status: "unauthenticated" },
              message: health.message ?? `Sign in to ${displayName} to use it.`,
              models,
              ...latest,
            } satisfies AcpProviderProbeOutcome;
          default:
            return {
              installed: true,
              version,
              status: "warning",
              auth: { status: "unknown" },
              message: `${health.message ?? `${displayName} didn't start.`} This agent may not work with Threadlines yet.`,
              models,
              ...latest,
            } satisfies AcpProviderProbeOutcome;
        }
      }),
    snapshotExtras: () => ({ community: community() }),
  };

  /**
   * Starts the agent once in an empty folder and records what it learned.
   * Undefined when the agent can't be started right now (its gate is
   * closed): the last result stands.
   */
  const checkHealth = (
    installed: AcpRegistryInstalledAgent,
    settings: AcpRegistrySettings,
    environment: NodeJS.ProcessEnv,
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  ): Effect.Effect<AcpRegistryHealth | undefined> =>
    Effect.gen(function* () {
      if (state.gate.busy) return undefined;
      state.checkRequested = false;
      const stamp = {
        recipeDigest: installed.receipt.recipeDigest,
        authGeneration: state.authGeneration,
      };
      const startOnce = (scratch: string) =>
        Effect.gen(function* () {
          const acp = yield* makeAcpProviderRuntime(descriptor, {
            settings,
            environment,
            childProcessSpawner: spawner,
            cwd: scratch,
            clientInfo: { name: "threadlines-provider-probe", version: "0.0.0" },
          });
          const started = yield* acp
            .start()
            .pipe(Effect.timeoutOption(HEALTH_CHECK_TIMEOUT), Effect.exit);
          return {
            started,
            initialize: yield* acp.getInitializeResult,
            configOptions: yield* acp.getConfigOptions,
          };
        }).pipe(Effect.scoped);
      // A folder that can't be made ends as a failed check below, like an
      // agent that can't start: a status check never fails by itself.
      const outcome = yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "threadlines-agent-check-")),
          catch: () => new Error(`Couldn't make a folder to start ${displayName} in.`),
        }),
        startOnce,
        (scratch) =>
          Effect.promise(() =>
            NodeFS.rm(scratch, { recursive: true, force: true }).catch(() => undefined),
          ),
      ).pipe(Effect.exit);

      const verdict = (
        status: AcpRegistryHealth["status"],
        message: string | null,
      ): AcpRegistryHealth => ({ status, message, ...stamp, checkedAtMs: Date.now() });
      const failureOf = (cause: Cause.Cause<unknown>) => Cause.squash(cause);

      let health: AcpRegistryHealth;
      if (Exit.isFailure(outcome)) {
        // It never got as far as `initialize`.
        health = verdict("problem", boundAgentText(messageOf(failureOf(outcome.cause)), 300));
      } else {
        const { started, initialize, configOptions } = outcome.value;
        const opened = Exit.isSuccess(started) && Option.isSome(started.value);
        if (initialize) {
          // Kept whether or not a session then opened: a signed-out agent
          // still says how to sign in.
          yield* writeAcpRegistryOffers(state, input.agentRoot, stamp, (current) => ({
            authMethods: authMethodsOf(initialize),
            canSignOut:
              initialize.agentCapabilities?.auth !== undefined &&
              initialize.agentCapabilities.auth !== null &&
              "logout" in initialize.agentCapabilities.auth,
            reportedVersion: boundAgentText(initialize.agentInfo?.version, 64),
            models: opened
              ? buildAcpModelsFromConfigOptions({
                  configOptions,
                  mapping: NATIVE_ACP_MODEL_OPTION_MAPPING,
                  sharedCapabilities: true,
                  defaultModelWhenNone: true,
                })
              : (current?.models ?? null),
            verifiedAuthMethodId: current?.verifiedAuthMethodId ?? null,
          }));
        }
        if (opened) {
          health = verdict("ready", null);
        } else if (Exit.isSuccess(started)) {
          health = verdict("problem", `${displayName} didn't answer in time.`);
        } else {
          const failure = failureOf(started.cause);
          health = isAcpAuthRequiredError(failure)
            ? verdict("signedOut", null)
            : verdict("problem", boundAgentText(messageOf(failure), 300));
        }
      }
      recordAcpRegistryHealth(state, health);
      // Dropped when a sign-in or an `auth_required` came in meanwhile.
      return state.health === health
        ? health
        : currentAcpRegistryHealth(state, stamp.recipeDigest, Date.now());
    });

  const community = (): ServerProviderCommunity => {
    const offers = state.offers;
    const installed = state.lastInstalled;
    const plans =
      installed && offers
        ? acpRegistrySignInPlans({
            installed,
            authMethods: offers.authMethods,
            allowsEnvName: input.allowsEnvName,
          })
        : [];
    const selected = selectAcpRegistrySignIn(plans, input.authMethodId);
    return {
      agentId: input.agentId,
      authors: input.listing?.authors ?? [],
      website: input.listing?.website ?? null,
      repository: input.listing?.repository ?? null,
      iconSvg: input.listing?.iconSvg ?? null,
      source:
        input.listing?.source ?? (installed?.receipt.recipe.kind === "npm" ? "npm" : "download"),
      packageSpec: input.listing?.packageSpec ?? null,
      host: input.listing?.host ?? null,
      verification: installed?.receipt.verification ?? null,
      confirmedRecipeDigest: state.confirmedRecipeDigest ?? null,
      updateCandidate: state.updateCandidate ?? null,
      reportedVersionChanged:
        offers !== undefined &&
        offers.firstReportedVersion !== null &&
        offers.reportedVersion !== null &&
        offers.firstReportedVersion !== offers.reportedVersion,
      signIn: {
        methods: plans.map((plan) => plan.method),
        selected: selected?.method.id ?? null,
        canSignOut: offers?.canSignOut ?? false,
      },
    };
  };

  return descriptor;
}

const messageOf = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);
