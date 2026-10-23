# Agents outside Threadlines

Claude Code, Codex, Gemini CLI, Cursor and other agents you run outside
Threadlines can use it: list your projects, start a thread, wait for its reply,
send it more work and stop it. You approve each one first, in Threadlines, and
pick how much it may do.

The design is in `design/outside-agents.md`.

## Connect an agent

Open Settings → Connections → Agents. It shows this computer's address for
agents, for example `http://127.0.0.1:3773/mcp/connect`, and the command for
each agent:

| Agent       | Add it                                                                   | Sign in                                                  |
| ----------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| Claude Code | `claude mcp add --transport http threadlines <address>`                  | `/mcp` in Claude Code, or `claude mcp login threadlines` |
| Codex       | `codex mcp add threadlines --url <address>`                              | `codex mcp login threadlines`                            |
| Gemini CLI  | `gemini mcp add --transport http threadlines <address>`                  | `/mcp auth threadlines`                                  |
| Cursor      | `"threadlines": { "url": "<address>" }` under `mcpServers` in `mcp.json` | Cursor asks when it first connects                       |

Signing in opens your browser on a small Threadlines page with a code. At the
same moment Threadlines asks you, in its own window:

- **What it can do.** See threads: your projects, your agents, and every
  thread's status and messages. Start threads: all of that, plus starting
  threads and sending to or stopping the ones it started.
- **Projects.** All of them, or the ones you pick.
- **Highest access.** For threads it starts. Supervised by default.

Check that the code matches the one in your browser, then Allow. The name in the
dialog is the one the agent gave; Threadlines can't check it.

Sign-in happens once. Later runs, including unattended ones like `claude -p` or
`codex exec`, use it until you remove the agent or don't use it for 90 days.

## What an agent can and can't do

- It sees only the projects you gave it. A thread elsewhere looks like it
  doesn't exist.
- It can send to and stop only threads it started, and only while their access
  is at or below its highest access. If you raise a thread above it, the agent
  can read that thread but no longer drive it.
- It sends one message at a time: while the thread is working or waiting for
  you, a send answers "busy" and the agent waits.
- It can't answer approvals, questions or plans in its threads. Those wait for
  you in Threadlines; the agent sees what's waiting and can tell you.
- Threads it starts are labelled with its name, and so are the messages it
  sends. They get no Threadlines agent tools of their own: they can't start
  more threads, invite agents or schedule tasks.
- Limits: 120 calls a minute, 4 of its threads running at once, 50 new threads
  a day.

## Change or remove an agent

Settings → Connections → Agents lists every agent with what it may do and when
it was last used. **Change** applies on its next call. A tool you newly allowed
shows up the next time the agent lists its tools, usually when it starts.
**Remove** cuts it off on its next call; it has to sign in again to come back.
Threads it started stay, with its name.

**Deny all** turns down every waiting sign-in and stops new ones for 10
minutes, in case something keeps asking. **Take requests again** ends that
early.

## Honest limits

- Agents connect only on this computer, over `127.0.0.1`. Connections from
  another machine, through Tailscale or a proxy, are refused. ChatGPT and
  claude.ai connectors can't reach it.
- The access level protects you from an agent that can only use these tools,
  including one tricked by something it read. An agent that can run commands
  on your computer as you can read Threadlines' data folder anyway; no setting
  here changes that.
- The address includes the port. If Threadlines starts on a different port
  (when something else holds 3773), add the agent again with the new address.
- If Threadlines restarts in the moment an agent starts a thread, that thread
  can be left without its first message. It stays visible in the sidebar; the
  agent is told to start again.
- Cursor may send its web address for the sign-in instead of the one on your
  computer. Threadlines only accepts the one on your computer; if Cursor's
  sign-in fails, tell us.
