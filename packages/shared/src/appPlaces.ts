/**
 * Places in the app: every page, settings section and settings row a user can
 * be sent to (docs/design/app-guide.md). One catalog serves three readers:
 *
 * - the settings screens take their titles (and default descriptions) from it,
 *   so the words agents use are the words on screen;
 * - the server's `app_guide` tool answers agents' questions about the app from
 *   it, with this computer's current values for places that have a `value`;
 * - the chat turns `threadlines-place:<id>` links into chips that open the
 *   place and highlight it.
 *
 * Rows built from data (one per provider, device, linked computer, agent) are
 * not listed one by one: their section is the place, and its `about` says what
 * each row holds.
 */
import type {
  AgentInvitesMode,
  AgentThreadsMode,
  ComputerLinkAccess,
  ServerSettings,
} from "@threadlines/contracts";

import { agentInvitesChoice, agentThreadsMode } from "./serverSettings.ts";

/** Where a page lives in the app, and which computer it can show. */
export interface AppPlaceRoute {
  /** The route path, e.g. "/settings/threads". Fleet computer pages add the computer. */
  readonly to: string;
  /** Search params the page already uses to reveal something (`?section=agents`). */
  readonly search?: Readonly<Record<string, string>>;
}

/**
 * How a page targets a computer: "own" shows the app's own computer only;
 * "thread" can show the computer (and project) a thread runs on; "fleet"
 * shows any linked computer.
 */
export type AppPlaceTarget = "own" | "thread" | "fleet";

/** Where a place's value lives: on the computer's server, in each app, or in the desktop app. */
export type AppPlaceScope = "computer" | "device" | "desktop";

/**
 * How `app_guide` reads and words a place's current value. Only places with a
 * value are ever read, so this is the allowlist of what agents can see.
 */
export type AppPlaceValue =
  | { readonly kind: "switch"; readonly read: (settings: ServerSettings) => boolean }
  | {
      readonly kind: "choice";
      readonly read: (settings: ServerSettings) => string;
      /** Each value's label, exactly as the screen's menu shows it. */
      readonly options: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "state";
      /** Values the server gathers from its own records, not from settings. */
      readonly state: "linkedComputers" | "providers" | "outsideAgents" | "scheduledTasks";
    };

interface AppPlaceSpec {
  readonly id: string;
  readonly kind: "page" | "section" | "row";
  /** Exactly what the screen says. */
  readonly title: string;
  /** One sentence: what it is or does. Settings rows show it when they have no live description. */
  readonly about: string;
  /** The section a row sits in, or the page a section sits on. */
  readonly parent?: string;
  /** Pages: where they live. Sections and rows: search params that reveal them. */
  readonly route?: AppPlaceRoute;
  /** Pages: which computer they can show (default "own"). */
  readonly target?: AppPlaceTarget;
  /** Words users say for it that its title doesn't ("link", "phone", "PC"). */
  readonly keywords?: ReadonlyArray<string>;
  readonly scope?: AppPlaceScope;
  readonly value?: AppPlaceValue;
  /** Only shown in the desktop app. */
  readonly appliesWhen?: "desktop";
  /** Gives agents more reach: the guide says only the user can change it. */
  readonly widensAgents?: true;
}

const onOff = (read: (settings: ServerSettings) => boolean): AppPlaceValue => ({
  kind: "switch",
  read,
});

/** "Agents bringing in other agents", as its menu words each choice. */
export const AGENT_INVITES_LABELS: Readonly<Record<AgentInvitesMode, string>> = {
  off: "Off",
  ask: "Ask me first",
  auto: "Without asking",
};

/** "Agents can start threads", as its menu words each choice. */
export const AGENT_THREADS_LABELS: Readonly<Record<AgentThreadsMode, string>> = {
  off: "Off",
  ask: "Ask me first",
  auto: "Automatic",
};

/** What a computer link's access is called wherever the user sees or sets it (Fleet). */
export const COMPUTER_LINK_ACCESS_LABELS: Readonly<Record<ComputerLinkAccess, string>> = {
  allowed: "Allowed",
  ask: "Ask first",
  off: "Off",
};

// ----- pages ---------------------------------------------------------------------

