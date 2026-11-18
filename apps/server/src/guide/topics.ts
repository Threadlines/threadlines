/**
 * The app guide's topics (docs/design/app-guide.md, "Topics"): short pages on
 * how Threadlines works, for agents answering a user's questions about it.
 * Places are named as `{place:<id>}` and become their path and link when the
 * guide answers; a test fails on an id the catalog doesn't know.
 *
 * Keep each under ~250 words, in the words the screen uses. A change users can
 * see updates its topic (AGENTS.md, "Hit every surface"). `themes` runs
 * longer: it carries the theme file format and art rules, shared with the
 * theme tools (themes/themeGuide.ts).
 */
import { THEME_FILE_EXTENSION } from "@threadlines/contracts";

import {
  THEME_ART_CONTRACT_GUIDE,
  THEME_ART_RULES_GUIDE,
  THEME_DESIGN_GUIDE,
  THEME_FORMAT_GUIDE,
} from "../themes/themeGuide.ts";

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
    keywords: [
      "thread",
      "worktree",
      "existing worktree",
      "pick up",
      "import",
      "branch",
      "checkout",
      "setup script",
      "wrap",
      "archive",
      "restart",
    ],
    body: `A thread is one conversation with an agent in a project. Threads are listed in the sidebar; one that needs you, finished or failed says so there. In a narrow window the sidebar floats over the thread instead of sitting beside it: the sidebar button at the top left, or Cmd+B (Ctrl+B on Windows and Linux), opens it, and picking a thread or clicking the thread puts it away. A thread you scrolled up in opens where you left it when you come back, until Threadlines reloads; one that finished, failed or needs you since then opens at the end.

The sliders button beside the project picker at the top of the sidebar groups the list by project or computer and sorts it: recent activity, newest, oldest, title, or a custom order. In the custom order you drag rows to arrange them, or use Move up and Move down in a thread's menu, and only you move a row; new threads go to the bottom, and the same button can reset the order. Pinned threads stay above a thin line in every sort, under a project's lead chat, which comes first. When the list is grouped, drag a group's header to move the whole group, in any sort; its menu has Move up, Move down and Use automatic order. These orders are kept per device, so a phone has its own.

A new thread starts either in the project folder as it is, or in a worktree of its own: a separate git checkout on a new branch, so its changes stay apart until you merge them. You pick per thread in the composer; the default is {place:threads.startIn}, and new worktrees branch from {place:threads.worktreesFrom}. A project's setup script runs once in each new worktree.

A repository can already have worktrees that Threadlines did not make (git worktree add, or another app). Right after such a repository is added as a project, the new-thread screen lists them under the message box with a checkbox each, and "Add N threads" makes a thread for every ticked one, named from its branch; nothing runs until you send a message there. After that the screen shows only a count beside the recent threads ("4 worktrees"); opening it lists them with Work here, which points the thread you are about to start at that worktree, Add as threads…, and Hide for this project. The Workspace picker under the message box lists the same worktrees under Existing worktree, and the command palette has Add existing worktrees as threads…, which also brings a hidden count back. A thread in one of these is a guest: no setup script runs, the branch is not renamed, deleting the thread never offers to delete the folder, and undoing a turn only undoes that thread's own edits. Worktrees a thread already works in are left out. The computer's server needs to be on a version that has this; with an older one none of it shows.

The agent and model a new thread starts with is {place:threads.agent}. You can switch model or agent at any time from the model button in the composer, which also holds the agent's effort. Beside it sit Build or Plan (one click switches, as does Shift+Tab in the message box) and the access level; on a narrow window they show just their icons, and on phones both live in the model button's panel instead.

While an agent works, the arrow beside the send button picks how a message goes: Steer now adds it to the reply in progress, Send when done holds it for the next one, and the choice sticks. Enter sends that way; Cmd+Enter (Ctrl+Enter on Windows and Linux) sends that one message the other way.

After a reply to your message, Claude or Codex can suggest what you might send next: gray text in the empty message box, taken with Tab (Use on a phone), hidden with Escape. Claude makes its own and skips them when you're on track to run out of usage early, unless {place:threads.claudeSuggestions} is on. Codex's are made by Threadlines with one extra Codex answer each, only after messages you sent, never while a usage limit is 90% used, and {place:threads.codexSuggestions} turns them off.

When Claude or Codex asks multiple-choice questions, a card takes the place of the message box. Besides answering, you can Skip a question, close the card with its X (the agent goes on without answers), or choose Reply in chat: the message box comes back, and the next message you send, text only, is your answer. The agent is told exactly which you did. Questions from other agents, such as a yes/no confirmation, still need an answer or Stop.

When a thread is done it wraps up and moves to the Wrapped shelf at the bottom of the sidebar; {place:threads.whenDone} says when that happens on its own. An agent coming back later (a check-back) doesn't keep a thread out of Wrapped: the thread returns to the list when the agent does. Old threads can be archived for you: {place:archived.cleanup}.

When Threadlines quits, updates or crashes while an agent works on something the user asked for, the agent picks it back up when Threadlines starts again: the chat gets a message marked "Sent after a restart" telling the agent to check before repeating anything. A turn waiting on an approval or a question, or one another thread, a scheduled task or an outside agent started, stops with a note instead, as does a turn restarts cut off three times in five minutes. {place:threads.continueAfterRestart} turns this off.`,
  },
  {
    id: "access-levels",
    title: "Access levels",
    keywords: ["access", "permissions", "approval", "sandbox", "full access", "auto", "supervised"],
    body: `Each thread runs at an access level, picked from the access button beside the model button in the composer (on phones, in the model button's panel):

- Supervised: asks before commands and file changes.
- Auto-accept edits: edits run without asking; other actions ask.
- Auto: no routine prompts; a safety check reviews risky actions.
- Full access: no prompts or sandbox. For trusted repos only.

Some agents lack a level; they run at the next safer one they have, and the composer shows what actually applies. Threads started for you by other means never get more than they were allowed: a thread an agent starts gets at most its parent's level, one another computer starts gets at most what that link allows ({place:fleet.worksWith}), and an outside agent starts, messages or answers only in threads at or under the most access you approved for it ({place:connections.agentsUsingThis}), an assistant the same ({place:connections.assistantsUsingThis}).`,
  },
  {
    id: "rooms",
    title: "Rooms: more than one agent in a thread",
    keywords: ["room", "multiple agents", "reviewer", "second opinion", "hand off", "teammate"],
    body: `A room is a thread with more than one agent: for example one agent doing the work and another reviewing it. Rooms are turned on with {place:threads.enableRooms}; {place:threads.room} sets which agents new threads start with.

You add and remove agents at the top of the model button's panel in the composer: one pill per agent, the picked one being who your next message goes to (typing @ and picking an agent does the same). The model and effort under the pills are that agent's.

Only one agent works at a time, in the same checkout. Agents in a room can ask each other a question on the side, ask for an independent review of the changes, or hand the next turn to another agent. Up to three agents can answer on the side at once, one answer each, so you can ask a second agent while the first is still answering, and an agent can ask two or three for a review of the same changes in one go.

Whether the thread's agent may bring in another model on its own is {place:threads.agentInvites}: Off, Ask me first (a card asks you each time), or Without asking. Bringing in another provider's model spends that provider's quota.`,
  },
  {
    id: "agent-threads",
    title: "Threads agents start",
    keywords: ["child thread", "subthread", "thread_start", "spawn", "parallel", "delegate"],
    body: `An agent can start threads of its own to work in parallel, and message, read or stop them. Each started thread shows under its parent in the sidebar; its final reply comes back to the parent as a message, which wakes the parent's agent. The parent and the threads it started also show as a row of tabs under the chat header, on the parent and on each of its threads: a click opens that thread, with its own message box and draft. The row lists the threads the sidebar shows under the parent; one the user made its own, or whose parent is wrapped, has no row.

{place:threads.agentThreads} decides this: Off, Ask me first (a card in the chat lists the threads and you decide), or Automatic. The same setting covers agents creating or changing scheduled tasks. An agent may start at most 5 threads and send 10 messages to them per message you send.

A started thread works in a worktree of its own; in a project without git it shares the project's folder. With {place:threads.agentThreadsShareWorktrees} on, an agent can instead put a thread in a checkout that already exists: its own, or that of a thread it started. The new thread sees the files as they are there, uncommitted changes included, which suits a reviewer for work another thread just finished. An agent can also move an idle thread into such a checkout with a message, and the thread keeps its conversation. The thread the checkout belongs to must not be working at that moment. No worktree or branch is made and the project's setup script does not run. The two threads then share one set of files, so only one should work at a time. The thread's row under the message box reads Shared worktree. This works on one computer only, and not for threads an outside agent starts.

A started thread gets at most its parent's access level, or a lower one the agent asks for, and the parent's model unless the agent picks another. On a model already in the room it runs at the reasoning you set for that agent there, unless the agent or you name another level; the approval card shows the level. With computers linked in Fleet, an agent can also start a thread on another computer, if that computer allows it ({place:fleet.worksWith}).

A thread on another computer stays under its parent on both computers and shows how it is doing there, even after its answer came back. Once its answer reached the parent it wraps up and moves to Wrapped like any other, unless someone picked it up again there. Its row has Wrap up (and Reopen in Wrapped), which applies on both computers. To open it, connect this app to that computer.

A project's lead chat is a thread set up to coordinate the project; see the lead chat topic.`,
  },
  {
    id: "lead-chat",
    title: "Lead chat",
    keywords: [
      "lead chat",
      "lead",
      "coordinator",
      "project lead",
      "orchestrator",
      "drop work",
      "threads panel",
      "project threads",
      "board",
    ],
    body: `Each project can have one lead chat: a thread you drop work into (a bug, a stack trace, a list of tasks). Its agent answers small questions itself and starts threads for new work. Those threads show under the lead in the sidebar and report back to it, and it tells you what finished and what needs you.

Any thread can be the lead. Use "Make this the lead chat" in a thread's menu (right-click its row, or click the title above the chat), or the command palette. The project's menu in the project picker has Open lead chat, or New lead chat, which starts a thread in the project folder and makes it the lead. "Go to lead chat" in the command palette opens it.

The lead can also pass a message to a thread you started by hand in the project. That is one-way: the thread works on it and answers there, not back in the lead, and it can't start threads of its own for it until you write there. The lead can't pass work into a room, a thread another thread still owns, or one you stopped. A pass never runs with more access than the lead had.

When an agent asks to start several threads, the card has a checkbox per thread, so you can start some and leave the rest; the agent is told which.

Only one thread leads a project; making another the lead replaces it. "Stop using as lead chat" turns it back into an ordinary thread, and the threads it started stay with it. Archiving or deleting the lead ends it. A lead can't move to another computer, and each computer keeps its own lead for a project.

The lead's row sits at the top of the sidebar with a crown, says Lead where the project name goes, and never wraps up on its own. {place:archived.autoArchive} leaves it alone, as it does a pinned thread. The chat shows a Lead chat label beside the title, or, once it has started threads, the family tabs with the lead first.

The Threads tab in the right sidebar shows the project's threads on every computer you can see, grouped as Needs you, Ready for review, Working, Landing, Idle and Done. Open it from the sidebar's list of panels or its + menu, on any thread of the project. A thread you wrapped up goes under Done (for 7 days, closed until you open it) unless its pull request is still open, which keeps it under Ready for review or Landing. Ready for review says what the pull request waits on, as the Pull requests page does. Click a row to open the thread, or right-click it for the thread's menu. The top line counts what needs you and what's working, with a Lead chat link when you're on another thread.

The lead's agent is told its role at the start of every turn, and when you give it a goal. It may start 10 threads and send 20 messages to them per message you send, instead of 5 and 10. It needs {place:threads.agentThreads} to be on, and an agent that can't use the thread tools says so. General chats, a thread another thread still owns, and threads from another computer or an outside agent can't be the lead.`,
  },
  {
    id: "linking-computers",
    title: "Linking computers (Fleet)",
    keywords: [
      "fleet",
      "link",
      "computer",
      "pc",
      "mac",
      "windows",
      "remote",
      "another machine",
      "move",
      "transfer",
      "shut down",
    ],
    body: `Fleet, in the left bar, lists the computers this app knows. Use + at the top of its Computers list to link another computer running Threadlines. Each computer's page shows its connection, {place:fleet.worksWith}, and its devices.

Linking is two-way, with a permission for each direction: "<A>'s agents can start work on <B>" is Allowed, Ask first or Off, with the most access those threads get ("Up to Auto"). Each direction is stored on the computer the work would run on, so the Mac's setting decides what the PC's agents may do on the Mac, and the other way round. Unlink from the same group.

With a link allowed, an agent can start a thread on the other computer in that computer's copy of the project, read it and message it, and its reply comes back. A computer you only open from this app (Settings › Connections › Computers you use from here) is not a link: you see its threads here, but agents can't work across. This app's sign-in to it renews whenever they connect and ends after 90 days without one, or when that computer removes it. Fleet's All computers page and its own page then say the sign-in ended and offer to connect again with a new code; its threads stay on it.

To carry on a thread on a linked computer, for example before shutting this one down, click its title at the top of the chat or right-click it in the sidebar (or use the command palette), and pick Move to another computer. The thread goes with its messages and its code changes, including files not yet committed; staged changes arrive unstaged. It lands in a new worktree of that computer's copy of the project; the dialog offers to set the project up there when it's missing. When that computer's permission for this one is Ask first, its user allows the move there. The copy left here stays, read-only, with a link to the new one. With Claude, Codex or Pi, and the same kind of agent picked on the other computer, the agent keeps its full memory: its own session moves too (up to 50 MB) and picks up where it was. Otherwise, or if that session can't be resumed there, the agent gets a summary of the conversation; the dialog and the moved thread's timeline say which. Turns from before the move can't be undone there. A working thread can move too: Move when it's done starts the move once its turn and background work finish, and Stop and move now stops its agent first. While it waits, a notice above the message box says what for, with Cancel, and the thread takes no new messages. An agent can move its own thread with thread_move; it goes when that turn ends. To clear a computer before shutting it down, Move threads (on a computer's page in Fleet, or in the command palette) moves several at once, and quitting the desktop app while threads work offers to move them first, quitting once each has gone. When the other computer asks first, it takes each move's files right away and holds them until its user allows them (all the moves from one computer together, or one at a time), so this computer counts them as sent and can shut down; a move that isn't allowed unfreezes here the next time the two connect. What a thread had going comes along when the other computer runs a current Threadlines, and runs there by itself: a goal that was working carries on, the agent is told its check-backs and sets them again, your queued messages are sent in order, its pull requests come along with auto-fix and auto-merge off (a notice there says what was on, with Turn on), and its plans come along, the waiting one with Implement. Until you send the moved thread a message there, its agent can't use other threads, rooms or schedules, and the thread can move only back to the computer it came from. If the link it came over can't confirm which computer sent it, it can't move at all until then. A General Chats thread moves with every file in its folder, up to 100 MB. The dialog says what comes along and what won't work there; the "Moved here" line on the other computer says what arrived and what didn't. If a move doesn't happen, the thread gets back here what the move stopped: its goal and its check-backs, and its queued messages go. A room moves with its agents: the dialog has a row per agent with the matching agent on the other computer picked (same kind and model, else that kind's default), or Leave out. An agent with no match, or left out, arrives as having left, and both ends say which; each agent that comes keeps its own memory or gets the whole conversation once. Move when it's done waits for the agents' hand-offs and replies to finish, and Stop and move now ends them as Stop does. A thread that started other threads moves with them: the dialog lists its threads here, ticked, and one you untick stays here as its own thread, as does one that can't move (the dialog says why). On the other computer the threads that came are still its threads, and its "Moved here" line names the ones that stayed. Threads its agent started on another computer stay there, and the moved thread can't reach them. Moved to the computer one of them is on, its "Moved here" line names that thread, which stays separate. Move when it's done waits for the threads it started to report back, and Stop and move now ends that wait as Stop does. A thread another thread started can move on its own (Move just this thread) or with its whole family. With its whole family, each thread moves with the agent the other computer suggests for it. On its own it stays that thread's thread on the other computer, which can still send to it, read it and stop it; there, like any thread another computer's agent started, its agent never gets other threads, rooms or schedules. A thread another computer's agent started can move only back to that computer, where it is that thread's thread again. A thread with a message queued by a scheduled task, an assistant or a thread outside its family can't move yet; the dialog says what to finish first.`,
  },
  {
    id: "devices",
    title: "Phones and other devices",
    keywords: [
      "phone",
      "tablet",
      "pair",
      "qr",
      "remote access",
      "tailscale",
      "network",
      "browser",
      "open in the app",
      "alerts",
      "notifications",
      "mute",
      "sound",
    ],
    body: `{place:settings.connections} is where other devices use this computer. {place:connections.devices} lists every phone, tablet, browser and linked computer paired with it; Connect a phone, tablet, or computer there to pair a new one.

{place:connections.computersFromHere} are other computers this app opens, so their threads show here too. {place:connections.options} sets how devices reach this computer: the same network, Tailscale, or a one-time link. A phone away from home connects through Threadlines' relay, end to end encrypted.

A thread link from an assistant or a phone alert, opened in a computer's browser that isn't paired, offers Open in the Threadlines app: it opens the thread in the desktop app on that computer, no pairing needed. On Linux only the .deb install opens these links; with the AppImage, pair the browser instead.

{place:general.alertSound} plays a short sound in the open app, on any device, when an agent finishes or needs you; a thread you're looking at stays quiet. {place:general.alerts} on a phone turns its alerts on and picks which ones it gets. {place:general.alertsQuietAtComputer} holds them while you're using Threadlines on a computer that's connected to the thread's computer: a request that still needs you comes through once you've stepped away, and finished or failed alerts from that time don't. To stop one project's alerts on every phone, choose Mute phone alerts from that project's menu in the project list at the top of the sidebar.

{place:connections.thisComputer} is this computer's name as the others see it.`,
  },
  {
    id: "scheduled-tasks",
    title: "Scheduled and event tasks",
    keywords: [
      "schedule",
      "cron",
      "recurring",
      "every day",
      "webhook",
      "event",
      "github event",
      "check-back",
      "check back",
    ],
    body: `{place:scheduled} lists tasks that start an agent at set times (once, hourly, daily, weekdays, weekly or a cron rule) or when an event arrives at the task's address (a webhook, or GitHub events like a new issue or failed checks). Each run starts a new thread with the task's instructions, or sends them to one thread as a follow-up.

Tasks run while Threadlines is running on that computer. A time missed while it was off or asleep gets one catch-up run when it's back, if the missed time was within the last 7 days. A Mac that wakes only briefly for upkeep (screen off) starts nothing; runs wait until it's fully awake. The desktop app can keep the computer awake for them.

Agents can list, create and change scheduled tasks when {place:threads.agentThreads} isn't Off; with Ask me first, a card asks you before a change takes effect. A task an agent sets up on a model already in the room runs at the reasoning you set for that agent, unless the agent or you name another level.

Below the tasks, Check-backs lists the threads an agent set itself to come back to, soonest first, with when and why. A row opens its thread, and Cancel ends the check-back (it stops that agent's session; one saved to the project has no Cancel). A thread with a check-back can still wrap up: in Wrapped its row shows a clock with the time left, and it comes back to the list when the agent does.`,
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

What it can do is up to you: See threads, Start threads (and message or stop the ones it started), or Work with all threads, which also lets it message, stop and answer questions in any thread in its projects. Only you grant Work, and no outside agent answers approvals. Once its work runs in a thread, that thread's agent gets read-only Threadlines tools and no browser panel until it starts fresh (your next message there, or Start fresh on the thread's notice).

