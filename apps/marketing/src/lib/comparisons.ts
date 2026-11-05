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

/**
 * News about the other app that changes whether people can keep using it (an acquisition, a
 * shutdown), told in its maker's own dates and linked to its own announcement.
 */
export interface ComparisonStatus {
  heading: string;
  /** Two or three plain sentences. */
  text: string;
  /** Short date labels, like "Nov 13" or "Early 2027", with what happens then. */
  timeline: { date: string; text: string }[];
  /** A few words for the /compare grid, like "Joining Meta". */
  label: string;
  announcement: { label: string; url: string };
}

/**
 * How to move from the other app, every step checked against both apps. Step and list text may
 * wrap code (a file name, a variable) in backticks; the page sets it in mono.
 */
export interface ComparisonSwitching {
  heading: string;
  steps: { title: string; text: string }[];
  leftBehindHeading: string;
  leftBehind: string[];
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
  status?: ComparisonStatus;
  rows: ComparisonRow[];
  pickThreadlines: string[];
  pickOther: string[];
  switching?: ComparisonSwitching;
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
  text: "Yes, where the project is set up",
};

const THREADLINES_TASKS: ComparisonCell = {
  mark: "yes",
  text: "Schedules, GitHub issues, webhooks",
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
    maker: "Meta",
    title: "Conductor app alternative for Claude Code and Codex | Threadlines",
    description:
      "Conductor is joining Meta and stopped new sign-ups. Threadlines is a free, open-source app for Mac, Windows and Linux that runs Claude Code, Codex and more.",
    headline: "A free, open-source Conductor alternative",
    summary:
      "A Mac app that's joining Meta and closed to new users. Threadlines is free, open source, and runs on Mac, Windows and Linux.",
    intro:
      "Conductor (conductor.build) is a polished Mac app for running coding agents side by side, each in its own Git worktree, and it's joining Meta. Threadlines works the same way, on Mac, Windows and Linux, and two agents can share one thread. It's free and MIT-licensed, so the code stays public whatever happens to the project.",
    status: {
      heading: "Conductor is joining Meta",
      text: "On November 4, 2026, Conductor announced it's joining Meta and stopped new sign-ups and downloads. If you already use it, the Mac app keeps working for now, and Pro users keep Pro features for free.",
      timeline: [
        {
          date: "Nov 4",
          text: "No new sign-ups or downloads. Pro users keep Pro features for free.",
        },
        {
          date: "Nov 13",
          text: "Conductor Cloud goes read-only. Active subscribers get a refund.",
        },
        {
          date: "Nov 20",
          text: "Conductor Cloud shuts down, and Conductor starts deleting its data.",
        },
        {
          date: "Early 2027",
          text: "New models and critical fixes for the Mac app end, and it starts winding down.",
        },
      ],
      label: "Joining Meta",
      announcement: {
        label: "Read Conductor's announcement",
        url: "https://www.conductor.build/announcement",
      },
    },
    rows: [
      {
        icon: "download",
        label: "Availability",
        threadlines: { mark: "yes", text: "Free download" },
        other: { mark: "partial", text: "Existing users only, since Nov 4" },
      },
      {
        icon: "monitor",
        label: "Platforms",
        threadlines: THREADLINES_DESKTOP,
        other: { mark: "partial", text: "macOS only" },
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
          text: "Claude Code, Codex, OpenCode, Cursor, Pi. Local Cursor runs need a Cursor API key.",
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
        other: { mark: "no", text: "Its own cloud machines, until Nov 13" },
      },
      {
        icon: "clock",
        label: "Scheduled and event tasks",
        threadlines: THREADLINES_TASKS,
        other: { mark: "partial", text: "Routines in the cloud, until Nov 13" },
      },
      {
        icon: "terminal",
        label: "Agents in your terminal",
        threadlines: THREADLINES_TERMINAL_AGENTS,
        other: { mark: "partial", text: "MCP and a CLI for cloud work, until Nov 13" },
      },
      {
        icon: "branch",
        label: "Git worktree per task",
        threadlines: { mark: "yes", text: "Per thread" },
        other: { mark: "yes", text: "Per workspace" },
      },
      {
        icon: "sliders",
        label: "Setup scripts",
        threadlines: { mark: "yes", text: "Per project, in each new worktree" },
        other: { mark: "yes", text: "Shared in a repo file, plus files to copy" },
      },
      {
        icon: "pullRequest",
        label: "Pull requests and CI",
        threadlines: { mark: "yes", text: "Beside the thread, with fix and merge switches" },
        other: { mark: "yes", text: "Plus GitHub stacks and Graphite" },
      },
      {
        icon: "eye",
        label: "Review in the diff",
        threadlines: { mark: "partial", text: "Comment on pull requests, hand fixes to agents" },
        other: { mark: "yes", text: "Edit and comment right in the diff" },
      },
      {
        icon: "target",
        label: "Start from an issue",
        threadlines: { mark: "partial", text: "GitHub issue events start tasks" },
        other: { mark: "yes", text: "GitHub and Linear issues" },
      },
      {
        icon: "globe",
        label: "Built-in browser",
        threadlines: { mark: "yes", text: "Built in" },
        other: { mark: "yes", text: "Built-in previews" },
      },
      {
        icon: "cloud",
        label: "Cloud agents",
        threadlines: { mark: "no", text: "Agents run on your computers" },
        other: { mark: "partial", text: "Read-only Nov 13, closes Nov 20" },
      },
      {
        icon: "accounts",
        label: "Teams",
        threadlines: { mark: "no", text: "Made for one person" },
        other: { mark: "partial", text: "Shared cloud workspaces, until Nov 13" },
      },
      {
        icon: "phone",
        label: "Phone",
        threadlines: THREADLINES_PHONE,
        other: { mark: "yes", text: "iPhone app that controls your Mac" },
      },
    ],
    pickThreadlines: [
      "You want an app that's free and open source.",
      "You want Codex to check Claude's work in the same thread.",
      "You work on Windows or Linux, or move between computers.",
      "You want your own Windows PC or Linux box to share the work.",
      "You use Antigravity or fx.",
    ],
    pickOther: [
      "You already use it, and the Mac app keeps working into early 2027.",
      "You use GitHub stacks or Graphite.",
      "You start work from Linear issues.",
      "You like editing code right in the diff.",
    ],
    switching: {
      heading: "Coming from Conductor",
      steps: [
        {
          title: "Bring cloud workspaces to your Mac",
          text: "In Conductor, right-click a cloud workspace and choose Transfer to local before November 20. Settings › Account › Export data saves an archive of the rest.",
        },
        {
          title: "Add your repo",
          text: "Each Conductor workspace is a Git worktree on its own branch, so there's nothing to convert. In Threadlines, click Add project at the top of the sidebar and pick your repo's main folder.",
        },
        {
          title: "Pick up a workspace",
          text: "If the line under the message box says a new worktree, switch it to Current checkout. Then click the branch name and choose the workspace's branch, marked worktree. The thread works in the worktree Conductor already made.",
        },
        {
          title: "Move your setup script",
          text: "Click Add action in the top bar, paste the command and turn on Run automatically on worktree creation. Use `$THREADLINES_PROJECT_ROOT` where your local script used `$CONDUCTOR_ROOT_PATH`, and copy `.env` files in the script.",
        },
        {
          title: "Sign in with the same accounts",
          text: "Conductor ran its own copies of Claude Code and Codex. In Settings › Providers, install them if they're missing, then sign in with your Claude or ChatGPT account. If they're already signed in on this computer, Threadlines uses that.",
        },
      ],
      leftBehindHeading: "What stays in Conductor",
      leftBehind: [
        "Chats and their history. Export data in Conductor keeps a copy.",
        "Workspaces as Conductor lists them. Their worktrees and branches stay in your repo.",
        "Linear links, Graphite stacks and team sharing, which Threadlines doesn't have.",
      ],
    },
    faq: [
      {
        question: "Is Conductor shutting down?",
        answer:
          "Partly. On November 4, 2026, Conductor announced it's joining Meta and stopped new sign-ups. Conductor Cloud goes read-only on November 13 and shuts down on November 20. The Mac app keeps getting new models and critical fixes until early 2027, then starts winding down.",
      },
      {
        question: "Can I still download Conductor?",
        answer:
          "Not as a new user. Since November 4, new users can't sign up for Conductor or download it. If you already have it, it keeps working, and Pro users keep Pro features for free.",
      },
      {
        question: "Will my Conductor workspaces open in Threadlines?",
        answer:
          "Their code will. Each workspace is a Git worktree and branch in your repo, and a Threadlines thread set to Current checkout can work in it when you pick its branch under the message box. Chats stay in Conductor.",
      },
      {
        question: "Does Threadlines use my Claude and ChatGPT plans, like Conductor?",
        answer:
          "Yes. Both apps run the agents with your own sign-ins, and neither resells model usage.",
      },
      {
        question: "Does Threadlines run on Windows and Linux?",
        answer:
          "Yes. Threadlines has a Mac app, a Windows installer and a Linux AppImage. Conductor runs only on macOS.",
      },
      {
        question: "Does Threadlines have cloud workspaces?",
        answer:
          "No. Threadlines runs agents on your own computer. You can reach it from your phone or another computer, but the work happens on your machine.",
      },
    ],
    checkedOn: "2026-11-04",
    sources: [
      { label: "Conductor's announcement", url: "https://www.conductor.build/announcement" },
      {
        label: "0.93.0 release notes",
        url: "https://www.conductor.build/changelog/0.93.0-conductor-is-joining-meta",
      },
      {
        label: "TechCrunch's report",
        url: "https://techcrunch.com/2026/11/04/meta-acquires-ai-coding-startup-conductor/",
      },
      { label: "install guide", url: "https://www.conductor.build/docs/installation" },
      { label: "docs", url: "https://www.conductor.build/llms-full.txt" },
      { label: "changelog", url: "https://www.conductor.build/changelog" },
    ],
  },
  {
    slug: "jules",
    name: "Jules",
    maker: "Google",
    title: "Jules alternative with Gemini, Claude Code and Codex | Threadlines",
    description:
      "Google's Jules winds down on December 31, 2026. Threadlines is a free, open-source app that runs Antigravity's Gemini agent, Claude Code and Codex on your computer.",
    headline: "A Jules alternative that runs on your computer",
    summary:
      "Google's cloud coding agent, winding down Dec 31. Threadlines runs Gemini, Claude Code and Codex on your own computers.",
    intro:
      "Jules is Google's coding agent that works on your GitHub repos in its own cloud machines, and Google is winding it down. Threadlines runs agents on your own computer instead. That includes Antigravity's agent with Gemini models, next to Claude Code and Codex, and the app is free and MIT-licensed.",
    status: {
      heading: "Jules is winding down",
      text: "On October 29, 2026, Google said it's winding down Jules as part of its work to unify its agentic coding efforts. Google says what it learned from Jules is shaping products including Google Antigravity.",
      timeline: [
        { date: "Nov 11", text: "Last day to finish sessions. Jules is read-only after that." },
        { date: "Dec 31", text: "Jules winds down." },
      ],
      label: "Winding down Dec 31",
      announcement: {
        label: "Read Google's notice",
        url: "https://jules.google/docs/changelog/2026-10-29/",
      },
    },
    rows: [
      {
        icon: "download",
        label: "Availability",
        threadlines: { mark: "yes", text: "Free download" },
        other: { mark: "partial", text: "Read-only after Nov 11, ends Dec 31" },
      },
      {
        icon: "cloud",
        label: "Cloud agents",
        threadlines: { mark: "no", text: "Agents run on your computers" },
        other: { mark: "yes", text: "Each task in a fresh cloud machine" },
      },
      {
        icon: "monitor",
        label: "Platforms",
        threadlines: THREADLINES_DESKTOP,
        other: { mark: "yes", text: "A web app, plus a CLI" },
      },
      {
        icon: "dollar",
        label: "Price",
        threadlines: { mark: "yes", text: "Free app, your own plans" },
        other: { mark: "yes", text: "Free tier, more with Google AI Pro or Ultra" },
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
        other: { text: "Jules, on Gemini models" },
      },
      {
        icon: "message",
        label: "Two agents in one chat",
        threadlines: { mark: "yes", text: "One can review the other's work" },
        other: { mark: "partial", text: "Jules, checked by its own critic" },
      },
      {
        icon: "folder",
        label: "Repos",
        threadlines: { mark: "yes", text: "Any Git repo on your computer" },
        other: { mark: "partial", text: "GitHub repos" },
      },
      {
        icon: "sliders",
        label: "Setup scripts",
        threadlines: { mark: "yes", text: "Per project, in each new worktree" },
        other: { mark: "yes", text: "Per repo, in each cloud machine" },
      },
      {
        icon: "clock",
        label: "Scheduled and event tasks",
        threadlines: THREADLINES_TASKS,
        other: { mark: "yes", text: "Schedules, plus tasks from labeled GitHub issues" },
      },
      {
        icon: "pullRequest",
        label: "Pull requests and CI",
        threadlines: { mark: "yes", text: "Beside the thread, with fix and merge switches" },
        other: { mark: "yes", text: "Opens pull requests and fixes failing CI" },
      },
    ],
    pickThreadlines: [
      "You want agents to work on your own computer, with your own tools.",
      "You want Gemini, Claude Code and Codex in one app.",
      "You want two agents in the same thread.",
      "Your code isn't on GitHub.",
    ],
    pickOther: [
      "You're wrapping up sessions already in Jules, before it turns read-only on November 11.",
      "You need a task to keep running in the cloud with your laptop closed, before November 11.",
    ],
    switching: {
      heading: "Coming from Jules",
      steps: [
        {
          title: "Export what's in Jules",
          text: "Google's notice has an export that saves setup scripts, environment variables, scheduled tasks, memories and every session to a folder on your computer.",
        },
        {
          title: "Clone your repo and add it",
          text: "Your code, branches and pull requests are on GitHub already. Clone the repo, then click Add project at the top of the Threadlines sidebar and pick its folder.",
        },
        {
          title: "Move your setup script",
          text: "Click Add action in the top bar, paste the script and turn on Run automatically on worktree creation. Put exported environment variables where your project reads them, like a `.env` file the script copies in.",
        },
        {
          title: "Recreate scheduled tasks",
          text: "Open Scheduled and add each task with its prompt and timing. Tasks run while Threadlines is running on that computer.",
        },
        {
          title: "Pick an agent",
          text: "Install Antigravity from Settings › Providers to keep using Gemini models, or use Claude Code, Codex or another agent.",
        },
      ],
      leftBehindHeading: "What stays in Jules",
      leftBehind: [
        "Sessions, with their plans and logs. The export keeps a copy.",
        "Memories. Put what matters in `AGENTS.md` or `CLAUDE.md`, under Settings › Agent Instructions.",
        "Cloud machines. Agents in Threadlines work on your computer.",
      ],
    },
    faq: [
      {
        question: "When does Jules shut down?",
        answer:
          "Google says you can finish sessions until November 11, 2026. After that Jules is read-only, and it winds down on December 31, 2026.",
      },
      {
        question: "How do I export my Jules data?",
        answer:
          "Install Jules Tools, sign in, and paste the export prompt from Google's notice into a command-line agent like Claude Code. Your code, branches and pull requests are already on GitHub.",
      },
      {
        question: "Can Threadlines run Gemini models?",
        answer:
          "Yes. Threadlines installs Google Antigravity's agent from Settings › Providers. You sign in with a Google account, Gemini Enterprise, an API key or Vertex AI.",
      },
      {
        question: "Does Threadlines work while my computer is off?",
        answer:
          "No. Agents run on your own computers, so the computer has to be on with Threadlines running. A scheduled task missed in the last 7 days gets one catch-up run when it's back.",
      },
    ],
    checkedOn: "2026-11-04",
    sources: [
      { label: "Google's notice", url: "https://jules.google/docs/changelog/2026-10-29/" },
      { label: "Jules FAQ", url: "https://jules.google/docs/faq/" },
      { label: "limits and plans", url: "https://jules.google/docs/usage-limits/" },
      { label: "scheduled tasks", url: "https://jules.google/docs/scheduled-tasks/" },
      {
        label: "GitHub issues",
        url: "https://jules.google/docs/changelog/2025-06-26/",
      },
      { label: "CI fixes", url: "https://jules.google/docs/changelog/2026-02-19/" },
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
  {
    slug: "monocode",
    name: "MonoCode",
    maker: "hardbeat920",
    title: "MonoCode alternative with several agents in one thread | Threadlines",
    description:
      "MonoCode and Threadlines are both free, MIT-licensed apps for running coding agents on Mac, Windows and Linux. Here's where they differ, including where MonoCode is ahead.",
    headline: "A MonoCode alternative with several agents in one thread",
    summary:
      "A fast-moving MIT app with eleven agents and an inbox for automations. Threadlines puts several agents in one thread.",
    intro:
      "MonoCode is a free, MIT-licensed app that runs eleven coding agents in tabs and split panes, with an inbox for pull requests and issues. Threadlines is free and MIT-licensed too. It puts several agents in one thread, and an agent on one of your computers can start a thread on another.",
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
        other: { mark: "partial", text: "iPhone app in beta" },
      },
      {
        icon: "agents",
        label: "Agents",
        threadlines: THREADLINES_AGENTS,
        other: { text: "Eleven, including Hermes Agent and Devin" },
      },
      {
        icon: "message",
        label: "Two agents in a thread at once",
        threadlines: { mark: "yes", text: "One can review the other's work" },
        other: { mark: "no", text: "One at a time, by handoff" },
      },
      {
        icon: "computers",
        label: "Your other computers",
        threadlines: THREADLINES_COMPUTERS,
        other: { mark: "partial", text: "SSH hosts, experimental" },
      },
      {
        icon: "clock",
        label: "Scheduled and event tasks",
        threadlines: THREADLINES_TASKS,
        other: { mark: "yes", text: "Schedules, plus GitHub, GitLab and Linear events" },
      },
      {
        icon: "terminal",
        label: "Agents in your terminal",
        threadlines: THREADLINES_TERMINAL_AGENTS,
        other: { mark: "partial", text: "Only agents inside MonoCode" },
      },
      {
        icon: "branch",
        label: "Git worktree per task",
        threadlines: { mark: "yes", text: "Per thread" },
        other: { mark: "yes", text: "For parallel tasks" },
      },
      {
        icon: "pullRequest",
        label: "Pull requests and CI",
        threadlines: { mark: "yes", text: "Beside the thread" },
        other: { mark: "yes", text: "An inbox with checks, fixes and merge" },
      },
    ],
    pickThreadlines: [
      "You want two agents working in the same thread at once.",
      "You want Claude Code or Codex in your terminal to start threads in the app.",
    ],
    pickOther: [
      "You use Hermes Agent, omp or Devin.",
      "You want a lead agent that hands work to agents from other providers.",
      "You start work from GitLab, Jira or Azure DevOps issues.",
    ],
    faq: [
      {
        question: "Is MonoCode open source?",
        answer:
          "Yes. MonoCode is MIT-licensed, like Threadlines. Both are free and use the agent sign-ins you already have.",
      },
      {
        question: "Does MonoCode run on Windows?",
        answer: "Yes. MonoCode has a Windows installer, plus builds for Mac and Linux.",
      },
      {
        question: "Can I use both?",
        answer:
          "Yes. They're separate apps, and both run the agent CLIs already on your computer with your own sign-ins.",
      },
    ],
    checkedOn: "2026-10-29",
    sources: [
      { label: "MonoCode's README", url: "https://github.com/hardbeat920/monocode" },
      {
        label: "changelog",
        url: "https://github.com/hardbeat920/monocode/blob/main/CHANGELOG.md",
      },
      {
        label: "remote access",
        url: "https://github.com/hardbeat920/monocode/blob/main/docs/remote-access.md",
      },
      {
        label: "agent access",
        url: "https://github.com/hardbeat920/monocode/blob/main/docs/agent-access.md",
      },
      {
        label: "iPhone app",
        url: "https://github.com/hardbeat920/monocode/blob/main/mobile/README.md",
      },
    ],
  },
  {
    slug: "synara",
    name: "Synara",
    maker: "Emanuele-web04",
    title: "Synara alternative with several agents in one thread | Threadlines",
    description:
      "Synara and Threadlines are both free, MIT-licensed apps that grew from T3 Code. Here's where they differ, including where Synara is ahead.",
    headline: "A Synara alternative with several agents in one thread",
    summary:
      "Another app that grew from T3 Code, with hubs and a shared browser. Threadlines puts several agents in one thread.",
    intro:
      "Synara began as a clone of T3 Code in March, and Threadlines grew from T3 Code too. Both are free and MIT-licensed. Synara adds hubs, where a coordinator runs workers on different agents, and a browser it shares with the agent. Threadlines lets two agents work in one thread at the same time.",
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
        other: { mark: "yes", text: "Web client, iPhone app in early access" },
      },
      {
        icon: "agents",
        label: "Agents",
        threadlines: THREADLINES_AGENTS,
        other: { text: "Ten, including Devin and Factory Droid" },
      },
      {
        icon: "message",
        label: "Two agents in a thread at once",
        threadlines: { mark: "yes", text: "One can review the other's work" },
        other: { mark: "no", text: "One at a time, by handoff" },
      },
      {
        icon: "computers",
        label: "Your other computers",
        threadlines: THREADLINES_COMPUTERS,
        other: { mark: "yes", text: "Headless server, Remote in early access" },
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
        other: { mark: "yes", text: "An MCP server for Codex or Claude Code" },
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
        threadlines: { mark: "yes", text: "Beside the thread" },
        other: { mark: "yes", text: "Stacked PRs and auto-fix for CI" },
      },
      {
        icon: "globe",
        label: "Built-in browser",
        threadlines: { mark: "yes", text: "Built in" },
        other: { mark: "yes", text: "Shared with the agent, computer use on macOS" },
      },
    ],
    pickThreadlines: [
      "You want two agents working in the same thread at once.",
      "You want phone alerts without signing in to anything.",
    ],
    pickOther: [
      "You want hubs, where a coordinator runs workers on different agents.",
      "You want the iOS Simulator, or computer use on macOS, beside the chat.",
      "You want a built-in code editor with a JavaScript debugger.",
    ],
    faq: [
      {
        question: "Is Synara a fork of T3 Code?",
        answer:
          "Its changelog says it started as a clone of T3 Code in March 2026. Threadlines also grew from T3 Code, and all three are MIT-licensed.",
      },
      {
        question: "Can I use both?",
        answer:
          "Yes. They're separate apps, and both run the agent CLIs already on your computer with your own sign-ins.",
      },
    ],
    checkedOn: "2026-10-29",
    sources: [
      { label: "Synara's README", url: "https://github.com/Emanuele-web04/synara" },
      { label: "website", url: "https://trysynara.com" },
      { label: "handoffs", url: "https://trysynara.com/docs/workflows/handoffs" },
      { label: "hubs", url: "https://trysynara.com/docs/features/hubs" },
      { label: "pull requests", url: "https://trysynara.com/docs/workflows/pull-requests" },
      {
        label: "browser verification",
        url: "https://trysynara.com/docs/workflows/browser-verification",
      },
      { label: "automations", url: "https://trysynara.com/docs/workflows/automations" },
      { label: "external MCP", url: "https://trysynara.com/docs/workflows/external-mcp" },
      { label: "headless server", url: "https://trysynara.com/docs/workflows/headless-server" },
      { label: "computer use", url: "https://trysynara.com/docs/features/computer-use" },
      { label: "releases", url: "https://github.com/Emanuele-web04/synara/releases" },
      {
        label: "changelog",
        url: "https://github.com/Emanuele-web04/synara/blob/main/CHANGELOG.md",
      },
    ],
  },
];