const PAGES = [
  {
    id: "settings.general",
    kind: "page",
    title: "General",
    about: "How Threadlines looks, how chats show, and this computer.",
    route: { to: "/settings/general" },
  },
  {
    id: "settings.threads",
    kind: "page",
    title: "Threads",
    about: "How new threads start, who's in them, and what happens when they're done.",
    route: { to: "/settings/threads" },
  },
  {
    id: "settings.archived",
    kind: "page",
    title: "Archives",
    about: "Threads you've put away, and when old ones get archived for you.",
    route: { to: "/settings/archived" },
  },
  {
    id: "settings.providers",
    kind: "page",
    title: "Providers",
    about: "The agents you can run, their accounts and their models.",
    route: { to: "/settings/providers" },
    keywords: ["agents", "models", "sign in", "account", "claude", "codex", "cursor"],
    value: { kind: "state", state: "providers" },
  },
  {
    id: "settings.plugins",
    kind: "page",
    title: "Plugins & Skills",
    about: "Plugins, skills and connections your agents can use.",
    route: { to: "/settings/plugins" },
    target: "thread",
    keywords: ["mcp", "extensions", "marketplace"],
  },
  {
    id: "settings.instructions",
    kind: "page",
    title: "Agent Instructions",
    about: "The instruction files agents read before they start work.",
    route: { to: "/settings/instructions" },
    target: "thread",
    keywords: ["AGENTS.md", "CLAUDE.md", "rules"],
  },
  {
    id: "settings.sourceControl",
    kind: "page",
    title: "Source Control",
    about: "How Threadlines works with Git and the sites that host your code.",
    route: { to: "/settings/source-control" },
    keywords: ["git", "github", "pull request"],
  },
  {
    id: "settings.connections",
    kind: "page",
    title: "Connections",
    about: "Use this computer from your phone, or other computers from here.",
    route: { to: "/settings/connections" },
    keywords: ["phone", "pair", "remote", "devices"],
  },
  {
    id: "settings.keybindings",
    kind: "page",
    title: "Keybindings",
    about: "Keyboard shortcuts for commands, and when each one applies.",
    route: { to: "/settings/keybindings" },
    keywords: ["shortcuts", "keyboard"],
  },
  {
    id: "settings.diagnostics",
    kind: "page",
    title: "Diagnostics",
    about: "Slow requests, live processes and recent failures on this computer.",
    route: { to: "/settings/diagnostics" },
  },
  {
    id: "fleet",
    kind: "page",
    title: "Fleet",
    about:
      "The computers this app knows: each one's connection, what other computers' agents may do on it, and its devices.",
    route: { to: "/fleet" },
    target: "fleet",
    keywords: ["computers", "link", "pc", "mac", "windows", "machines"],
  },
  {
    id: "scheduled",
    kind: "page",
    title: "Scheduled",
    about: "Tasks that start an agent on a schedule or when an event arrives.",
    route: { to: "/scheduled" },
    keywords: ["cron", "schedule", "webhook", "event", "recurring"],
    value: { kind: "state", state: "scheduledTasks" },
  },
  {
    id: "usage",
    kind: "page",
    title: "Usage",
    about: "How much of each provider's plan you've used, by model and computer.",
    route: { to: "/usage" },
    keywords: ["limits", "quota", "tokens"],
  },
  {
    id: "generalChats",
    kind: "page",
    title: "General Chats",
    about: "Chats with an agent that aren't tied to a project.",
    route: { to: "/chats" },
  },
  {
    id: "pullRequests",
    kind: "page",
    title: "Pull Requests",
    about: "Your pull requests across projects, with their checks and reviews.",
    route: { to: "/pull-requests" },
    keywords: ["pr", "github", "checks"],
  },
] as const satisfies ReadonlyArray<AppPlaceSpec>;

// ----- sections --------------------------------------------------------------------

