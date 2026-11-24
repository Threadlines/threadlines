/**
 * Every command the app has, by name (docs/design/command-palette.md,
 * section 1). Data only: the command palette offers a command when whoever
 * owns its behavior registers a handler for it, and takes the words from
 * here; the Keybindings page and settings search label shortcuts from it.
 *
 * - A command with a shortcut uses the shortcut's id, and the check at the
 *   bottom fails to compile when a shortcut command has no entry.
 * - The numbered shortcut families (`thread.jump.N`, `modelPicker.jump.N`)
 *   share one `numbered` entry each, with "{n}" in the title.
 * - Order is the palette's order for commands that rank the same.
 *
 * Components that load at startup import only the `AppCommandId` type, so
 * this data loads with the palette and Settings.
 */
import type {
  KeybindingCommand,
  ModelPickerJumpKeybindingCommand,
  ThreadJumpKeybindingCommand,
} from "@threadlines/contracts";

export type AppCommandGroup = "thread" | "panels" | "project" | "goTo" | "app";

export interface AppCommandSpec {
  /** Exactly what the palette row says. */
  readonly title: string;
  /** One sentence, shown under the title. */
  readonly about?: string;
  readonly group: AppCommandGroup;
  /** Other words that find it. */
  readonly keywords?: ReadonlyArray<string>;
  /** "list": Enter opens a list to pick from (projects, themes, scripts, computers). */
  readonly kind?: "action" | "list";
  /** A list whose items are also found from the main search. */
  readonly itemsSearchable?: true;
  /** One entry for a numbered shortcut family; "{n}" in the title is the number. */
  readonly numbered?: true;
}

export const APP_COMMAND_GROUP_TITLES: Readonly<Record<AppCommandGroup, string>> = {
  thread: "Thread",
  panels: "Panels",
  project: "Projects",
  goTo: "Go to",
  app: "App",
};

