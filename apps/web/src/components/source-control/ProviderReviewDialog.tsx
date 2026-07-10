import {
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@threadlines/contracts";
import { createModelSelection } from "@threadlines/shared/model";
import { memo, useId } from "react";

import type { ProviderInstanceEntry } from "~/providerInstances";

import { getComposerProviderState } from "../chat/composerProviderState";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import { shouldRenderTraitsControls, TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

export interface ProviderReviewDialogProps {
  readonly open: boolean;
  readonly targetDescription: string;
  readonly modelSelection: ModelSelection;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly isPending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onModelSelectionChange: (selection: ModelSelection) => void;
  readonly onConfirm: () => void;
}

export const ProviderReviewDialog = memo(function ProviderReviewDialog({
  open,
  targetDescription,
  modelSelection,
  providerInstanceEntries,
  modelOptionsByInstance,
  isPending,
  onOpenChange,
  onModelSelectionChange,
  onConfirm,
}: ProviderReviewDialogProps) {
  const modelLabelId = useId();
  const reasoningLabelId = useId();
  const activeProviderEntry =
    providerInstanceEntries.find((entry) => entry.instanceId === modelSelection.instanceId) ?? null;
  const supportsTraits = activeProviderEntry
    ? shouldRenderTraitsControls({
        provider: CODEX_DRIVER,
        models: activeProviderEntry.models,
        model: modelSelection.model,
        modelOptions: modelSelection.options,
      })
    : false;

  const selectModel = (instanceId: ProviderInstanceId, model: string) => {
    const providerEntry = providerInstanceEntries.find((entry) => entry.instanceId === instanceId);
    if (!providerEntry) {
      return;
    }

    const providerState = getComposerProviderState({
      provider: CODEX_DRIVER,
      model,
      models: providerEntry.models,
      prompt: "",
      modelOptions: modelSelection.instanceId === instanceId ? modelSelection.options : undefined,
    });
    onModelSelectionChange(
      createModelSelection(instanceId, model, providerState.modelOptionsForDispatch),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg" showCloseButton={!isPending}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>Start review in a new thread</DialogTitle>
            <DialogDescription>
              Threadlines will create a fresh Codex thread for this review. The current thread and
              its selected provider stay unchanged.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <div className="text-xs font-medium text-muted-foreground">Review target</div>
              <div className="mt-1 break-words text-foreground">{targetDescription}</div>
            </div>

            <div className="space-y-2" role="group" aria-labelledby={modelLabelId}>
              <div id={modelLabelId} className="text-sm font-medium">
                Codex model
              </div>
              <ProviderModelPicker
                activeInstanceId={modelSelection.instanceId}
                model={modelSelection.model}
                lockedProvider={CODEX_DRIVER}
                instanceEntries={providerInstanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                disabled={isPending}
                side="bottom"
                triggerVariant="outline"
                triggerClassName="w-full max-w-none justify-start"
                onInstanceModelChange={selectModel}
              />
            </div>

            <div className="space-y-2" role="group" aria-labelledby={reasoningLabelId}>
              <div id={reasoningLabelId} className="text-sm font-medium">
                Reasoning and options
              </div>
              {activeProviderEntry && supportsTraits ? (
                <TraitsPicker
                  provider={CODEX_DRIVER}
                  instanceId={activeProviderEntry.instanceId}
                  models={activeProviderEntry.models}
                  model={modelSelection.model}
                  modelOptions={modelSelection.options}
                  triggerVariant="outline"
                  triggerClassName="w-full max-w-none justify-start"
                  onModelOptionsChange={(options) => {
                    onModelSelectionChange(
                      createModelSelection(
                        modelSelection.instanceId,
                        modelSelection.model,
                        options,
                      ),
                    );
                  }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  This model does not expose additional review options.
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isPending || activeProviderEntry === null}>
              {isPending ? "Starting review..." : "Start review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
});