A message it sends while a thread is working waits above the message box as "Queued from" its name and goes as the next turn, one per thread at a time. You can remove it there; Stop, or a turn that ends in an error, takes it back. It can read a long message in full, not just its first 4,000 characters.

{place:connections.threadlinesCommand} (desktop app) puts the command on your PATH. Then, in a new terminal, \`threadlines connect\` signs the agent in: the browser shows a short code, and you approve the agent in the Threadlines window when the same code shows there, choosing what it can do and its highest access. After that: \`threadlines projects\`, \`threadlines thread start <project> "<prompt>" --wait\`, and \`threadlines thread list\`, \`read\`, \`send\`, \`wait\`, \`stop\`.

{place:connections.agentsUsingThis} lists each agent you let in, to change its access or remove it. {place:connections.agents} also shows the address agents use.

It can work on your other computers linked to this one in Fleet too, through this one: in its Change dialog, Other computers asks each one, and you allow it on that computer. It never gets more there than here, and this computer has to be on. \`threadlines computers\` lists them; \`--computer <name>\` sends a command there.`,
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
      "webhook",
      "alert",
      "grok routine",
    ],
    body: `Always-on assistants run in their makers' cloud. Through the relay they can see projects and threads, start threads, and message or stop the ones they started. With Work with all threads, which only you grant, they can also message, stop and answer questions in any thread in their projects. Checking in, they see what needs you (approvals, questions and plans), what finished or failed since they last looked, and what a thread changed, with its pull request's checks and review. This computer keeps that record of finished and failed for 7 days, only while an assistant is connected or an alert address is on.

To connect one, paste {place:connections.assistantAddress} into the assistant as a custom connector. Its sign-in page asks for a code: choose {place:connections.addAssistant}'s Connect an assistant, type the code it shows into that page, then allow the assistant in the window that opens, choosing what it can do and its highest access. Only type the code into a page your own assistant just opened. An assistant that takes a key instead of signing in (Muse) gets one from Create a key, shown once with the address. For Muse, ask it in a chat to add a custom connector with that address, then enter the key in the box Muse opens for it, never in the chat, and choose Always allow when Muse asks to reach threadlines.dev: Muse holds each request until it's allowed and gives up after about 45 seconds.

{place:connections.assistantsUsingThis} lists each assistant you let in, to change its access or remove it. Each shows by what it is, with its mark: Grok Bot signs in as Cursor, so Threadlines guesses from how an assistant signs in, and you pick another in the approval dialog or with Change. A thread an assistant starts shows its mark before the title in the sidebar, and its name beside the title at the top of the thread. Assistants never answer approvals or plans; those wait for you. A message an assistant sends while a thread is working waits above the message box as "Queued from" its name and goes as the next turn; you can remove it, and Stop takes it back. Once an assistant's work runs in a thread, that thread's agent gets read-only Threadlines tools and no browser panel until it starts fresh (your next message there, or Start fresh on the thread's notice).

With {place:connections.assistantAlerts}, this computer wakes an assistant instead of waiting for it to check in: it sends a signed alert to a web address when a thread needs you, finishes or fails. An alert carries only the kind, the project, the computer and a link, never a thread's title or what its agents wrote. For a Grok routine, add its webhook URL with its key (\`Bearer crsr_…\`) as the Authorization header, so the routine runs and checks in to see what happened. Skip threads I'm looking at, on by default, holds back alerts for threads you have open, since the routine runs a model for each one. Finished only when I ask sends a finished alert just for turns where the user told the thread's agent to tell their assistant ("let Grok know when you're done"); the agent's alert_assistants tool marks that turn, and it goes out when the turn ends, even while the thread is open. Agents in threads another computer, an outside agent or an assistant started can't mark a turn, nor can community agents that don't take Threadlines' tools.

Dots and ChatGPT Work chats can subscribe to those alerts themselves (MCP Events), for one kind of alert and every project they can see or just one. A subscription shows in that same list with the assistant that added it and when it must be renewed by. The assistant renews it on its own, at most a week at a time. Its only action is Remove, and the assistant can subscribe again while it's connected; remove the assistant to stop it for good. None of these alerts cover General Chats.

An assistant connected here can work on your other computers linked to this one in Fleet: in its Change dialog, Other computers asks each one, and you allow it on that computer, never with more than it has here. Its calls go through this computer, so this one has to be on. Alerts are set on each computer.

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
      "workspace",
      "chatgpt",
      "gateway",
      "model provider",
      "security notice",
    ],
    body: `{place:settings.providers} lists the agents this computer can run (Claude, Codex, Cursor, OpenCode, Pi and others), in use and not in use. Each card has its account and sign-in, its models, how it appears (name and color), and how it launches (command and environment variables).

