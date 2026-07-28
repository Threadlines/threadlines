import type { ModelSelection, ServerProvider } from "@threadlines/contracts";
import { ProviderDriverKind } from "@threadlines/contracts";
import type { UnifiedSettings } from "@threadlines/contracts/settings";
import { createModelSelection } from "@threadlines/shared/model";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  filterMaintainedProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

/** Instances a text generation model can be chosen from, in display order. */
export function textGenerationInstanceEntries(
  serverProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceEntry> {
  return sortProviderInstanceEntries(
    filterMaintainedProviderInstanceEntries(deriveProviderInstanceEntries(serverProviders)),
  );
}

/** Which part of the selection the user just edited. */
export type TextGenerationModelChangeKind = "instanceModel" | "options";

export interface TextGenerationModelControlProps {
  readonly selection: ModelSelection;
  readonly settings: UnifiedSettings;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onSelectionChange: (
    selection: ModelSelection,
    change: TextGenerationModelChangeKind,
  ) => void;
}

/**
 * The provider/model + traits pair used by every text generation model row
 * (primary, backup, source control writer). Callers own how the raw selection
 * is resolved and persisted; this only reports what the user picked.
 */
export function TextGenerationModelControl({
  selection,
  settings,
  serverProviders,
  instanceEntries,
  onSelectionChange,
}: TextGenerationModelControlProps) {
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const provider: ProviderDriverKind = instanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        triggerVariant="outline"
        triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
        onInstanceModelChange={(instanceId, model) => {
          onSelectionChange(createModelSelection(instanceId, model), "instanceModel");
        }}
      />
      <TraitsPicker
        provider={provider}
        models={
          // Use the exact instance's models (rather than the first-kind-match)
          // so a custom text-gen instance like `codex_personal` gets its own
          // model list, not the default Codex one.
          instanceEntry?.models ?? []
        }
        model={selection.model}
        modelOptions={selection.options}
        triggerVariant="outline"
        triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
        onModelOptionsChange={(nextOptions) => {
          onSelectionChange(
            createModelSelection(selection.instanceId, selection.model, nextOptions),
            "options",
          );
        }}
      />
    </div>
  );
}
