import type { IconName } from "./icons";

/**
 * Threadlines compared with another app, one page each at /compare/<slug>. Claims about the
 * other app come from its own site and docs on `checkedOn`, listed in `sources`; re-check them
 * and bump the date before editing a row. Rows about Threadlines follow the stable app, like
 * lib/agents.ts. Keep cells to a few words: the marks carry the answer.
 */
export type ComparisonMark = "yes" | "partial" | "no";

export interface ComparisonCell {
  mark?: ComparisonMark;
  text: string;
}

export interface ComparisonRow {
  icon: IconName;
  label: string;
  threadlines: ComparisonCell;
  other: ComparisonCell;
}

export interface Comparison {
  slug: string;
  name: string;
  maker: string;
  title: string;
  description: string;
  headline: string;
  intro: string;
  /** One line for the /compare grid. */
  summary: string;
  rows: ComparisonRow[];
  pickThreadlines: string[];
  pickOther: string[];
  faq: { question: string; answer: string }[];
  /** The day the facts about the other app were last checked, as YYYY-MM-DD. */
  checkedOn: string;
  sources: { label: string; url: string }[];
}

export function comparisonPath(comparison: Pick<Comparison, "slug">): string {
  return `/compare/${comparison.slug}`;
}

const THREADLINES_AGENTS: ComparisonCell = {
  text: "Codex, Claude Code and seven more, plus community agents",
};

const THREADLINES_DESKTOP: ComparisonCell = { mark: "yes", text: "macOS, Windows, Linux" };

const THREADLINES_PHONE: ComparisonCell = {
  mark: "yes",
  text: "Home Screen web app with alerts",
};

/** Fleet: linked computers, and agents that start threads on them. */
const THREADLINES_COMPUTERS: ComparisonCell = {
  mark: "yes",
  text: "Agents start threads where the project is set up",
};

const THREADLINES_TASKS: ComparisonCell = {
  mark: "yes",
  text: "On a schedule, a GitHub issue or a webhook",
};

/** Outside agents: approved terminal agents and the threadlines command. */
const THREADLINES_TERMINAL_AGENTS: ComparisonCell = {
  mark: "yes",
  text: "Claude Code, Codex, Gemini CLI, Cursor, scripts",
};

