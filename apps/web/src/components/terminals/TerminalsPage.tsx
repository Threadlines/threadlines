/**
 * The Terminals page (docs/terminal.md, "The Terminals page"): terminal tabs
 * and split panes tied to no chat. Each computer has its own set, kept by its
 * own server; the picker in the title row chooses the project the next tab or
 * split starts in, and picking a project on another computer shows that
 * computer's tabs. Nothing here starts an agent or makes a thread.
 */
import {
  type EnvironmentId,
  type ScopedThreadRef,
  TERMINALS_PAGE_THREAD_ID,
} from "@threadlines/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopeProjectRef,
} from "@threadlines/client-runtime";
import { projectScriptRuntimeEnv } from "@threadlines/shared/projectScripts";
import { shortenHomePath } from "@threadlines/shared/path";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn, randomUUID } from "../../lib/utils";
import { isKeyboardOwnedByDialog } from "../../commands/shortcutBlock";
import { useServerKeybindings } from "../../rpc/serverState";
import { selectWorkspaceProjectsAcrossEnvironments, useStore } from "../../store";
import { type TerminalCommandKind, useTerminalCommandsStore } from "../../terminalCommands";
import {
  selectTerminalTabs,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "../../terminalStateStore";
import type { Project } from "../../types";
import { PageTitlebar } from "../PageTitlebar";
import { ProjectFavicon } from "../ProjectFavicon";
import { useComputerLabel } from "../sidebar/linkedComputers";
import { ManagedTerminalDrawer } from "../terminal/ManagedTerminalDrawer";
import {
  type TerminalStopAction,
  TerminalStopConfirmDialog,
  terminalStopNeedsConfirm,
} from "../terminal/TerminalStopConfirmDialog";
import { killTerminalTab } from "../terminal/terminalTabActions";
import { Button } from "../ui/button";
import {
  Menu,
  MENU_PICK_ITEM_CLASS_NAME,
  MENU_PICK_ITEM_SELECTED_CLASS_NAME,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { DropdownChevron } from "../ui/select";
import { failureNotice, toastManager } from "../ui/toast";
import {
  forgetRequestedTabFolder,
  parseTerminalsSearch,
  requestedTabFolder,
  requestTabFolder,
  tabFolderLabel,
  terminalsPageThreadRef,
} from "./terminalsPage.logic";

const SELECTED_PROJECT_STORAGE_KEY = "threadlines:terminals-page-project";
/** The size a restarted shell starts at; the tab resizes it right away. */
const RESTART_COLS = 120;
const RESTART_ROWS = 30;

function projectKeyOf(project: Pick<Project, "environmentId" | "id">): string {
  return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
}

/** The pick for a computer with page tabs but no project left. */
const COMPUTER_KEY_PREFIX = "computer:";

/** One computer's projects, as the picker groups them. */
interface ComputerProjects {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly online: boolean;
  readonly projects: ReadonlyArray<Project>;
}

/** Whether this app can reach a computer's server now. This computer's always counts. */
function useComputerOnline(): (environmentId: EnvironmentId) => boolean {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  return useCallback(
    (environmentId) =>
      environmentId === primaryEnvironmentId ||
      runtimeById[environmentId]?.connectionState === "connected",
    [primaryEnvironmentId, runtimeById],
  );
}

export function TerminalsPage() {
  const projects = useStore(useShallow(selectWorkspaceProjectsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const computerLabel = useComputerLabel();
  const isOnline = useComputerOnline();
  const [selectedKey, setSelectedKey] = useLocalStorage(
    SELECTED_PROJECT_STORAGE_KEY,
    "",
    Schema.String,
  );
  // Computers with page tabs, also once their last project is gone: their
  // shells still run and hold ports.
  const tabEnvironmentIds = useTerminalStateStore(
    useShallow((state) =>
      Object.entries(state.terminalTabsByThreadKey).flatMap(([threadKey, tabs]) => {
        const ref = parseScopedThreadKey(threadKey);
        return ref?.threadId === TERMINALS_PAGE_THREAD_ID && tabs.length > 0
          ? [ref.environmentId]
          : [];
      }),
    ),
  );
  // This computer first, then the others by name.
  const computers = useMemo((): ComputerProjects[] => {
    const byEnvironment = new Map<EnvironmentId, Project[]>();
    for (const environmentId of tabEnvironmentIds) byEnvironment.set(environmentId, []);
    for (const project of projects) {
      const list = byEnvironment.get(project.environmentId) ?? [];
      list.push(project);
      byEnvironment.set(project.environmentId, list);
    }
    return [...byEnvironment]
      .map(([environmentId, list]) => ({
        environmentId,
        label: computerLabel(environmentId, "Computer"),
        online: isOnline(environmentId),
        projects: list,
      }))
      .toSorted((left, right) =>
        left.environmentId === primaryEnvironmentId
          ? -1
          : right.environmentId === primaryEnvironmentId
            ? 1
            : left.label.localeCompare(right.label),
      );
  }, [computerLabel, isOnline, primaryEnvironmentId, projects, tabEnvironmentIds]);
  // The pick, or (gone, or never made) this computer's first project.
  const pickedProject = projects.find((entry) => projectKeyOf(entry) === selectedKey) ?? null;
  const pickedComputer = selectedKey.startsWith(COMPUTER_KEY_PREFIX)
    ? computers.find(
        (entry) => entry.environmentId === selectedKey.slice(COMPUTER_KEY_PREFIX.length),
      )
    : undefined;
  const computer =
    (pickedProject
      ? computers.find((entry) => entry.environmentId === pickedProject.environmentId)
      : pickedComputer) ?? computers[0];
  const project = pickedProject ?? computer?.projects[0] ?? null;

  // Asked to show a computer (a port notice's Show): its first project, unless
  // the pick is already there. The address then drops the ask.
  const navigate = useNavigate();
  const askedEnvironment = useSearch({
    strict: false,
    select: (search: Record<string, unknown>) => parseTerminalsSearch(search).environment ?? null,
  });
  useEffect(() => {
    if (askedEnvironment === null) return;
    const asked = computers.find((entry) => entry.environmentId === askedEnvironment);
    if (asked === undefined) return;
    if (computer?.environmentId !== askedEnvironment) {
      const first = asked.projects[0];
      setSelectedKey(first ? projectKeyOf(first) : `${COMPUTER_KEY_PREFIX}${asked.environmentId}`);
    }
    void navigate({ to: "/terminals", search: {}, replace: true });
  }, [askedEnvironment, computer?.environmentId, computers, navigate, setSelectedKey]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-testid="terminals-page">
      <PageTitlebar label="Terminals">
        {computer ? (
          <TerminalsProjectPicker
            computers={computers}
            project={project}
            computer={computer}
            onSelect={(next) => setSelectedKey(projectKeyOf(next))}
            onSelectComputer={(environmentId) =>
              setSelectedKey(`${COMPUTER_KEY_PREFIX}${environmentId}`)
            }
          />
        ) : null}
      </PageTitlebar>
      {computer === undefined ? (
        <TerminalsPageMessage
          title="No projects yet"
          detail="Add a project, then open terminals in its folder here."
        />
      ) : !computer.online ? (
        <TerminalsPageMessage
          title={`${computer.label} is offline`}
          detail="Its terminals keep running there and show here again once it's back."
        />
      ) : (
        <ComputerTerminals
          key={computer.environmentId}
          environmentId={computer.environmentId}
          computerLabel={computer.label}
          project={project}
          projects={computer.projects}
        />
      )}
    </div>
  );
}

function TerminalsPageMessage({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-[13px] text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * "New tabs in <project>" in the title row: a plain toolbar picker whose menu
 * groups projects under each computer's name. It names the computer too when
 * there is more than one. A computer with open tabs and no project left is
 * listed with its tabs alone.
 */
function TerminalsProjectPicker({
  computers,
  project,
  computer,
  onSelect,
  onSelectComputer,
}: {
  readonly computers: ReadonlyArray<ComputerProjects>;
  readonly project: Project | null;
  readonly computer: ComputerProjects;
  readonly onSelect: (project: Project) => void;
  readonly onSelectComputer: (environmentId: EnvironmentId) => void;
}) {
  const several = computers.length > 1;
  const selectedKey = project === null ? null : projectKeyOf(project);
  const name = project?.name ?? "its tabs' folders";
  return (
    <div className="flex min-w-0 items-center gap-1 text-[13px]">
      <span className="shrink-0 text-muted-foreground">New tabs in</span>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`Project for new terminals: ${name}${several ? ` on ${computer.label}` : ""}`}
              className="inline-flex min-w-0 max-w-72 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
            />
          }
        >
          {project ? (
            <ProjectFavicon
              environmentId={project.environmentId}
              cwd={project.cwd}
              name={project.name}
            />
          ) : null}
          <span className={cn("truncate", project ? "font-medium" : "text-muted-foreground")}>
            {name}
          </span>
          {several ? (
            <span className="truncate text-muted-foreground">on {computer.label}</span>
          ) : null}
          <DropdownChevron solid={false} />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-60 max-w-96">
          {computers.map((entry, index) => (
            <MenuGroup key={entry.environmentId}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuGroupLabel className="flex min-w-0 items-center gap-1.5">
                <MonitorIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{entry.label}</span>
                {entry.online ? null : <span className="shrink-0 font-normal">· offline</span>}
              </MenuGroupLabel>
              {entry.projects.length === 0 ? (
                <MenuItem
                  className={cn(
                    MENU_PICK_ITEM_CLASS_NAME,
                    project === null &&
                      entry.environmentId === computer.environmentId &&
                      MENU_PICK_ITEM_SELECTED_CLASS_NAME,
                  )}
                  onClick={() => onSelectComputer(entry.environmentId)}
                >
                  Open tabs (no project)
                </MenuItem>
              ) : null}
              {entry.projects.map((candidate) => {
                const selected = projectKeyOf(candidate) === selectedKey;
                return (
                  <MenuItem
                    key={projectKeyOf(candidate)}
                    className={cn(
                      MENU_PICK_ITEM_CLASS_NAME,
                      selected && MENU_PICK_ITEM_SELECTED_CLASS_NAME,
                    )}
                    onClick={() => onSelect(candidate)}
                  >
                    <ProjectFavicon
                      environmentId={candidate.environmentId}
                      cwd={candidate.cwd}
                      name={candidate.name}
                    />
                    <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                    <span
                      className="max-w-40 shrink truncate font-mono text-[10.5px] text-muted-foreground"
                      title={candidate.cwd}
                    >
                      {shortenHomePath(candidate.cwd)}
                    </span>
                  </MenuItem>
                );
              })}
            </MenuGroup>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}

/**
 * One computer's tabs. New ones start in `project` (with none left, in the
 * active tab's folder); each keeps its own folder after.
 */
function ComputerTerminals({
  environmentId,
  computerLabel,
  project,
  projects,
}: {
  readonly environmentId: EnvironmentId;
  readonly computerLabel: string;
  readonly project: Project | null;
  readonly projects: ReadonlyArray<Project>;
}) {
  const threadRef = useMemo(() => terminalsPageThreadRef(environmentId), [environmentId]);
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore(
    (state) => selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).terminalOpen,
  );
  const activeTerminalId = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).activeTerminalId,
  );
  // Whether this device's layout holds a tab the server lists. Not just "the
  // server lists tabs": right after the last tab is killed the list still
  // names it, and opening then would start a new shell.
  const showsListedTab = useTerminalStateStore((state) => {
    const { terminalIds } = selectThreadTerminalState(state.terminalStateByThreadKey, threadRef);
    return selectTerminalTabs(state.terminalTabsByThreadKey, threadRef).some((tab) =>
      terminalIds.includes(tab.terminalId),
    );
  });
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [findRequested, setFindRequested] = useState(false);
  const [pendingStop, setPendingStop] = useState<TerminalStopAction | null>(null);

  // Tabs the server lists show, also on a device that never opened them.
  useEffect(() => {
    if (showsListedTab && !terminalOpen) {
      useTerminalStateStore.getState().setTerminalOpen(threadRef, true);
    }
  }, [showsListedTab, terminalOpen, threadRef]);

  const listedFolder = useTerminalStateStore((state) => {
    const tabs = selectTerminalTabs(state.terminalTabsByThreadKey, threadRef);
    return (
      tabs.find((tab) => tab.terminalId === activeTerminalId)?.cwd ??
      tabs.find((tab) => tab.cwd !== null)?.cwd ??
      null
    );
  });
  const projectCwd = project?.cwd ?? listedFolder;
  const runtimeEnv = useMemo(
    () =>
      projectCwd === null
        ? {}
        : projectScriptRuntimeEnv({ project: { cwd: projectCwd }, worktreePath: null }),
    [projectCwd],
  );
  // A tab's own folder, and its environment from that folder, never the
  // pick's: the one asked for here, or the one the server lists (a shell it
  // starts again after a restart).
  const launchFor = useCallback(
    (terminalId: string) => {
      const cwd =
        requestedTabFolder(threadRef, terminalId) ??
        selectTerminalTabs(
          useTerminalStateStore.getState().terminalTabsByThreadKey,
          threadRef,
        ).find((tab) => tab.terminalId === terminalId)?.cwd ??
        null;
      return cwd === null
        ? null
        : { cwd, runtimeEnv: projectScriptRuntimeEnv({ project: { cwd }, worktreePath: null }) };
    },
    [threadRef],
  );
  const folderLabelFor = useCallback(
    (_terminalId: string, cwd: string | null) => tabFolderLabel(cwd, projects),
    [projects],
  );

  const newTerminal = useCallback(
    (terminalId: string) => {
      if (projectCwd === null) return;
      requestTabFolder(threadRef, terminalId, projectCwd);
      useTerminalStateStore.getState().newTerminal(threadRef, terminalId);
    },
    [projectCwd, threadRef],
  );
  const splitTerminal = useCallback(
    (terminalId: string) => {
      if (projectCwd === null) return;
      requestTabFolder(threadRef, terminalId, projectCwd);
      useTerminalStateStore.getState().splitTerminal(threadRef, terminalId);
    },
    [projectCwd, threadRef],
  );
  /**
   * The first tab, when none is open. It gets an id of its own rather than
   * the drawer's placeholder ("default"), which every device shares: two
   * devices opening their first tab at once would get one shell, and a kill
   * asked about one tab could stop the next one made under the same id.
   */
  const openFirstTerminal = useCallback(() => {
    if (projectCwd === null) return;
    const store = useTerminalStateStore.getState();
    const placeholder = activeTerminalId;
    const terminalId = `terminal-${randomUUID()}`;
    requestTabFolder(threadRef, terminalId, projectCwd);
    store.newTerminal(threadRef, terminalId);
    const listed = selectTerminalTabs(store.terminalTabsByThreadKey, threadRef);
    if (!listed.some((tab) => tab.terminalId === placeholder)) {
      useTerminalStateStore.getState().closeTerminal(threadRef, placeholder);
    }
    setFocusRequestId((value) => value + 1);
  }, [activeTerminalId, projectCwd, threadRef]);

  const performStop = useCallback(
    (kind: "kill" | "restart", terminalId: string) => {
      if (kind === "kill") {
        if (killTerminalTab(threadRef, terminalId)) forgetRequestedTabFolder(threadRef, terminalId);
        setFocusRequestId((value) => value + 1);
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      // A new shell where the old one started, below its output.
      const listed = selectTerminalTabs(
        useTerminalStateStore.getState().terminalTabsByThreadKey,
        threadRef,
      ).find((tab) => tab.terminalId === terminalId);
      const cwd = listed?.cwd ?? requestedTabFolder(threadRef, terminalId) ?? projectCwd;
      if (cwd === null) return;
      void api.terminal
        .restart({
          threadId: threadRef.threadId,
          terminalId,
          cwd,
          cols: RESTART_COLS,
          rows: RESTART_ROWS,
          env: projectScriptRuntimeEnv({ project: { cwd }, worktreePath: null }),
        })
        .catch((error: unknown) => {
          toastManager.add(failureNotice({ title: "Couldn't restart the terminal", error }));
        });
      setFocusRequestId((value) => value + 1);
    },
    [environmentId, projectCwd, threadRef],
  );
  const requestStop = useCallback(
    (kind: "kill" | "restart", terminalId: string, options?: { sessionExited?: boolean }) => {
      if (options?.sessionExited !== true && terminalStopNeedsConfirm(threadRef, terminalId)) {
        setPendingStop({ kind, threadRef, terminalId });
        return;
      }
      performStop(kind, terminalId);
    },
    [performStop, threadRef],
  );
  const closeTerminal = useCallback(
    (_ref: ScopedThreadRef, terminalId: string, options?: { sessionExited?: boolean }) =>
      requestStop("kill", terminalId, options),
    [requestStop],
  );
  const restartTerminal = useCallback(
    (_ref: ScopedThreadRef, terminalId: string) => requestStop("restart", terminalId),
    [requestStop],
  );

  // The terminal's shortcuts, as a thread's drawer answers them.
  const runCommand = useEffectEvent((kind: TerminalCommandKind) => {
    const id = `terminal-${randomUUID()}`;
    switch (kind) {
      case "toggle":
        return;
      case "new":
        if (!terminalOpen) openFirstTerminal();
        else newTerminal(id);
        setFocusRequestId((value) => value + 1);
        return;
      case "split":
        if (!terminalOpen) openFirstTerminal();
        else splitTerminal(id);
        setFocusRequestId((value) => value + 1);
        return;
      case "find":
        if (terminalOpen) setFindRequested(true);
        return;
      case "clear":
        if (!terminalOpen) return;
        void readEnvironmentApi(environmentId)
          ?.terminal.clear({ threadId: threadRef.threadId, terminalId: activeTerminalId })
          .catch(() => undefined);
        return;
      case "restart":
        if (terminalOpen) requestStop("restart", activeTerminalId);
        return;
      case "kill":
        if (terminalOpen) requestStop("kill", activeTerminalId);
        return;
    }
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isKeyboardOwnedByDialog() || event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), terminalOpen },
      });
      const kind =
        command === "terminal.new"
          ? "new"
          : command === "terminal.split"
            ? "split"
            : command === "terminal.close"
              ? "kill"
              : command === "terminal.find"
                ? "find"
                : null;
      if (kind === null) return;
      event.preventDefault();
      event.stopPropagation();
      runCommand(kind);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [keybindings, terminalOpen]);
  // The palette's terminal actions, while this page is open.
  const commandRequest = useTerminalCommandsStore((state) => state.request);
  const handledNonceRef = useRef(commandRequest?.nonce ?? 0);
  useEffect(() => {
    if (!commandRequest || commandRequest.nonce === handledNonceRef.current) return;
    handledNonceRef.current = commandRequest.nonce;
    runCommand(commandRequest.kind);
  }, [commandRequest]);

  const shortcutOptions = useMemo(
    () => ({ context: { terminalFocus: true, terminalOpen: true } }),
    [],
  );
  const shortcut = (command: Parameters<typeof shortcutLabelForCommand>[1]) =>
    shortcutLabelForCommand(keybindings, command, shortcutOptions) ?? undefined;

  return (
    <>
      {terminalOpen && projectCwd !== null ? (
        <ManagedTerminalDrawer
          threadRef={threadRef}
          layout="page"
          cwd={projectCwd}
          worktreePath={null}
          runtimeEnv={runtimeEnv}
          launchFor={launchFor}
          folderLabelFor={folderLabelFor}
          visible
          focusRequestId={focusRequestId}
          findRequested={findRequested}
          onFindRequestHandled={() => setFindRequested(false)}
          splitShortcutLabel={shortcut("terminal.split")}
          newShortcutLabel={shortcut("terminal.new")}
          closeShortcutLabel={shortcut("terminal.close")}
          hideShortcutLabel={undefined}
          findShortcutLabel={shortcut("terminal.find")}
          keybindings={keybindings}
          onAddTerminalContext={null}
          onCloseTerminal={closeTerminal}
          onRestartTerminal={restartTerminal}
          onNewTerminal={newTerminal}
          onSplitTerminal={splitTerminal}
        />
      ) : project === null ? (
        <TerminalsPageMessage
          title={`No projects on ${computerLabel}`}
          detail="Add a project there to open terminals in its folder."
        />
      ) : (
        <TerminalsPageMessage
          title={`No terminals on ${computerLabel}`}
          detail={`A new one starts in ${project.name}. Its shell keeps running while you work elsewhere.`}
          action={
            <Button size="sm" variant="outline" onClick={openFirstTerminal}>
              New terminal
            </Button>
          }
        />
      )}
      <TerminalStopConfirmDialog
        action={pendingStop}
        host="page"
        onConfirm={() => {
          if (pendingStop) performStop(pendingStop.kind, pendingStop.terminalId);
          setPendingStop(null);
        }}
        onCancel={() => setPendingStop(null)}
      />
    </>
  );
}