export const APP_COMMANDS = {
  "chat.new": {
    title: "New thread",
    group: "thread",
    keywords: ["new thread", "chat", "create", "draft"],
  },
  "chat.newLocal": {
    title: "New local thread",
    about: "A new thread in the project's own folder, not a worktree",
    group: "thread",
    keywords: ["new thread", "local", "checkout", "no worktree"],
  },
  "codex.import": {
    title: "Bring in Codex conversation…",
    about: "Continue work from Codex app, CLI, or IDE",
    group: "thread",
    keywords: ["open", "import", "codex", "session", "chat", "conversation"],
  },
  "worktrees.pickUp": {
    title: "Add existing worktrees as threads…",
    about: "Worktrees this repository already has, made outside Threadlines",
    group: "project",
    keywords: ["worktree", "existing", "pick up", "import", "branch", "add threads"],
  },
  "project.brief": {
    title: "Project brief and notes",
    group: "project",
    keywords: ["brief", "project brief", "notes", "instructions", "rules"],
  },
  "chat.newIn": {
    title: "New thread in...",
    group: "thread",
    kind: "list",
    keywords: ["new thread", "project", "pick", "choose", "select"],
  },
  "project.add": {
    title: "Add project",
    group: "project",
    keywords: [
      "add project",
      "folder",
      "directory",
      "browse",
      "clone",
      "remote",
      "repository",
      "repo",
      "git",
      "github",
      "gitlab",
      "bitbucket",
      "azure",
      "devops",
      "url",
      "environment",
    ],
  },
  "navigate.home": {
    title: "Go to Home",
    group: "goTo",
    keywords: ["home", "landing", "start", "threads"],
  },
  "chat.newGeneral": {
    title: "New general chat",
    group: "thread",
    keywords: ["new chat", "general chat", "chat", "conversation", "no project"],
  },
  "navigate.generalChats": {
    title: "Open general chats",
    group: "goTo",
    keywords: ["general chats", "chats", "conversations", "no project"],
  },
  "navigate.terminals": {
    title: "Open Terminals",
    about: "Terminal tabs for any project, outside a chat",
    group: "goTo",
    keywords: ["terminals", "terminal", "shell", "shells", "split terminal", "dev server"],
  },
  "navigate.fleet": {
    title: "Open Fleet",
    about: "Your computers and what runs on them",
    group: "goTo",
    keywords: ["fleet", "computers", "machines", "devices", "phone", "graph", "running"],
  },
  "navigate.scheduled": {
    title: "Open Scheduled",
    about: "Tasks agents start at set times",
    group: "goTo",
    keywords: ["scheduled", "schedule", "tasks", "automations", "cron", "recurring", "daily"],
  },
  "scheduled.new": {
    title: "New scheduled task",
    group: "app",
    keywords: ["new scheduled task", "schedule", "automation", "cron", "recurring"],
  },
  "computer.rename": {
    title: "Rename this computer",
    group: "app",
    keywords: ["rename computer", "computer name", "name this computer", "fleet", "device"],
  },
  "app.whatsNew": {
    title: "What's new in Threadlines",
    group: "app",
    keywords: ["what's new", "whats new", "changelog", "release notes", "version", "update"],
  },
  "app.reportProblem": {
    title: "Report a problem",
    about: "Write a bug report and post it to GitHub",
    group: "app",
    keywords: ["report a problem", "report", "bug", "issue", "feedback", "github", "crash"],
  },
  "computer.connect": {
    title: "Connect to a computer",
    about: "Use projects from another computer that runs Threadlines",
    group: "app",
    keywords: ["connect", "computer", "add computer", "pair", "code", "ssh", "link computers"],
  },
  "outsideAgents.connect": {
    title: "Connect an agent",
    about: "Let an agent you run outside Threadlines use it",
    group: "app",
    keywords: [
      "connect an agent",
      "outside agent",
      "mcp",
      "claude code",
      "codex",
      "gemini",
      "cursor",
      "terminal",
    ],
  },
  "assistants.connect": {
    title: "Connect an assistant",
    about: "Show a code for an always-on assistant to sign in with",
    group: "app",
    keywords: [
      "connect an assistant",
      "assistant",
      "always-on",
      "grok bot",
      "dots",
      "muse",
      "claude duet",
      "connector",
      "sign-in code",
      "key",
    ],
  },
  "fleet.openComputer": {
    title: "Open computer in Fleet…",
    group: "goTo",
    kind: "list",
    itemsSearchable: true,
    keywords: ["fleet", "computer", "link", "unlink"],
  },
  "sidebar.toggle": {
    title: "Toggle sidebar",
    group: "panels",
    keywords: ["sidebar", "thread list", "hide", "show", "toggle", "rail"],
  },
  "navigate.pullRequests": {
    title: "Open pull requests",
    group: "goTo",
    keywords: ["pull requests", "prs", "pr", "reviews", "github"],
  },
  "thread.pullRequest": {
    title: "Open pull request",
    group: "panels",
    keywords: ["pull request", "pr", "review", "github"],
  },
  "panel.device": {
    title: "Open device",
    group: "panels",
    keywords: ["device", "simulator", "emulator", "ios", "android", "phone"],
  },
  "chat.find": {
    title: "Find in chat",
    about: "Search this chat's messages",
    group: "thread",
    keywords: ["find in chat", "find", "search this chat", "search messages", "ctrl f"],
  },
  "composer.screenshot": {
    title: "Capture screenshot",
    about: "Add a screenshot to the message you're writing",
    group: "thread",
    keywords: ["screenshot", "capture", "screen", "image", "attach", "picture"],
  },
  "terminal.toggle": {
    title: "Toggle terminal",
    about: "Show or hide this thread's terminal",
    group: "panels",
    keywords: ["terminal", "toggle terminal", "show terminal", "hide terminal", "shell"],
  },
  "terminal.new": {
    title: "New terminal tab",
    about: "Open another terminal for this thread",
    group: "panels",
    keywords: ["new terminal", "terminal tab", "open terminal", "shell"],
  },
  "terminal.split": {
    title: "Split terminal",
    about: "Open a terminal beside the current one",
    group: "panels",
    keywords: ["split terminal", "side by side", "terminal"],
  },
  "terminal.find": {
    title: "Find in terminal",
    about: "Search the terminal's output",
    group: "panels",
    keywords: ["find in terminal", "search terminal", "terminal output", "find"],
  },
  "terminal.restart": {
    title: "Restart terminal",
    about: "A new shell in the thread's folder, below the old output",
    group: "panels",
    keywords: ["restart terminal", "reset terminal", "new shell", "terminal"],
  },
  "terminal.clear": {
    title: "Clear terminal output",
    about: "Empty the terminal and its saved output",
    group: "panels",
    keywords: ["clear terminal", "clear output", "terminal"],
  },
  "terminal.close": {
    title: "Kill terminal",
    about: "Stop the terminal's shell and close its tab",
    group: "panels",
    keywords: ["kill terminal", "close terminal", "stop terminal", "terminal"],
  },
  "room.addAgent": {
    title: "Add agent",
    about: "Bring another model into this thread",
    group: "thread",
    keywords: ["add agent", "agents", "room", "model", "invite", "second opinion", "review"],
  },
  "thread.move": {
    title: "Move to another computer",
    about: "Move this thread and its changes to a linked computer",
    group: "thread",
    keywords: ["move", "computer", "linked", "transfer", "send", "another machine"],
  },
  "threads.moveMany": {
    title: "Move threads to another computer…",
    about: "Move several of this computer's threads to a linked computer",
    group: "app",
    keywords: ["move", "threads", "computer", "linked", "shut down", "clear", "another machine"],
  },
  "project.setUpElsewhere": {
    title: "Set up project on another computer",
    about: "Clone this project on another computer, with the ignored files you pick",
    group: "project",
    keywords: ["set up", "project", "computer", "clone", "copy", "another machine"],
  },
  "thread.makeLead": {
    title: "Make this the lead chat",
    group: "thread",
    keywords: ["lead chat", "lead", "coordinate", "project lead"],
  },
  "thread.stopLead": {
    title: "Stop using as lead chat",
    group: "thread",
    keywords: ["lead chat", "lead", "coordinate", "project lead"],
  },
  "thread.rename": {
    title: "Rename thread",
    group: "thread",
    keywords: ["rename", "title", "name"],
  },
  "thread.pin": {
    title: "Pin thread",
    group: "thread",
    keywords: ["pin", "keep", "top"],
  },
  "thread.unpin": {
    title: "Unpin thread",
    group: "thread",
    keywords: ["unpin"],
  },
  "thread.wrapUp": {
    title: "Wrap up thread",
    group: "thread",
    keywords: ["wrap up", "done", "finish", "file away"],
  },
  "thread.reopen": {
    title: "Reopen thread",
    group: "thread",
    keywords: ["reopen", "active", "unwrap"],
  },
  "thread.copyPath": {
    title: "Copy thread path",
    group: "thread",
    keywords: ["copy", "path", "folder", "directory"],
  },
  "thread.copyId": {
    title: "Copy thread ID",
    group: "thread",
    keywords: ["copy", "id"],
  },
  "thread.archive": {
    title: "Archive thread",
    group: "thread",
    keywords: ["archive", "hide", "put away"],
  },
  "thread.delete": {
    title: "Delete thread",
    group: "thread",
    keywords: ["delete", "remove", "trash"],
  },
  "leadChat.goTo": {
    title: "Go to lead chat…",
    group: "goTo",
    kind: "list",
    itemsSearchable: true,
    keywords: ["lead chat", "lead"],
  },
  "leadChat.new": {
    title: "New lead chat",
    group: "project",
    keywords: ["new lead chat", "lead chat", "lead", "coordinate"],
  },
  "navigate.usage": {
    title: "Open usage",
    group: "goTo",
    keywords: ["usage", "tokens", "cost", "spend", "spending", "price", "billing"],
  },
  "navigate.settings": {
    title: "Open settings",
    group: "goTo",
    keywords: ["settings", "preferences", "configuration", "keybindings"],
  },
  "navigate.setup": {
    title: "Set up agents",
    group: "app",
    keywords: ["setup", "set up", "agents", "providers", "install", "sign in", "onboarding"],
  },
  "navigate.communityAgents": {
    title: "Browse community agents",
    group: "app",
    keywords: ["community", "agents", "add agent", "install agent", "acp", "registry"],
  },
  "navigate.skills": {
    title: "Open skills",
    group: "goTo",
    keywords: ["skills", "plugins", "extensions", "agents", "capabilities"],
  },

  // Commands with a real action today that the palette did not offer (section 4).
  "diff.toggle": {
    title: "Toggle panel",
    about: "Show or hide the panel beside the chat: diff, source control, agents",
    group: "panels",
    keywords: ["diff", "toggle diff", "panel", "changes", "review", "side panel"],
  },
  "panel.diff": {
    title: "Show diff",
    about: "The changes this thread made",
    group: "panels",
    keywords: ["diff", "changes", "review", "files changed", "panel"],
  },
  "panel.sourceControl": {
    title: "Show source control",
    group: "panels",
    keywords: ["source control", "git", "commit", "branch", "changes", "panel"],
  },
  "panel.agents": {
    title: "Show agents",
    about: "The agents working in this thread",
    group: "panels",
    keywords: ["agents", "subagents", "workers", "panel"],
  },
  "panel.threads": {
    title: "Show threads panel",
    about: "Threads this thread started",
    group: "panels",
    keywords: ["threads", "child threads", "children", "panel"],
  },
  "modelPicker.toggle": {
    title: "Switch model",
    group: "thread",
    keywords: ["model", "switch model", "change model", "agent", "provider"],
  },
  "composer.stash": {
    title: "Stash message",
    about: "Put the message you're writing aside for later",
    group: "thread",
    keywords: ["stash", "save draft", "put aside", "later"],
  },
  "composer.planMode": {
    title: "Switch to plan mode",
    about: "The agent plans before it changes anything",
    group: "thread",
    keywords: ["plan", "plan mode", "mode", "think first"],
  },
  "composer.defaultMode": {
    title: "Switch to build mode",
    about: "The agent works on the task directly",
    group: "thread",
    keywords: ["build", "default mode", "mode", "leave plan mode"],
  },
  "editor.openFavorite": {
    title: "Open in editor",
    group: "project",
    keywords: ["editor", "open in editor", "vs code", "cursor", "zed", "ide"],
  },
  "thread.previous": {
    title: "Previous thread",
    group: "goTo",
    keywords: ["previous thread", "thread above", "up"],
  },
  "thread.next": {
    title: "Next thread",
    group: "goTo",
    keywords: ["next thread", "thread below", "down"],
  },
  "navigate.back": {
    title: "Go back",
    group: "goTo",
    keywords: ["back", "previous page", "history"],
  },
  "navigate.forward": {
    title: "Go forward",
    group: "goTo",
    keywords: ["forward", "next page", "history"],
  },
  "project.runScript": {
    title: "Run script…",
    group: "project",
    kind: "list",
    itemsSearchable: true,
    keywords: ["run", "script", "action", "dev server", "build", "test"],
  },
  "files.browse": {
    title: "Browse project files",
    group: "project",
    keywords: ["files", "file viewer", "browse", "open file", "tree"],
  },
  "browser.toggle": {
    title: "Toggle browser preview",
    group: "panels",
    keywords: ["browser", "preview", "web page", "localhost", "panel"],
  },
  "theme.change": {
    title: "Change theme…",
    group: "app",
    kind: "list",
    itemsSearchable: true,
    keywords: ["theme", "appearance", "dark mode", "light mode", "colors", "wallpaper"],
  },
  "theme.editColors": {
    title: "Edit theme colors…",
    group: "app",
    keywords: ["edit theme", "theme colors", "customize colors", "accent color", "tweak theme"],
  },
  "theme.useDefault": {
    title: "Use default theme",
    group: "app",
    keywords: ["default theme", "reset theme", "system theme", "can't read"],
  },
  "inbox.showWrapped": {
    title: "Show wrapped threads",
    about: "Threads you wrapped up, below the active ones",
    group: "thread",
    keywords: ["wrapped", "done", "finished", "filed away", "show wrapped"],
  },

  // Shortcut commands the palette has no row for: named for the Keybindings page.
  "commandPalette.toggle": {
    title: "Toggle command palette",
    group: "app",
    keywords: ["search", "commands", "palette"],
  },
  "thread.jump": {
    title: "Jump to thread {n}",
    group: "goTo",
    numbered: true,
  },
  "modelPicker.jump": {
    title: "Choose model {n}",
    group: "thread",
    numbered: true,
  },
} as const satisfies Record<string, AppCommandSpec>;

