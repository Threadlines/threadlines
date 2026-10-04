import {
  type EnvironmentId,
  type EditorId,
  type ProviderDriverKind,
  type ThreadId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@threadlines/contracts";
import { memo } from "react";
import {
  CornerDownRightIcon,
  FolderInputIcon,
  FolderOpenIcon,
  GitForkIcon,
  GlobeIcon,
  PanelRightIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger, TooltipWrapper } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarOpenTrigger } from "../ui/sidebar";
import { ProjectCrumbMenu } from "./ProjectCrumbMenu";
import { openActiveFileViewer } from "../../fileViewerStore";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { ThreadActivityPopover, type ThreadTaskProgressState } from "./ThreadActivityPopover";
import type { ThreadBackgroundRunItem } from "./threadActivity";
import type { LiveAgentIndicator } from "./agentsPanel.logic";
import { HeaderAgentFaces } from "./HeaderAgentFaces";
import type { WorkingTreeChanges } from "../ChatView.logic";
import { cn } from "../../lib/utils";

export interface ForkHeaderContext {
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
}

/** Child threads: the thread whose agent started this one. */
export interface ParentThreadHeaderContext {
  readonly parentThreadId: ThreadId;
  readonly parentThreadTitle: string;
}

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  /** The folder the project crumb's menu acts on: the thread's worktree when it
   *  has one. Null for General Chats and threads without a project, whose
   *  crumb is plain text. */
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  railToggleShortcutLabel: string | null;
  /** Whether the right rail is showing, on any of its tabs or the launcher. */
  railOpen: boolean;
  /** False for capability-gated threads (General Chats) even when a project
   *  name exists: the rail still opens, just without its Source tab. */
  sourceControlAvailable: boolean;
  /** False where there is no project to preview, e.g. a general chat. */
  browserAvailable: boolean;
  browserOpen: boolean;
  /** Uncommitted work in the checkout, shown as its own count that opens the
   *  Source tab. Null when the tree is clean or the status has not loaded. */
  workingTreeChanges: WorkingTreeChanges | null;
  /**
   * Commits the branch is behind its upstream, shown beside the change count
   * as a pull-available hint. Null when there is nothing to pull or the status
   * has not loaded.
   */
  remoteBehindCount: number | null;
  /** Subagents running right now, drawn as faces. Null when nothing is live. */
  liveAgents: LiveAgentIndicator | null;
  /** The provider the thread's subagents run on; their faces carry its mark. */
  agentProviderDriverKind: ProviderDriverKind | null;
  /** False for General Chats: their scratch workspace has no files worth browsing. */
  fileBrowserAvailable: boolean;
  taskProgress: ThreadTaskProgressState | null;
  forkContext: ForkHeaderContext | null;
  /** Set on a thread another thread's agent started; it stays after separating. */
  parentContext?: ParentThreadHeaderContext | null | undefined;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  /** The thread the background runs belong to; where their output is read from. */
  activeThreadRef: ScopedThreadRef | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
  onViewProposedPlan?: (() => void) | undefined;
  onImplementProposedPlan?: (() => void) | undefined;
  onDismissProposedPlan?: (() => void) | undefined;
  onOpenForkSourceThread: (threadId: ThreadId) => void;
  /** Opens the thread that started this one. */
  onOpenParentThread?: ((threadId: ThreadId) => void) | undefined;
  onToggleTerminal: () => void;
  onToggleRail: () => void;
  onToggleBrowser: () => void;
  /** Opens (or focuses) the rail's Source tab; the change count's action. */
  onOpenSourceTab: () => void;
  /** Opens (or focuses) the rail's Agents tab; the agent faces' action. */
  onOpenAgentsTab: () => void;
  /** Present only for General Chat threads that can continue into a project. */
  onContinueInProject?: ((event: React.MouseEvent<HTMLButtonElement>) => void) | undefined;
  continueInProjectDisabledReason?: string | null;
}

/** Panel toggles carry no border, pressed or not: an open panel reads as a
 *  filled control, the way a hovered one reads as a tinted one. */
const HEADER_TOGGLE_CLASS =
  "shrink-0 text-muted-foreground hover:text-foreground data-pressed:border-transparent data-pressed:text-foreground dark:data-pressed:border-transparent";

/** Icon buttons that launch something rather than show a panel. */
const HEADER_ICON_BUTTON_CLASS = "shrink-0 text-muted-foreground hover:text-foreground";

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

