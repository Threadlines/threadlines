# Running suggested commands from the chat

When an agent can't run a command itself (it needs your password or a sign-in,
its sandbox or permissions blocked it, or it's a dev server you should own), it
used to tell you to copy the command into a terminal. Threadlines lets you run
it from the chat instead, in a new tab of the built-in terminal.

There are two ways a command reaches you:

- **A shell code block in an agent's reply** gets a "Run in terminal" button
  next to its copy button (shown when you hover the block, always on touch
  screens). Only blocks fenced as a shell (`bash`, `sh`, `zsh`, `shell`,
  `console`, or `powershell` on Windows) in a finished reply get one.
- **A command card**: the agent calls `ask_user_to_run` with the command and a
  one-sentence reason. The card offers Run, Put in terminal and Skip. Skip
  folds it to one line you can undo.

Nothing runs until you click.

## Run, or put it in the terminal

**Run** starts the command in a new terminal tab as its own process, so
Threadlines knows exactly when it ends and how (its exit code), and keeps its
output. The tab shows the output as it comes and stays open as a normal shell
afterwards. Ctrl+C stops the command, not the tab. Under the block or on the
card a line says how it is going: running, finished (and how long it took),
exited with a code, or stopped.

**Put in terminal** opens a new tab, waits for the shell's prompt, and types
the command there without pressing Enter. You check it, change it if you need
to, and press Enter yourself. Threadlines does not follow a command after you
press Enter; the line under it says it ran.

Only a command with nothing worth a second look gets a one-click Run. These
always go into the terminal for you to press Enter, with a plain reason shown
under them:

- anything that deletes or overwrites files, throws away uncommitted changes,
  deletes branches or rewrites history on the remote, or pushes commits
- `sudo` and other ways of running as administrator
- code piped from the internet into a shell (`curl … | sh` and the like)
- deleting databases, containers, cloud resources or backups; disk tools
- changing permissions on many files, stopping programs, changing system
  settings or services
- publishing or deploying, and changes on GitHub (merging, releases, comments)
- printing a secret (`gh auth token`, `printenv`, `cat .env`) or sending one
  over the network
- commands with blanks to fill in (`<your-token>`), more than one line, or that
  Threadlines couldn't read fully

The check reads the command the way a shell does, so `echo "rm -rf /"` is an
echo, not a delete. It is a speed bump with reasons, not a guarantee: a harmful
command can match no rule. Read what you run.

A command with hidden characters (control characters, invisible or
direction-changing Unicode) never goes to the terminal at all, because what
runs could differ from what you see.

## Sending the output back

When you click **Run** on an agent's card, the output goes back to that agent
by itself when the command finishes, as a message from you. If the agent is
still working, the message goes into its turn; otherwise it waits for it, like
a message you type. It shows in the chat as one line ("You ran `pnpm install`
· Finished after 14s") that opens to the full text.

Everything else is sent by hand with **Send output to …**: a code block's run,
a card you put in the terminal, or a run still going ("Send output so far").
Output is the end of what the command printed, about 16,000 characters, with
progress bars collapsed to their last frame.

Output that would have gone back by itself is held, and says why, when:

- you pressed Stop after the command started (so a command finishing later
  never restarts work you stopped)
- you skipped the card
- the agent it was for left the room (it never goes to another agent)

You can still send held output by hand.

## Where it runs

Each run gets a new terminal tab in the thread's folder (its worktree when it
has one), with the same environment the terminal drawer gives any tab. On
macOS and Linux a command written for bash or zsh runs in your shell when it
is one of those, or in zsh, bash or sh otherwise, and the tab then carries on
in your own shell. On Windows only PowerShell commands run; others can be
copied.

## Turning it off

Settings, Threads, Command requests turns off the agent tool: agents stop
getting `ask_user_to_run`, and cards already in threads stay. The Run buttons
on code blocks stay, since they only act when you click them.

## How it works

- `packages/shared/src/shellCommandSafety.ts` reads a command and decides Run,
  Put in terminal, or nothing. The server checks every run against it again.
- The terminal manager (`apps/server/src/terminal/`) starts a run as
  `<shell> -i -c <wrapper>`. The wrapper, in `commandRunShell.ts`, takes the
  command from an environment variable, runs it in a subshell, prints an
  end-of-run marker carrying the run id and exit status (OSC 6973, stripped
  from the terminal history), then execs a normal interactive shell. An insert
  waits for the shell's line editor to switch on bracketed paste, then pastes.
- Requests and runs are orchestration events (`thread.command-requested`,
  `thread.command-run-started`, `thread.command-run-updated`), kept in
  `projection_thread_command_requests` and `projection_thread_command_runs`.
  A run's output is a server-only event and column; clients never receive it.
  Reverting a turn drops its cards and runs; a fork starts without them, and
  its agent is told they existed.
- Sending output is one decision (`thread.command-run.deliver-output`) that
  either steers into the agent's running turn or queues the message, and marks
  the run sent in the same step. A server restart marks runs it cut off as
  stopped and sends any finished output that never went out.
- `ask_user_to_run` is served at `/mcp/commands` (`threadlines_commands`), its
  own MCP server so Codex can approve it without asking, as pages do.
