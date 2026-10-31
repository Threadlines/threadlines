/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@threadlines/contracts";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { usageLimitFromAccountUsage } from "@threadlines/shared/usageLimits";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  carryClaudeUsageAcrossChecks,
  checkClaudeProviderStatus,
  claudeChatAndUsageAccountsDiffer,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  readClaudeNormalAuthEmail,
  readClaudeUsageBreakdown,
  refreshClaudeOAuthCredential,
  seedClaudeProviderUsage,
} from "../Layers/ClaudeProvider.ts";
import { makeClaudeTokenUsageHistoryReader } from "../Layers/ClaudeTokenUsageHistory.ts";
import {
  applyClaudeRateLimitInfoToAccountUsage,
  checkClaudeSignInRenewalDue,
  fetchClaudeAccountUsage,
  readClaudeStoredSignIn,
} from "../Layers/ClaudeUsage.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "../providerStatusCache.ts";
import {
  mergeProviderInstanceEnvironment,
  refreshProviderInstanceEnvironment,
} from "../ProviderInstanceEnvironment.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "../providerMaintenance.ts";
import { throwawayClaudeSpawnViolation } from "../claudeThrowawayIsolation.ts";
import { materializeClaudeAccountFolder } from "./ClaudeAccountFolder.ts";
import { resolveClaudeMaintenanceCapabilities } from "./ClaudeMaintenance.ts";
import {
  claudeInstanceBaseEnvironment,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeConfigDir,
  resolveClaudeMainConfigDir,
} from "./ClaudeHome.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
/**
 * Floor between re-probes triggered by unclassifiable turn errors. One probe
 * answers the "was that an auth death?" question; a failing session that
 * errors on every send must not turn into a probe stream.
 */
const UNCLASSIFIED_ERROR_PROBE_MIN_INTERVAL_MS = 15_000;
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);
// Claude's usage report reads a week of transcripts, and it moves slowly: one
// reading serves the Usage page for a while. One that failed is retried sooner.
const USAGE_BREAKDOWN_TTL = Duration.minutes(10);
const USAGE_BREAKDOWN_RETRY_TTL = Duration.minutes(1);
const CLAUDE_CHAT_AUTH_REQUIRED_MESSAGE = "Claude sign-in expired. Sign in again, then retry.";

function hasTransientClaudeProbeStatus(provider: ServerProvider): boolean {
  return (
    provider.statusReason === "provider_probe_pending" ||
    provider.statusReason === "provider_probe_timeout"
  );
}

function clearClaudeLiveVerifiedStatus(provider: ServerProvider): ServerProvider {
  if (
    provider.message !== CLAUDE_CHAT_AUTH_REQUIRED_MESSAGE &&
    !hasTransientClaudeProbeStatus(provider)
  ) {
    return provider;
  }
  const { message: _message, statusReason: _statusReason, ...verifiedProvider } = provider;
  return verifiedProvider;
}

export function patchClaudeChatAuthState(
  provider: ServerProvider,
  state: "verified" | "unauthenticated",
): ServerProvider | null {
  const previousChatStatus = provider.auth.capabilities?.chat?.status;
  const nextChat =
    state === "verified"
      ? {
          status: "verified" as const,
          detail: "Verified by a live chat.",
        }
      : {
          status: "unavailable" as const,
          detail: "Chat sign-in expired. Sign in again.",
        };
  const nextAuthStatus = state === "verified" ? "authenticated" : "unauthenticated";
  const liveVerificationNeedsStatusRepair =
    state === "verified" &&
    (provider.message === CLAUDE_CHAT_AUTH_REQUIRED_MESSAGE ||
      hasTransientClaudeProbeStatus(provider));
  if (
    previousChatStatus === nextChat.status &&
    provider.auth.status === nextAuthStatus &&
    !liveVerificationNeedsStatusRepair &&
    (state === "verified" || provider.message === CLAUDE_CHAT_AUTH_REQUIRED_MESSAGE)
  ) {
    return null;
  }

  const baseProvider = state === "verified" ? clearClaudeLiveVerifiedStatus(provider) : provider;
  return {
    ...baseProvider,
    status:
      state === "verified"
        ? liveVerificationNeedsStatusRepair
          ? "ready"
          : provider.status
        : provider.status === "disabled"
          ? "disabled"
          : "warning",
    auth: {
      ...provider.auth,
      status: nextAuthStatus,
      capabilities: {
        ...provider.auth.capabilities,
        chat: nextChat,
      },
    },
    ...(state === "unauthenticated" ? { message: CLAUDE_CHAT_AUTH_REQUIRED_MESSAGE } : {}),
  };
}

