import {
  type EnvironmentId,
  type EditorId,
  type ThreadId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@threadlines/contracts";
import { memo } from "react";
import { FolderInputIcon, FolderOpenIcon, GitForkIcon, TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Group } from "../ui/group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarOpenTrigger } from "../ui/sidebar";
import { SourceControlIcon } from "../Icons";
import { OpenInPicker } from "./OpenInPicker";
import { openActiveFileViewer } from "../../fileViewerStore";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  ThreadActivityPopover,
  type ThreadBackgroundRunItem,
  type ThreadTaskProgressState,
} from "./ThreadActivityPopover";
import type { SubagentProgressState } from "../../session-logic";
import { cn } from "../../lib/utils";

export interface ForkHeaderContext {
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
}

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
  /** False for capability-gated threads (General Chats) even when a project name exists. */
  sourceControlAvailable: boolean;
  /** False for General Chats: their scratch workspace has no files worth browsing. */
  fileBrowserAvailable: boolean;
  taskProgress: ThreadTaskProgressState | null;
  subagentProgress: SubagentProgressState | null;
  forkContext: ForkHeaderContext | null;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
  onOpenForkSourceThread: (threadId: ThreadId) => void;
  onToggleTerminal: () => void;
  onToggleSourceControl: () => void;
  /** Present only for General Chat threads that can continue into a project. */
  onContinueInProject?: ((event: React.MouseEvent<HTMLButtonElement>) => void) | undefined;
  continueInProjectDisabledReason?: string | null;
}

export function shouldShowOpenInEditor(input: {
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

export function resolveContinueInProjectHeaderState(disabledReason: string | null | undefined): {
  readonly disabled: boolean;
  readonly tooltip: string;
} {
  const disabled = typeof disabledReason === "string" && disabledReason.length > 0;
  return {
    disabled,
    tooltip: disabled ? disabledReason : "Start a project thread seeded with this chat",
  };
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
  sourceControlAvailable,
  fileBrowserAvailable,
  taskProgress,
  subagentProgress,
  forkContext,
  backgroundRuns,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleBackgroundRunTerminal,
  onStopBackgroundRun,
  onOpenForkSourceThread,
  onToggleTerminal,
  onToggleSourceControl,
  onContinueInProject,
  continueInProjectDisabledReason,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInEditor = shouldShowOpenInEditor({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const continueInProjectState = resolveContinueInProjectHeaderState(
    continueInProjectDisabledReason,
  );

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
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
        {forkContext ? (
          <button
            type="button"
            className="translate-y-px inline-flex h-6 min-w-0 shrink-0 items-center rounded-md border border-border/70 bg-muted/45 px-1.5 text-[11px] leading-none text-muted-foreground transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground"
            onClick={() => onOpenForkSourceThread(forkContext.sourceThreadId)}
            aria-label={`Open source thread: ${forkContext.sourceThreadTitle}`}
            title={`Forked from ${forkContext.sourceThreadTitle}`}
          >
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitForkIcon aria-hidden="true" className="size-3 shrink-0" />
              <span className="hidden sm:inline">Forked from</span>
              <span className="max-w-28 truncate text-foreground/80 sm:max-w-40">
                {forkContext.sourceThreadTitle}
              </span>
            </span>
          </button>
        ) : null}
        {activeProjectName && !isGitRepo && sourceControlAvailable && (
          <Badge variant="outline" className="shrink-0 text-[10px] leading-none text-amber-700/90">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        <ThreadActivityPopover
          taskProgress={taskProgress}
          subagentProgress={subagentProgress}
          backgroundRuns={backgroundRuns}
          onToggleBackgroundRunTerminal={onToggleBackgroundRunTerminal}
          onStopBackgroundRun={onStopBackgroundRun}
        />
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
        {showOpenInEditor &&
          openInCwd !== null && (
            // Desktop affordance: "open in editor" acts on the machine running
            // the server, so it earns no room in the phone-width header.
            <div className="flex shrink-0 items-center max-sm:hidden">
              <OpenInPicker
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={openInCwd}
              />
            </div>
          )}
        <div className="flex shrink-0 items-center gap-1">
          {onContinueInProject ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Continue in project"
                    aria-disabled={continueInProjectState.disabled || undefined}
                    data-disabled={continueInProjectState.disabled ? "true" : undefined}
                    className={cn(
                      "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-[11px] transition-colors",
                      continueInProjectState.disabled
                        ? "cursor-default text-muted-foreground/70 opacity-70 hover:bg-background hover:text-muted-foreground/70"
                        : "cursor-pointer text-foreground/85 hover:bg-foreground/10 hover:text-foreground",
                    )}
                    onClick={continueInProjectState.disabled ? undefined : onContinueInProject}
                  >
                    <FolderInputIcon className="size-3" />
                    <span className="max-sm:hidden">Continue in project</span>
                  </button>
                }
              />
              <TooltipPopup side="bottom">{continueInProjectState.tooltip}</TooltipPopup>
            </Tooltip>
          ) : null}
          {fileBrowserAvailable ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    className="shrink-0"
                    onClick={() => {
                      openActiveFileViewer();
                    }}
                    aria-label="Browse project files"
                    variant="outline"
                    size="icon-xs"
                    disabled={!terminalAvailable}
                  >
                    <FolderOpenIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">
                {!terminalAvailable
                  ? "File viewer is unavailable until this thread has an active project."
                  : "Browse project files"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Group aria-label="Thread panels">
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
            {sourceControlAvailable || sourceControlOpen ? (
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
                      disabled={!sourceControlAvailable && !sourceControlOpen}
                    >
                      <SourceControlIcon className="size-[11px]" />
                    </Toggle>
                  }
                />
                <TooltipPopup side="bottom">
                  {!sourceControlAvailable && !sourceControlOpen
                    ? "Source control is unavailable until this thread has an active project."
                    : sourceControlToggleShortcutLabel
                      ? `Toggle source control panel (${sourceControlToggleShortcutLabel})`
                      : "Toggle source control panel"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </Group>
        </div>
      </div>
    </div>
  );
});
