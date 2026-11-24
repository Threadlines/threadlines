# Tool-use evals

These check how real models use the tools Threadlines gives agents: starting and stopping threads, schedules, the app guide, settings changes. When a change to a tool's description or to our instructions makes models misuse a tool, a case starts failing.

Each case sends one message to a real agent: the real Claude or Codex program, through our real adapter, with our real prompt, instructions and tool list. Only Threadlines' tool endpoints are stand-ins. They serve the production tool definitions, listing and sign-in check, log every call and answer with canned results (`cannedTools.ts`), so nothing real happens. Checks then grade the calls, the agent's own tools and its reply (`cases.ts`).

They're not part of CI. Models vary, so read the pass rates, not a single run.

## Running

```
cd apps/server
node scripts/eval-tool-use.ts --provider claude [--model claude-opus-5-5] [--case parallel-threads] [--samples 2]
node scripts/eval-tool-use.ts --provider codex  [--model gpt-6.1-sol]
```

Full results (every call and reply) go to `~/.threadlines-evals/results/`.

## One-time setup

Evals use your subscriptions, never per-use billing, from settings folders made only for them. That way the model can't reach your plugins, connected services or personal instructions:

```
mkdir -p ~/.threadlines-evals/claude && CLAUDE_CONFIG_DIR=~/.threadlines-evals/claude claude   # then /login
mkdir -p ~/.threadlines-evals/codex && CODEX_HOME=~/.threadlines-evals/codex codex login
```

Codex turns on your ChatGPT connectors and syncs your account's plugins even in a fresh folder, so the Codex folder also needs this in `~/.threadlines-evals/codex/config.toml`:

```
[features]
apps = false
plugins = false
```

Before the first model request, each session checks the sign-in is a subscription, the model backend isn't a paid gateway, and only Threadlines' tool servers are connected. If any check fails, the run stops. API-key and sign-in environment variables are removed from the run.

Agent pages and command requests are off in evals (their tools and instructions are both left out), as are Codex's next-message suggestions.

## Adding a case

Add it to `TOOL_USE_CASES` in `cases.ts`: the message, any canned answers the case needs, and checks that name what a user would see go wrong.
