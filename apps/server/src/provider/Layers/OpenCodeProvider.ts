/**
 * OpenCodeProvider — the OpenCode 2 provider snapshot: install, version,
 * models, slash commands and skills.
 *
 * Models come from the running server, so the catalog is exactly what the
 * user's OpenCode can use right now. OpenCode has no "signed in" flag: with no
 * credentials it still serves its free Zen models, so a catalog of only those
 * is ready but nudges the user to connect a provider.
 *
 * @module provider/Layers/OpenCodeProvider
 */
import {
  type ModelCapabilities,
  type OpenCodeSettings,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { type OpenCodeClient, OpenCodeError, runOpenCode } from "../opencode/OpenCodeClient.ts";
import {
  isOpenCodeNotInstalledError,
  isOpenCodeOneVersion,
  isSupportedOpenCodeVersion,
  MINIMUM_OPENCODE_VERSION,
  probeOpenCodeVersion,
} from "../opencode/OpenCodeServer.ts";
import { OPENCODE_INSTALL_COMMAND } from "../opencode/OpenCodeBinary.ts";
import type { OpenCodeServerManagerShape } from "../opencode/OpenCodeServerManager.ts";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("opencode");

export const OPENCODE_PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: true,
} as const;

const CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** OpenCode's own provider; without a key it serves only its free models. */
const OPENCODE_ZEN_PROVIDER = "opencode";

function titleCase(value: string): string {
  return value
    .split(/[-_]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

/** Reasoning variants, with OpenCode's usual middle ground preselected. */
export function openCodeVariantCapabilities(variants: ReadonlyArray<string>): ModelCapabilities {
  const usable = variants.filter((variant) => variant !== "default");
  if (usable.length === 0) return CUSTOM_MODEL_CAPABILITIES;
  const preferred = ["medium", "high"].find((variant) => usable.includes(variant)) ?? usable[0]!;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        options: usable.map((variant) =>
          variant === preferred
            ? { id: variant, label: titleCase(variant), isDefault: true as const }
            : { id: variant, label: titleCase(variant) },
        ),
        currentValue: preferred,
      },
    ],
  });
}

interface OpenCodeCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * Providers the user connected, by name: any listed model that costs money
   * or comes from a provider other than OpenCode's free Zen tier. Empty when
   * only the free models are available.
   */
  readonly connectedProviders: ReadonlyArray<string>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

/** The server lists nothing for a moment while a directory loads. */
const retryWhileEmpty = <A>(load: Effect.Effect<ReadonlyArray<A>, OpenCodeError>) =>
  load.pipe(
    Effect.flatMap((items) =>
      items.length > 0 ? Effect.succeed(items) : Effect.fail("empty" as const),
    ),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(250)), times: 20 }),
    Effect.catch((error) => (error === "empty" ? Effect.succeed([]) : Effect.fail(error))),
  );

