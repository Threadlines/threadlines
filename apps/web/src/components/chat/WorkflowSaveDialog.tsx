/**
 * Saving a finished run's script as a command Claude runs by name later:
 * `/<name>` in any Claude thread of this project, or of every project. The
 * server says where each choice would go before anything is written.
 */
import type {
  EnvironmentId,
  ThreadId,
  WorkflowCommandLocation,
  WorkflowSaveCommandResult,
} from "@threadlines/contracts";
import { useEffect, useState } from "react";

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
import { Radio, RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { saveWorkflowCommand } from "./workflowRunClient";

const LOCATIONS: ReadonlyArray<{
  readonly value: WorkflowCommandLocation;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    value: "project",
    label: "This project",
    detail: "Saved in the repository, for everyone who clones it.",
  },
  { value: "personal", label: "All my projects", detail: "Saved in your Claude folder, for you." },
];

type Preview =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly result: WorkflowSaveCommandResult }
  | { readonly status: "error"; readonly message: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function WorkflowSaveDialog({
  open,
  onOpenChange,
  environmentId,
  threadId,
  taskId,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
}) {
  const [location, setLocation] = useState<WorkflowCommandLocation>("project");
  const [preview, setPreview] = useState<Preview>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview({ status: "loading" });
    setSaveError(null);
    saveWorkflowCommand({
      environmentId,
      threadId,
      taskId,
      location,
      overwrite: false,
      dryRun: true,
    })
      .then((result) => {
        if (!cancelled) setPreview({ status: "ready", result });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPreview({ status: "error", message: errorMessage(error, "It can not be saved.") });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, location, open, taskId, threadId]);

  const exists = preview.status === "ready" && preview.result.outcome === "exists";
  const name = preview.status === "ready" ? preview.result.name : null;

  const save = () => {
    setSaving(true);
    setSaveError(null);
    saveWorkflowCommand({ environmentId, threadId, taskId, location, overwrite: exists })
      .then((result) => {
        if (result.outcome === "exists") {
          setPreview({ status: "ready", result });
          return;
        }
        toastManager.add({
          type: "success",
          title: `Saved /${result.name}`,
          description: "Type it in a Claude thread to run this workflow again.",
        });
        onOpenChange(false);
      })
      .catch((error: unknown) => {
        setSaveError(errorMessage(error, "The workflow could not be saved."));
      })
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save as a command</DialogTitle>
          <DialogDescription>
            {name
              ? `Run it again later by typing /${name} in a Claude thread.`
              : "Run it again later by typing its name in a Claude thread."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <RadioGroup
            value={location}
            onValueChange={(value) => setLocation(value as WorkflowCommandLocation)}
            aria-label="Where to save it"
            className="gap-2"
          >
            {LOCATIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1.5"
              >
                <Radio value={option.value} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium">{option.label}</span>
                  <span className="block text-[12.5px] text-muted-foreground">
                    {option.detail}
                  </span>
                  {location === option.value && preview.status === "ready" ? (
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                      {preview.result.path}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </RadioGroup>
          {preview.status === "error" ? (
            <p className="mt-3 text-[12.5px] text-destructive">{preview.message}</p>
          ) : null}
          {exists ? (
            <p className="mt-3 text-[12.5px] text-muted-foreground">
              A command named /{name} is already there. Saving replaces it.
            </p>
          ) : null}
          {saveError ? <p className="mt-3 text-[12.5px] text-destructive">{saveError}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={preview.status !== "ready" || saving}
            onClick={save}
          >
            {exists ? "Replace" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