const SECTIONS = [
  // General
  {
    id: "general.alerts",
    kind: "section",
    parent: "settings.general",
    title: "Alerts",
    about: "Which alerts this device shows: when a thread needs you, finishes or fails.",
    scope: "device",
    keywords: ["notifications", "push"],
  },
  {
    id: "general.appearance",
    kind: "section",
    parent: "settings.general",
    title: "Appearance",
    about: "Theme and time format.",
    scope: "device",
    keywords: ["dark mode", "light mode"],
  },
  {
    id: "general.chatAndDiffs",
    kind: "section",
    parent: "settings.general",
    title: "Chat & diffs",
    about: "How replies stream, how changed files show in the chat, and how diffs wrap.",
  },
  {
    id: "general.terminal",
    kind: "section",
    parent: "settings.general",
    title: "Terminal",
    about: "The terminal's text size and screen reader support.",
    scope: "device",
  },
  {
    id: "general.dictation",
    kind: "section",
    parent: "settings.general",
    title: "Dictation",
    about: "The speech model for talking to agents, and how recording starts.",
    keywords: ["voice", "microphone", "speech"],
  },
  {
    id: "general.thisComputer",
    kind: "section",
    parent: "settings.general",
    title: "This computer",
    about:
      "Keeping this computer awake, where new projects start, which browser opens links, the size its pages open at, and which sites agents can visit.",
  },
  {
    id: "general.about",
    kind: "section",
    parent: "settings.general",
    title: "Privacy & about",
    about: "The app's version and update track, usage analytics, and diagnostics.",
    keywords: ["version", "update", "nightly", "stable"],
  },
  // Threads
  {
    id: "threads.newThreads",
    kind: "section",
    parent: "settings.threads",
    title: "New threads",
    about:
      "The agent and room new threads start with, where they start, and what agents in them may do.",
  },
  {
    id: "threads.rooms",
    kind: "section",
    parent: "settings.threads",
    title: "Rooms",
    about: "Threads with more than one agent, and whether agents may bring in others.",
  },
  {
    id: "threads.titlesAndWriting",
    kind: "section",
    parent: "settings.threads",
    title: "Titles & writing",
    about: "The models that write thread titles and other short text.",
  },
  {
    id: "threads.whenDone",
    kind: "section",
    parent: "settings.threads",
    title: "When a thread is done",
    about: "When threads wrap up on their own, and whether archive and delete ask first.",
    scope: "device",
  },
  // Archives
  {
    id: "archived.cleanup",
    kind: "section",
    parent: "settings.archived",
    title: "Thread cleanup",
    about: "Archiving inactive threads, and deleting old archived ones.",
  },
  {
    id: "archived.threads",
    kind: "section",
    parent: "settings.archived",
    title: "Archived threads",
    about: "Every archived thread, to bring back or delete.",
  },
  // Providers
  {
    id: "providers.community",
    kind: "section",
    parent: "settings.providers",
    title: "Community agents",
    about: "Agents from the open ACP registry you can add. Threadlines hasn't tested them.",
    route: { to: "/settings/providers", search: { section: "community" } },
    widensAgents: true,
  },
  // Plugins & Skills
  {
    id: "plugins.installed",
    kind: "section",
    parent: "settings.plugins",
    title: "Installed plugins",
    about: "Plugins installed for each provider, on this computer or a project.",
    route: { to: "/settings/plugins", search: { tab: "plugins" } },
    widensAgents: true,
  },
  {
    id: "plugins.apps",
    kind: "section",
    parent: "settings.plugins",
    title: "Apps",
    about: "Apps your agents can open inside the chat.",
    route: { to: "/settings/plugins", search: { tab: "plugins" } },
    widensAgents: true,
  },
  {
    id: "plugins.connections",
    kind: "section",
    parent: "settings.plugins",
    title: "Connections",
    about: "MCP servers your agents can use.",
    route: { to: "/settings/plugins", search: { tab: "plugins" } },
    keywords: ["mcp", "servers"],
    widensAgents: true,
  },
  {
    id: "plugins.hooks",
    kind: "section",
    parent: "settings.plugins",
    title: "Hooks",
    about: "Commands providers run at points in a turn.",
    route: { to: "/settings/plugins", search: { tab: "plugins" } },
    widensAgents: true,
  },
  {
    id: "plugins.advanced",
    kind: "section",
    parent: "settings.plugins",
    title: "Advanced",
    about: "Marketplace sources and how much MCP context agents get.",
    route: { to: "/settings/plugins", search: { tab: "plugins" } },
  },
  {
    id: "plugins.skills",
    kind: "section",
    parent: "settings.plugins",
    title: "Skills",
    about: "Skills agents can use, on this computer or a project.",
    route: { to: "/settings/plugins", search: { tab: "skills" } },
    widensAgents: true,
  },
  // Agent Instructions
  {
    id: "instructions.project",
    kind: "section",
    parent: "settings.instructions",
    title: "Project",
    about: "Which project's instruction files to show.",
  },
  {
    id: "instructions.files",
    kind: "section",
    parent: "settings.instructions",
    title: "Instruction files",
    about: "The instruction files each provider reads in that project, to open or edit.",
    widensAgents: true,
  },
  // Source Control
  {
    id: "sourceControl.panel",
    kind: "section",
    parent: "settings.sourceControl",
    title: "Panel",
    about: "Whether the source control panel opens by default.",
  },
  {
    id: "sourceControl.versionControl",
    kind: "section",
    parent: "settings.sourceControl",
    title: "Version control",
    about: "Git on this computer, and how often it fetches.",
  },
  {
    id: "sourceControl.providers",
    kind: "section",
    parent: "settings.sourceControl",
    title: "Source control providers",
    about: "Sign-ins for the sites that host your code, like GitHub.",
    keywords: ["github", "gitlab", "sign in"],
  },
  {
    id: "sourceControl.textGeneration",
    kind: "section",
    parent: "settings.sourceControl",
    title: "Text generation",
    about: "How commit messages and pull requests are written, and by which model.",
  },
  // Connections
  {
    id: "connections.thisComputer",
    kind: "section",
    parent: "settings.connections",
    title: "This computer",
    about: "This computer's name, as other devices and computers see it.",
  },
  {
    id: "connections.devices",
    kind: "section",
    parent: "settings.connections",
    title: "Devices that can use this computer",
    about:
      "Phones, tablets, browsers and linked computers paired with this computer, one row each, and Connect for a new one.",
    keywords: ["phone", "pair", "tablet", "qr"],
    widensAgents: true,
  },
  {
    id: "connections.agents",
    kind: "section",
    parent: "settings.connections",
    title: "Agents",
    about:
      "Outside agents (Claude Code, Codex in a terminal) using this computer through the threadlines command. Each can see threads, start threads or work with all threads, as far as you allow.",
    route: { to: "/settings/connections", search: { section: "agents" } },
    keywords: ["outside agents", "cli", "threadlines command", "terminal", "connect"],
    widensAgents: true,
  },
  {
    id: "connections.agentsUsingThis",
    kind: "section",
    parent: "settings.connections",
    title: "Agents that can use this computer",
    about:
      "Each outside agent you let in, what it can do, and the most access a thread may have for it to act there. Work with all threads, which only you can grant, also lets it message, stop and answer questions in any thread in its projects, never approvals.",
    keywords: ["see threads", "start threads", "work with all threads", "access level"],
    route: { to: "/settings/connections", search: { section: "agents" } },
    value: { kind: "state", state: "outsideAgents" },
    widensAgents: true,
  },
  {
    id: "connections.assistants",
    kind: "section",
    parent: "settings.connections",
    title: "Assistants",
    about:
      "Always-on assistants (Grok Bot, dots, Muse, Claude Duet) using this computer from their own cloud, through the relay. Each can see threads, start threads or work with all threads, as far as you allow.",
    route: { to: "/settings/connections", search: { section: "assistants" } },
    keywords: ["grok bot", "dots", "muse", "claude duet", "connector", "always-on", "mcp"],
    widensAgents: true,
  },
  {
    id: "connections.assistantsUsingThis",
    kind: "section",
    parent: "settings.connections",
    title: "Assistants that can use this computer",
    about:
      "Each assistant you let in, how it signs in, what it can do, and the most access a thread may have for it to act there. Work with all threads, which only you can grant, also lets it message, stop and answer questions in any thread in its projects, never approvals.",
    keywords: ["see threads", "start threads", "work with all threads", "access level"],
    route: { to: "/settings/connections", search: { section: "assistants" } },
    value: { kind: "state", state: "outsideAgents" },
    widensAgents: true,
  },
  {
    id: "connections.assistantAlerts",
    kind: "section",
    parent: "settings.connections",
    title: "Alerts to a web address",
    about:
      "Web addresses (a Grok routine's webhook, say) this computer sends a signed alert to when a thread needs you, finishes or fails, each with the kinds and projects it gets. An alert carries only the kind, the project, the computer and a link, never a thread's title or what its agents wrote.",
    route: { to: "/settings/connections", search: { section: "assistants" } },
    keywords: ["webhook", "grok routine", "routine", "notify", "signed", "authorization"],
    // It sends word of threads off this computer, to any address it's given.
    widensAgents: true,
  },
  {
    id: "connections.computersFromHere",
    kind: "section",
    parent: "settings.connections",
    title: "Computers you use from here",
    about: "Other computers this app opens, so their threads show here too.",
    keywords: ["remote", "add computer"],
  },
  {
    id: "connections.options",
    kind: "section",
    parent: "settings.connections",
    title: "Connection options",
    about: "How other devices reach this computer: the same network, Tailscale, or a link.",
    keywords: ["tailscale", "lan", "network"],
    widensAgents: true,
  },
  // Fleet: a computer's page (/fleet/<computer>)
  {
    id: "fleet.connection",
    kind: "section",
    parent: "fleet",
    title: "Connection",
    about: "Whether this app reaches the computer right now, and how.",
  },
  {
    id: "fleet.worksWith",
    kind: "section",
    parent: "fleet",
    title: "Works with other computers",
    about:
      "For each linked computer, whether its agents may start work here and the most access their threads get (Allowed, Ask first or Off), in both directions. Link a computer with + at the top of the Computers list.",
    keywords: ["link", "pc", "mac", "windows", "start work", "permission", "unlink"],
    value: { kind: "state", state: "linkedComputers" },
    widensAgents: true,
  },
  {
    id: "fleet.devices",
    kind: "section",
    parent: "fleet",
    title: "Devices",
    about: "How many devices can use the computer; managed in Settings › Connections.",
  },
  {
    id: "fleet.thisApp",
    kind: "section",
    parent: "fleet",
    title: "This app",
    about: "This app's own connection to a computer it opens, and removing it.",
  },
] as const satisfies ReadonlyArray<AppPlaceSpec>;

