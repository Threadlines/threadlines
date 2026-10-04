import {
  type AgentInvitesMode,
  type AgentThreadsMode,
  ServerSettings,
  type ServerSettingsPatch,
} from "@threadlines/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

type ModelSelectionPatch = NonNullable<ServerSettingsPatch["textGenerationModelSelection"]>;
type NullableModelSelectionPatch = ModelSelectionPatch | null | undefined;
type ModelSelectionValue = ServerSettings["textGenerationModelSelection"];

function shouldReplaceTextGenerationModelSelection(
  patch: ModelSelectionPatch | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

/**
 * Applies a server settings patch while treating textGenerationModelSelection as
 * replace-on-provider/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const backupSelectionPatch = patch.textGenerationBackupModelSelection;
  const writerSelectionPatch = patch.sourceControlWriterModelSelection;
  const {
    automaticGitFetchInterval,
    newThreadModelSelection,
    newThreadRoomAgents,
    ...patchForMerge
  } = patch;
  const next = deepMerge(current, patchForMerge);
  // Whole values: merging would keep an old default's options in a new one,
  // and turns a list into an object.
  let nextWithReplacements = {
    ...next,
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(newThreadModelSelection !== undefined ? { newThreadModelSelection } : {}),
    ...(newThreadRoomAgents !== undefined ? { newThreadRoomAgents } : {}),
  };

  const applyModelSelectionPatch = (
    currentSelection: ModelSelectionValue,
    modelSelectionPatch: ModelSelectionPatch,
  ): ModelSelectionValue => {
    const instanceId = modelSelectionPatch.instanceId ?? currentSelection.instanceId;
    const model = modelSelectionPatch.model ?? currentSelection.model;
    const options = shouldReplaceTextGenerationModelSelection(modelSelectionPatch)
      ? modelSelectionPatch.options
      : mergeModelSelectionOptionsById({
          current: currentSelection.options,
          patch: modelSelectionPatch.options,
        });

    return createModelSelection(instanceId, model, options);
  };

  const applyNullableModelSelectionPatch = (
    currentSelection: ModelSelectionValue | null,
    modelSelectionPatch: NullableModelSelectionPatch,
  ): ModelSelectionValue | null | undefined => {
    if (modelSelectionPatch === undefined) {
      return undefined;
    }
    if (modelSelectionPatch === null) {
      return null;
    }
    return applyModelSelectionPatch(
      currentSelection ?? current.textGenerationModelSelection,
      modelSelectionPatch,
    );
  };

  if (selectionPatch) {
    nextWithReplacements = {
      ...nextWithReplacements,
      textGenerationModelSelection: applyModelSelectionPatch(
        current.textGenerationModelSelection,
        selectionPatch,
      ),
    };
  }

  const backupSelection = applyNullableModelSelectionPatch(
    current.textGenerationBackupModelSelection,
    backupSelectionPatch,
  );
  if (backupSelection !== undefined) {
    nextWithReplacements = {
      ...nextWithReplacements,
      textGenerationBackupModelSelection: backupSelection,
    };
  }

  const writerSelection = applyNullableModelSelectionPatch(
    current.sourceControlWriterModelSelection,
    writerSelectionPatch,
  );
  if (writerSelection !== undefined) {
    nextWithReplacements = {
      ...nextWithReplacements,
      sourceControlWriterModelSelection: writerSelection,
    };
  }

  return nextWithReplacements;
}

type RoomsSettings =
  | Pick<Partial<ServerSettings>, "enableRooms" | "agentInvites">
  | null
  | undefined;

/** Whether Rooms is on for a computer. Never chosen: on. */
export const roomsEnabled = (settings: RoomsSettings): boolean => settings?.enableRooms !== false;

/** What the user chose for agents bringing in other agents. Never chosen: ask first. */
export const agentInvitesChoice = (settings: RoomsSettings): AgentInvitesMode =>
  settings?.agentInvites ?? "ask";

/**
 * Whether the thread's agents may bring in other agents right now: the
 * user's choice while Rooms is on, and never with Rooms off. The server's
 * tools, the answer check and the settings page all read this one rule.
 */
export const agentInvitesMode = (settings: RoomsSettings): AgentInvitesMode =>
  roomsEnabled(settings) ? agentInvitesChoice(settings) : "off";

/**
 * Whether the thread's agents may start threads of their own (child threads):
 * the user's choice, never chosen meaning ask first. Unlike invites it does
 * not depend on Rooms. The server's tools, the approval check and the
 * settings page all read this one rule.
 */
export const agentThreadsMode = (
  settings: Pick<Partial<ServerSettings>, "agentThreads"> | null | undefined,
): AgentThreadsMode => settings?.agentThreads ?? "ask";
