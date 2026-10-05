import type { EnvironmentId } from "@threadlines/contracts";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectInlineTrigger,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  /** `sentence` sets the picker in running words: plain text, dotted underline. */
  presentation?: "chip" | "sentence";
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  presentation = "chip",
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarEnvironmentSelectorProps) {
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () =>
      availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
    [availableEnvironments],
  );

  if (envLocked && presentation === "sentence") {
    return <span className="text-foreground/85">{activeEnvironment?.label ?? "this device"}</span>;
  }

  if (envLocked) {
    return (
      <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        {activeEnvironment?.isPrimary ? (
          <MonitorIcon className="size-3" />
        ) : (
          <CloudIcon className="size-3" />
        )}
        {activeEnvironment?.label ?? "Run on"}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={environmentId}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
      items={environmentItems}
    >
      {presentation === "sentence" ? (
        <SelectInlineTrigger aria-label="Run on">
          <SelectValue />
        </SelectInlineTrigger>
      ) : (
        <SelectTrigger variant="ghost" size="xs" className="font-medium" aria-label="Run on">
          {activeEnvironment?.isPrimary ? (
            <MonitorIcon className="size-3" />
          ) : (
            <CloudIcon className="size-3" />
          )}
          <SelectValue />
        </SelectTrigger>
      )}
      <SelectPopup
        {...(presentation === "sentence"
          ? { alignItemWithTrigger: false, matchTriggerWidth: false }
          : {})}
      >
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                {env.isPrimary ? (
                  <MonitorIcon className="size-3" />
                ) : (
                  <CloudIcon className="size-3" />
                )}
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
