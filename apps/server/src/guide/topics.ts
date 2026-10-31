/**
 * The app guide's topics (docs/design/app-guide.md, "Topics"): short pages on
 * how Threadlines works, for agents answering a user's questions about it.
 * Places are named as `{place:<id>}` and become their path and link when the
 * guide answers; a test fails on an id the catalog doesn't know.
 *
 * Keep each under ~250 words, in the words the screen uses. A change users can
 * see updates its topic (AGENTS.md, "Hit every surface").
 */
export interface GuideTopic {
  readonly id: string;
  readonly title: string;
  /** Words users say for it, for the guide's search. */
  readonly keywords: ReadonlyArray<string>;
  readonly body: string;
}

export const GUIDE_TOPICS: ReadonlyArray<GuideTopic> = [
  {
    id: "threads-and-worktrees",
    title: "Threads and worktrees",
    keywords: ["thread", "worktree", "branch", "checkout", "setup script", "wrap", "archive"],
    body: `A thread is one conversation with an agent in a project. Threads are listed in the sidebar; one that needs you, finished or failed says so there.

A new thread starts either in the project folder as it is, or in a worktree of its own: a separate git checkout on a new branch, so its changes stay apart until you merge them. You pick per thread in the composer; the default is {place:threads.startIn}, and new worktrees branch from {place:threads.worktreesFrom}. A project's setup script runs once in each new worktree.

The agent and model a new thread starts with is {place:threads.agent}. You can switch model or agent in the composer at any time.

When a thread is done it wraps up and moves to the Wrapped shelf at the bottom of the sidebar; {place:threads.whenDone} says when that happens on its own. Old threads can be archived for you: {place:archived.cleanup}.`,
  },
  {
    id: "access-levels",
    title: "Access levels",
    keywords: ["access", "permissions", "approval", "sandbox", "full access", "auto", "supervised"],
    body: `Each thread runs at an access level, picked in the composer:

- Supervised: asks before commands and file changes.
- Auto-accept edits: edits run without asking; other actions ask.
- Auto: no routine prompts; a safety check reviews risky actions.
- Full access: no prompts or sandbox. For trusted repos only.

Some agents lack a level; they run at the next safer one they have, and the composer shows what actually applies. Threads started for you by other means never get more than they were allowed: a thread an agent starts gets at most its parent's level, one another computer starts gets at most what that link allows ({place:fleet.worksWith}), an outside agent's threads at most what you approved for it ({place:connections.agentsUsingThis}), and an assistant's the same ({place:connections.assistantsUsingThis}).`,
  },
  {
    id: "rooms",
    title: "Rooms: more than one agent in a thread",
    keywords: ["room", "multiple agents", "reviewer", "second opinion", "hand off", "teammate"],
    body: `A room is a thread with more than one agent: for example one agent doing the work and another reviewing it. Rooms are turned on with {place:threads.enableRooms}; {place:threads.room} sets which agents new threads start with.

Only one agent works at a time, in the same checkout. Agents in a room can ask each other a question on the side, ask for an independent review of the changes, or hand the next turn to another agent.

Whether the thread's agent may bring in another model on its own is {place:threads.agentInvites}: Off, Ask me first (a card asks you each time), or Without asking. Bringing in another provider's model spends that provider's quota.`,
  },
  {
    id: "agent-threads",
    title: "Threads agents start",
    keywords: ["child thread", "subthread", "thread_start", "spawn", "parallel", "delegate"],
    body: `An agent can start threads of its own to work in parallel, and message, read or stop them. Each started thread shows under its parent in the sidebar; its final reply comes back to the parent as a message, which wakes the parent's agent.

{place:threads.agentThreads} decides this: Off, Ask me first (a card in the chat lists the threads and you decide), or Automatic. The same setting covers agents creating or changing scheduled tasks. An agent may start at most 5 threads and send 10 messages to them per message you send.

A started thread gets at most its parent's access level, and the parent's model unless the agent picks another. With computers linked in Fleet, an agent can also start a thread on another computer, if that computer allows it ({place:fleet.worksWith}).

A thread on another computer stays under its parent on both computers and shows how it is doing there, even after its answer came back. Once its answer reached the parent it wraps up and moves to Wrapped like any other, unless someone picked it up again there. Its row has Wrap up (and Reopen in Wrapped), which applies on both computers. To open it, connect this app to that computer.`,
  },
  {
    id: "linking-computers",
    title: "Linking computers (Fleet)",
    keywords: ["fleet", "link", "computer", "pc", "mac", "windows", "remote", "another machine"],
    body: `Fleet, in the left bar, lists the computers this app knows. Use + at the top of its Computers list to link another computer running Threadlines. Each computer's page shows its connection, {place:fleet.worksWith}, and its devices.

Linking is two-way, with a permission for each direction: "<A>'s agents can start work on <B>" is Allowed, Ask first or Off, with the most access those threads get ("Up to Auto"). Each direction is stored on the computer the work would run on, so the Mac's setting decides what the PC's agents may do on the Mac, and the other way round. Unlink from the same group.

With a link allowed, an agent can start a thread on the other computer in that computer's copy of the project, read it and message it, and its reply comes back. A computer you only open from this app (Settings › Connections › Computers you use from here) is not a link: you see its threads here, but agents can't work across.`,
  },
  {
    id: "devices",
    title: "Phones and other devices",
    keywords: ["phone", "tablet", "pair", "qr", "remote access", "tailscale", "network"],
    body: `{place:settings.connections} is where other devices use this computer. {place:connections.devices} lists every phone, tablet, browser and linked computer paired with it; Connect a phone, tablet, or computer there to pair a new one.

{place:connections.computersFromHere} are other computers this app opens, so their threads show here too. {place:connections.options} sets how devices reach this computer: the same network, Tailscale, or a one-time link. A phone away from home connects through Threadlines' relay, end to end encrypted.

{place:connections.thisComputer} is this computer's name as the others see it.`,
  },
  {
    id: "scheduled-tasks",
    title: "Scheduled and event tasks",
    keywords: ["schedule", "cron", "recurring", "every day", "webhook", "event", "github event"],
    body: `{place:scheduled} lists tasks that start an agent at set times (once, hourly, daily, weekdays, weekly or a cron rule) or when an event arrives at the task's address (a webhook, or GitHub events like a new issue or failed checks). Each run starts a new thread with the task's instructions, or sends them to one thread as a follow-up.

Tasks run while Threadlines is running on that computer. A time missed while it was off or asleep gets one catch-up run when it's back, if the missed time was within the last 7 days. The desktop app can keep the computer awake for them.

Agents can list, create and change scheduled tasks when {place:threads.agentThreads} isn't Off; with Ask me first, a card asks you before a change takes effect.`,
  },
  {
    id: "outside-agents",
    title: "Outside agents and the threadlines command",
    keywords: [
      "cli",
      "terminal",
      "claude code",
      "codex cli",
      "threadlines connect",
      "PATH",
      "command",
    ],
    body: `An agent running in a terminal (Claude Code, Codex and others) can use Threadlines through the threadlines command: list projects, start threads, read them, message and stop them.

{place:connections.threadlinesCommand} (desktop app) puts the command on your PATH. Then, in a new terminal, \`threadlines connect\` signs the agent in: the browser shows a short code, and you approve the agent in the Threadlines window when the same code shows there, choosing the most access its threads get. After that: \`threadlines projects\`, \`threadlines thread start <project> "<prompt>" --wait\`, and \`threadlines thread list\`, \`read\`, \`send\`, \`wait\`, \`stop\`.

{place:connections.agentsUsingThis} lists each agent you let in, to change its access or remove it. {place:connections.agents} also shows the address agents use.`,
  },
  {
    id: "assistants",
    title: "Assistants: Grok Bot, dots, Muse and Claude Duet",
    keywords: [
      "assistant",
      "always-on",
      "grok bot",
      "dots",
      "muse",
      "claude duet",
      "custom connector",
      "connector",
      "key",
      "inbox",
    ],
    body: `Always-on assistants run in their makers' cloud. They can use Threadlines from there through the relay: see projects and threads, start threads, and message or stop the ones they started. When they check in, they can see what needs you (approvals, questions and plans waiting in Threadlines), what finished or failed since they last looked, and what a thread changed, with its pull request's checks and review. This computer keeps that record of finished and failed for 7 days, only while an assistant is connected.

To connect one, paste {place:connections.assistantAddress} into the assistant as a custom connector. Its sign-in page asks for a code: choose {place:connections.addAssistant}'s Connect an assistant and type the code it shows into that page, then allow the assistant in the window that opens, choosing what it can do and the most access its threads get. Only type the code into a page your own assistant just opened. An assistant that takes a key instead of signing in (Muse) gets one from Create a key, shown once.

{place:connections.assistantsUsingThis} lists each assistant you let in, to change its access or remove it. Assistants can't answer approvals, questions or plans; those wait for you in Threadlines.

While this computer is asleep or Threadlines is closed, assistants are told it's offline. The relay passes their requests to this computer and can read them, unlike a phone's, which are end-to-end encrypted.`,
  },
  {
    id: "providers",
    title: "Providers, sign-in and models",
    keywords: [
      "provider",
      "sign in",
      "login",
      "account",
      "model",
      "api key",
      "claude",
      "codex",
      "cursor",
      "usage limit",
      "rate limit",
      "continue at reset",
    ],
    body: `{place:settings.providers} lists the agents this computer can run (Claude, Codex, Cursor, OpenCode, Pi and others), in use and not in use. Each card has its account and sign-in, its models, how it appears (name and color), and how it launches (command and environment variables).

{place:providers.community} adds agents from the open ACP registry; Threadlines hasn't tested those.

How much of each plan you've used is on {place:usage}.

When a Claude or Codex usage limit stops a thread, the notice above the composer says which limit and when it resets. Its Continue at reset switch sends "Continue where you left off." a minute after the reset, from the computer the thread runs on, and {place:threads.continueAfterUsageLimits} turns it on for every limit. If you added another account of the same agent that still has room, the notice offers it by name. Threadlines never switches accounts on its own.`,
  },
  {
    id: "plugins-skills-instructions",
    title: "Plugins, skills and agent instructions",
    keywords: [
      "plugin",
      "skill",
      "mcp",
      "hooks",
      "AGENTS.md",
      "CLAUDE.md",
      "instructions",
      "rules",
    ],
    body: `{place:settings.plugins} manages what agents can use beyond their own tools, per provider, on this computer or one project: {place:plugins.installed}, {place:plugins.apps}, {place:plugins.connections} (MCP servers) and {place:plugins.hooks}. Its Skills tab is {place:plugins.skills}.

{place:settings.instructions} shows the instruction files each provider reads in a project (like AGENTS.md or CLAUDE.md), to open or edit.`,
  },
  {
    id: "browser-panel",
    title: "The browser panel",
    keywords: ["browser", "preview", "localhost", "web page", "screenshot", "sites"],
    body: `In the desktop app a browser panel sits beside the chat. Agents use it to open your dev server, check a layout, reproduce a bug or fill in a form, and you watch every step; you can also mark up the page and send the marks to the agent.

{place:general.sitesAgentsCanVisit} decides which sites agents may open without asking you first. Local addresses always work.`,
  },
  {
    id: "file-viewer",
    title: "The file viewer",
    keywords: [
      "file",
      "files",
      "viewer",
      "editor",
      "edit a file",
      "open a file",
      "pdf",
      "svg",
      "outside the project",
      "restore original",
      "reveal in finder",
    ],
    body: `The file viewer opens over the chat: from the folder button in the chat header (Browse project files), or by clicking a file name in the chat. Its file list holds the project's files and a Go to file search; files from outside the project are listed apart, under Outside this project.

Click a line number to select lines (drag for a range) and add them to the chat, or attach the whole file. The open button in its header opens the file in one of your editors, or reveals it in Finder or Explorer.

Edit (or double-click, or start typing) edits the file in place, and it saves as you type. If the file changed on disk meanwhile, for example an agent edited it, the footer offers Reload file or Keep my version. Editing is off for files over 1 MB, read-only files, text that isn't UTF-8, and on touch screens.

A file outside the project opens and edits the same way, but git doesn't track it, so Threadlines keeps the original before the first save, for 30 days. Restore original in the footer puts it back.

Pictures and PDFs show in the viewer, PDFs with zoom and find. An SVG shows as a picture, with Show source for its code. Any other file offers Reveal in Finder (Explorer on Windows) and Copy path. A folder outside the project opens in Finder or Explorer.`,
  },
  {
    id: "pages-and-command-requests",
    title: "Agent pages and command requests",
    keywords: ["page", "chart", "diagram", "mockup", "run command", "card", "artifact"],
    body: `With {place:threads.agentPages} on, an agent can show a chart, diagram, mockup or document as a page in its reply. {place:threads.claudeArtifacts} lets Claude also publish one to claude.ai for a link you can share.

With {place:threads.commandRequests} on, an agent can ask you to run a command it can't run itself (one that needs your password or sign-in, or a long-running server): a card in the chat with Run, Put in terminal and Skip, and the output comes back to the agent.`,
  },
  {
    id: "updates",
    title: "Updates and release tracks",
    keywords: ["update", "version", "nightly", "stable", "release", "what's new"],
    body: `The desktop app updates itself. When an update is ready, a notice says so with a button to restart into it. The app's version and which releases it follows (stable, or nightly builds with the newest changes) are in {place:general.about}; its Version row opens What's new.`,
  },
];
