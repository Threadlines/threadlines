import type { ModelSelection, ServerProvider } from "@threadlines/contracts";
import { ProviderDriverKind } from "@threadlines/contracts";
import { CheckIcon, HistoryIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { UnifiedSettings } from "@threadlines/contracts/settings";
import { createModelSelection } from "@threadlines/shared/model";

import { getCustomModelOptionsByInstance, writingModelProviders } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  filterMaintainedProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { DropdownChevron } from "../ui/select";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const TEXT_GENERATION_OMITTED_OPTIONS = ["ultracode"] as const;

/** Instances a text generation model can be chosen from, in display order. */
export function textGenerationInstanceEntries(
  serverProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceEntry> {
  return sortProviderInstanceEntries(
    filterMaintainedProviderInstanceEntries(
      deriveProviderInstanceEntries(writingModelProviders(serverProviders)),
    ),
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
export function TextGenerationModelControl(props: TextGenerationModelControlProps) {
  // Commit messages and titles never run Ultracode's agent workflows.
  return <ModelSelectionControl {...props} omitOptionIds={TEXT_GENERATION_OMITTED_OPTIONS} />;
}

export interface ModelSelectionControlProps extends TextGenerationModelControlProps {
  /** Reasoning-style choices this setting never offers. */
  readonly omitOptionIds?: ReadonlyArray<string>;
  /** Picker button variant; settings rows use outline, inline lists ghost. */
  readonly variant?: "outline" | "ghost";
  /**
   * A choice above the model list that is not a model ("Last used"). While
   * it is the one chosen, the button names it and the traits picker hides.
   */
  readonly leadingChoice?: PickerLeadingChoice;
}

export interface PickerLeadingChoice {
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

/**
 * A model and its reasoning (and other traits) for a setting: the composer's
 * own model picker and traits picker, reporting what the user picked.
 */
export function ModelSelectionControl({
  selection,
  settings,
  serverProviders,
  instanceEntries,
  onSelectionChange,
  omitOptionIds,
  variant = "outline",
  leadingChoice,
}: ModelSelectionControlProps) {
  const [open, setOpen] = useState(false);
  const leadingChosen = leadingChoice?.selected === true;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const provider: ProviderDriverKind = instanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const triggerClassName =
    variant === "outline"
      ? "min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
      : "min-w-0 max-w-none shrink-0 px-2 text-foreground/90 hover:text-foreground";

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        triggerVariant={variant}
        triggerClassName={triggerClassName}
        open={open}
        onOpenChange={setOpen}
        {...(leadingChoice
          ? {
              notice: (
                <LeadingChoiceRow
                  choice={leadingChoice}
                  onPicked={() => {
                    leadingChoice.onSelect();
                    setOpen(false);
                  }}
                />
              ),
            }
          : {})}
        {...(leadingChosen
          ? {
              triggerContent: (
                <span className="flex items-center gap-2">
                  <HistoryIcon aria-hidden="true" className="size-4" />
                  <span>{leadingChoice.label}</span>
                  <DropdownChevron solid={variant === "outline"} />
                </span>
              ),
            }
          : {})}
        onInstanceModelChange={(instanceId, model) => {
          onSelectionChange(createModelSelection(instanceId, model), "instanceModel");
        }}
      />
      {leadingChosen ? null : (
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
          {...(omitOptionIds ? { omitOptionIds } : {})}
          triggerVariant={variant}
          triggerClassName={triggerClassName}
          onModelOptionsChange={(nextOptions) => {
            onSelectionChange(
              createModelSelection(selection.instanceId, selection.model, nextOptions),
              "options",
            );
          }}
        />
      )}
    </div>
  );
}

/** The leading choice's row at the top of the picker card. */
function LeadingChoiceRow({
  choice,
  onPicked,
}: {
  choice: PickerLeadingChoice;
  onPicked: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onPicked}
      className="flex w-full shrink-0 items-center gap-2.5 border-b border-border px-3 py-2 text-left transition-colors hover:bg-accent focus-ring"
    >
      <HistoryIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-foreground">{choice.label}</span>
        <span className="block text-xs text-muted-foreground">{choice.description}</span>
      </span>
      {choice.selected ? (
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary-readable" />
      ) : null}
    </button>
  );
}
