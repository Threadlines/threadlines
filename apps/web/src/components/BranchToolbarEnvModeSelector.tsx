import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, type ReactNode, useMemo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolveWorkspaceDescription,
  resolveWorkspacePhrase,
  type EnvMode,
} from "./BranchToolbar.logic";
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

interface BranchToolbarEnvModeSelectorProps {
  /** `sentence` sets the picker in running words: plain text, dotted underline. */
  presentation?: "chip" | "sentence";
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
}

/** A workspace choice in the menu: its name, and one line on what picking it does. */
function WorkspaceOption(props: { icon: ReactNode; label: string; description: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1.5">
        {props.icon}
        {props.label}
      </span>
      <span className="ps-[1.125rem] text-xs text-muted-foreground/75">{props.description}</span>
    </span>
  );
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  presentation = "chip",
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
}: BranchToolbarEnvModeSelectorProps) {
  // The trigger shows the chosen item's label, so the sentence gets the
  // phrasing that reads mid-sentence and the chip keeps its title.
  const envModeItems = useMemo(
    () =>
      presentation === "sentence"
        ? [
            { value: "local", label: resolveWorkspacePhrase("local", activeWorktreePath) },
            { value: "worktree", label: resolveWorkspacePhrase("worktree", activeWorktreePath) },
          ]
        : [
            { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
            { value: "worktree", label: resolveEnvModeLabel("worktree") },
          ],
    [activeWorktreePath, presentation],
  );

  if (envLocked && presentation === "sentence") {
    return (
      <span className="text-foreground/85">
        {resolveWorkspacePhrase(effectiveEnvMode, activeWorktreePath)}
      </span>
    );
  }

  if (envLocked) {
    return (
      <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        {activeWorktreePath ? (
          <>
            <FolderGitIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        ) : (
          <>
            <FolderIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        )}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value) => onEnvModeChange(value as EnvMode)}
      items={envModeItems}
    >
      {presentation === "sentence" ? (
        <SelectInlineTrigger aria-label="Workspace">
          <SelectValue />
        </SelectInlineTrigger>
      ) : (
        <SelectTrigger variant="ghost" size="xs" className="font-medium" aria-label="Workspace">
          {effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : activeWorktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
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
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          <SelectItem className="items-start py-1.5" value="local">
            <WorkspaceOption
              description={resolveWorkspaceDescription("local", activeWorktreePath)}
              icon={
                activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )
              }
              label={resolveCurrentWorkspaceLabel(activeWorktreePath)}
            />
          </SelectItem>
          <SelectItem className="items-start py-1.5" value="worktree">
            <WorkspaceOption
              description={resolveWorkspaceDescription("worktree", activeWorktreePath)}
              icon={<FolderGit2Icon className="size-3" />}
              label={resolveEnvModeLabel("worktree")}
            />
          </SelectItem>
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