export type ClaudeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const httpClient = yield* HttpClient.HttpClient;
      const eventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(
        environment,
        claudeInstanceBaseEnvironment(config),
      );
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClaudeSettings;
      // Checked before the folder is touched: laying an account folder over a
      // throwaway run's main folder would re-link a real account's history.
      const isolationViolation = throwawayClaudeSpawnViolation(
        yield* makeClaudeEnvironment(config, processEnv),
      );
      if (isolationViolation !== undefined) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: isolationViolation,
        });
      }
      // An account folder is laid over the main Claude folder before anything
      // runs in it, so the first turn already sees the user's settings and
      // writes its history where other Claude instances can resume it.
      const accountFolder =
        config.accountFolder.trim().length > 0
          ? yield* materializeClaudeAccountFolder({
              mainDir: yield* resolveClaudeMainConfigDir(config, processEnv),
              accountDir: yield* resolveClaudeConfigDir(config, processEnv),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            )
          : undefined;
      const resolveMaintenanceCapabilities = Effect.gen(function* () {
        return yield* resolveClaudeMaintenanceCapabilities(
          yield* resolveClaudeMainConfigDir(config, processEnv),
          { binaryPath: effectiveConfig.binaryPath, env: processEnv, platform: process.platform },
        );
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      let maintenanceCapabilities = yield* resolveMaintenanceCapabilities;
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(
        effectiveConfig,
        processEnv,
        { sharesMainHistory: accountFolder?.sharesMainHistory ?? true },
      );
      // An account that shares the main folder's history would report the
      // same transcripts as the main instance; only one row counts them.
      const readTokenUsage = accountFolder?.sharesMainHistory
        ? undefined
        : yield* makeClaudeTokenUsageHistoryReader(effectiveConfig, processEnv);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const textGeneration = yield* makeClaudeTextGeneration(effectiveConfig, processEnv);

      // The normal sign-in this instance's CLI would act on. A status check
      // reads it to avoid starting, or stopping, a CLI mid-renewal.
      const readStoredSignIn = readClaudeStoredSignIn(effectiveConfig, {
        environment: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const isSignInRenewalDue = checkClaudeSignInRenewalDue({
        readStoredSignIn,
        environment: processEnv,
      });

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, { readStoredSignIn }).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      // One reading at a time: a Usage page opened twice shares the read.
      const usageBreakdownCache = yield* Cache.makeWith(
        () =>
          readClaudeUsageBreakdown(effectiveConfig, processEnv, { readStoredSignIn }).pipe(
            Effect.provideService(Path.Path, path),
          ),
        {
          capacity: 1,
          timeToLive: (exit) =>
            Exit.isSuccess(exit) && exit.value.status === "ready"
              ? USAGE_BREAKDOWN_TTL
              : USAGE_BREAKDOWN_RETRY_TTL,
        },
      );
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
        effectiveConfig,
        processEnv,
      );

      const checkProvider = checkClaudeProviderStatus(
        effectiveConfig,
        () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
        processEnv,
        (settings) =>
          fetchClaudeAccountUsage(
            settings,
            processEnv,
            refreshClaudeOAuthCredential(settings, processEnv, { readStoredSignIn }).pipe(
              Effect.provideService(Path.Path, path),
            ),
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(Path.Path, path),
          ),
        (settings) =>
          readClaudeNormalAuthEmail(settings, processEnv).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        readTokenUsage ? () => readTokenUsage : undefined,
        () => isSignInRenewalDue,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, path),
      );

      // The usage this instance last saved, so a restart (or a rebuild after a
      // settings change) starts from the last reading instead of empty meters.
      const cachedSnapshot = yield* resolveProviderStatusCachePath({
        cacheDir: serverConfig.providerStatusCacheDir,
        instanceId,
      }).pipe(
        Effect.flatMap(readProviderStatusCache),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<ClaudeSettings>({
        get maintenanceCapabilities() {
          return maintenanceCapabilities;
        },
        getSettings: Effect.gen(function* () {
          // From the same filtered base the instance started with: an account
          // must not pick the server's ambient credentials back up.
          refreshProviderInstanceEnvironment(
            environment,
            processEnv,
            claudeInstanceBaseEnvironment(config),
          );
          maintenanceCapabilities = yield* resolveMaintenanceCapabilities;
          return effectiveConfig;
        }),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingClaudeProvider(settings, processEnv).pipe(
            Effect.map(stampIdentity),
            Effect.map((pending) => seedClaudeProviderUsage(pending, cachedSnapshot)),
          ),
        checkProvider,
        reconcileSnapshot: carryClaudeUsageAcrossChecks,
        // Only the advisory is this enrichment's to write. Usage and chat
        // sign-in may have been patched since it started from `snapshot`.
        enrichSnapshot: ({ snapshot, updateSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(({ versionAdvisory }) =>
              updateSnapshot((current) => ({ ...current, versionAdvisory })),
            ),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
        shouldRetrySnapshot: (provider) => provider.statusReason === "provider_probe_timeout",
        retryDelay: Duration.minutes(1),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // Repeated turn failures must not stack probes: one re-probe per
      // window is enough to catch an auth-shaped death, and the snapshot's
      // own refresh semaphore handles the rest. The probes fork into their
      // own scope so they outlive the failing turn's fiber but not the
      // driver instance.
      const lastUnclassifiedErrorProbeMsRef = yield* Ref.make(0);
      const errorProbeScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(errorProbeScope, Exit.void));

      // The adapter is built after the snapshot so mid-turn `rate_limit_event`
      // messages can be folded straight into the live provider snapshot —
      // account usage then updates in real time instead of waiting for the
      // periodic probe of the OAuth usage endpoint.
      const adapter = yield* makeClaudeAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        resolveModelMetadata: (model) =>
          snapshot.getSnapshot.pipe(
            Effect.map((provider) => provider.models.find((candidate) => candidate.slug === model)),
          ),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        // Read live, so turning Claude artifacts off stops a running
        // session's next upload. Unreadable settings count as off.
        artifactsAllowed: serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.enableAgentPages && settings.enableClaudeArtifacts),
          Effect.orElseSucceed(() => false),
        ),
        // Read live too, so a size chosen in Settings applies from the next
        // message. Unreadable settings leave Claude's own default.
        workflowSize: serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.claudeWorkflowSize),
          Effect.orElseSucceed(() => "default" as const),
        ),
        installedCliVersion: snapshot.getSnapshot.pipe(
          Effect.map((provider) => provider.version ?? undefined),
        ),
        // Read live as well. Unreadable settings leave Claude's own rule.
        suggestionsWhenUsageRunsFast: serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.claudeSuggestionsWhenUsageRunsFast),
          Effect.orElseSucceed(() => false),
        ),
        readUsageLimit: Effect.gen(function* () {
          const current = yield* snapshot.getSnapshot;
          // A reading of another account says nothing about this chat's limit.
          if (claudeChatAndUsageAccountsDiffer(current.auth)) return undefined;
          return usageLimitFromAccountUsage(current.accountUsage, yield* Clock.currentTimeMillis);
        }),
        onAccountRateLimitsUpdated: (rateLimitInfo) =>
          Effect.gen(function* () {
            const checkedAt = DateTime.formatIso(yield* DateTime.now);
            yield* snapshot.patchSnapshot((current) => {
              // The event describes the chat account. When usage is read for
              // another account, it is not these numbers' to change.
              if (claudeChatAndUsageAccountsDiffer(current.auth)) return null;
              const accountUsage = applyClaudeRateLimitInfoToAccountUsage(
                current.accountUsage,
                rateLimitInfo,
                checkedAt,
              );
              return accountUsage ? { ...current, accountUsage } : null;
            });
          }),
        onChatAuthStateChanged: (state) =>
          snapshot.patchSnapshot((current) => patchClaudeChatAuthState(current, state)),
        onUnclassifiedRuntimeError: () =>
          Effect.gen(function* () {
            const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
            const lastMs = yield* Ref.get(lastUnclassifiedErrorProbeMsRef);
            if (nowMs - lastMs < UNCLASSIFIED_ERROR_PROBE_MIN_INTERVAL_MS) {
              return;
            }
            yield* Ref.set(lastUnclassifiedErrorProbeMsRef, nowMs);
            yield* snapshot.refresh.pipe(Effect.forkIn(errorProbeScope), Effect.asVoid);
          }),
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        // An account that shares the main folder's history would report the
        // main instance's transcripts again, as with token usage above.
        ...(accountFolder?.sharesMainHistory
          ? {}
          : {
              accountUsage: {
                readUsageBreakdown: Cache.get(usageBreakdownCache, "breakdown"),
              },
            }),
      } satisfies ProviderInstance;
    }),
};
