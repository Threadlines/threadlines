import {
  type EnvironmentId,
  type EditorId,
  type ThreadId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@threadlines/contracts";
import { memo } from "react";
import {
  FolderInputIcon,
  FolderOpenIcon,
  GitForkIcon,
  GlobeIcon,
  PanelRightIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Group } from "../ui/group";
import { Tooltip, TooltipPopup, TooltipTrigger, TooltipWrapper } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarOpenTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { openActiveFileViewer } from "../../fileViewerStore";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { ThreadActivityChip, type ThreadTaskProgressState } from "./ThreadActivityPopover";
import type { ThreadBackgroundRunItem } from "./threadActivity";
import type { SubagentProgressState } from "../../session-logic";
import type { LiveAgentIndicator } from "./agentsPanel.logic";
import { LiveNode } from "../ui/threadline";
import { cn } from "../../lib/utils";

export interface ForkHeaderContext {
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
}

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
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
  railToggleShortcutLabel: string | null;
  /** Whether the right rail is showing, on either of its tabs. */
  railOpen: boolean;
  /** False for capability-gated threads (General Chats) even when a project
   *  name exists: the rail still opens, just without its Changes tab. */
  sourceControlAvailable: boolean;
  /** False where there is no project to preview, e.g. a general chat. */
  browserAvailable: boolean;
  browserOpen: boolean;
  /**
   * Working-tree diffstat, surfaced on the closed rail toggle so the size of
   * the pending change is legible without opening the rail. Null when the tree
   * is clean or the status has not loaded.
   */
  workingTreeDiffStat: { readonly insertions: number; readonly deletions: number } | null;
  /**
   * Commits the branch is behind its upstream, surfaced on the closed rail
   * toggle as a pull-available hint. Null when there is nothing to pull or the
   * status has not loaded.
   */
  remoteBehindCount: number | null;
  /**
   * Agents running right now, surfaced on the closed rail toggle the same way
   * the diffstat is. Null when nothing is live. While the rail is open its Agents
   * tab carries the live node itself, so these stay closed-only.
   */
  liveAgents: LiveAgentIndicator | null;
  /** False for General Chats: their scratch workspace has no files worth browsing. */
  fileBrowserAvailable: boolean;
  taskProgress: ThreadTaskProgressState | null;
  subagentProgress: SubagentProgressState | null;
  forkContext: ForkHeaderContext | null;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  /** Whether the activity chip's panel is the one showing in the right slot. */
  agentsPanelOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleAgentsPanel: () => void;
  onOpenForkSourceThread: (threadId: ThreadId) => void;
  onToggleTerminal: () => void;
  onToggleRail: () => void;
  onToggleBrowser: () => void;
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

/** Reads the live-agent node on the closed panel button out loud. Waiting leads,
 *  because it is the part that asks the user for something. */
export function formatLiveAgentsTooltip(liveAgents: LiveAgentIndicator): string {
  const { count, waitingCount } = liveAgents;
  const running = count - waitingCount;
  const noun = (value: number) => (value === 1 ? "agent" : "agents");
  if (running === 0) {
    return `${waitingCount} ${noun(waitingCount)} waiting on you.`;
  }
  if (waitingCount === 0) {
    return `${running} ${noun(running)} running.`;
  }
  return `${running} ${noun(running)} running, ${waitingCount} waiting on you.`;
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
  railToggleShortcutLabel,
  railOpen,
  sourceControlAvailable,
  browserAvailable,
  browserOpen,
  onToggleBrowser,
  workingTreeDiffStat,
  remoteBehindCount,
  liveAgents,
  fileBrowserAvailable,
  taskProgress,
  subagentProgress,
  forkContext,
  backgroundRuns,
  agentsPanelOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleAgentsPanel,
  onOpenForkSourceThread,
  onToggleTerminal,
  onToggleRail,
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
    <div
      className="@container/header-actions flex min-w-0 flex-1 items-center gap-2"
      data-active-project-name={activeProjectName}
      data-active-thread-title={activeThreadTitle}
    >
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
          <TooltipWrapper tooltip="This folder isn't a git repository. Chat works; source control, diffs, and refs need git. Run git init to enable them.">
            <Badge
              variant="outline"
              className="shrink-0 text-[10px] leading-none text-amber-700/90"
            >
              No Git
            </Badge>
          </TooltipWrapper>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        <ThreadActivityChip
          taskProgress={taskProgress}
          subagentProgress={subagentProgress}
          backgroundRuns={backgroundRuns}
          pressed={agentsPanelOpen}
          onClick={onToggleAgentsPanel}
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
        {/* Desktop affordance: "open in editor" acts on the machine running
            the server, so it earns no room in the phone-width header. */}
        {showOpenInEditor && openInCwd !== null && (
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
            {browserAvailable ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Toggle
                      className="shrink-0"
                      pressed={browserOpen}
                      onPressedChange={onToggleBrowser}
                      aria-label="Toggle browser preview"
                      variant="outline"
                      size="xs"
                    >
                      <GlobeIcon className="size-3" />
                    </Toggle>
                  }
                />
                <TooltipPopup side="bottom">Toggle browser preview</TooltipPopup>
              </Tooltip>
            ) : null}
            {/* One entry point for the whole rail: the tab row inside it picks
                between the turn's agents and the thread's changes. */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className={cn(
                      "shrink-0",
                      // With the counts alongside it, the control needs room
                      // on both sides -- the icon otherwise sits against the
                      // hover fill -- and less between them: the base gap is
                      // sized for icons, not for a label that belongs to one.
                      (workingTreeDiffStat !== null ||
                        remoteBehindCount !== null ||
                        liveAgents !== null) &&
                        !railOpen &&
                        "gap-1 px-1.5",
                    )}
                    pressed={railOpen}
                    onPressedChange={onToggleRail}
                    aria-label="Toggle panel"
                    variant="outline"
                    size="xs"
                  >
                    <PanelRightIcon className="size-3" />
                    {/* Only while closed: once the rail is open its Changes tab
                        shows the per-file counts, and repeating the total is
                        noise. */}
                    {!railOpen && (workingTreeDiffStat || remoteBehindCount !== null) ? (
                      <span className="font-mono text-[10px] leading-none">
                        {workingTreeDiffStat ? (
                          <>
                            <span className="text-success">+{workingTreeDiffStat.insertions}</span>
                            <span className="ps-1 text-destructive">
                              −{workingTreeDiffStat.deletions}
                            </span>
                          </>
                        ) : null}
                        {/* Deliberately hue-less: the arrow is the signal, and a
                            third color next to the green/red counts would crowd
                            an icon-sized control. */}
                        {remoteBehindCount !== null ? (
                          <span
                            className={cn(
                              "text-muted-foreground",
                              workingTreeDiffStat !== null && "ps-1",
                            )}
                          >
                            ↓{remoteBehindCount}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    {/* Typographic, like the counts beside it: a node and at most
                        a digit. An agent waiting on the user turns it amber. */}
                    {!railOpen && liveAgents ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5"
                        data-header-live-agents={liveAgents.waitingCount > 0 ? "waiting" : "running"}
                      >
                        {liveAgents.waitingCount > 0 ? (
                          <span
                            aria-hidden="true"
                            className="block size-1.5 rounded-full bg-amber-500"
                          />
                        ) : (
                          <LiveNode className="size-1.5" />
                        )}
                        {liveAgents.count > 1 ? (
                          <span className="font-mono text-[10px] leading-none text-muted-foreground">
                            {liveAgents.count}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </Toggle>
                }
              />
              <TooltipPopup side="bottom">
                {railToggleShortcutLabel ? `Panel (${railToggleShortcutLabel})` : "Panel"}
                {!railOpen && liveAgents ? (
                  <div className="text-muted-foreground">
                    {formatLiveAgentsTooltip(liveAgents)} Open the Agents tab.
                  </div>
                ) : null}
                {!railOpen && sourceControlAvailable && remoteBehindCount !== null ? (
                  <div className="text-muted-foreground">
                    {remoteBehindCount === 1
                      ? "1 commit behind the remote."
                      : `${remoteBehindCount} commits behind the remote.`}{" "}
                    Pull from the Changes tab.
                  </div>
                ) : null}
              </TooltipPopup>
            </Tooltip>
          </Group>
        </div>
      </div>
    </div>
  );
});