// ----- rows ------------------------------------------------------------------------

const ROWS = [
  // General › Alerts
  {
    id: "general.alertsOnThisDevice",
    kind: "row",
    parent: "general.alerts",
    title: "Alerts on this device",
    about: "An alert when an agent needs you or finishes, even with Threadlines closed.",
    keywords: ["notifications", "push"],
    scope: "device",
  },
  {
    id: "general.alertNeedsYou",
    kind: "row",
    parent: "general.alerts",
    title: "Needs you",
    about: "An approval, a question or a plan to review.",
    keywords: ["approval", "question", "notifications"],
    scope: "device",
  },
  {
    id: "general.alertFinished",
    kind: "row",
    parent: "general.alerts",
    title: "Finished",
    about: "An agent finished its work.",
    keywords: ["done", "notifications"],
    scope: "device",
  },
  {
    id: "general.alertFailed",
    kind: "row",
    parent: "general.alerts",
    title: "Failed",
    about: "A turn stopped with an error, or couldn't start.",
    keywords: ["error", "notifications"],
    scope: "device",
  },
  // General › Appearance
  {
    id: "general.theme",
    kind: "row",
    parent: "general.appearance",
    title: "Theme",
    about: "How Threadlines looks.",
    keywords: ["dark mode", "light mode", "night mode", "colors"],
    scope: "device",
  },
  {
    id: "general.timeFormat",
    kind: "row",
    parent: "general.appearance",
    title: "Time format",
    about: "System default follows your computer's clock setting.",
    keywords: ["12-hour", "24-hour", "clock"],
    scope: "device",
  },
  // General › Chat & diffs (on a phone, Stream replies sits under This computer)
  {
    id: "general.streamReplies",
    kind: "row",
    parent: "general.chatAndDiffs",
    title: "Stream replies",
    about: "Show the agent's reply while it's being written.",
    keywords: ["streaming"],
    value: onOff((settings) => settings.enableAssistantStreaming),
  },
  {
    id: "general.changedFilesInChat",
    kind: "row",
    parent: "general.chatAndDiffs",
    title: "Changed files in chat",
    about: "Open the list of changed files under each reply.",
    keywords: ["files", "edits"],
    scope: "device",
  },
  {
    id: "general.agentsPanel",
    kind: "row",
    parent: "general.chatAndDiffs",
    title: "Agents panel",
    about: "Open it on the right when a thread starts subagents.",
    keywords: ["subagents"],
    scope: "device",
  },
  {
    id: "general.wrapDiffLines",
    kind: "row",
    parent: "general.chatAndDiffs",
    title: "Wrap diff lines",
    about: "Wrap long lines when the diff panel opens.",
    keywords: ["word wrap", "long lines"],
    scope: "device",
  },
  {
    id: "general.hideWhitespace",
    kind: "row",
    parent: "general.chatAndDiffs",
    title: "Hide whitespace changes",
    about: "Leave out edits that only change spacing.",
    keywords: ["diff", "whitespace"],
    scope: "device",
  },
  // General › Terminal
  {
    id: "general.terminalTextSize",
    kind: "row",
    parent: "general.terminal",
    title: "Text size",
    about: "The size of the terminal's text on this device.",
    keywords: ["font size", "zoom", "bigger text", "smaller text"],
    scope: "device",
  },
  {
    id: "general.terminalScreenReader",
    kind: "row",
    parent: "general.terminal",
    title: "Screen reader support",
    about: "Lets a screen reader read what the terminal prints. Busy output draws a little slower.",
    keywords: ["accessibility", "voiceover"],
    scope: "device",
  },
  // General › Dictation
  {
    id: "general.speechModel",
    kind: "row",
    parent: "general.dictation",
    title: "Speech model",
    about:
      "The model that turns your speech into text, on this computer, with nothing sent to the internet.",
    keywords: ["parakeet", "moonshine", "download"],
  },
  {
    id: "general.holdToRecord",
    kind: "row",
    parent: "general.dictation",
    title: "Hold to record",
    about:
      "Hold the mic button to record and let go to finish. Off: click to start, click again to stop.",
    keywords: ["push to talk"],
    scope: "device",
  },
  {
    id: "general.downloadedModels",
    kind: "row",
    parent: "general.dictation",
    title: "Downloaded models",
    about:
      "How much disk the downloaded speech models use and where they are, with Remove all to free it.",
    keywords: ["disk space"],
  },
  // General › This computer
  {
    id: "general.keepAwake",
    kind: "row",
    parent: "general.thisComputer",
    title: "Keep awake during turns",
    about: "Stops the computer sleeping while an agent works, on macOS and Windows.",
    keywords: ["sleep", "caffeinate"],
    value: onOff((settings) => settings.preventSleepDuringActiveTurns),
  },
  {
    id: "general.keepAwakeForScheduledTasks",
    kind: "row",
    parent: "general.thisComputer",
    title: "Keep this computer awake for scheduled tasks",
    about: "Stops this computer sleeping while it has an active scheduled task.",
    keywords: ["sleep"],
    scope: "desktop",
    appliesWhen: "desktop",
    widensAgents: true,
  },
  {
    id: "general.runInBackground",
    kind: "row",
    parent: "general.thisComputer",
    title: "Keep running in the background when the window closes",
    about:
      "On Windows and Linux, closing the window leaves Threadlines in the tray, so scheduled tasks and linked computers keep working.",
    keywords: ["tray", "close window", "quit"],
    scope: "desktop",
    appliesWhen: "desktop",
    widensAgents: true,
  },
  {
    id: "general.addProjectStartsIn",
    kind: "row",
    parent: "general.thisComputer",
    title: "Add project starts in",
    about: "Where the folder picker opens. Empty means your home folder (~/).",
    keywords: ["folder", "base directory"],
  },
  {
    id: "general.openLinksIn",
    kind: "row",
    parent: "general.thisComputer",
    title: "Open links in",
    about: "Where chat and terminal links open. Right-click a link for the other choice.",
    keywords: ["browser", "built-in browser", "external browser"],
    scope: "device",
    appliesWhen: "desktop",
  },
  {
    id: "general.browserPageSize",
    kind: "row",
    parent: "general.thisComputer",
    title: "Browser page size",
    about:
      "The size new tabs in the browser panel open at. Responsive fills the panel; a set size shrinks to fit it.",
    keywords: ["browser", "viewport", "device", "responsive", "laptop", "desktop", "phone"],
    scope: "device",
    appliesWhen: "desktop",
  },
  {
    id: "general.sitesAgentsCanVisit",
    kind: "row",
    parent: "general.thisComputer",
    title: "Sites agents can visit",
    about: "Which sites agents may open in the browser panel without asking first.",
    keywords: ["browser", "allowed sites", "domains"],
    scope: "device",
    appliesWhen: "desktop",
    widensAgents: true,
  },
  {
    id: "general.clearBrowserData",
    kind: "row",
    parent: "general.thisComputer",
    title: "Clear all browser data",
    about: "Signs you out of every site in the built-in browser, in every project.",
    keywords: ["cookies", "sign out"],
    appliesWhen: "desktop",
  },
  // General › Privacy & about (on a phone, Usage analytics sits under This computer)
  {
    id: "general.version",
    kind: "row",
    parent: "general.about",
    title: "Version",
    about:
      "The version of Threadlines you're running and what's new in it, with updates in the desktop app.",
    keywords: ["update", "what's new", "release notes"],
  },
  {
    id: "general.updateTrack",
    kind: "row",
    parent: "general.about",
    title: "Update track",
    about:
      "Stable gets full releases. Nightly gets a new build every day, and you can switch back any time.",
    keywords: ["nightly", "stable", "channel", "beta"],
    scope: "desktop",
    appliesWhen: "desktop",
  },
  {
    id: "general.usageAnalytics",
    kind: "row",
    parent: "general.about",
    title: "Usage analytics",
    about:
      "Anonymous usage counts that show us installs and reliability. Never prompts, code, file paths, repository names, terminal output, or secrets.",
    keywords: ["telemetry", "privacy", "tracking"],
    value: onOff((settings) => settings.usageAnalyticsEnabled),
  },
  {
    id: "general.diagnostics",
    kind: "row",
    parent: "general.about",
    title: "Diagnostics",
    about: "Where this computer's traces go, with a link to the Diagnostics page.",
    keywords: ["logs", "traces", "otel"],
  },
  {
    id: "general.phoneSettings",
    kind: "row",
    parent: "general.about",
    title: "Phone settings",
    about:
      "On a phone, which settings the phone's browser keeps and which apply to your paired computer.",
  },
  // Threads › New threads
  {
    id: "threads.agent",
    kind: "row",
    parent: "threads.newThreads",
    title: "Agent",
    about: "The agent and model new threads start with.",
    keywords: ["default model"],
    widensAgents: true,
  },
  {
    id: "threads.room",
    kind: "row",
    parent: "threads.newThreads",
    title: "Room",
    about: "Other agents new threads start with in the room, if any.",
    widensAgents: true,
  },
  {
    id: "threads.startIn",
    kind: "row",
    parent: "threads.newThreads",
    title: "Start in",
    about: "Work in the project folder, or give each new thread its own worktree.",
    keywords: ["worktree", "local checkout"],
  },
  {
    id: "threads.worktreesFrom",
    kind: "row",
    parent: "threads.newThreads",
    title: "New worktrees from",
    about: "The branch new worktrees start from.",
    keywords: ["base branch"],
  },
  {
    id: "threads.agentThreads",
    kind: "row",
    parent: "threads.newThreads",
    title: "Agents can start threads",
    about:
      "Whether a thread's agent may start threads of its own and change scheduled tasks: Off, Ask me first, or Automatic.",
    keywords: ["child threads", "subthreads", "thread_start", "scheduled tasks", "spawn"],
    value: {
      kind: "choice",
      read: (settings) => agentThreadsMode(settings),
      options: AGENT_THREADS_LABELS,
    },
    widensAgents: true,
  },
  {
    id: "threads.agentPages",
    kind: "row",
    parent: "threads.newThreads",
    title: "Agent pages",
    about:
      "Agents can show a chart, diagram, mockup or document as a page in their reply. Pages already shown stay when this is off.",
    keywords: ["charts", "diagrams", "mockups"],
    value: onOff((settings) => settings.enableAgentPages !== false),
    widensAgents: true,
  },
  {
    id: "threads.claudeArtifacts",
    kind: "row",
    parent: "threads.newThreads",
    title: "Claude artifacts",
    about: "Claude can publish a page to claude.ai for a link you can share. Needs agent pages.",
    keywords: ["share", "publish"],
    value: onOff((settings) => settings.enableClaudeArtifacts === true),
    widensAgents: true,
  },
  {
    id: "threads.claudeWorkflowSize",
    kind: "row",
    parent: "threads.newThreads",
    title: "Claude workflow size",
    about: "How many agents Claude aims for in a workflow.",
  },
  {
    id: "threads.claudeSuggestions",
    kind: "row",
    parent: "threads.newThreads",
    title: "Keep Claude's suggestions when you're using a lot",
    about:
      "Keep Claude suggesting your next message even when you're on track to run out of usage early.",
    keywords: ["autocomplete", "prompt suggestions"],
    value: onOff((settings) => settings.claudeSuggestionsWhenUsageRunsFast),
  },
  {
    id: "threads.continueAfterUsageLimits",
    kind: "row",
    parent: "threads.newThreads",
    title: "Continue after usage limits",
    about:
      "When a Claude or Codex usage limit stops a thread, it continues on its own once the limit resets. Each limit's notice above the composer also has a Continue at reset switch.",
    keywords: ["usage limit", "rate limit", "resume", "reset"],
    value: onOff((settings) => settings.continueAfterUsageLimits),
  },
  {
    id: "threads.commandRequests",
    kind: "row",
    parent: "threads.newThreads",
    title: "Command requests",
    about:
      "Agents can ask you to run a command they can't run themselves, as a card you run from the chat. Cards already shown stay when this is off.",
    keywords: ["ask_user_to_run", "run command"],
    value: onOff((settings) => settings.enableCommandRequests !== false),
    widensAgents: true,
  },
  {
    id: "threads.startWhileTyping",
    kind: "row",
    parent: "threads.newThreads",
    title: "Start agents while you type",
    about:
      "A stopped Claude or Codex agent starts in the background as you type, so your message gets a faster first reply.",
    keywords: ["faster", "warm up"],
    value: onOff((settings) => settings.startAgentsWhileTyping !== false),
    widensAgents: true,
  },
  // Threads › Rooms
  {
    id: "threads.enableRooms",
    kind: "row",
    parent: "threads.rooms",
    title: "Rooms",
    about: "Let a thread hold more than one agent.",
    keywords: ["multiple agents", "reviewer"],
    value: onOff((settings) => settings.enableRooms !== false),
    widensAgents: true,
  },
  {
    id: "threads.agentInvites",
    kind: "row",
    parent: "threads.rooms",
    title: "Agents bringing in other agents",
    about:
      "Whether the thread's agent may bring in another model to review its work: Off, Ask me first, or Without asking.",
    keywords: ["invite", "review", "room_invite", "second opinion"],
    value: {
      kind: "choice",
      read: (settings) => agentInvitesChoice(settings),
      options: AGENT_INVITES_LABELS,
    },
    widensAgents: true,
  },
  // Threads › Titles & writing
  {
    id: "threads.writingModel",
    kind: "row",
    parent: "threads.titlesAndWriting",
    title: "Writing model",
    about: "Writes thread titles. Also commit and PR text, unless Source Control picks its own.",
    keywords: ["title model", "text generation"],
  },
  {
    id: "threads.backupWritingModel",
    kind: "row",
    parent: "threads.titlesAndWriting",
    title: "Backup writing model",
    about: "Takes over when the writing model's provider fails.",
    keywords: ["fallback"],
  },
  // Threads › When a thread is done
  {
    id: "threads.wrapUpIdle",
    kind: "row",
    parent: "threads.whenDone",
    title: "Wrap up idle threads",
    about:
      "Move a thread to Wrapped after two quiet days, unless it's pinned or has news you haven't seen.",
    keywords: ["wrapped"],
    scope: "device",
  },
  {
    id: "threads.wrapUpMerged",
    kind: "row",
    parent: "threads.whenDone",
    title: "Wrap up merged threads",
    about: "Move a thread to Wrapped when its pull request merges or closes, unless it's pinned.",
    keywords: ["wrapped", "pull request"],
    scope: "device",
  },
  {
    id: "threads.wrapUpChildren",
    kind: "row",
    parent: "threads.whenDone",
    title: "Wrap up finished child threads",
    about:
      "File a thread an agent started under Wrapped once its answer went back to that agent, or once the thread that started it is wrapped.",
    keywords: ["wrapped", "child threads"],
    scope: "device",
  },
  {
    id: "threads.confirmArchive",
    kind: "row",
    parent: "threads.whenDone",
    title: "Confirm archive",
    about: "Ask for a second click before archiving a thread.",
    scope: "device",
  },
  {
    id: "threads.confirmDelete",
    kind: "row",
    parent: "threads.whenDone",
    title: "Confirm delete",
    about: "Ask before deleting a thread and its history.",
    scope: "device",
  },
  // Archives › Thread cleanup
  {
    id: "archived.autoArchive",
    kind: "row",
    parent: "archived.cleanup",
    title: "Auto-archive inactive threads",
    about: "Moves old inactive threads out of active lists without deleting their history.",
    keywords: ["cleanup", "old threads"],
  },
  {
    id: "archived.archiveNow",
    kind: "row",
    parent: "archived.cleanup",
    title: "Archive inactive threads now",
    about: "Review the same safe candidates and move them to Archive immediately.",
  },
  {
    id: "archived.deleteOld",
    kind: "row",
    parent: "archived.cleanup",
    title: "Delete old archived threads",
    about: "Permanently removes archived threads by how long they have been in Archive.",
    keywords: ["cleanup", "disk space", "storage"],
  },
  // Plugins & Skills › Advanced
  {
    id: "plugins.marketplaceSources",
    kind: "row",
    parent: "plugins.advanced",
    title: "Marketplace sources",
    about: "The marketplaces each provider installs plugins from, to add or remove.",
    widensAgents: true,
  },
  {
    id: "plugins.mcpContext",
    kind: "row",
    parent: "plugins.advanced",
    title: "MCP context",
    about: "The Codex thread this page uses to run MCP tools and list what a thread can use.",
  },
  // Source Control
  {
    id: "sourceControl.openPanelByDefault",
    kind: "row",
    parent: "sourceControl.panel",
    title: "Open panel by default",
    about:
      "Show the source control panel when you enter a thread. Narrow windows always start with it closed, since the panel covers the conversation there.",
    keywords: ["git", "changes"],
    scope: "device",
  },
  // Source Control › Version control
  {
    id: "sourceControl.fetchInterval",
    kind: "row",
    parent: "sourceControl.versionControl",
    title: "Fetch interval",
    about:
      "How often Git checks remote branches in the background. 0 seconds leaves it to the Git actions you run.",
    keywords: ["git fetch", "background", "remote branches"],
  },
  // Source Control › Text generation
  {
    id: "sourceControl.writingStyle",
    kind: "row",
    parent: "sourceControl.textGeneration",
    title: "Source control writing style",
    about:
      "How commit messages and pull requests are written: in the repository's style, as Conventional Commits, or by your own instructions.",
    keywords: ["commit message", "conventional commits"],
  },
  {
    id: "sourceControl.followPrTemplates",
    kind: "row",
    parent: "sourceControl.textGeneration",
    title: "Follow PR templates",
    about:
      "Structures PR descriptions using the repository's pull request template when one is available.",
    keywords: ["pull request template"],
  },
  {
    id: "sourceControl.writerModel",
    kind: "row",
    parent: "sourceControl.textGeneration",
    title: "Source control writer model",
    about:
      "Optional model override for commit messages, PR titles and descriptions, and branch names. Off uses the writing model from Settings › Threads.",
    keywords: ["commit message", "model"],
  },
  // Connections › Devices that can use this computer
  {
    id: "connections.connectDevice",
    kind: "row",
    parent: "connections.devices",
    title: "Connect a phone, tablet, or computer",
    about:
      "Get a code to type on the other device, or a QR code for a phone. Works from anywhere while this computer is on.",
    keywords: ["connect a device", "pair", "qr code", "relay"],
    widensAgents: true,
  },
  // Connections › Agents
  {
    id: "connections.agentAddress",
    kind: "row",
    parent: "connections.agents",
    title: "Address for agents",
    about: "The address outside agents use to reach this computer.",
    widensAgents: true,
  },
  {
    id: "connections.assistantAddress",
    kind: "row",
    parent: "connections.assistants",
    title: "Address for assistants",
    about: "The address to paste into an assistant as a custom connector.",
    widensAgents: true,
  },
  {
    id: "connections.addAssistant",
    kind: "row",
    parent: "connections.assistants",
    title: "Add an assistant",
    about:
      "Shows a code to type into an assistant's sign-in page, or makes a key for one that takes a key instead (Muse).",
    keywords: ["code", "key", "sign in", "connector"],
    widensAgents: true,
  },
  {
    id: "connections.connectAgent",
    kind: "row",
    parent: "connections.agents",
    title: "Connect an agent",
    about: "What to run so an agent like Claude Code or Codex connects to this computer.",
    keywords: ["claude code", "mcp", "setup"],
    widensAgents: true,
  },
  {
    id: "connections.threadlinesCommand",
    kind: "row",
    parent: "connections.agents",
    title: "Threadlines command",
    about:
      "Puts the threadlines command on your PATH, so an agent in a terminal can sign in with threadlines connect.",
    keywords: ["cli", "PATH", "install", "threadlines connect"],
    scope: "desktop",
    appliesWhen: "desktop",
    widensAgents: true,
  },
  // Connections › Connection options
  {
    id: "connections.sameNetwork",
    kind: "row",
    parent: "connections.options",
    title: "Same network",
    about:
      "Devices on your home or office network connect straight to this computer, which can be faster and doesn't use the relay. Turning it on or off restarts Threadlines.",
    keywords: ["lan", "wifi", "local network"],
    scope: "desktop",
    widensAgents: true,
  },
  {
    id: "connections.tailscale",
    kind: "row",
    parent: "connections.options",
    title: "Tailscale",
    about: "Lets devices on your Tailscale network reach this computer.",
    keywords: ["vpn", "remote"],
    appliesWhen: "desktop",
    widensAgents: true,
  },
  {
    id: "connections.oneTimeLink",
    kind: "row",
    parent: "connections.options",
    title: "One-time link for this network",
    about:
      "For devices that can reach this computer directly. The link works once and expires in 5 minutes.",
    keywords: ["link", "pairing link"],
    widensAgents: true,
  },
  // Fleet › This app
  {
    id: "fleet.removeFromApp",
    kind: "row",
    parent: "fleet.thisApp",
    title: "Remove from this app",
    about:
      "This app forgets its connection to the computer. Its threads stay there, and you can connect again with a new code.",
    keywords: ["forget", "disconnect"],
  },
] as const satisfies ReadonlyArray<AppPlaceSpec>;