export const loadOpenCodeCatalog = (
  client: OpenCodeClient,
  directory: string,
): Effect.Effect<OpenCodeCatalog, OpenCodeError> =>
  Effect.gen(function* () {
    const location = { location: { directory } };
    const [models, providers, commands, skills] = yield* Effect.all(
      [
        retryWhileEmpty(
          runOpenCode("model.list", (signal) => client.model.list(location, { signal })).pipe(
            Effect.map((result) => result.data ?? []),
          ),
        ),
        runOpenCode("provider.list", (signal) => client.provider.list(location, { signal })).pipe(
          Effect.map((result) => result.data ?? []),
          Effect.orElseSucceed(() => []),
        ),
        runOpenCode("command.list", (signal) => client.command.list(location, { signal })).pipe(
          Effect.map((result) => result.data ?? []),
          Effect.orElseSucceed(() => []),
        ),
        runOpenCode("skill.list", (signal) => client.skill.list(location, { signal })).pipe(
          Effect.map((result) => result.data ?? []),
          Effect.orElseSucceed(() => []),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
    return {
      models: models
        .flatMap((model): ReadonlyArray<ServerProviderModel> => {
          const name = nonEmptyTrimmed(model.name) ?? model.id;
          const subProvider = nonEmptyTrimmed(providerNames.get(model.providerID));
          return [
            {
              slug: `${model.providerID}/${model.id}`,
              name,
              ...(subProvider ? { subProvider } : {}),
              isCustom: false,
              capabilities: openCodeVariantCapabilities(
                (model.variants ?? []).map((variant) => variant.id),
              ),
            },
          ];
        })
        .toSorted((left, right) => left.name.localeCompare(right.name)),
      connectedProviders: [
        ...new Set(
          models
            .filter(
              (model) =>
                model.providerID !== OPENCODE_ZEN_PROVIDER ||
                (model.cost ?? []).some((tier) => tier.input > 0 || tier.output > 0),
            )
            .map((model) => providerNames.get(model.providerID) ?? model.providerID),
        ),
      ].toSorted((left, right) => left.localeCompare(right)),
      slashCommands: commands.flatMap((command) => {
        const name = nonEmptyTrimmed(command.name);
        if (!name) return [];
        const description = nonEmptyTrimmed(command.description);
        return [{ name, ...(description ? { description } : {}) }];
      }),
      skills: skills.flatMap((skill) => {
        const name = nonEmptyTrimmed(skill.id);
        const path = nonEmptyTrimmed(skill.path);
        if (!name || !path) return [];
        const description = nonEmptyTrimmed(skill.description);
        const displayName = nonEmptyTrimmed(skill.name);
        return [
          {
            name,
            path,
            enabled: true,
            ...(displayName && displayName !== name ? { displayName } : {}),
            ...(description ? { description } : {}),
          },
        ];
      }),
    };
  });

const snapshot = (input: {
  readonly settings: OpenCodeSettings;
  readonly checkedAt: string;
  readonly probe: ProviderProbeResult;
  readonly catalog?: OpenCodeCatalog;
}): ServerProviderDraft =>
  buildServerProvider({
    presentation: OPENCODE_PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.catalog?.models ?? [],
      PROVIDER,
      input.settings.customModels,
      CUSTOM_MODEL_CAPABILITIES,
    ),
    ...(input.catalog ? { modelCatalogSource: "live" as const } : {}),
    ...(input.catalog?.slashCommands.length ? { slashCommands: input.catalog.slashCommands } : {}),
    ...(input.catalog?.skills.length ? { skills: input.catalog.skills } : {}),
    probe: input.probe,
  });

function openCodeProviderLabel(providers: ReadonlyArray<string>): string {
  return providers.length <= 3
    ? providers.join(", ")
    : `${providers.slice(0, 3).join(", ")} and ${providers.length - 3} more`;
}

export const makePendingOpenCodeProvider = (
  settings: OpenCodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot({
      settings,
      checkedAt: DateTime.formatIso(now),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "OpenCode has not been checked yet."
          : "OpenCode is turned off in Threadlines settings.",
      },
    }),
  );

export const checkOpenCodeProviderStatus = (input: {
  readonly settings: OpenCodeSettings;
  readonly manager: OpenCodeServerManagerShape;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** A 1.x binary here has an Update that moves it to OpenCode 2. */
  readonly canMoveToOpenCodeTwo: boolean;
}): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const { settings } = input;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const failed = (
      probe: Omit<ProviderProbeResult, "auth" | "status"> & { readonly message: string },
    ) =>
      snapshot({
        settings,
        checkedAt,
        probe: { ...probe, status: "error", auth: { status: "unknown" } },
      });

    if (!settings.enabled) {
      return yield* makePendingOpenCodeProvider(settings);
    }

    const external = settings.serverUrl.trim().length > 0;
    let version: string | null = null;
    if (!external) {
      const probed = yield* probeOpenCodeVersion({
        binaryPath: settings.binaryPath,
        environment: input.environment,
      }).pipe(Effect.result);
      if (probed._tag === "Failure") {
        return failed({
          installed: !isOpenCodeNotInstalledError(probed.failure),
          version: null,
          message: isOpenCodeNotInstalledError(probed.failure)
            ? "OpenCode is not installed. Install OpenCode 2 to use it in Threadlines."
            : probed.failure.detail,
        });
      }
      version = probed.success.version ?? null;
      if (!version) {
        return failed({
          installed: true,
          version: null,
          message: `Could not read OpenCode's version from \`${settings.binaryPath} --version\`.`,
        });
      }
      if (!isSupportedOpenCodeVersion(version)) {
        return failed({
          installed: true,
          version,
          // OpenCode 2 is a separate package. The driver turns Update into
          // the move for install methods it knows; others install by hand.
          message: !isOpenCodeOneVersion(version)
            ? `OpenCode ${version} is too old. Update to ${MINIMUM_OPENCODE_VERSION} or newer.`
            : input.canMoveToOpenCodeTwo
              ? `Threadlines needs OpenCode 2, and \`${settings.binaryPath}\` is OpenCode ${version}. Update moves it to OpenCode 2 and keeps your OpenCode chats.`
              : `Threadlines needs OpenCode 2, and \`${settings.binaryPath}\` is OpenCode ${version}. Install OpenCode 2 with \`${process.platform === "win32" ? "npm install -g @opencode/cli" : OPENCODE_INSTALL_COMMAND}\`. If Threadlines still finds 1.x afterwards, set Binary path to the new one.`,
        });
      }
    }

    const installedVersion = version;
    const catalog = yield* input.manager
      .withServer((active) =>
        Effect.gen(function* () {
          version = version ?? active.server.version;
          // The binary was updated under a running server: restart it once
          // nothing is using it, so new sessions get the new version.
          if (installedVersion && installedVersion !== active.server.version) {
            yield* input.manager.retire;
          }
          return yield* loadOpenCodeCatalog(active.server.client, input.cwd);
        }),
      )
      .pipe(Effect.result);
    if (catalog._tag === "Failure") {
      return failed({ installed: true, version, message: catalog.failure.detail });
    }
    const { connectedProviders, models } = catalog.success;
    const connected = connectedProviders.length > 0;
    return snapshot({
      settings,
      checkedAt,
      catalog: catalog.success,
      probe: {
        installed: true,
        version,
        status: models.length > 0 ? "ready" : "warning",
        // OpenCode's free models need no account, so a catalog of only those
        // is signed in, labelled for what it is; "Sign in again" adds a
        // provider. No models at all is the one state that needs a sign-in.
        auth:
          models.length === 0
            ? { status: "unauthenticated" }
            : {
                status: "authenticated",
                type: "opencode",
                label: connected ? openCodeProviderLabel(connectedProviders) : "Free models only",
              },
        message:
          models.length === 0
            ? "OpenCode has no models it can use yet. Sign in to connect a provider."
            : connected
              ? `${models.length} model${models.length === 1 ? "" : "s"} available through ${external ? "the configured OpenCode server" : "OpenCode"}.`
              : "Only OpenCode's free models are available. Sign in again to connect your own provider.",
      },
    });
  });