{place:providers.community} adds agents from the open ACP registry; Threadlines hasn't tested those.

Claude's models come from Claude Code itself, so a new one shows up without a Threadlines update. A model Threadlines has no settings of its own for starts on Default reasoning: no level is sent and Claude Code picks one. When Claude Code stops listing a model, the picker stops offering it, but a thread, room agent or setting already on it keeps it.

How much of each plan you've used is on {place:usage}.

An agent's row that says Can't start means its program is on this computer but fails to launch, usually because an update stopped partway. It is not a sign-in problem: the sign-in is still saved. The row has Reinstall when Threadlines can put that same copy back: with npm, bun or Homebrew for a copy they installed, or with the agent's own installer for a copy sitting where that installer puts it (Claude, OpenCode, Cursor, fx, Muse Code, and Codex on Windows). For Pi it reinstalls an npm copy, or installs Threadlines' own copy of Pi. There is no Reinstall for a copy from pnpm, Scoop, winget or Nix, for one at a custom path, or for Grok from xAI's installer (it would switch the release channel); reinstall those the way they were installed. An update that leaves an agent unable to start runs that reinstall once on its own before reporting. Community agents are installed by Threadlines itself and have Install again instead. Antigravity is downloaded and checked by Threadlines, so it isn't covered.

A Claude sign-in made with Claude's own sign-in (not an API key or a long-lived token) ends on a date that renewing doesn't move: up to 3 days before the date Claude saved. From 10 days before, the Claude row in Settings and the notice above the message box say when, with Sign in again; signing in again sets a new date. The notice's X hides it until the next sign-in.