// ----- the catalog -------------------------------------------------------------------

export const APP_PLACES = [...PAGES, ...SECTIONS, ...ROWS] as const;

export type AppPlace = (typeof APP_PLACES)[number];
export type PlaceId = AppPlace["id"];
/** A settings row's or section's id, for the `place` prop of SettingsRow and SettingsSection. */
export type SettingsPlaceId = Extract<AppPlace, { readonly kind: "row" | "section" }>["id"];

const PLACE_BY_ID: ReadonlyMap<string, AppPlaceSpec> = new Map(
  (APP_PLACES as ReadonlyArray<AppPlaceSpec>).map((place) => [place.id, place]),
);

export const isPlaceId = (value: string): value is PlaceId => PLACE_BY_ID.has(value);

/** A place by id; every PlaceId has one. */
export function placeById(id: PlaceId): AppPlaceSpec {
  return PLACE_BY_ID.get(id)!;
}

/** The place and the ones holding it, outermost first (page, section, row). */
export function placeChain(id: PlaceId): ReadonlyArray<AppPlaceSpec> {
  const chain: AppPlaceSpec[] = [];
  let current: AppPlaceSpec | undefined = PLACE_BY_ID.get(id);
  while (current !== undefined) {
    chain.unshift(current);
    current = current.parent === undefined ? undefined : PLACE_BY_ID.get(current.parent);
  }
  return chain;
}