/** Reads the change count out loud, naming what clicking it does. */
export function formatSourceChangesLabel(input: {
  readonly workingTreeChanges: WorkingTreeChanges | null;
  readonly remoteBehindCount: number | null;
}): string {
  const parts: string[] = [];
  const changes = input.workingTreeChanges;
  if (changes) {
    parts.push(
      changes.insertions > 0 || changes.deletions > 0
        ? `Uncommitted changes: ${changes.insertions} added, ${changes.deletions} removed.`
        : `Uncommitted changes in ${formatFileCount(changes.fileCount)}.`,
    );
  }
  if (input.remoteBehindCount !== null) {
    parts.push(
      input.remoteBehindCount === 1
        ? "1 commit behind the remote."
        : `${input.remoteBehindCount} commits behind the remote.`,
    );
  }
  parts.push("Open the Source tab.");
  return parts.join(" ");
}

function formatFileCount(count: number): string {
  if (count === 0) return "the working tree";
  return count === 1 ? "1 file" : `${count} files`;
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
  workingTreeChanges,
  remoteBehindCount,
  liveAgents,
  agentProviderDriverKind,
  fileBrowserAvailable,
  taskProgress,
  forkContext,
  parentContext = null,
  backgroundRuns,
  activeThreadRef,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleBackgroundRunTerminal,
  onStopBackgroundRun,
  onViewProposedPlan,
  onImplementProposedPlan,
  onDismissProposedPlan,
  onOpenForkSourceThread,
  onOpenParentThread,
  onToggleTerminal,
  onToggleRail,
  onOpenSourceTab,
  onOpenAgentsTab,
  onContinueInProject,
  continueInProjectDisabledReason,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canOpenInEditor = shouldShowOpenInEditor({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const continueInProjectState = resolveContinueInProjectHeaderState(
    continueInProjectDisabledReason,
  );
  const showSourceChanges =
    sourceControlAvailable && (workingTreeChanges !== null || remoteBehindCount !== null);
  // The divider splits launchers from the views on its right; with nothing on
  // its left it would only hang there. A narrow header drops it for the title.
  const hasLaunchers =
    activeProjectScripts !== undefined || fileBrowserAvailable || onContinueInProject !== undefined;

  return (
    <div
      className="@container/header-actions flex min-w-0 flex-1 items-center gap-2"
      data-active-project-name={activeProjectName}
      data-active-thread-title={activeThreadTitle}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
        <SidebarOpenTrigger className="size-7 shrink-0" />
        {activeProjectName && (
          // Hidden, not unmounted, on phones: the crumb menu owns the
          // open-favorite shortcut, which should still work there.
          <div className="hidden min-w-0 shrink items-center gap-1.5 sm:flex">
            {openInCwd !== null ? (
              <ProjectCrumbMenu
                projectName={activeProjectName}
                cwd={openInCwd}
                canOpenInEditor={canOpenInEditor}
                keybindings={keybindings}
                availableEditors={availableEditors}
              />
            ) : (
              <span
                className="min-w-0 max-w-48 truncate text-sm text-muted-foreground"
                title={activeProjectName}
              >
                {activeProjectName}
              </span>
            )}
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
            className="translate-y-px inline-flex h-6 min-w-0 shrink-0 items-center rounded-md px-1.5 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
        {parentContext && onOpenParentThread ? (
          <button
            type="button"
            data-testid="chat-header-started-by"
            className="translate-y-px inline-flex h-6 min-w-0 shrink-0 items-center rounded-md border border-border/70 bg-muted/45 px-1.5 text-[11px] leading-none text-muted-foreground transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground"
            onClick={() => onOpenParentThread(parentContext.parentThreadId)}
            aria-label={`Open the thread that started this one: ${parentContext.parentThreadTitle}`}
            title={`Started by ${parentContext.parentThreadTitle}`}
          >
            <span className="inline-flex min-w-0 items-center gap-1">
              <CornerDownRightIcon aria-hidden="true" className="size-3 shrink-0" />
              <span className="hidden sm:inline">Started by</span>
              <span className="max-w-28 truncate text-foreground/80 sm:max-w-40">
                {parentContext.parentThreadTitle}
              </span>
            </span>
          </button>
        ) : null}
        {activeProjectName && !isGitRepo && sourceControlAvailable && (
          <TooltipWrapper tooltip="This folder isn't a git repository. Chat works; source control, diffs, and refs need git. Run git init to enable them.">
            <span className="shrink-0 cursor-default text-[11px] leading-none text-amber-700/90 dark:text-amber-400/90">
              No Git
            </span>
          </TooltipWrapper>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1 @3xl/header-actions:gap-1.5">
        <ThreadActivityPopover
          taskProgress={taskProgress}
          backgroundRuns={backgroundRuns}
          threadRef={activeThreadRef}
          onToggleBackgroundRunTerminal={onToggleBackgroundRunTerminal}
          onStopBackgroundRun={onStopBackgroundRun}
          onViewProposedPlan={onViewProposedPlan}
          onImplementProposedPlan={onImplementProposedPlan}
          onDismissProposedPlan={onDismissProposedPlan}
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
                    "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors",
                    continueInProjectState.disabled
                      ? "cursor-default text-muted-foreground/70 opacity-70"
                      : "cursor-pointer text-foreground/85 hover:bg-accent hover:text-foreground",
                  )}
                  onClick={continueInProjectState.disabled ? undefined : onContinueInProject}
                >
                  <FolderInputIcon className="size-3.5" />
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
                  className={HEADER_ICON_BUTTON_CLASS}
                  onClick={() => {
                    openActiveFileViewer();
                  }}
                  aria-label="Browse project files"
                  variant="ghost"
                  size="icon-xs"
                  disabled={!terminalAvailable}
                >
                  <FolderOpenIcon className="size-3.5" />
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
        {hasLaunchers ? (
          <span
            aria-hidden="true"
            className="mx-0.5 h-4 w-px shrink-0 bg-border @max-xl/header-actions:hidden"
          />
        ) : null}
        {/* Hidden on a narrow header, where the room goes to the title; the
            Source tab still lists every count. */}
        {showSourceChanges ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="shrink-0 gap-1 px-1.5 font-mono text-[10.5px] @max-xl/header-actions:hidden"
                  onClick={onOpenSourceTab}
                  aria-label={formatSourceChangesLabel({ workingTreeChanges, remoteBehindCount })}
                  data-header-source-changes="true"
                />
              }
            >
              {workingTreeChanges ? (
                workingTreeChanges.insertions > 0 || workingTreeChanges.deletions > 0 ? (
                  <>
                    <span className="text-success">+{workingTreeChanges.insertions}</span>
                    <span className="text-destructive">−{workingTreeChanges.deletions}</span>
                  </>
                ) : (
                  <span className="font-sans text-[11px] text-muted-foreground">
                    {formatFileCount(workingTreeChanges.fileCount)}
                  </span>
                )
              ) : null}
              {/* Deliberately hue-less: the arrow is the signal, and a third
                  color beside the green/red counts would crowd them. */}
              {remoteBehindCount !== null ? (
                <span className="text-muted-foreground">↓{remoteBehindCount}</span>
              ) : null}
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {workingTreeChanges ? "Uncommitted changes. " : null}Open the Source tab.
              {remoteBehindCount !== null ? (
                <div className="text-muted-foreground">
                  {remoteBehindCount === 1
                    ? "1 commit behind the remote."
                    : `${remoteBehindCount} commits behind the remote.`}{" "}
                  Pull from the Source tab.
                </div>
              ) : null}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {liveAgents ? (
          <HeaderAgentFaces
            liveAgents={liveAgents}
            providerDriverKind={agentProviderDriverKind}
            onOpenAgents={onOpenAgentsTab}
          />
        ) : null}
        <div role="group" aria-label="Thread panels" className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className={HEADER_TOGGLE_CLASS}
                  pressed={terminalOpen}
                  onPressedChange={onToggleTerminal}
                  aria-label="Toggle terminal drawer"
                  size="xs"
                  disabled={!terminalAvailable}
                >
                  <TerminalSquareIcon className="size-3.5" />
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
                    className={HEADER_TOGGLE_CLASS}
                    pressed={browserOpen}
                    onPressedChange={onToggleBrowser}
                    aria-label="Toggle browser preview"
                    size="xs"
                  >
                    <GlobeIcon className="size-3.5" />
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
                  className={HEADER_TOGGLE_CLASS}
                  pressed={railOpen}
                  onPressedChange={onToggleRail}
                  aria-label="Toggle panel"
                  size="xs"
                >
                  <PanelRightIcon className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {railToggleShortcutLabel ? `Panel (${railToggleShortcutLabel})` : "Panel"}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
});
