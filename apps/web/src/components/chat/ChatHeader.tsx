import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo } from "react";
import { TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarOpenTrigger } from "../ui/sidebar";
import { SourceControlIcon } from "../Icons";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { TaskProgressPopover } from "./TaskProgressPopover";
import type { PlanTaskBadgeState } from "../../planPanelState";
import type { ActivePlanState, LatestProposedPlanState } from "../../session-logic";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  sourceControlToggleShortcutLabel: string | null;
  sourceControlOpen: boolean;
  taskProgress: {
    activePlan: ActivePlanState | null;
    activeProposedPlan: LatestProposedPlanState | null;
    badge: PlanTaskBadgeState | null;
    label: string;
  } | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleSourceControl: () => void;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  sourceControlToggleShortcutLabel,
  sourceControlOpen,
  taskProgress,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleSourceControl,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:gap-2">
        <SidebarOpenTrigger className="size-7 shrink-0" />
        {activeProjectName && (
          <div className="hidden min-w-0 shrink items-center gap-1.5 sm:flex">
            <span
              className="min-w-0 max-w-48 truncate text-sm text-muted-foreground"
              title={activeProjectName}
            >
              {activeProjectName}
            </span>
            <span aria-hidden="true" className="select-none text-muted-foreground/40">
              /
            </span>
          </div>
        )}
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {taskProgress ? (
          <TaskProgressPopover
            activePlan={taskProgress.activePlan}
            activeProposedPlan={taskProgress.activeProposedPlan}
            badge={taskProgress.badge}
            label={taskProgress.label}
          />
        ) : null}
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={terminalOpen}
                  onPressedChange={onToggleTerminal}
                  aria-label="Toggle terminal drawer"
                  variant="outline"
                  size="xs"
                  disabled={!terminalAvailable}
                >
                  <TerminalSquareIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {!terminalAvailable
                ? "Terminal is unavailable until this thread has an active project."
                : terminalToggleShortcutLabel
                  ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                  : "Toggle terminal drawer"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={sourceControlOpen}
                  onPressedChange={onToggleSourceControl}
                  aria-label="Toggle source control panel"
                  variant="outline"
                  size="xs"
                  disabled={!activeProjectName && !sourceControlOpen}
                >
                  <SourceControlIcon className="size-[11px]" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {!activeProjectName && !sourceControlOpen
                ? "Source control is unavailable until this thread has an active project."
                : sourceControlToggleShortcutLabel
                  ? `Toggle source control panel (${sourceControlToggleShortcutLabel})`
                  : "Toggle source control panel"}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
});