/** The page a place is on. */
export function placePage(id: PlaceId): AppPlaceSpec {
  return placeChain(id)[0]!;
}

/** Whether a page sits in Settings (as opposed to the left bar). */
const isSettingsPage = (page: AppPlaceSpec) => page.route?.to.startsWith("/settings/") === true;

/**
 * Where a place is, as the user reads it on screen:
 * "Settings › Threads › New threads › Agents can start threads", "Fleet › Works with other computers".
 */
export function placePathLabel(id: PlaceId): string {
  const chain = placeChain(id);
  const titles = chain.map((place) => place.title);
  return (isSettingsPage(chain[0]!) ? ["Settings", ...titles] : titles).join(" › ");
}

/** The route that shows a place: its page's, with any reveal params of the place or its section. */
export function placeRoute(id: PlaceId): AppPlaceRoute {
  const chain = placeChain(id);
  const page = chain[0]!;
  const search = Object.assign({}, ...chain.map((place) => place.route?.search ?? {})) as Record<
    string,
    string
  >;
  return {
    to: page.route?.to ?? "/",
    ...(Object.keys(search).length > 0 ? { search } : {}),
  };
}

/** The link scheme for places in chat markdown (the desktop app owns `threadlines://`). */
export const PLACE_HREF_SCHEME = "threadlines-place:";

export const placeHref = (id: PlaceId): string => `${PLACE_HREF_SCHEME}${id}`;

/** The place a `threadlines-place:` href names, or null (another scheme, or an id this build doesn't know). */
export function placeIdFromHref(href: string): PlaceId | null {
  if (!href.startsWith(PLACE_HREF_SCHEME)) return null;
  const id = href.slice(PLACE_HREF_SCHEME.length).trim();
  return isPlaceId(id) ? id : null;
}

/** The markdown link an agent puts in its reply: the place's path, opening the place. */
export const placeMarkdownLink = (id: PlaceId): string =>
  `[${placePathLabel(id)}](${placeHref(id)})`;
