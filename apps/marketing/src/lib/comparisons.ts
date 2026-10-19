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
  text: "Codex, Claude Code, OpenCode, Cursor, Antigravity, fx. Grok, Muse Code and Pi in 0.7.0.",
};

const THREADLINES_DESKTOP: ComparisonCell = { mark: "yes", text: "macOS, Windows, Linux" };

const THREADLINES_PHONE: ComparisonCell = {
  mark: "partial",
  text: "Pair your phone and use its browser",
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
        other: { mark: "yes", text: "iPhone app on Pro" },
      },
      {
        icon: "account",
        label: "Accounts",
        threadlines: { mark: "yes", text: "None needed, GitHub optional" },
        other: { mark: "partial", text: "Conductor sign-in, GitHub required" },
      },
    ],
    pickThreadlines: [
      "You work on Windows or Linux.",
      "You want open source with no paid tier.",
      "You want Codex to check Claude's work in the same chat.",
      "You use Antigravity or fx.",
    ],
    pickOther: [
      "You want agents to keep working in the cloud.",
      "Your team shares chats live or needs SSO.",
      "You use GitHub stacks or Graphite.",
      "You want scheduled or pull-request-triggered runs.",
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
    checkedOn: "2026-10-18",
    sources: [
      { label: "Conductor's install guide", url: "https://www.conductor.build/docs/installation" },
      { label: "pricing page", url: "https://www.conductor.build/pricing" },
      { label: "docs and terms", url: "https://www.conductor.build/llms-full.txt" },
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
        other: { mark: "yes", text: "iPhone and Android apps" },
      },
      {
        icon: "agents",
        label: "Agents",
        threadlines: THREADLINES_AGENTS,
        other: {
          text: "Codex, Claude Code, OpenCode, Cursor, Antigravity, Grok, Pi, and Muse Code in beta.",
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
        icon: "refresh",
        label: "Switch agents mid-thread",
        threadlines: { mark: "yes", text: "With a recap and your working tree" },
        other: { mark: "yes", text: "With a selection of past messages" },
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
      "You use fx.",
    ],
    pickOther: [
      "You want native phone apps or a hosted web app.",
      "Your code lives on Forgejo or Gitea.",
      "You want pooled limits, scheduled tasks or webhooks.",
      "You'd rather use the bigger project, with about 28,000 stars.",
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
    checkedOn: "2026-10-18",
    sources: [
      { label: "T3 Code's README", url: "https://github.com/pingdotgg/t3code" },
      {
        label: "v0.1.0 release notes",
        url: "https://github.com/pingdotgg/t3code/releases/tag/v0.1.0",
      },
      { label: "user docs", url: "https://github.com/pingdotgg/t3code/tree/main/docs/user" },
    ],
  },
];