export type AppCommandId = keyof typeof APP_COMMANDS;

type NumberedFamilyCommand = ThreadJumpKeybindingCommand | ModelPickerJumpKeybindingCommand;
type StaticKeybindingCommand = Exclude<KeybindingCommand, `script.${string}.run`>;
/** The catalog id each static shortcut command is named by. */
type ShortcutCatalogId =
  | Exclude<StaticKeybindingCommand, NumberedFamilyCommand>
  | "thread.jump"
  | "modelPicker.jump";
type UnnamedShortcutCommand = Exclude<ShortcutCatalogId, AppCommandId>;
// A shortcut command without a catalog entry fails here, naming the command.
const everyShortcutIsNamed: [UnnamedShortcutCommand] extends [never]
  ? true
  : UnnamedShortcutCommand = true;
void everyShortcutIsNamed;

const NUMBERED_FAMILY = /^(thread\.jump|modelPicker\.jump)\.(\d+)$/;

/** The catalog entry a shortcut command is named by, with its number for a numbered family. */
export function appCommandForKeybinding(
  command: KeybindingCommand,
): { readonly id: AppCommandId; readonly number: number | null } | null {
  const numbered = NUMBERED_FAMILY.exec(command);
  if (numbered) {
    return { id: numbered[1] as AppCommandId, number: Number(numbered[2]) };
  }
  return command in APP_COMMANDS ? { id: command as AppCommandId, number: null } : null;
}

/** A command's title, with a numbered family's number filled in. */
export function appCommandTitle(id: AppCommandId, number: number | null = null): string {
  const title: string = APP_COMMANDS[id].title;
  return number === null ? title : title.replace("{n}", String(number));
}

/** Whether a string names a catalog command. */
export function isAppCommandId(value: string): value is AppCommandId {
  return Object.hasOwn(APP_COMMANDS, value);
}
