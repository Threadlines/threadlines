import { compareVersions } from "./changelog";
import type { IconName } from "./icons";

/**
 * The coding agents Threadlines runs, in the order the homepage shows them. Each one gets a
 * page at /agents/<slug>, a link in the homepage's agent row and a sitemap entry. Every claim
 * here has to hold for the stable app: mark anything newer with `since`, and update an entry
 * when its driver changes. Keep feature and step text to one short line; the pages lead with
 * icons and pictures.
 */
export type AgentSlug =
  | "codex"
  | "claude-code"
  | "opencode"
  | "cursor"
  | "antigravity"
  | "grok"
  | "fx"
  | "muse-code"
  | "pi";

/** Something that first shipped in a stable release; without `since` it's in every one. */
interface Versioned {
  since?: string;
}

export interface AgentFeature extends Versioned {
  icon: IconName;
  title: string;
  description: string;
}

export interface AgentStep {
  icon: IconName;
  text: string;
}

export interface Agent extends Versioned {
  slug: AgentSlug;
  name: string;
  /** Who makes the agent, for the page's "not affiliated" line. */
  maker: string;
  /** The logo already spells the name, so the homepage row shows the logo alone. */
  markIsWordmark?: boolean;
  title: string;
  description: string;
  headline: string;
  intro: string;
  /** One line for the /agents grid. */
  summary: string;
  features: AgentFeature[];
  setup: AgentStep[];
  faq: { question: string; answer: string }[];
}

export function agentPath(agent: Pick<Agent, "slug">): string {
  return `/agents/${agent.slug}`;
}

/** Whether an agent or feature is in the stable app, given the newest stable version. */
export function isInStableRelease(item: Versioned, latestStable: string): boolean {
  return item.since === undefined || compareVersions(latestStable, item.since) >= 0;
}

/** Steps one and four are the same for every agent. */
const DOWNLOAD_STEP: AgentStep = { icon: "download", text: "Download Threadlines" };
const START_STEP: AgentStep = { icon: "play", text: "Open a project and start a thread" };

