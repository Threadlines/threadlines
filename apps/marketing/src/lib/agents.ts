import { compareVersions } from "./changelog";

/**
 * The coding agents Threadlines runs, in the order the homepage shows them. Each one gets a
 * page at /agents/<slug>, a link in the homepage's agent row and a sitemap entry. Every claim
 * here has to hold for the stable app: mark anything newer with `since`, and update an entry
 * when its driver changes (Pi moves off `community` when its built-in driver ships).
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
  title: string;
  description: string;
}

export interface Agent extends Versioned {
  slug: AgentSlug;
  name: string;
  /** Who makes the agent, for the page's "not affiliated" line. */
  maker: string;
  /** The logo already spells the name, so the homepage row shows the logo alone. */
  markIsWordmark?: boolean;
  /** Runs as an untested agent from the open ACP registry rather than a built-in driver. */
  community?: boolean;
  title: string;
  description: string;
  headline: string;
  intro: string;
  /** One line for the /agents list. */
  summary: string;
  features: AgentFeature[];
  setup: string[];
  faq: { question: string; answer: string }[];
}

export function agentPath(agent: Pick<Agent, "slug">): string {
  return `/agents/${agent.slug}`;
}

/** Whether an agent or feature is in the stable app, given the newest stable version. */
export function isInStableRelease(item: Versioned, latestStable: string): boolean {
  return item.since === undefined || compareVersions(latestStable, item.since) >= 0;
}

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
      "Threadlines runs OpenAI's Codex CLI with your ChatGPT sign-in and gives every conversation a thread you can come back to, with its plan, subagents, diffs and pull request in view. OpenAI's Codex app runs Codex. Threadlines also runs Claude Code and the other agents on this site, and a thread can switch between them.",
    summary:
      "OpenAI's coding agent, with goals, subagents you can message, forks and your ChatGPT limits on screen.",
    features: [
      {
        title: "Your ChatGPT plan",
        description:
          "Sign in with ChatGPT and turns count against your plan. Usage meters show how much of each limit is left.",
      },
      {
        title: "Goals with token budgets",
        description:
          "Give Codex a goal and a token budget, and it keeps working toward it across turns.",
      },
      {
        title: "Subagents you can message",
        description:
          "Codex's subagents show up live in the thread, and you can send one a message while it works.",
      },
      {
        title: "Steer a running turn",
        description: "Send a message while Codex is busy and it reads it in the same turn.",
      },
      {
        title: "Fork and undo",
        description:
          "Fork a thread from any message, or undo a turn and Codex's own conversation rolls back with it.",
      },
      {
        title: "Bring in old sessions",
        description: "Import threads you started in the Codex CLI and pick them up in Threadlines.",
      },
      {
        title: "Skills, plugins and MCP",
        description: "Manage Codex skills, plugins and MCP servers from Settings.",
      },
    ],
    setup: [
      "Download Threadlines and open it.",
      "Go to Settings › Providers. If Codex isn't installed, click Install. Windows uses OpenAI's installer, and Mac and Linux use npm.",
      "Sign in with your ChatGPT account, or use an OpenAI API key.",
      "Open a project folder and start a thread with Codex.",
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
      "Threadlines runs Anthropic's Claude Code with your own sign-in, so your Claude plan, MCP servers and skills come along. Anthropic's Claude app runs Claude. Threadlines puts Claude Code next to Codex and the other agents here, and you can have two of them working in one thread.",
    summary:
      "Anthropic's coding agent, with plan mode, live subagents, mid-turn steering and your 5-hour and weekly limits.",
    features: [
      {
        title: "Your Claude plan",
        description:
          "Turns count against your Claude plan, and the 5-hour and weekly meters show how much is left.",
      },
      {
        title: "Plan mode and access levels",
        description:
          "Ask for a plan before any edits, then choose how much Claude can do without asking, up to Auto or full access.",
      },
      {
        title: "Subagents you can watch",
        description:
          "Claude's subagents appear live beside the thread, and you can open each one's transcript.",
      },
      {
        title: "Steer a running turn",
        description:
          "Send a message while Claude is working and it reads it mid-turn instead of waiting for the end.",
      },
      {
        title: "Models and effort",
        description: "Pick any model Claude Code offers and set its effort level for each thread.",
      },
      {
        title: "Your MCP servers and skills",
        description:
          "Claude Code loads your MCP servers, skills and slash commands, and Settings lets you manage them.",
      },
      {
        title: "Workflows in the chat",
        description:
          "Claude workflows run live in the thread, with a workflow view and a Stop button.",
        since: "0.7.0",
      },
      {
        title: "Goals",
        description:
          "Give Claude a goal and follow its progress in the goal bar above the composer.",
        since: "0.7.0",
      },
    ],
    setup: [
      "Download Threadlines and open it.",
      "Go to Settings › Providers. If Claude Code isn't installed, click Install. Windows uses Anthropic's installer, and Mac and Linux use npm.",
      "Sign in with your Claude account in the browser, or paste a token from claude setup-token.",
      "Open a project folder and start a thread with Claude.",
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
      "OpenCode lets you bring your own model accounts. Threadlines runs OpenCode 2 through its built-in server, so every model you've connected shows up in the picker, and each conversation gets a thread with its plan, subagents and diffs.",
    summary:
      "The open-source agent that works with your own model accounts, with plan mode, subagents and forks.",
    features: [
      {
        title: "Any model you've connected",
        description:
          "Pick from every model OpenCode reports, with its reasoning variants, for each thread.",
      },
      {
        title: "Plan mode",
        description: "Switch to OpenCode's plan agent to get a plan before any file changes.",
      },
      {
        title: "Subagents",
        description: "OpenCode's subagents show up live in the thread.",
      },
      {
        title: "Steer, fork and resume",
        description:
          "Message OpenCode mid-turn, fork a thread from any message, and pick up where you left off after a restart.",
      },
      {
        title: "Images and files",
        description: "Attach screenshots and files, and OpenCode receives them inline.",
      },
      {
        title: "Slash commands",
        description: "Run OpenCode's slash commands from the composer.",
      },
    ],
    setup: [
      "Download Threadlines and open it.",
      "Go to Settings › Providers and install OpenCode. Mac and Linux use OpenCode's install script, and Windows uses npm. If you have OpenCode 1, Threadlines walks you through the move to 2.",
      "Run the sign-in to connect a model provider account.",
      "Open a project folder and start a thread with OpenCode.",
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
      "Cursor's agent also runs outside the editor, as the cursor-agent command. Threadlines drives that CLI with your Cursor sign-in, so you can use Cursor's models in threads next to your other agents, without opening the editor.",
    summary:
      "Cursor's command-line agent, with plan mode, questions, to-do lists and Cursor's models.",
    features: [
      {
        title: "Your Cursor account",
        description: "Sign in with cursor-agent login and turns use your Cursor plan.",
      },
      {
        title: "Plan mode",
        description:
          "Ask Cursor for a plan first. Its questions and to-do list show up right in the thread.",
      },
      {
        title: "Access levels",
        description: "Approve each step as Cursor asks, or give it full access.",
      },
      {
        title: "Cursor's models",
        description: "Pick Auto or any model your Cursor plan includes, with its options.",
      },
      {
        title: "The browser and other agents",
        description:
          "Cursor can open pages in the built-in browser and ask the other agents in its thread for help.",
      },
    ],
    setup: [
      "Download Threadlines and open it.",
      "Go to Settings › Providers and install the Cursor CLI. Threadlines runs Cursor's own install script.",
      "Sign in with your Cursor account.",
      "Open a project folder and start a thread with Cursor.",
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
      "Antigravity is Google's agent-first IDE, and its agent also runs as a standalone server. Threadlines downloads, checks and runs that server for you, so you can use Gemini models in the same threads as Claude Code and Codex.",
    summary:
      "Google's agent with Gemini models, installed in one click, with four ways to sign in and plan mode.",
    features: [
      {
        title: "One-click install",
        description:
          "Threadlines downloads Google's agent server for your computer, verifies it, and updates it from Settings.",
      },
      {
        title: "Four ways to sign in",
        description: "Use a Google account, Gemini Enterprise, a Gemini API key, or Vertex AI.",
      },
      {
        title: "Plan mode",
        description: "Ask Antigravity for a plan before it edits anything.",
      },
      {
        title: "Access levels",
        description: "Threadlines maps its approval levels onto Antigravity's own modes.",
      },
      {
        title: "More than one account",
        description: "Add a second Google account and choose which one each thread uses.",
      },
      {
        title: "Reasoning options",
        description: "Pick a Gemini model and how hard it thinks.",
      },
    ],
    setup: [
      "Download Threadlines and open it.",
      "Go to Settings › Providers and click Install next to Antigravity. Threadlines fetches Google's agent server for your system.",
      "Sign in with your Google account, or choose an API key or Vertex AI.",
      "Open a project folder and start a thread with Antigravity.",
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
      "Grok Build is xAI's coding agent. Threadlines runs it with your Grok subscription, shows its subagents and background shells as they run, and lets you interject while it works.",
    summary:
      "xAI's coding agent, with live subagents and shells, mid-turn steering, forks and credit meters.",
    features: [
      {
        title: "Your Grok subscription",
        description:
          "Sign in with SuperGrok or X Premium in the browser. Credit meters show what's left.",
      },
      {
        title: "Plan mode",
        description: "Get a plan before Grok touches your files.",
      },
      {
        title: "Subagents and shells",
        description: "Watch Grok's subagents and long-running shells live in the thread.",
      },
      {
        title: "Steer a running turn",
        description: "Interject while Grok works and it reads your message in the same turn.",
      },
      {
        title: "Fork and revert",
        description: "Fork a thread or revert a turn, and Grok's own history follows.",
      },
      {
        title: "More than one account",
        description: "Add a second Grok account and choose which one each thread uses.",
      },
    ],
    setup: [
      "Download Threadlines and open it.",
      "Go to Settings › Providers and install Grok Build. Threadlines runs xAI's installer.",
      "Sign in with your Grok subscription, or use an xAI API key.",
      "Open a project folder and start a thread with Grok.",
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
      "fx is Vercel Labs' small, open-source coding agent. Threadlines runs it with models from the Vercel AI Gateway and shows each model's price right in the picker, so you know what a thread costs before you start.",
    summary: "Vercel's open-source agent, with AI Gateway models and their prices in the picker.",
    features: [
      {
        title: "Prices in the picker",
        description:
          "Pick from the AI Gateway catalog. The picker shows what each model costs and marks the free ones.",
      },
      {
        title: "Simple sign-in",
        description:
          "Click Sign in and Threadlines runs fx login for you, or add an AI Gateway API key.",
      },
      {
        title: "Access levels",
        description: "Approve each step as fx asks, or give it full access.",
      },
      {
        title: "Reasoning effort",
        description: "Set reasoning effort on models that offer it.",
      },
      {
        title: "Windows through WSL",
        description:
          "fx ships for Mac and Linux. On Windows, Threadlines runs it inside WSL for you.",
      },
    ],
    setup: [
      "Download Threadlines and open it.",
      "Go to Settings › Providers and install fx. Threadlines runs fx's setup script, inside WSL on Windows.",
      "Click Sign in to connect the Vercel AI Gateway, or add an AI Gateway key.",
      "Open a project folder and start a thread with fx.",
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
      "Meta ships Muse Code as a terminal tool. Threadlines runs it with your Meta sign-in and gives it a desktop home, with plans you approve, subagents you can follow, and your usage limits on screen.",
    summary:
      "Meta's coding agent, with read-only plan mode, subagents, workflows and your 5-hour and weekly limits.",
    features: [
      {
        title: "Your Muse plan",
        description: "Sign in with muse login. The 5-hour and weekly meters show your limits.",
      },
      {
        title: "Read-only plan mode",
        description: "Muse plans without touching your files. Approve the plan and it builds.",
      },
      {
        title: "Subagents and workflows",
        description: "Follow Muse's subagents and workflows as they run.",
      },
      {
        title: "Steer a running turn",
        description: "Send Muse a message while it works and it reads it in the same turn.",
      },
      {
        title: "Contributor mode is your call",
        description:
          "Muse's contributor mode lets Meta train on your chats. Threadlines asks you once and sends your choice to every session.",
      },
      {
        title: "No surprise API bills",
        description:
          "Threadlines won't run Muse on an API key unless you turn on API key billing yourself.",
      },
    ],
    setup: [
      "Download Threadlines and open it.",
      "Go to Settings › Providers and install Muse Code. Threadlines runs Meta's installer.",
      "Sign in, then choose whether to turn on contributor mode.",
      "Open a project folder and start a thread with Muse.",
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
    community: true,
    since: "0.6.0",
    title: "Pi coding agent GUI | Threadlines",
    description:
      "Run the Pi coding agent in a free, open-source desktop app. Threadlines installs pi-acp from the ACP registry, and Pi brings its own models and sign-in.",
    headline: "A desktop GUI for the Pi coding agent",
    intro:
      "Pi is an open-source coding agent from Earendil. Threadlines runs it today as a community agent, through the pi-acp adapter from the open ACP registry, with whatever models and sign-ins your Pi setup has.",
    summary: "Earendil's open-source agent, running today as a community agent through pi-acp.",
    features: [
      {
        title: "Installed when you confirm",
        description:
          "Threadlines installs pi-acp with its own copy of Node.js, so it doesn't depend on the Node on your computer.",
      },
      {
        title: "Pi's own sign-in",
        description:
          "Run Pi's login in the sign-in panel's terminal and use the model accounts Pi supports.",
      },
      {
        title: "Pi's models and modes",
        description: "Pick from the models and modes Pi offers, right in the composer.",
      },
      {
        title: "A checkout of its own",
        description:
          "Give a Pi thread its own Git worktree, so its edits stay apart from the code you're working on.",
      },
      {
        title: "Updates on your say-so",
        description:
          "Threadlines never updates Pi's adapter by itself. An update is one click and installs exactly the version shown.",
      },
    ],
    setup: [
      "Install Pi itself from pi.dev. The adapter starts the pi command, so it has to be on your computer.",
      "Download Threadlines and open it.",
      "Go to Settings › Providers, scroll to Community agents and install pi-acp.",
      "Sign in through Pi, then start a thread.",
    ],
    faq: [
      {
        question: "Is Pi a built-in agent?",
        answer:
          "Not yet. Pi runs as a community agent, which means Threadlines installs and runs it but hasn't tested every feature with it. Built-in support is in the works.",
      },
      {
        question: "Does Pi ask before it runs commands?",
        answer:
          "No. Pi doesn't ask for permission, so Threadlines has nothing to approve. Run it in its own worktree if you want its changes kept apart.",
      },
      {
        question: "Why does Pi say it can't start?",
        answer:
          "pi-acp needs the pi command on your computer. Install Pi from pi.dev, then start the thread again.",
      },
      {
        question: "What doesn't work with Pi yet?",
        answer:
          "Usage meters, extra accounts, and thread titles or commit messages written by Pi. Resuming after a restart and image attachments depend on pi-acp.",
      },
      {
        question: "What does it cost?",
        answer: "Threadlines and Pi are both free. You pay the model providers you connect to Pi.",
      },
    ],
  },
];
