/**
 * How the two speech models are described to the user.
 *
 * The server owns the file catalog; this is only the copy that names each
 * model, so the composer's setup popover and the Settings rows stay in sync.
 *
 * @module dictationModels
 */
import type { DictationModelId, DictationStatus } from "@threadlines/contracts";

export interface DictationModelPresentation {
  readonly id: DictationModelId;
  readonly name: string;
  /** Mono meta line: trade-off, download size, memory while listening. */
  readonly meta: string;
  /** One sentence on accuracy and speed. */
  readonly description: string;
}

export const DICTATION_MODEL_PRESENTATION: Record<DictationModelId, DictationModelPresentation> = {
  parakeet: {
    id: "parakeet",
    name: "Parakeet",
    meta: "best accuracy · 631 MB · about 1 GB of memory while listening",
    description: "English. Word for word on clear speech.",
  },
  moonshine: {
    id: "moonshine",
    name: "Moonshine",
    meta: "small and fast · 120 MB · about 300 MB of memory",
    description: "English. Slightly less accurate, three times faster on slow machines.",
  },
};

/** The status entry for one model, or undefined before the first status lands. */
export function findDictationModel(
  status: DictationStatus | undefined,
  model: DictationModelId,
): DictationStatus["models"][number] | undefined {
  return status?.models.find((entry) => entry.id === model);
}

/** True when this model can transcribe right now: runtime and files both present. */
export function selectedModelReady(
  status: DictationStatus | undefined,
  model: DictationModelId,
): boolean {
  if (!status || status.runtime.state !== "ready") {
    return false;
  }
  return findDictationModel(status, model)?.state === "ready";
}