export const AGENTS: readonly Agent[] = [
  {
    slug: "codex",
    name: "Codex",
    maker: "OpenAI",
    title: "Codex GUI for Mac, Windows and Linux | Threadlines",
    description:
      "Run OpenAI's Codex in a free, open-source desktop app with your ChatGPT sign-in. Goals, subagents, forks and usage meters, plus Claude Code in the same thread.",
    headline: "A desktop GUI for Codex",
    intro:
      "Threadlines runs OpenAI's Codex with your ChatGPT sign-in and keeps each thread's plan, subagents, diffs and pull request in view. Add Claude Code to the same thread whenever you want a second opinion.",
    summary: "Goals, subagents you can message, and your ChatGPT limits on screen.",
    features: [
      {
        icon: "gauge",
        title: "Your ChatGPT plan",
        description: "Turns use your plan, and meters show what's left.",
      },
      {
        icon: "target",
        title: "Goals with budgets",
        description: "Give Codex a goal and a token budget.",
      },
      {
        icon: "agents",
        title: "Subagents you can message",
        description: "Watch them live and message one while it works.",
      },
      {
        icon: "message",
        title: "Steer mid-turn",
        description: "Codex reads your message in the same turn.",
      },
      {
        icon: "fork",
        title: "Fork and undo",
        description: "Fork from any message. Undo rolls Codex back too.",
      },
      {
        icon: "download",
        title: "Bring in old sessions",
        description: "Import threads you started in the Codex CLI.",
      },
      {
        icon: "plug",
        title: "Skills, plugins and MCP",
        description: "Manage them all from Settings.",
      },
    ],
    setup: [
      DOWNLOAD_STEP,
      { icon: "package", text: "Install Codex from Settings › Providers" },
      { icon: "key", text: "Sign in with ChatGPT or an API key" },
      START_STEP,
    ],
    faq: [
      {
        question: "Does Threadlines use my ChatGPT subscription?",
        answer:
          "Yes. It runs the Codex CLI with your ChatGPT sign-in, so it uses the same limits as Codex anywhere else. An OpenAI API key works too, and that bills per token.",
      },
      {
        question: "Can I move a Codex thread to Claude Code?",
        answer:
          "Yes. Switch the thread's agent and Threadlines gives Claude Code a recap of the conversation along with your current working tree. Or keep Codex and add Claude Code to the same thread.",
      },
      {
        question: "What does it cost?",
        answer:
          "Threadlines is free and MIT-licensed. You only pay for your ChatGPT plan or API usage.",
      },
    ],
  },
  {
    slug: "claude-code",
    name: "Claude Code",
    maker: "Anthropic",
    title: "Claude Code GUI for Mac, Windows and Linux | Threadlines",
    description:
      "Run Claude Code in a free, open-source desktop app with your Claude plan. Plan mode, live subagents, steering and usage meters, plus Codex in the same thread.",
    headline: "A desktop GUI for Claude Code",
    intro:
      "Threadlines runs Anthropic's Claude Code with your own sign-in, so your Claude plan, MCP servers and skills come along. Add Codex to the same thread whenever you want a second opinion.",
    summary: "Plan mode, live subagents, and your 5-hour and weekly limits.",
    features: [
      {
        icon: "gauge",
        title: "Your Claude plan",
        description: "5-hour and weekly meters show what's left.",
      },
      {
        icon: "plan",
        title: "Plan mode",
        description: "Plan first, then choose how much Claude does alone.",
      },
      {
        icon: "agents",
        title: "Live subagents",
        description: "Watch each one and open its transcript.",
      },
      {
        icon: "message",
        title: "Steer mid-turn",
        description: "Claude reads your message without waiting for the end.",
      },
      {
        icon: "sliders",
        title: "Models and effort",
        description: "Any Claude Code model, with effort set per thread.",
      },
      {
        icon: "plug",
        title: "MCP servers and skills",
        description: "Yours load as usual, and Settings manages them.",
      },
      {
        icon: "workflow",
        title: "Workflows",
        description: "Run live in the chat, with a Stop button.",
        since: "0.7.0",
      },
      {
        icon: "target",
        title: "Goals",
        description: "Follow Claude's progress in the goal bar.",
        since: "0.7.0",
      },
    ],
    setup: [
      DOWNLOAD_STEP,
      { icon: "package", text: "Install Claude Code from Settings › Providers" },
      { icon: "key", text: "Sign in with Claude, or paste a setup token" },
      START_STEP,
    ],
    faq: [
      {
        question: "Does Threadlines use my Claude subscription?",
        answer:
          "Yes. It runs Anthropic's Claude Code with your sign-in, the same way a terminal does. If you set an Anthropic API key in your environment, Claude Code bills that key instead, and Threadlines warns you when that happens.",
      },
      {
        question: "Can I use Claude Code and Codex together?",
        answer:
          "Yes. Add Codex to a Claude thread and ask it to review Claude's work, or switch the thread to Codex and it gets a recap plus your working tree.",
      },
      {
        question: "Does my code go anywhere new?",
        answer:
          "No. Your prompts and code go to Anthropic exactly as they do from the terminal. Threadlines runs on your computer and doesn't upload your code to a server of its own.",
      },
      {
        question: "What does it cost?",
        answer:
          "Threadlines is free and MIT-licensed. You pay Anthropic for your Claude plan, or for API usage if you use a key.",
      },
    ],
  },
  {
    slug: "opencode",
    name: "OpenCode",
    maker: "Anomaly",
    since: "0.6.0",
    title: "OpenCode GUI for Mac, Windows and Linux | Threadlines",
    description:
      "Run OpenCode 2 in a free, open-source desktop app. Use any model you've connected, with plan mode, subagents, steering and forks.",
    headline: "A desktop GUI for OpenCode",
    intro:
      "OpenCode lets you bring your own model accounts. Threadlines runs OpenCode 2 and gives each conversation a thread with its plan, subagents and diffs.",
    summary: "Your own model accounts, with plan mode, subagents and forks.",
    features: [
      {
        icon: "sliders",
        title: "Any model you've connected",
        description: "With its reasoning variants, picked per thread.",
      },
      {
        icon: "plan",
        title: "Plan mode",
        description: "OpenCode's plan agent plans before any edits.",
      },
      {
        icon: "agents",
        title: "Subagents",
        description: "Shown live in the thread.",
      },
      {
        icon: "fork",
        title: "Steer, fork and resume",
        description: "Message it mid-turn, fork, and pick up after a restart.",
      },
      {
        icon: "image",
        title: "Images and files",
        description: "Attachments reach OpenCode inline.",
      },
      {
        icon: "terminal",
        title: "Slash commands",
        description: "Run them from the composer.",
      },
    ],
    setup: [
      DOWNLOAD_STEP,
      { icon: "package", text: "Install OpenCode 2 from Settings › Providers" },
      { icon: "key", text: "Connect a model provider account" },
      START_STEP,
    ],
    faq: [
      {
        question: "Which OpenCode version do I need?",
        answer:
          "OpenCode 2. Threadlines talks to it through opencode serve and helps you upgrade if you're still on 1.x.",
      },
      {
        question: "Which models can I use?",
        answer:
          "Whatever you've connected in OpenCode. Threadlines lists the models OpenCode reports for your accounts.",
      },
      {
        question: "Are there usage meters for OpenCode?",
        answer:
          "No. OpenCode doesn't report plan limits, so Threadlines has nothing to show. Check your model provider's own dashboard.",
      },
      {
        question: "What does it cost?",
        answer:
          "Threadlines and OpenCode are both free. You pay your model providers for what you use.",
      },
    ],
  },
  {
    slug: "cursor",
    name: "Cursor",
    maker: "Anysphere",
    since: "0.5.0",
    title: "Cursor CLI agent in a desktop app | Threadlines",
    description:
      "Run Cursor's command-line agent in a free, open-source desktop app with your Cursor sign-in. Plan mode, to-do lists and Cursor's models.",
    headline: "A desktop GUI for the Cursor CLI",
    intro:
      "Cursor's agent also runs outside the editor, as the cursor-agent CLI. Threadlines drives it with your Cursor sign-in, so Cursor's models sit next to your other agents.",
    summary: "Cursor's CLI agent, with plan mode, questions and to-do lists.",
    features: [
      {
        icon: "account",
        title: "Your Cursor account",
        description: "Sign in once and turns use your plan.",
      },
      {
        icon: "plan",
        title: "Plan mode",
        description: "Questions and to-do lists show in the thread.",
      },
      {
        icon: "shield",
        title: "Access levels",
        description: "Approve each step, or give full access.",
      },
      {
        icon: "sliders",
        title: "Cursor's models",
        description: "Auto, or any model your plan includes.",
      },
      {
        icon: "globe",
        title: "Browser and other agents",
        description: "Cursor can open pages and ask other agents for help.",
      },
    ],
    setup: [
      DOWNLOAD_STEP,
      { icon: "package", text: "Install the Cursor CLI from Settings › Providers" },
      { icon: "key", text: "Sign in with your Cursor account" },
      START_STEP,
    ],
    faq: [
      {
        question: "Do I need the Cursor editor?",
        answer:
          "No. Threadlines uses Cursor's command-line agent, which installs on its own. You need a Cursor CLI from April 2026 or later.",
      },
      {
        question: "Does it use my Cursor subscription?",
        answer: "Yes. The CLI uses your Cursor sign-in, so turns count against your Cursor plan.",
      },
      {
        question: "What does it cost?",
        answer: "Threadlines is free and MIT-licensed. You only pay for your Cursor plan.",
      },
    ],
  },
  {
    slug: "antigravity",
    name: "Antigravity",
    maker: "Google",
    since: "0.6.0",
    title: "Google Antigravity agent in a desktop app | Threadlines",
    description:
      "Run Google Antigravity's agent with Gemini models in a free, open-source desktop app. One-click install, four sign-in options and plan mode.",
    headline: "Antigravity's agent, without the IDE",
    intro:
      "Antigravity is Google's agent-first IDE, and its agent also runs on its own. Threadlines installs and runs that agent for you, so Gemini models sit next to Claude Code and Codex.",
    summary: "Gemini models, a one-click install and four ways to sign in.",
    features: [
      {
        icon: "package",
        title: "One-click install",
        description: "Downloaded, verified and updated from Settings.",
      },
      {
        icon: "key",
        title: "Four ways to sign in",
        description: "Google account, Gemini Enterprise, API key or Vertex AI.",
      },
      {
        icon: "plan",
        title: "Plan mode",
        description: "Get a plan before any edits.",
      },
      {
        icon: "shield",
        title: "Access levels",
        description: "Mapped onto Antigravity's own modes.",
      },
      {
        icon: "accounts",
        title: "More than one account",
        description: "Pick which Google account each thread uses.",
      },
      {
        icon: "zap",
        title: "Reasoning options",
        description: "Choose how hard Gemini thinks.",
      },
    ],
    setup: [
      DOWNLOAD_STEP,
      { icon: "package", text: "Install Antigravity from Settings › Providers" },
      { icon: "key", text: "Sign in with Google, an API key or Vertex AI" },
      START_STEP,
    ],
    faq: [
      {
        question: "Do I need the Antigravity IDE?",
        answer: "No. Threadlines installs only the agent server it needs.",
      },
      {
        question: "Does a Gemini API key cost money?",
        answer:
          "It can. API keys and Vertex AI bill per use past any free tier Google gives you, and that usage doesn't appear on Threadlines' Usage page. Signing in with a Google account uses your plan instead.",
      },
      {
        question: "Which models can I pick?",
        answer:
          "The ones Google offers your account. Some plans only see Gemini models, and Threadlines shows what Google returns.",
      },
      {
        question: "What does it cost?",
        answer:
          "Threadlines is free and MIT-licensed. Antigravity's cost depends on how you sign in.",
      },
    ],
  },
  {
    slug: "grok",
    name: "Grok",
    maker: "xAI",
    since: "0.7.0",
    title: "Grok Build GUI: a desktop app for Grok Build | Threadlines",
    description:
      "Run xAI's Grok Build in a free, open-source desktop app with your SuperGrok or X Premium sign-in. Live subagents, steering, forks and credit meters.",
    headline: "A desktop GUI for Grok Build",
    intro:
      "Grok Build is xAI's coding agent. Threadlines runs it with your Grok subscription and shows its subagents and shells as they run.",
    summary: "Live subagents and shells, mid-turn steering and credit meters.",
    features: [
      {
        icon: "gauge",
        title: "Your Grok subscription",
        description: "SuperGrok or X Premium, with credit meters.",
      },
      {
        icon: "plan",
        title: "Plan mode",
        description: "Get a plan before Grok touches files.",
      },
      {
        icon: "agents",
        title: "Subagents and shells",
        description: "Watch them live in the thread.",
      },
      {
        icon: "message",
        title: "Steer mid-turn",
        description: "Grok reads your message in the same turn.",
      },
      {
        icon: "fork",
        title: "Fork and revert",
        description: "Grok's own history follows.",
      },
      {
        icon: "accounts",
        title: "More than one account",
        description: "Pick which one each thread uses.",
      },
    ],
    setup: [
      DOWNLOAD_STEP,
      { icon: "package", text: "Install Grok Build from Settings › Providers" },
      { icon: "key", text: "Sign in with your Grok subscription or an xAI key" },
      START_STEP,
    ],
    faq: [
      {
        question: "Does an xAI API key cost extra?",
        answer:
          "Yes, a key bills per request. Threadlines keeps a stray XAI_API_KEY in your environment away from your subscription sign-in, so you don't pay by accident.",
      },
      {
        question: "Which access levels does Grok support?",
        answer: "Approval required, Auto and Full access. Grok has no accept-edits-only mode.",
      },
      {
        question: "What does it cost?",
        answer:
          "Threadlines is free and MIT-licensed. You pay xAI for your Grok plan, or per request with an API key.",
      },
    ],
  },
  {
    slug: "fx",
    name: "fx",
    maker: "Vercel",
    markIsWordmark: true,
    since: "0.5.0",
    title: "fx coding agent GUI | Threadlines",
    description:
      "Run Vercel's fx coding agent in a free, open-source desktop app, with AI Gateway models and their prices in the picker. Works on Windows through WSL.",
    headline: "A desktop GUI for fx",
    intro:
      "fx is Vercel Labs' small, open-source coding agent. Threadlines runs it with Vercel AI Gateway models and shows each model's price in the picker.",
    summary: "AI Gateway models, with their prices in the picker.",
    features: [
      {
        icon: "tag",
        title: "Prices in the picker",
        description: "See what each model costs. Free ones are marked.",
      },
      {
        icon: "key",
        title: "Simple sign-in",
        description: "Click Sign in, or add an AI Gateway key.",
      },
      {
        icon: "shield",
        title: "Access levels",
        description: "Approve each step, or give full access.",
      },
      {
        icon: "zap",
        title: "Reasoning effort",
        description: "On models that offer it.",
      },
      {
        icon: "monitor",
        title: "Windows through WSL",
        description: "Threadlines runs fx inside WSL for you.",
      },
    ],
    setup: [
      DOWNLOAD_STEP,
      { icon: "package", text: "Install fx from Settings › Providers" },
      { icon: "key", text: "Sign in to the Vercel AI Gateway" },
      START_STEP,
    ],
    faq: [
      {
        question: "Does fx work on Windows?",
        answer:
          "Yes, through WSL. Threadlines runs fx inside your default WSL distro. The built-in browser and the tools agents use to talk to each other can't reach fx there yet.",
      },
      {
        question: "Is there a plan mode?",
        answer: "No. fx doesn't offer one, so Threadlines hides the plan toggle for it.",
      },
      {
        question: "What does it cost?",
        answer:
          "Threadlines and fx are free. Models bill through the Vercel AI Gateway, and some cost nothing.",
      },
    ],
  },
  {
    slug: "muse-code",
    name: "Muse Code",
    maker: "Meta",
    since: "0.7.0",
    title: "Muse Code GUI: a desktop app for Meta's agent | Threadlines",
    description:
      "Run Meta's Muse Code in a free, open-source desktop app with your Meta sign-in. Read-only plan mode, subagents, workflows, steering and usage meters.",
    headline: "A desktop GUI for Muse Code",
    intro:
      "Meta ships Muse Code as a terminal tool. Threadlines gives it a desktop home, with plans you approve, subagents you can follow and your limits on screen.",
    summary: "Read-only plan mode, workflows, and your 5-hour and weekly limits.",
    features: [
      {
        icon: "gauge",
        title: "Your Muse plan",
        description: "5-hour and weekly meters show your limits.",
      },
      {
        icon: "plan",
        title: "Read-only plan mode",
        description: "Muse plans without touching files, then builds.",
      },
      {
        icon: "workflow",
        title: "Subagents and workflows",
        description: "Follow them as they run.",
      },
      {
        icon: "message",
        title: "Steer mid-turn",
        description: "Muse reads your message in the same turn.",
      },
      {
        icon: "eye",
        title: "Contributor mode is your call",
        description: "Choose once whether Meta can train on your chats.",
      },
      {
        icon: "lock",
        title: "No surprise API bills",
        description: "API keys run only if you turn billing on.",
      },
    ],
    setup: [
      DOWNLOAD_STEP,
      { icon: "package", text: "Install Muse Code from Settings › Providers" },
      { icon: "key", text: "Sign in and choose contributor mode" },
      START_STEP,
    ],
    faq: [
      {
        question: "What is contributor mode?",
        answer:
          "A Muse setting that lets Meta use your chats for training, in exchange for longer plan limits. Meta's terms say confidential code shouldn't go there. Threadlines asks before your first chat, and you can change it in Settings.",
      },
      {
        question: "Does Muse Code work on Windows?",
        answer:
          "Muse supports Windows, but we haven't tested Threadlines with it there yet. Mac is tested.",
      },
      {
        question: "Can Muse join a thread with other agents?",
        answer:
          "Yes. It can't answer side questions while another agent is working, though, because Muse loads your own hooks and MCP servers in every chat.",
      },
      {
        question: "What does it cost?",
        answer:
          "Threadlines is free and MIT-licensed. You pay Meta for your Muse plan, or for API usage if you turn that on.",
      },
    ],
  },
  {
    slug: "pi",
    name: "Pi",
    maker: "Earendil",
    since: "0.7.0",
    title: "Pi coding agent GUI | Threadlines",
    description:
      "Run the Pi coding agent in a free, open-source desktop app with your own Pi setup. Approvals, plan mode, steering, forks and any model Pi can use.",
    headline: "A desktop GUI for the Pi coding agent",
    intro:
      "Pi is an open-source coding agent from Earendil that works with almost any model provider. Threadlines runs one Pi per chat, with your own Pi settings, extensions and sign-ins.",
    summary: "Almost any model provider, with approvals and plan mode.",
    features: [
      {
        icon: "account",
        title: "Your Pi setup",
        description: "Settings, extensions, skills and sign-ins carry over.",
      },
      {
        icon: "package",
        title: "No Node.js needed",
        description: "Uses your Pi 1.3 or newer, or installs its own copy.",
      },
      {
        icon: "shield",
        title: "Approvals and plan mode",
        description: "Choose when Pi asks first, or get a plan with no changes.",
      },
      {
        icon: "sliders",
        title: "Any model Pi can use",
        description: "Grouped by provider, with thinking levels.",
      },
      {
        icon: "fork",
        title: "Steer, revert and fork",
        description: "Message Pi mid-turn, revert a turn, or fork.",
      },
      {
        icon: "gauge",
        title: "Spending on the Usage page",
        description: "Right next to your other agents.",
      },
    ],
    setup: [
      DOWNLOAD_STEP,
      { icon: "package", text: "Turn Pi on in Settings › Providers" },
      { icon: "key", text: "Type /login in Pi, or add an API key" },
      START_STEP,
    ],
    faq: [
      {
        question: "Does Pi ask before it runs commands?",
        answer:
          "In Threadlines it does, unless you give it full access. Supervised asks before commands and file changes, and auto-accept edits asks only before commands and other tools. These approvals aren't a sandbox, though: Pi's own ! shell commands and tools from other Pi extensions skip them.",
      },
      {
        question: "Can I use Pi on the stable app today?",
        answer:
          "Yes, as a community agent. Install Pi from pi.dev, then install pi-acp under Community agents in Settings › Providers. After you update, its row offers to move you to the built-in Pi.",
      },
      {
        question: "What doesn't work with Pi yet?",
        answer:
          "Extra accounts, side answers in rooms, and goals. Pi's terminal-only commands such as /model and /login don't run from the composer, and a turn a Pi extension starts on its own can't be reverted exactly.",
      },
      {
        question: "What does it cost?",
        answer: "Threadlines and Pi are both free. You pay the model providers you connect to Pi.",
      },
    ],
  },
];