When a Codex ChatGPT sign-in belongs to more than one workspace (a personal one and a company's, say), the Codex row shows the one in use, and its Account & Sign-in has Workspace: pick another and Switch. Switching first stops that Codex's running chats and holds new ones until it's done. A workspace behind company sign-on opens a sign-in page; Cancel keeps the current workspace. A chat whose data the old workspace keeps in another region may not continue after a switch; start a new thread for it. It needs Codex 0.167 or later.

When Codex's own config points it at a gateway or another model provider instead of OpenAI, the Codex row says Runs on and the provider's name, and Account & Sign-in has a Model provider line. Threadlines only shows it; change it in Codex's config. A ChatGPT sign-in beside it keeps its email, workspace and Sign out. The model Codex's config names is in the model picker and is the default for new threads, and titles and commit messages written by Codex go through the gateway too. A Codex agent answering on the side in a room still runs on OpenAI. It needs Codex 0.168 or later.

When OpenAI asks a ChatGPT account to do something about its security, the Codex row says Security notice, and Account & Sign-in shows OpenAI's words with a button that opens the page on OpenAI's site. It needs Codex 0.169 or later.

When Claude Code refuses to start (a settings file that is not valid JSON, a bad proxy address, a version too old), the chat shows Claude Code's own reason once, with the file and its backup for a broken settings file. Fix what it names, then Retry.

If Codex's sign-in goes stale in a chat before it has started on your message, Threadlines restarts Codex and sends the message again, once, with a note in the chat. If that fails too, the chat asks you to sign in.

When a Claude or Codex usage limit stops a thread, the notice above the composer says which limit and when it resets. Its Continue at reset switch sends "Continue where you left off." a minute after the reset, from the computer the thread runs on (a Mac that wakes only briefly for upkeep waits until it's fully awake), or within a few minutes of the limit resetting early because the user spent a limit reset, and {place:threads.continueAfterUsageLimits} turns it on for every limit. With it on, a thread another thread's agent started on this computer also waits for the reset instead of failing, and its answer goes back once it continues; so does a thread hearing back from one it started. Stop ends the wait, and a turn you stopped never comes back by itself. If you added another account of the same agent that still has room, the notice offers it by name. Threadlines never switches accounts on its own.`,
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
    keywords: [
      "browser",
      "preview",
      "localhost",
      "web page",
      "screenshot",
      "sites",
      "page size",
      "viewport",
      "sign in",
      "cookies",
      "passwords",
    ],
    body: `In the desktop app a browser panel sits beside the chat. Agents use it to open your dev server, check a layout, reproduce a bug or fill in a form, and you watch every step; you can also mark up the page and send the marks to the agent.

{place:general.sitesAgentsCanVisit} decides which sites agents may open without asking you first. Local addresses always work.

{place:general.browserSignIns} is Shared by default: every project on a computer uses one browser, so you sign in to a site once and every project's agents can use that sign-in. Local sites are shared too, so two projects on localhost:3000 see each other's cookies and storage. Per project gives each project its own. Each project still has its own allowed sites. The browser can't use Chrome's saved passwords or your Chrome sign-ins.

Show device toolbar, in the browser's options menu (⋮), sets the page's size: Responsive fills the panel, and a Phone, Tablet, Laptop or Desktop size shrinks to fit it. New tabs open at {place:general.browserPageSize}, which the size menu can also set.

Words typed in the browser's address bar are searched for, with the search engine set in {place:general.browserSearchEngine}. An address loads as it always did.`,
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

A file the agent named without its full folder (\`Model/Form.php\`) opens the one project file that ends that way. In a worktree thread, the project folder is searched too when the worktree lacks the file. If several files match, nothing opens: ask the agent for the full path.

Click a line number to select lines (drag for a range) and add them to the chat, or attach the whole file. The open button in its header opens the file in one of your editors, or reveals it in Finder or Explorer.

Edit (or double-click, or start typing) edits the file in place, and it saves as you type. If the file changed on disk meanwhile, for example an agent edited it, the footer offers Reload file or Keep my version. Editing is off for files over 1 MB, read-only files, text that isn't UTF-8, and on touch screens.

A file outside the project opens and edits the same way, but git doesn't track it, so Threadlines keeps the original before the first save, for 30 days. Restore original in the footer puts it back.

Pictures and PDFs show in the viewer, PDFs with zoom and find. An SVG shows as a picture, with Show source for its code. Videos and sound files play in it: one up to 64 MB loads as it opens, a bigger one waits for Load, and one over 1 GB doesn't play here. Any other file offers Reveal in Finder (Explorer on Windows) and Copy path. A folder outside the project opens in Finder or Explorer.`,
  },
  {
    id: "media-tab",
    title: "The Media tab",
    keywords: [
      "media",
      "assets",
      "pictures",
      "images",
      "screenshots",
      "videos",
      "audio",
      "documents",
      "generated images",
      "before and after",
      "play video",
      "pdf preview",
      "attachments",
      "shared in chat",
    ],
    body: `The Media tab in the right sidebar lists the pictures, videos, sounds and documents (PDFs, Word, slides and the like) that agents created or changed, then, under Shared in chat, the pictures the chat showed and the pictures and PDFs you attached. Open it from the sidebar's list of panels or its + menu.

It opens on the current thread; All threads shows every thread in the project, each file marked with the thread that made it. Files are grouped by type, and each is marked A (the thread added it) or M (it changed one that was there). Search by name, sort newest, oldest or by name, and group by type or by thread. Pictures and PDFs show as small pictures (a PDF its first page); a video shows its first frame once it has played.

Click a picture to see it full size, with arrows to step through the rest; a changed picture has Before and After. A PDF, video or sound file opens in the file viewer, where videos and sound play. Right-click any file to preview it, open it in the file viewer, go to the turn that made it, open it in your editor, reveal it in Finder or Explorer, or copy its path.

Files agents made are listed only from inside the project's folder. Shared in chat covers the rest: a screenshot a tool took, a picture an agent's reply showed (even from a temp folder or a folder git ignores), and your attachments. Each says where it came from (You attached, From a tool, In a reply), and right-clicking it can go to that message. A picture is listed once, at the newest place it showed, and one the files above already list isn't repeated. A file deleted since doesn't show. Right after an update, pictures from older chats appear over the first minutes while they are looked through.

In the Diff tab, a changed picture shows its Before and After side by side instead of a file name.`,
  },
  {
    id: "source-control",
    title: "The Source tab and Git",
    keywords: [
      "git",
      "source control",
      "source tab",
      "side panel",
      "header",
      "down arrow",
      "uncommitted",
      "commit",
      "push",
      "pull",
      "behind",
      "remote",
      "branch",
      "merge",
      "stash",
      "changes",
      "graph",
      "fetch",
    ],
    body: `The panel button at the right of the chat header opens a side panel, and so does Cmd+D, or Ctrl+D on Windows and Linux. Its Source tab is where you work with Git in the thread's checkout. {place:sourceControl.openPanelByDefault} opens it as you enter a thread.

Beside that button the header shows uncommitted lines added and removed, and ↓ with how many commits the branch is behind its remote. Click the counts to open the Source tab. ⌘-click the ↓ count (Ctrl+click on Windows and Linux) to pull without opening the panel, or right-click it, or hold it on a touch screen, for a menu with the same pull. A narrow header hides the counts.

The Source tab lists staged and unstaged changes; click a file for its diff. The main button commits and pushes, writing the message unless you pick Write message from its menu first. With nothing to commit, it only pushes. The same menu has Commit only, Push only, Stash changes, View stashes and Review changes with Codex. Below it are Pull, New PR or Open PR, and the branch menu for creating, switching and merging branches. Graph shows the history. Right-click a commit to copy it, tag it or open it on the site that hosts the repository.

Pull only fast-forwards, so it never merges or rebases. With uncommitted changes it asks to stash them, pull, and put them back. If the remote branch was force-pushed or recreated, Pull offers to back up your branch before taking the remote's. Pull and the Source tab's buttons wait while another Git action changes the checkout. In a project inside a bigger repository, the Source tab asks before it changes anything.

The ↓ count is only as fresh as the last fetch, and {place:sourceControl.fetchInterval} sets how often that runs. Commit and pull request text follow {place:sourceControl.writingStyle} and {place:sourceControl.writerModel}. GitHub sign-ins are in {place:sourceControl.providers}, and {place:pullRequests} lists your pull requests across projects.`,
  },
  {
    id: "pages-and-command-requests",
    title: "Agent pages and command requests",
    keywords: ["page", "chart", "diagram", "mockup", "run command", "card", "artifact"],
    body: `With {place:threads.agentPages} on, an agent can show a chart, diagram, mockup or document as a page in its reply. {place:threads.claudeArtifacts} lets Claude also publish one to claude.ai for a link you can share.

With {place:threads.commandRequests} on, an agent can ask you to run a command it can't run itself (one that needs your password or sign-in, or a long-running server): a card in the chat with Run, Put in terminal and Skip, and the output comes back to the agent.`,
  },
  {
    id: "themes",
    title: "Themes",
    keywords: [
      "theme",
      "custom theme",
      "colors",
      "font",
      "background",
      "art",
      "animated",
      "glass",
      "look",
      "showcase",
      "share theme",
      "vs code theme",
      "vscode",
      "open vsx",
      "edit colors",
      "color editor",
      "change accent",
      "dark mode",
      "light mode",
      "follow system",
    ],
    body: `A theme changes how all of Threadlines looks: its colors, its fonts, and optionally live art behind the app, with the chat and Settings on frosted glass in front. A device picks its theme in {place:settings.appearance}, and with {place:appearance.sameEverywhere} on (the default) its pick becomes every such device's theme; a theme kept once is in this computer's library on every device.

System follows the computer's light or dark setting. In {place:appearance.systemThemes} the user picks the theme System shows in each mode (a light one and a dark one: built in, a starter or one of theirs), and the app switches between them when the computer does; picking one switches the device to System, and its reset goes back to plain Light and Dark. A light or dark theme's options in the gallery also have "Use when my computer is light" (or dark), and while System is in use the gallery marks the themes it shows. Setting the theme to "system" brings that pair back. There is no agent tool for the pair: point the user to the row.

An agent makes one with preview_theme (screenshots of the app wearing it, its readability checks and what its art costs) and offers it with show_theme: a row in the chat with Try it. Trying shows a bar at the top of the window, Keep or Undo, and it switches back by itself after 15 seconds (for a new version of a theme already kept from the same offer in that chat, the bar asks to Update that copy, with Keep both to add another); Esc, a reload or closing the window undo it too (while the /theme picker is open, a preview waits for its ✕ or Esc instead). The Settings gallery, the composer's /theme and an imported ${THEME_FILE_EXTENSION} file start the same trial. New theme, in /theme or in Settings, puts the start of a request in the message box ("Make me a Threadlines theme that feels like") with a few ideas to finish it (Settings opens a general chat for it); sending it asks the agent for one. In Settings, the options on a theme's picture rename it, duplicate it to change a copy, export a file to share, copy the request it was made from, or delete it; starters can be duplicated and exported. An exported file never says which thread made the theme and leaves the request out unless the user includes it; its author can add a credit (name, link, CC BY or CC0), which importing shows, and a theme that already has one keeps it.

The Showcase, beside Your themes in {place:settings.appearance}, lists themes people shared, reviewed before they're listed; clicking one starts the same trial. Share to Showcase…, in a theme's options, opens a public pull request to the Threadlines/themes repository from the GitHub account this computer is signed in to with gh, after showing what gets published. It's public the moment it's shared, under that account's name but without its email. It needs a CC BY or CC0 license, fonts that carry their own copyright and license, and no parts this version doesn't know; the theme's picture then says In review, In the Showcase, Taken back or Not added. Until it's added, Take back from Showcase…, in the same options, closes the pull request; GitHub keeps the closed one. Agents can't share or take back for the user.

Edit colors…, in a theme's options in {place:settings.appearance} (Light and Dark too) or "Edit theme colors…" in the command palette, opens a panel beside the app with the theme's own colors (background, text, quiet text, accent, text on accent, and the optional borders, status, code background and selected text). Every change shows across the app at once; Cancel or Esc puts back what was there. Each color says where it's hard to read, and Fix for me moves those colors a little until they read. Pick from the app, then a click anywhere, says which of those colors paints that spot. Save updates a theme in the library; any other is saved as a new theme.

VS Code, the third tab there, searches the Open VSX store for VS Code color themes under an open license. Clicking one lists the themes in it: pick one to try it the same way, or several to add them to the library. They bring the colors over (app, code and terminal), never fonts or art; a color that would be hard to read moves a little, and the dialog says how many did. The theme credits its author and keeps the extension's license. Import takes a VS Code theme file too. An agent finds one with find_vscode_theme, which saves each theme as a file in the chat's page assets folder for show_theme.

${THEME_FORMAT_GUIDE}

${THEME_ART_CONTRACT_GUIDE}

${THEME_ART_RULES_GUIDE}

${THEME_DESIGN_GUIDE}

The art is walled off: it runs in a worker in a sandboxed frame with no network, sees only agent counts and the theme's colors, and Threadlines stops it when it fails, gets too heavy, or nobody is looking. The frame raises the glass tint under text as needed, so text stays readable whatever the art draws, up to the last quarter of {place:appearance.glass}. That slider (Solid to Clear, the theme's own in the middle, the same slider in the /theme picker) sets how much of the art shows through the glass on every page; in its last quarter the frost and that extra tint fade out, so at Clear the art shows as it is and busy art can make text hard to read. Appearance also has {place:appearance.motion} (Live or Still) and {place:appearance.sameEverywhere}, on unless the user turns it off: picking a theme on a device with it on switches every other device with it on, phones and other computers included, and a device that turns it on takes the theme they share. Phones never animate the art: they draw one frame of it at the phone's own size. Switching a device to a theme by name, when the user asks, is a settings change to {place:appearance.theme}.`,
  },
  {
    id: "changing-settings",
    title: "Agents changing settings",
    keywords: [
      "change setting",
      "turn on",
      "turn off",
      "switch",
      "theme",
      "dark mode",
      "card",
      "default model",
      "alerts",
    ],
    body: `An agent can change many settings when you ask: the theme, streaming replies, the model new threads start with, the writing model, which alerts you get, where links open and more (the guide says which, place by place). A model it picks starts at that model's default reasoning, and it can't pick a provider billed per use. It puts a card above the message box listing each change, from what to what, and where it lands: this computer's settings, or the app you accept it in, since settings like {place:appearance.theme} are kept by each app. Alert switches change only where alerts are on (a phone or a browser), and {place:general.openLinksIn} only in the desktop app; the card says so if you're somewhere else. Nothing changes until you press Change; Not now changes nothing. The agent hears how it went at its next turn. The theme can also be one from the theme library, by name; a theme new to that device starts as a trial with Keep and Undo (see \`themes\`).

Settings that give agents more reach ({place:threads.agentThreads}, {place:threads.enableRooms}, access levels, linked computers, plugins and sign-ins), that archive or delete threads, or that share data ({place:general.usageAnalytics}) are yours alone: an agent links them for you instead.`,
  },
  {
    id: "updates",
    title: "Updates and release tracks",
    keywords: ["update", "version", "nightly", "stable", "release", "what's new", "bug", "report"],
    body: `The desktop app updates itself. When an update is ready, a notice says so with a button to restart into it. The app's version and which releases it follows (stable, or nightly builds with the newest changes) are in {place:general.about}; its Version row opens What's new.

To report a bug, {place:general.reportProblem} opens a short form in the app, with the version and setup filled in. When the computer is signed in to GitHub, Post report puts it on Threadlines' GitHub issues from the user's own account, so GitHub tells them about replies. Signed out, they can sign in from the form or finish on GitHub's form, which opens with what they wrote. Reports are public. The search box (Report a problem), the new-thread screen, the "Something went wrong" screen and the Help menu in the desktop app open the same form.`,
  },
];
