# The Threadlines demo computer

A Threadlines server in a container, holding fake projects and a scripted
agent. It's what assistant-directory reviewers connect to when they test the
Threadlines assistants door (`docs/design/assistants.md`, "The demo computer").
Nothing on it is real: no real code, no accounts, no coding agent that costs
money.

## The agent is scripted

Every thread on this computer runs **Demo agent (scripted)**. It is a small
Node script (`scripts/demo-computer/demo-agent.ts`), not a language model.

- **What it does:** it reads your message, picks one of a few fixed changes by
  keywords (below), really edits the files in the thread's checkout, and
  replies with what it changed. Every reply ends with a note saying it is
  scripted. It never runs tests.
- **Why:** a review shouldn't run up a model bill, and the computer shouldn't
  hold real code or real sign-ins.
- **What it stands in for:** the coding agents a real user runs in
  Threadlines: Codex, Claude, and the ACP agents (Cursor, fx, Grok,
  Antigravity and community agents). It speaks the same Agent Client Protocol
  as those ACP agents, so its threads go through the same states (working,
  waiting for an answer, waiting for an approval, failed, finished) that
  the tools report for real ones.
- **How it shows up:** the `agents` tool lists it as "Demo agent (scripted)",
  with one model, "Scripted demo". Its status check reports the account as
  "No account (scripted demo)".

### What it does with a message

The first rule that matches wins.

| The message contains                                       | What the agent does                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| the word "fail"                                            | Ends the turn with an error. Nothing changes.                                                          |
| "watch", "keep working", "keep watching", "long-running"   | Stays working until the thread is stopped (at most `DEMO_AGENT_WATCH_MINUTES`, default one day).       |
| "ask me", "question", "which one", "which change"          | Asks a question: which of three changes to make. Then makes the one picked.                            |
| "approval", "permission", "delete", "remove"               | Asks for an approval to delete a file (one named in the message, or the docs project's outdated page). |
| "explain", "summary", "summarize", "what does", "describe" | Describes the project from its README and file list. Nothing changes.                                  |
| "readme"                                                   | Adds a line about the request to the README.                                                           |
| "changelog"                                                | Adds the request to the changelog.                                                                     |
| anything else                                              | Code projects: adds a small helper with a test and a changelog line. Docs project: adds a page.        |

With the word "commit" it also commits everything in the checkout. Otherwise
the changes stay uncommitted, the way a reviewer would usually find an agent's
work.

## The fake data

`scripts/demo-computer/demo-fixtures.ts` builds three sample git repos, a
project for each, and threads in every state, all through the server's own
API as a signed-in owner (it never writes the database):

| Project          | Thread                           | State                                                 |
| ---------------- | -------------------------------- | ----------------------------------------------------- |
| Acme Notes (JS)  | Add a clamp helper               | Finished, 4 files changed (uncommitted)               |
| Acme Notes       | Pick the next change             | Waiting on a question (`thread_answer` can answer it) |
| Weather CLI (Py) | Add a slugify helper             | Finished, 3 files changed (uncommitted)               |
| Weather CLI      | Run the release check            | Failed                                                |
| Field Guide docs | Explain this project             | Finished, no changes                                  |
| Field Guide docs | Remove the outdated install page | Waiting on an approval (only the user can answer)     |
| Field Guide docs | Watch the docs build             | Working, until someone stops it                       |

Each thread works in its own git worktree, made by Threadlines the way a first
message from the app makes one. Branch names and thread titles come from the
scripted agent too, since there is no model to write them.

## Run it

Build from the repository root, then run it with a volume for its home folder:

```bash
docker build -f docker/demo/Dockerfile -t threadlines-demo .

docker run -d --name threadlines-demo --restart unless-stopped \
  -p 127.0.0.1:3773:3773 \
  -v threadlines-demo-home:/home/threadlines \
  threadlines-demo
```

The assistants door reaches the computer through the relay, over a connection
the computer opens itself, so nothing needs to be reachable from outside. The
port above is only open on the VPS itself; use an SSH tunnel to open the app
(the pairing link is in `docker logs threadlines-demo`).

| Setting                              | What it does                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `DEMO_RESET_ON_START`                | `1` (the default) rebuilds the fake data each time the container starts. `0` keeps what's there.                        |
| `DEMO_PR_REPO_URL`, `DEMO_PR_BRANCH` | Optional pull request sample: a public sample repo's clone URL and a branch with an open pull request there. See below. |
| `GH_TOKEN`                           | A read-only GitHub token, so the server can look that pull request up.                                                  |
| `DEMO_AGENT_WATCH_MINUTES`           | How long the "watch" thread keeps working if nobody stops it (default 1440).                                            |

The image sets `THREADLINES_TELEMETRY_ENABLED=false` and
`THREADLINES_ASSISTANT_REVIEW_COMPUTER=1`. It installs no provider CLI, and on
every start it writes a settings file that turns every real provider off and
the scripted agent on.

## Resets

```bash
docker exec threadlines-demo threadlines-demo reset    # rebuild the fake data now
docker exec threadlines-demo threadlines-demo status   # list the fake threads and their states
```

A reset deletes the demo projects with the app's own "delete project"
command (their threads go with them, including any a reviewer started),
deletes the sample repos and their worktrees, and builds everything again. A
daily reset from the host's cron keeps the data fresh:

```cron
0 6 * * * docker exec threadlines-demo threadlines-demo reset
```

**What a reset keeps:** everything that makes the computer itself.

- `~/.threadlines/userdata/secrets/`: the server's signing key, which signs
  every assistant's token; the relay host secret and end-to-end key, which are
  its relay registration; alert signing secrets.
- `~/.threadlines/userdata/environment-id`.
- In `state.sqlite`: assistant connections (`outside_agent_connections`),
  alert targets and MCP Events state (`assistant_targets`,
  `assistant_event_state`), sign-ins (`auth_sessions`), and the relay
  registration and devices (`relay_host`, `relay_devices` and the rest).
- The settings file, which only the container start rewrites.

A connection keeps working across a reset only if it may see all projects
(review sign-ins get that), because every reset makes new projects.

A container restart ends every agent session, so threads that were waiting or
working would come back idle. That's why a start rebuilds the fake data by
default.

## The pull request sample

`thread_changes` also reports a thread's pull request. To show a real one, make
a small public sample repo on GitHub with an open pull request, and give the
container its clone URL, the pull request's branch, and a read-only token:

```bash
-e DEMO_PR_REPO_URL=https://github.com/<owner>/<sample-repo>.git \
-e DEMO_PR_BRANCH=<branch-with-the-pull-request> \
-e GH_TOKEN=<read-only token>
```

A reset then clones it as a fourth project, "Pull request sample", with a
finished thread on that branch. Nothing in the image creates anything on
GitHub.

## Good to know

- `thread_changes` counts a thread's uncommitted work. After the agent commits
  and the checkout is clean, its totals read 0.
- `inbox` lists what finished or failed only while an assistant is connected,
  so the fake data built before the first connection shows up as live states
  only. Data from later resets shows up in full.
- Threadlines runs the agent through its Cursor driver, the one ACP driver
  that carries an agent's questions to the user (`thread_answer` needs that).
  Its own name replaces Cursor's everywhere a name is shown, and assistants
  never see a driver. In the Threadlines app on this computer it does sit under
  the Cursor driver's icon.