export const COMPARISONS: readonly Comparison[] = [
  {
    slug: "conductor",
    name: "Conductor",
    maker: "Melty Labs",
    title: "Conductor alternative for Windows and Linux | Threadlines",
    description:
      "Conductor runs only on macOS. Threadlines is a free, open-source desktop app for Mac, Windows and Linux that runs Claude Code, Codex and other coding agents.",
    headline: "A Conductor alternative for Windows and Linux",
    summary:
      "A Mac app with paid cloud workspaces. Threadlines also runs on Windows and Linux, and it's open source.",
    intro:
      "Conductor is a polished Mac app for running coding agents side by side, each in its own Git worktree. Threadlines does that on Mac, Windows and Linux, it's open source, and two agents can share one conversation.",
    rows: [
      {
        icon: "monitor",
        label: "Platforms",
        threadlines: THREADLINES_DESKTOP,
        other: { mark: "partial", text: "macOS only, Windows and Linux waitlist" },
      },
      {
        icon: "dollar",
        label: "Price",
        threadlines: { mark: "yes", text: "Free" },
        other: { mark: "partial", text: "Free locally, Pro is $50 a month" },
      },
      {
        icon: "code",
        label: "Open source",
        threadlines: { mark: "yes", text: "MIT license" },
        other: { mark: "no", text: "Closed source" },
      },
      {
        icon: "agents",
        label: "Agents",
        threadlines: THREADLINES_AGENTS,
        other: {
          text: "Claude Code, Codex, OpenCode, Cursor. Local Cursor runs need a Cursor API key.",
        },
      },
      {
        icon: "message",
        label: "Two agents in one chat",
        threadlines: { mark: "yes", text: "One can review the other's work" },
        other: { mark: "no", text: "Each agent gets its own tab" },
      },
      {
        icon: "computers",
        label: "Your other computers",
        threadlines: THREADLINES_COMPUTERS,
        other: { mark: "no", text: "Its own cloud machines on Pro, not yours" },
      },
      {
        icon: "clock",
        label: "Scheduled and event tasks",
        threadlines: THREADLINES_TASKS,
        other: { mark: "yes", text: "Routines in the cloud, on Pro" },
      },
      {
        icon: "terminal",
        label: "Agents in your terminal",
        threadlines: THREADLINES_TERMINAL_AGENTS,
        other: { mark: "partial", text: "MCP and a CLI for cloud work, on Pro" },
      },
      {
        icon: "branch",
        label: "Git worktree per task",
        threadlines: { mark: "yes", text: "Per thread" },
        other: { mark: "yes", text: "Per workspace" },
      },
      {
        icon: "pullRequest",
        label: "Pull requests and CI",
        threadlines: { mark: "yes", text: "Beside the thread" },
        other: { mark: "yes", text: "Plus GitHub stacks and Graphite" },
      },
      {
        icon: "globe",
        label: "Built-in browser",
        threadlines: { mark: "yes", text: "Built in" },
        other: { mark: "partial", text: "Experimental" },
      },
      {
        icon: "cloud",
        label: "Cloud agents",
        threadlines: { mark: "no", text: "Agents run on your computer" },
        other: { mark: "yes", text: "On Pro" },
      },
      {
        icon: "phone",
        label: "Phone",
        threadlines: THREADLINES_PHONE,
        other: { mark: "yes", text: "iPhone app, listed under Pro" },
      },
      {
        icon: "account",
        label: "Accounts",
        threadlines: { mark: "yes", text: "None needed, GitHub optional" },
        other: { mark: "partial", text: "GitHub, plus a sign-in for cloud and phone" },
      },
    ],
    pickThreadlines: [
      "You work on Windows or Linux.",
      "You want open source with no paid tier.",
      "You want Codex to check Claude's work in the same chat.",
      "You want your own Windows PC or Linux box to share the work.",
      "You use Antigravity or fx.",
    ],
    pickOther: [
      "You want agents to keep working in the cloud.",
      "Your team shares chats live or needs SSO.",
      "You use GitHub stacks or Graphite.",
      "You want routines that keep running in the cloud with your computer off.",
    ],
    faq: [
      {
        question: "Is Conductor available for Windows or Linux?",
        answer:
          "Not yet. Conductor's install guide says it isn't available for Windows or Linux and offers a waitlist. Threadlines has a Windows installer and a Linux AppImage today.",
      },
      {
        question: "Does Threadlines use my Claude and ChatGPT plans, like Conductor?",
        answer:
          "Yes. Both apps run the agents with your own sign-ins, and neither resells model usage.",
      },
      {
        question: "Does Threadlines have cloud workspaces?",
        answer:
          "No. Threadlines runs agents on your own computer. You can reach it from your phone or another computer, but the work happens on your machine.",
      },
    ],
    checkedOn: "2026-10-29",
    sources: [
      { label: "Conductor's install guide", url: "https://www.conductor.build/docs/installation" },
      { label: "pricing page", url: "https://www.conductor.build/pricing" },
      { label: "docs and terms", url: "https://www.conductor.build/llms-full.txt" },
      { label: "API and MCP docs", url: "https://www.conductor.build/docs/api" },
      {
        label: "Remote Control release notes",
        url: "https://www.conductor.build/changelog/0.92.0-remote-control",
      },
    ],
  },
  {
    slug: "t3-code",
    name: "T3 Code",
    maker: "T3 Tools",
    title: "T3 Code alternative: Threadlines vs T3 Code",
    description:
      "Threadlines began as a fork of T3 Code. Both are free and open source. Here's where they differ, including where T3 Code is ahead.",
    headline: "A T3 Code alternative with several agents in one thread",
    summary:
      "The open-source app Threadlines began from. T3 Code has phone apps, and Threadlines puts several agents in one thread.",
    intro:
      "Threadlines began as a fork of T3 Code, and both are free, MIT-licensed apps for the agents you already pay for. Threadlines puts several agents in one thread. T3 Code puts more into phones and remote machines.",
    rows: [
      {
        icon: "dollar",
        label: "Price and license",
        threadlines: { mark: "yes", text: "Free, MIT" },
        other: { mark: "yes", text: "Free, MIT" },
      },
      {
        icon: "monitor",
        label: "Desktop",
        threadlines: THREADLINES_DESKTOP,
        other: { mark: "yes", text: "macOS, Windows, Linux" },
      },
      {
        icon: "phone",
        label: "Phone",
        threadlines: THREADLINES_PHONE,
        other: { mark: "yes", text: "iPhone and Android apps with alerts" },
      },
      {
        icon: "account",
        label: "Account for phone alerts",
        threadlines: { mark: "yes", text: "None needed" },
        other: { mark: "partial", text: "A T3 Connect sign-in" },
      },
      {
        icon: "agents",
        label: "Agents",
        threadlines: THREADLINES_AGENTS,
        other: {
          text: "The same nine, plus ACP registry agents",
        },
      },
      {
        icon: "message",
        label: "Several agents in one thread",
        threadlines: { mark: "yes", text: "One can review the other's work" },
        other: { mark: "no", text: "Agents hand tasks to child threads" },
      },
      {
        icon: "fork",
        label: "Agents start threads",
        threadlines: { mark: "yes", text: "Yes" },
        other: { mark: "yes", text: "Yes" },
      },
      {
        icon: "computers",
        label: "Your other computers",
        threadlines: THREADLINES_COMPUTERS,
        other: { mark: "yes", text: "Linked machines in beta, plus SSH" },
      },
      {
        icon: "clock",
        label: "Scheduled and event tasks",
        threadlines: THREADLINES_TASKS,
        other: { mark: "yes", text: "On a schedule or a webhook" },
      },
      {
        icon: "terminal",
        label: "Agents in your terminal",
        threadlines: THREADLINES_TERMINAL_AGENTS,
        other: { mark: "yes", text: "An MCP server and a t3 command" },
      },
      {
        icon: "refresh",
        label: "Switch agents mid-thread",
        threadlines: { mark: "yes", text: "With a recap and your working tree" },
        other: { mark: "yes", text: "With a selection of past messages" },
      },
      {
        icon: "undo",
        label: "Undo in a shared folder",
        threadlines: { mark: "yes", text: "Undoes only that thread's changes" },
        other: { mark: "partial", text: "Puts the folder back, your edits too" },
      },
      {
        icon: "pullRequest",
        label: "Git hosts",
        threadlines: { mark: "partial", text: "GitHub, GitLab, Bitbucket, Azure DevOps" },
        other: { mark: "yes", text: "Those, plus Forgejo, Gitea and more" },
      },
      {
        icon: "globe",
        label: "Built-in browser",
        threadlines: { mark: "yes", text: "Built in" },
        other: { mark: "yes", text: "Built in" },
      },
      {
        icon: "gauge",
        label: "Usage limits",
        threadlines: { mark: "partial", text: "Meters where the agent reports limits" },
        other: { mark: "yes", text: "Pooled across accounts, auto-resume" },
      },
    ],
    pickThreadlines: [
      "You want two agents in the same thread.",
      "You want to ask Codex or Claude something while another agent works.",
      "You want phone alerts without signing in to anything.",
      "Your threads share a folder, and undo should touch only one thread's work.",
    ],
    pickOther: [
      "You want native phone apps or a hosted web app.",
      "Your code lives on Forgejo or Gitea.",
      "You want usage limits pooled across accounts.",
      "You'd rather use the bigger project, with about 31,000 stars.",
    ],
    faq: [
      {
        question: "Is Threadlines a fork of T3 Code?",
        answer:
          "Yes. Threadlines started from T3 Code and keeps its MIT license and Git history. It has its own direction now, and improvements still flow back when they fit.",
      },
      {
        question: "Can I use both?",
        answer:
          "Yes. They're separate apps with separate data, and both run the agents with the sign-ins already on your computer.",
      },
    ],
    checkedOn: "2026-10-29",
    sources: [
      { label: "T3 Code's README", url: "https://github.com/pingdotgg/t3code" },
      {
        label: "remote access docs",
        url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md",
      },
      {
        label: "outside agents docs",
        url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md",
      },
      {
        label: "composer docs",
        url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md",
      },
      {
        label: "phone alerts docs",
        url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/mobile-notifications.md",
      },
      {
        label: "v0.1.0 release notes",
        url: "https://github.com/pingdotgg/t3code/releases/tag/v0.1.0",
      },
      { label: "user docs", url: "https://github.com/pingdotgg/t3code/tree/main/docs/user" },
    ],
  },
  {
    slug: "codex-app",
    name: "Codex app",
    maker: "OpenAI",
    title: "Codex app alternative that runs Claude Code too | Threadlines",
    description:
      "OpenAI's Codex app now lives in the ChatGPT desktop app. Threadlines is a free, open-source app that runs Codex with your ChatGPT sign-in, with Claude Code and other agents in the same thread.",
    headline: "A Codex app alternative that runs other agents too",
    summary:
      "OpenAI's own app, now inside ChatGPT. Threadlines is open source and puts Codex and Claude Code in one thread.",
    intro:
      "OpenAI's Codex app is now a mode in the ChatGPT desktop app, with Codex Cloud, computer use and a pull request inbox. Threadlines runs the same Codex with your ChatGPT sign-in. It's free and open source, and Claude Code or another agent can work in the same thread.",
    rows: [
      {
        icon: "monitor",
        label: "Platforms",
        threadlines: THREADLINES_DESKTOP,
        other: { mark: "yes", text: "macOS, Windows, Linux in preview" },
      },
      {
        icon: "dollar",
        label: "Price",
        threadlines: { mark: "yes", text: "Free app, your ChatGPT plan" },
        other: { mark: "yes", text: "Part of ChatGPT, from the free plan" },
      },
      {
        icon: "code",
        label: "Open source",
        threadlines: { mark: "yes", text: "MIT license" },
        other: { mark: "no", text: "Closed, the Codex CLI is open source" },
      },
      {
        icon: "agents",
        label: "Agents",
        threadlines: THREADLINES_AGENTS,
        other: { text: "Codex only" },
      },
      {
        icon: "message",
        label: "Two agents in one chat",
        threadlines: { mark: "yes", text: "Codex and Claude Code together" },
        other: { mark: "no", text: "Codex subagents only" },
      },
      {
        icon: "computers",
        label: "Your other computers",
        threadlines: THREADLINES_COMPUTERS,
        other: { mark: "yes", text: "SSH hosts, hand a chat to another Mac or PC" },
      },
      {
        icon: "clock",
        label: "Scheduled and event tasks",
        threadlines: THREADLINES_TASKS,
        other: { mark: "yes", text: "Schedules, plus events on web and phone" },
      },
      {
        icon: "branch",
        label: "Git worktree per task",
        threadlines: { mark: "yes", text: "Per thread" },
        other: { mark: "yes", text: "Optional per chat" },
      },
      {
        icon: "pullRequest",
        label: "Pull requests and CI",
        threadlines: { mark: "yes", text: "Beside the thread" },
        other: { mark: "yes", text: "A pull request inbox with checks" },
      },
      {
        icon: "globe",
        label: "Built-in browser",
        threadlines: { mark: "yes", text: "Built in" },
        other: { mark: "yes", text: "Built in, plus computer use" },
      },
      {
        icon: "cloud",
        label: "Cloud agents",
        threadlines: { mark: "no", text: "Agents run on your computers" },
        other: { mark: "yes", text: "Codex Cloud on Plus and up" },
      },
      {
        icon: "phone",
        label: "Phone",
        threadlines: THREADLINES_PHONE,
        other: { mark: "yes", text: "The ChatGPT app, with alerts" },
      },
    ],
    pickThreadlines: [
      "You want Codex and Claude Code in the same thread.",
      "You want an open-source app.",
      "You also use OpenCode, Cursor, Grok, Pi or another agent.",
      "You want tasks that start from a GitHub issue or a webhook on your own computer.",
    ],
    pickOther: [
      "You want tasks to keep going in Codex Cloud with your computer off.",
      "You want computer use, or ChatGPT's chat in the same app.",
      "You want a native phone app.",
    ],
    faq: [
      {
        question: "Is the Codex app part of ChatGPT now?",
        answer:
          "Yes. On July 9 OpenAI merged the Codex app into the ChatGPT desktop app for macOS and Windows, where Codex is a mode beside chat. A Linux version has been in preview since August.",
      },
      {
        question: "Does Threadlines use my ChatGPT plan?",
        answer:
          "Yes. It runs the Codex CLI with your ChatGPT sign-in, so it counts against the same limits. An OpenAI API key works too, and that bills per token.",
      },
      {
        question: "Can I use both?",
        answer:
          "Yes. They're separate apps. Threadlines runs the Codex CLI, which reads the same Codex config, so your MCP servers and settings come along.",
      },
    ],
    checkedOn: "2026-10-29",
    sources: [
      { label: "Codex app docs", url: "https://learn.chatgpt.com/docs/app" },
      { label: "what's new", url: "https://learn.chatgpt.com/docs/whats-new" },
      { label: "pricing", url: "https://learn.chatgpt.com/docs/pricing" },
      { label: "Linux app", url: "https://learn.chatgpt.com/docs/linux/linux-app" },
      { label: "remote connections", url: "https://learn.chatgpt.com/docs/remote-connections" },
      { label: "automations", url: "https://learn.chatgpt.com/docs/automations" },
      { label: "open-source components", url: "https://learn.chatgpt.com/docs/open-source" },
    ],
  },
  {
    slug: "claude-code-desktop",
    name: "Claude Code desktop",
    maker: "Anthropic",
    title: "Claude Code desktop alternative that runs Codex too | Threadlines",
    description:
      "Claude Code's desktop app is the Code tab in the Claude app. Threadlines is a free, open-source app that runs Claude Code with your sign-in, with Codex and other agents in the same thread.",
    headline: "A Claude Code desktop alternative that runs other agents too",
    summary:
      "Anthropic's own app, inside Claude. Threadlines is open source and puts Claude Code and Codex in one thread.",
    intro:
      "Claude Code's desktop app is the Code tab in the Claude app, with cloud sessions, computer use and auto-fix for pull requests. Threadlines runs the same Claude Code with your sign-in. It's free and open source, and Codex or another agent can work in the same thread.",
    rows: [
      {
        icon: "monitor",
        label: "Platforms",
        threadlines: THREADLINES_DESKTOP,
        other: { mark: "yes", text: "macOS, Windows, Linux beta on Ubuntu and Debian" },
      },
      {
        icon: "dollar",
        label: "Price",
        threadlines: { mark: "yes", text: "Free app, your Claude plan or an API key" },
        other: { mark: "partial", text: "The Code tab needs a paid Claude plan" },
      },
      {
        icon: "code",
        label: "Open source",
        threadlines: { mark: "yes", text: "MIT license" },
        other: { mark: "no", text: "Closed source" },
      },
      {
        icon: "agents",
        label: "Agents",
        threadlines: THREADLINES_AGENTS,
        other: { text: "Claude only" },
      },
      {
        icon: "message",
        label: "Two agents in one chat",
        threadlines: { mark: "yes", text: "Claude Code and Codex together" },
        other: { mark: "no", text: "Claude sessions only" },
      },
      {
        icon: "computers",
        label: "Your other computers",
        threadlines: THREADLINES_COMPUTERS,
        other: { mark: "yes", text: "SSH sessions and Remote Control" },
      },
      {
        icon: "clock",
        label: "Scheduled and event tasks",
        threadlines: THREADLINES_TASKS,
        other: { mark: "yes", text: "Schedules, plus GitHub and API triggers in the cloud" },
      },
      {
        icon: "branch",
        label: "Git worktree per task",
        threadlines: { mark: "yes", text: "Per thread" },
        other: { mark: "yes", text: "Optional per session" },
      },
      {
        icon: "pullRequest",
        label: "Pull requests and CI",
        threadlines: { mark: "yes", text: "Beside the thread, with fix and merge switches" },
        other: { mark: "yes", text: "With auto-fix and merge when ready" },
      },
      {
        icon: "globe",
        label: "Built-in browser",
        threadlines: { mark: "yes", text: "Built in" },
        other: { mark: "yes", text: "Built in, plus computer use" },
      },
      {
        icon: "cloud",
        label: "Cloud agents",
        threadlines: { mark: "no", text: "Agents run on your computers" },
        other: { mark: "yes", text: "Cloud sessions keep going" },
      },
      {
        icon: "phone",
        label: "Phone",
        threadlines: THREADLINES_PHONE,
        other: { mark: "yes", text: "The Claude app, with alerts" },
      },
    ],
    pickThreadlines: [
      "You want Codex to check Claude's work in the same thread.",
      "You want an open-source app.",
      "You run Linux beyond Ubuntu and Debian, like Fedora or Arch.",
      "You also use OpenCode, Cursor, Grok, Pi or another agent.",
    ],
    pickOther: [
      "You want sessions to keep going in the cloud with your computer off.",
      "You want computer use or the iOS Simulator pane.",
      "You use Claude's chat and Cowork in the same app.",
    ],
    faq: [
      {
        question: "Where is Claude Code's desktop app?",
        answer:
          "It's the Code tab in the Claude desktop app, which also holds chat and Cowork. The Code tab needs a Pro, Max, Team or Enterprise plan.",
      },
      {
        question: "Does Threadlines use my Claude plan?",
        answer:
          "Yes. It runs Claude Code with your sign-in, the same way a terminal does. An Anthropic API key works too, and that bills per token.",
      },
      {
        question: "Can I use both?",
        answer:
          "Yes. They're separate apps. Threadlines runs the Claude Code CLI on your computer, so the skills and MCP servers you set up for it come along.",
      },
    ],
    checkedOn: "2026-10-29",
    sources: [
      { label: "Claude Code desktop docs", url: "https://code.claude.com/docs/en/desktop" },
      { label: "desktop quickstart", url: "https://code.claude.com/docs/en/desktop-quickstart" },
      { label: "Linux beta", url: "https://code.claude.com/docs/en/desktop-linux" },
      {
        label: "scheduled tasks",
        url: "https://code.claude.com/docs/en/desktop-scheduled-tasks",
      },
      { label: "routines", url: "https://code.claude.com/docs/en/routines" },
      { label: "Claude pricing", url: "https://claude.com/pricing" },
    ],
  },
  {
    slug: "orca",
    name: "Orca",
    maker: "Stably",
    title: "Orca alternative with several agents in one thread | Threadlines",
    description:
      "Orca and Threadlines are both free, open-source apps for running coding agents in Git worktrees. Here's where they differ, including where Orca is ahead.",
    headline: "An Orca alternative with several agents in one thread",
    summary:
      "A fast-moving open-source app with phone apps and dozens of agents. Threadlines puts several agents in one thread.",
    intro:
      "Orca is a free, MIT-licensed app that runs dozens of coding agents, each in its own Git worktree, with phone apps and remote servers. Threadlines is free and MIT-licensed too. It puts several agents in one thread, and an agent on one of your computers can start a thread on another.",
    rows: [
      {
        icon: "dollar",
        label: "Price and license",
        threadlines: { mark: "yes", text: "Free, MIT" },
        other: { mark: "yes", text: "Free, MIT" },
      },
      {
        icon: "monitor",
        label: "Desktop",
        threadlines: THREADLINES_DESKTOP,
        other: { mark: "yes", text: "macOS, Windows, Linux" },
      },
      {
        icon: "phone",
        label: "Phone",
        threadlines: THREADLINES_PHONE,
        other: { mark: "yes", text: "iPhone and Android apps in beta, with alerts" },
      },
      {
        icon: "agents",
        label: "Agents",
        threadlines: THREADLINES_AGENTS,
        other: { text: "About 40 agents, plus any CLI agent" },
      },
      {
        icon: "message",
        label: "Several agents in one thread",
        threadlines: { mark: "yes", text: "One can review the other's work" },
        other: { mark: "no", text: "Each chat runs one agent" },
      },
      {
        icon: "computers",
        label: "Your other computers",
        threadlines: THREADLINES_COMPUTERS,
        other: { mark: "yes", text: "SSH, and remote servers in beta" },
      },
      {
        icon: "clock",
        label: "Scheduled and event tasks",
        threadlines: THREADLINES_TASKS,
        other: { mark: "partial", text: "Schedules" },
      },
      {
        icon: "terminal",
        label: "Agents in your terminal",
        threadlines: THREADLINES_TERMINAL_AGENTS,
        other: { mark: "yes", text: "An orca command and skills" },
      },
      {
        icon: "branch",
        label: "Git worktree per task",
        threadlines: { mark: "yes", text: "Per thread" },
        other: { mark: "yes", text: "Per task" },
      },
      {
        icon: "pullRequest",
        label: "Pull requests and CI",
        threadlines: { mark: "yes", text: "Beside the thread, with fix and merge switches" },
        other: { mark: "yes", text: "Fix broken checks, auto-merge, stacked PRs" },
      },
      {
        icon: "globe",
        label: "Built-in browser",
        threadlines: { mark: "yes", text: "Built in" },
        other: { mark: "yes", text: "Built in, plus Design Mode" },
      },
      {
        icon: "cloud",
        label: "Cloud agents",
        threadlines: { mark: "no", text: "Agents run on your computers" },
        other: { mark: "partial", text: "Experimental VMs on your own cloud account" },
      },
    ],
    pickThreadlines: [
      "You want two agents in the same thread.",
      "You want Codex to check Claude's work without leaving the chat.",
      "You want tasks that start from a GitHub issue or a webhook.",
    ],
    pickOther: [
      "You use one of the many agents only Orca runs.",
      "You want an Android app.",
      "You want stacked pull requests or Design Mode.",
    ],
    faq: [
      {
        question: "Is Orca open source?",
        answer: "Yes. Orca is MIT-licensed, like Threadlines, and both are free.",
      },
      {
        question: "Can I use both?",
        answer:
          "Yes. They're separate apps, and both run the agent CLIs already on your computer with your own sign-ins.",
      },
    ],
    checkedOn: "2026-10-29",
    sources: [
      { label: "Orca's README", url: "https://github.com/stablyai/orca" },
      { label: "supported agents", url: "https://www.onorca.dev/docs/agents/supported" },
      { label: "chat docs", url: "https://www.onorca.dev/docs/agents/native-chat" },
      { label: "mobile", url: "https://www.onorca.dev/docs/mobile" },
      { label: "remote servers", url: "https://www.onorca.dev/docs/remote-servers" },
      { label: "automations", url: "https://www.onorca.dev/docs/cli/automations" },
      { label: "GitHub review", url: "https://www.onorca.dev/docs/review/github" },
      { label: "ways to run", url: "https://www.onorca.dev/docs/ways-to-run" },
    ],
  },
  {
    slug: "paradev",
    name: "Paradev",
    maker: "Paradev, formerly Superset",
    title: "Paradev (Superset) alternative for Windows and Linux | Threadlines",
    description:
      "Paradev, formerly Superset, supports macOS, with Linux experimental and Windows planned. Threadlines is a free, open-source app for Mac, Windows and Linux that puts several coding agents in one thread.",
    headline: "A Paradev (Superset) alternative for Windows and Linux",
    summary:
      "Formerly Superset. A Mac app with paid plans. Threadlines also runs on Windows and Linux, and it's MIT-licensed.",
    intro:
      "Paradev, called Superset until October, runs coding agents side by side on the Mac, with automations, cloud workspaces and team plans. Threadlines runs agents side by side on Mac, Windows and Linux. It's free and MIT-licensed, and it puts several agents in one thread.",
    rows: [
      {
        icon: "monitor",
        label: "Platforms",
        threadlines: THREADLINES_DESKTOP,
        other: { mark: "partial", text: "macOS, Linux experimental, Windows planned" },
      },
      {
        icon: "dollar",
        label: "Price",
        threadlines: { mark: "yes", text: "Free" },
        other: { mark: "partial", text: "Free, Pro is $20 a month" },
      },
      {
        icon: "code",
        label: "License",
        threadlines: { mark: "yes", text: "MIT" },
        other: { mark: "partial", text: "Source-available, Elastic License 2.0" },
      },
      {
        icon: "agents",
        label: "Agents",
        threadlines: THREADLINES_AGENTS,
        other: {
          text: "Claude, Codex, Gemini, Copilot and more, plus any CLI agent",
        },
      },
      {
        icon: "message",
        label: "Several agents in one thread",
        threadlines: { mark: "yes", text: "One can review the other's work" },
        other: { mark: "no", text: "One agent per session" },
      },
      {
        icon: "computers",
        label: "Your other computers",
        threadlines: THREADLINES_COMPUTERS,
        other: { mark: "partial", text: "Remote Access on Pro" },
      },
      {
        icon: "clock",
        label: "Scheduled and event tasks",
        threadlines: THREADLINES_TASKS,
        other: { mark: "yes", text: "Schedules, GitHub, Slack, Linear and more, on Pro" },
      },
      {
        icon: "terminal",
        label: "Agents in your terminal",
        threadlines: THREADLINES_TERMINAL_AGENTS,
        other: { mark: "yes", text: "A CLI, an SDK and an MCP server" },
      },
      {
        icon: "branch",
        label: "Git worktree per task",
        threadlines: { mark: "yes", text: "Per thread" },
        other: { mark: "yes", text: "Per workspace" },
      },
      {
        icon: "pullRequest",
        label: "Pull requests and CI",
        threadlines: { mark: "yes", text: "Beside the thread" },
        other: { mark: "yes", text: "Every check, and merge" },
      },
      {
        icon: "globe",
        label: "Built-in browser",
        threadlines: { mark: "yes", text: "Built in" },
        other: { mark: "yes", text: "Built in, plus Design Mode" },
      },
      {
        icon: "cloud",
        label: "Cloud agents",
        threadlines: { mark: "no", text: "Agents run on your computers" },
        other: { mark: "partial", text: "Early access on Team" },
      },
      {
        icon: "phone",
        label: "Phone",
        threadlines: THREADLINES_PHONE,
        other: { mark: "partial", text: "iPhone and iPad app on Pro, alerts coming" },
      },
    ],
    pickThreadlines: [
      "You work on Windows or Linux.",
      "You want an MIT-licensed app with no paid tier.",
      "You want two agents in the same thread.",
      "You want phone alerts today.",
    ],
    pickOther: [
      "You want automations that start from Slack, Linear or Sentry.",
      "Your team wants hosted cloud workspaces and organization features.",
      "You want a native iPad app.",
    ],
    faq: [
      {
        question: "Is Paradev the same as Superset?",
        answer:
          "Yes. Superset renamed itself Paradev in October 2026, and its command-line tool is still called superset.",
      },
      {
        question: "Is Paradev open source?",
        answer:
          "Its code is public under the Elastic License 2.0, which isn't an OSI-approved open-source license. Threadlines is MIT-licensed.",
      },
      {
        question: "Does Paradev run on Windows?",
        answer:
          "Not yet. Its FAQ lists Windows as planned with no date, and Linux as experimental. Threadlines has a Windows installer and a Linux AppImage today.",
      },
    ],
    checkedOn: "2026-10-29",
    sources: [
      { label: "Paradev's FAQ", url: "https://docs.paradev.com/faq" },
      { label: "pricing", url: "https://paradev.com/pricing" },
      { label: "GitHub repository", url: "https://github.com/ParadevAI/Paradev" },
      { label: "agent sessions", url: "https://docs.paradev.com/agent-sessions" },
      { label: "automations", url: "https://docs.paradev.com/automations" },
      { label: "remote access", url: "https://docs.paradev.com/remote-access" },
      { label: "MCP server", url: "https://docs.paradev.com/mcp-server" },
      { label: "cloud workspaces", url: "https://docs.paradev.com/cloud-workspaces" },
    ],
  },
  {
    slug: "emdash",
    name: "Emdash",
    maker: "General Action",
    title: "Emdash alternative with several agents in one thread | Threadlines",
    description:
      "Emdash and Threadlines are both free, open-source desktop apps for running coding agents on Mac, Windows and Linux. Here's where they differ.",
    headline: "An Emdash alternative with several agents in one thread",
    summary:
      "A free, open-source app that starts tasks from your issue tracker. Threadlines puts several agents in one thread.",
    intro:
      "Emdash is a free, Apache-licensed app that runs dozens of coding agents, each task in its own Git worktree, and starts tasks from Linear, Jira or GitHub issues. Threadlines is free and MIT-licensed. It puts several agents in one thread, and an agent on one of your computers can start a thread on another.",
    rows: [
      {
        icon: "dollar",
        label: "Price and license",
        threadlines: { mark: "yes", text: "Free, MIT" },
        other: { mark: "yes", text: "Free, Apache 2.0" },
      },
      {
        icon: "monitor",
        label: "Desktop",
        threadlines: THREADLINES_DESKTOP,
        other: { mark: "yes", text: "macOS, Windows, Linux" },
      },
      {
        icon: "agents",
        label: "Agents",
        threadlines: THREADLINES_AGENTS,
        other: { text: "35 agent CLIs" },
      },
      {
        icon: "message",
        label: "Several agents in one thread",
        threadlines: { mark: "yes", text: "One can review the other's work" },
        other: { mark: "partial", text: "Several chats per task, one agent each" },
      },
      {
        icon: "computers",
        label: "Your other computers",
        threadlines: THREADLINES_COMPUTERS,
        other: { mark: "yes", text: "Over SSH, with a server on the other machine" },
      },
      {
        icon: "clock",
        label: "Scheduled and event tasks",
        threadlines: THREADLINES_TASKS,
        other: { mark: "partial", text: "Schedules, and tasks from issue trackers" },
      },
      {
        icon: "branch",
        label: "Git worktree per task",
        threadlines: { mark: "yes", text: "Per thread" },
        other: { mark: "yes", text: "Per task, on by default" },
      },
      {
        icon: "pullRequest",
        label: "Pull requests and CI",
        threadlines: { mark: "yes", text: "Beside the thread" },
        other: { mark: "yes", text: "A checks tab for GitHub Actions" },
      },
      {
        icon: "globe",
        label: "Built-in browser",
        threadlines: { mark: "yes", text: "Built in" },
        other: { mark: "yes", text: "Built in, with remote ports" },
      },
      {
        icon: "account",
        label: "Accounts",
        threadlines: { mark: "yes", text: "None needed" },
        other: { mark: "yes", text: "None needed" },
      },
    ],
    pickThreadlines: [
      "You want two agents in the same thread.",
      "You want Codex to check Claude's work without leaving the chat.",
      "You want tasks that start from a webhook.",
    ],
    pickOther: [
      "You start most work from Linear, Jira or Asana issues.",
      "You want schedules that keep running on a remote machine with the app closed.",
      "You use one of the agents only Emdash runs.",
    ],
    faq: [
      {
        question: "Is Emdash open source?",
        answer:
          "Yes. Emdash is Apache 2.0 and Threadlines is MIT. Both are free and need no account.",
      },
      {
        question: "Can I use both?",
        answer:
          "Yes. They're separate apps, and both run the agent CLIs already on your computer with your own sign-ins.",
      },
    ],
    checkedOn: "2026-10-29",
    sources: [
      { label: "Emdash's README", url: "https://github.com/generalaction/emdash" },
      { label: "installation", url: "https://emdash.com/docs/installation" },
      { label: "tasks", url: "https://emdash.com/docs/tasks" },
      { label: "providers", url: "https://emdash.com/docs/providers" },
      { label: "remote development", url: "https://emdash.com/docs/remote-development" },
      { label: "automations", url: "https://emdash.com/docs/automations" },
      { label: "CI checks", url: "https://emdash.com/docs/ci-checks" },
    ],
  },
];
