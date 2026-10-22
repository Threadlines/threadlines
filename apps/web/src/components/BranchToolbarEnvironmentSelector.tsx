import type { EnvironmentId } from "@threadlines/contracts";
import { CloudIcon, FolderSyncIcon, MonitorIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectInlineTrigger,
  SelectItem,
  SelectPopup,
  SelectSeparator,
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
  /** Offers "Set up on another computer…" at the list's end. */
  onSetUpElsewhere?: (() => void) | undefined;
}

/** The value of the list's last item: not a computer, the way to add one. */
const SET_UP_ELSEWHERE_VALUE = "\u0000set-up-elsewhere";

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  presentation = "chip",
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  onSetUpElsewhere,
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
      onValueChange={(value) => {
        if (value === SET_UP_ELSEWHERE_VALUE) {
          onSetUpElsewhere?.();
          return;
        }
        onEnvironmentChange(value as EnvironmentId);
      }}
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
        {onSetUpElsewhere ? (
          <>
            <SelectSeparator />
            <SelectItem value={SET_UP_ELSEWHERE_VALUE} data-testid="runs-on-set-up-elsewhere">
              <span className="inline-flex items-center gap-1.5">
                <FolderSyncIcon className="size-3" />
                Set up on another computer…
              </span>
            </SelectItem>
          </>
        ) : null}
      </SelectPopup>
    </Select>
  );
});
