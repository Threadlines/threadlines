/**
 * AcpProviderRuntime — spawns an `AcpSessionRuntime` for a descriptor and
 * applies a Threadlines model selection to a live session.
 *
 * Selection order follows the agent's own `configOptions` order: options
 * listed before the model (fx's `provider`) are set first, then the model,
 * then the options that appear once the model is known (Cursor's per-model
 * reasoning / context toggles).
 *
 * @module provider/acp/AcpProviderRuntime
 */
import type { ProviderOptionSelection } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import type {
  AcpConfigUpdate,
  AcpProviderDescriptor,
  AcpProviderSettings,
} from "./AcpProviderDescriptor.ts";
import { GENERIC_ACP_MODEL_OPTION_MAPPING } from "./AcpProviderModels.ts";
import { findModelConfigOption } from "./AcpRuntimeModel.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
} from "./AcpSessionRuntime.ts";

export interface AcpProviderRuntimeInput<Settings extends AcpProviderSettings> extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly settings: Settings;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeAcpProviderRuntime = <Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  input: AcpProviderRuntimeInput<Settings>,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const { childProcessSpawner, settings, environment, ...runtimeOptions } = input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: descriptor.spawn(settings, input.cwd, environment),
        cwd: descriptor.resolveSessionCwd ? descriptor.resolveSessionCwd(input.cwd) : input.cwd,
        ...(descriptor.authMethodId ? { authMethodId: descriptor.authMethodId } : {}),
        ...(descriptor.clientCapabilities
          ? { clientCapabilities: descriptor.clientCapabilities }
          : {}),
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

export interface AcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

interface AcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function defaultResolveAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function applyAcpModelSelection<E>(input: {
  readonly descriptor: Pick<
    AcpProviderDescriptor<AcpProviderSettings>,
    "modelOptions" | "resolveModelId"
  >;
  readonly runtime: AcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: AcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  const mapping = input.descriptor.modelOptions ?? GENERIC_ACP_MODEL_OPTION_MAPPING;
  const resolveModelId = input.descriptor.resolveModelId ?? defaultResolveAcpModelId;

  const applyUpdates = (updates: ReadonlyArray<AcpConfigUpdate>) =>
    Effect.forEach(
      updates,
      (update) =>
        input.runtime
          .setConfigOption(update.configId, update.value)
          .pipe(
            Effect.mapError((cause) =>
              input.mapError({ cause, step: "set-config-option", configId: update.configId }),
            ),
          ),
      { discard: true },
    );

  return Effect.gen(function* () {
    const initialOptions = yield* input.runtime.getConfigOptions;
    const modelOption = findModelConfigOption(initialOptions);
    const modelIndex = modelOption ? initialOptions.indexOf(modelOption) : -1;
    const indexOf = (configId: string) =>
      initialOptions.findIndex((option) => option.id === configId);

    const leadingUpdates = mapping
      .configUpdatesFromSelections(initialOptions, input.selections)
      .filter((update) => modelIndex >= 0 && indexOf(update.configId) < modelIndex);
    yield* applyUpdates(leadingUpdates);

    const modelId = resolveModelId(input.model);
    if (modelId !== undefined) {
      yield* input.runtime
        .setModel(modelId)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-model" })));
    }

    const refreshedOptions = yield* input.runtime.getConfigOptions;
    const trailingUpdates = mapping
      .configUpdatesFromSelections(refreshedOptions, input.selections)
      .filter((update) => !leadingUpdates.some((applied) => applied.configId === update.configId));
    yield* applyUpdates(trailingUpdates);
  });
}
