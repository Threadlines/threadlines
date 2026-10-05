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
import {
  ACP_DEFAULT_MODEL_SLUG,
  acpModelOptionMappingFor,
  flattenSessionConfigSelectOptions,
} from "./AcpProviderModels.ts";
import { findModelConfigOption, findSessionConfigOption } from "./AcpRuntimeModel.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
} from "./AcpSessionRuntime.ts";

export interface AcpProviderRuntimeInput<Settings extends AcpProviderSettings> extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "sessionControls" | "spawn" | "stderrFailure"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly settings: Settings;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Only a sign-in flow passes this: it receives the sign-in URL the agent
   * prints. Every other runtime fails at once on such a line.
   */
  readonly onSignInUrl?: (url: string) => Effect.Effect<void>;
  /** Overrides the descriptor's `authMethodId` (a sign-in flow names its method). */
  readonly authMethodId?: string;
}

/** What a runtime that meets a sign-in prompt fails with. */
export const acpSignInRequiredMessage = (displayName: string) =>
  `Sign in to ${displayName} in Settings before you continue.`;

export const makeAcpProviderRuntime = <Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  input: AcpProviderRuntimeInput<Settings>,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const {
      childProcessSpawner,
      settings,
      environment,
      onSignInUrl,
      authMethodId,
      onStderrLine,
      ...runtimeOptions
    } = input;
    const planned = descriptor.spawn(settings, input.cwd, environment);
    const spawn = Effect.isEffect(planned) ? yield* planned : planned;
    const signInUrlFromStderr = descriptor.signInUrlFromStderr;
    const resolvedAuthMethodId = authMethodId ?? descriptor.authMethodId;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn,
        cwd: descriptor.resolveSessionCwd ? descriptor.resolveSessionCwd(input.cwd) : input.cwd,
        ...(resolvedAuthMethodId ? { authMethodId: resolvedAuthMethodId } : {}),
        ...(descriptor.sessionControls ? { sessionControls: descriptor.sessionControls } : {}),
        ...(onStderrLine || (onSignInUrl && signInUrlFromStderr)
          ? {
              onStderrLine: (line: string) =>
                Effect.gen(function* () {
                  if (onStderrLine) yield* onStderrLine(line);
                  const url = onSignInUrl ? signInUrlFromStderr?.(line) : undefined;
                  if (url !== undefined && onSignInUrl) yield* onSignInUrl(url);
                }),
            }
          : {}),
        ...(signInUrlFromStderr && !onSignInUrl
          ? {
              stderrFailure: (line: string) =>
                signInUrlFromStderr(line) === undefined
                  ? undefined
                  : acpSignInRequiredMessage(descriptor.presentation.displayName),
            }
          : {}),
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
    "modelOptions" | "resolveModelId" | "sessionControls"
  >;
  readonly runtime: AcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: AcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  const mapping = acpModelOptionMappingFor(input.descriptor);
  const resolveModelId = input.descriptor.resolveModelId ?? defaultResolveAcpModelId;

  const native = input.descriptor.sessionControls === "native";
  // Native controls: setting one option can retire another (or one of its
  // values), so each write is checked against what the agent offers now and
  // a retired one is skipped rather than failing the turn.
  const stillOffered = (update: AcpConfigUpdate) =>
    input.runtime.getConfigOptions.pipe(
      Effect.map((configOptions) => {
        const option = findSessionConfigOption(configOptions, update.configId);
        if (!option) return false;
        if (option.type !== "select") return typeof update.value === "boolean";
        return flattenSessionConfigSelectOptions(option).some(
          (choice) => choice.value === update.value,
        );
      }),
    );
  const applyUpdates = (updates: ReadonlyArray<AcpConfigUpdate>) =>
    Effect.forEach(
      updates,
      (update) =>
        Effect.gen(function* () {
          if (native && !(yield* stillOffered(update))) return;
          yield* input.runtime
            .setConfigOption(update.configId, update.value)
            .pipe(
              Effect.mapError((cause) =>
                input.mapError({ cause, step: "set-config-option", configId: update.configId }),
              ),
            );
        }),
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

    const modelId = resolveModelId(input.model, {
      selections: input.selections,
      configOptions: initialOptions,
    });
    // Native controls: "Default" is the stand-in model of an agent with no
    // model choice, so it is only ever sent when the agent really offers a
    // model by that name. And an agent with nothing to choose from is never
    // asked to set a model: that would fail the turn.
    const modelChoices = flattenSessionConfigSelectOptions(modelOption);
    const hasModelControl =
      !native ||
      (modelChoices.length > 0 &&
        (modelId !== ACP_DEFAULT_MODEL_SLUG ||
          modelChoices.some((choice) => choice.value === ACP_DEFAULT_MODEL_SLUG)));
    if (modelId !== undefined && hasModelControl) {
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
