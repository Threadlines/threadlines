# Running suggested commands from the chat

When an agent can't run a command itself (it needs your password or a sign-in,
its sandbox or permissions blocked it, or it's a dev server you should own), it
used to tell you to copy the command into a terminal. Threadlines lets you run
it from the chat instead, in the built-in terminal.

There are two ways a command reaches you:

- **A command code block in an agent's reply** gets a "Run in terminal" button
  next to its copy button (shown when you hover the block, always on touch
  screens), once the reply has finished. A block fenced as your terminal's
  shell (`bash`, `sh`, `zsh`, `shell`, `console`, or `powershell` on Windows)
  gets one. So does a block with no language, or one written for the other
  shell, when it calls a well-known program (`git`, `npm`, `pnpm`, `python`,
  `docker` and the like) with plain arguments that both shells read the same
  way. Anything with pipes, `&&`, variables, wildcards or escapes in such a
  block is left for you to copy.
- **A command card**: the agent calls `ask_user_to_run` with the command and a
  one-sentence reason. The card offers Run, Put in terminal and Skip. Skip
  folds it to one line you can undo. Like a page, the card is part of the
  answer: when the turn ends it sits right above the reply, after the steps.

Nothing runs until you click.

## Run, or put it in the terminal

**Run** starts the command in a terminal tab as its own process, so
Threadlines knows exactly when it ends and how (its exit code), and keeps its
output. The tab shows the command line, then the output as it comes, and stays
open as a normal shell afterwards. Ctrl+C stops the command, not the tab. Under the block or on the
card a line says how it is going: running, finished (and how long it took),
exited with a code, or stopped.

**Put in terminal** starts a fresh shell in a terminal tab, waits for its
prompt, and types the command there without pressing Enter. You check it, change it if you need
to, and press Enter yourself. From then on the tab is yours, like any line you
type, and Threadlines follows the command until the shell is back at its own
prompt. The line under it says it's running,
then that it ran and how long it took. A shell doesn't say how a command it
ran ended, so there's no exit code. Ctrl+C before Enter clears it ("Cleared
without running").

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

When you click **Run** on an agent's card, or put it in the terminal and press
Enter, the output goes back to that agent by itself when the command
finishes, as a message from you. For a command you put in, that's what the
tab showed from the moment it went in, so the agent also sees what you changed. If the agent is
still working, the message goes into its turn; if the turn is already
wrapping up, or the agent is idle, it goes out as the next turn, like a message
you type. It shows in the chat as one line ("You ran `pnpm install`
· Finished after 14s") that opens to the full text.

Everything else is sent by hand with **Send output to …**: a code block's run
or insert, or a command still going ("Send output so far", for a dev server
that never finishes, say; the rest then doesn't go by itself).
Output is the end of what the command printed, about 16,000 characters, with
progress bars collapsed to their last frame.

Output that would have gone back by itself is held, and says why, when:

- you pressed Stop after the command started (so a command finishing later
  never restarts work you stopped)
- you skipped the card
- the agent it was for left the room (it never goes to another agent)

You can still send held output by hand. If the agent's provider refuses the
message, the line says it didn't reach the agent and offers the send again.

## Where it runs

A run goes into the first free tab of the thread's terminal, and opens a new
tab only when none is free. A tab is free when nothing runs in it and you
haven't typed in it since its shell started: the thread's first tab before you
ever opened it, a tab you opened and left alone, or the tab an earlier run or
script left behind. The next run then starts below the earlier one's output, so
a few commands in a row share one tab. A tab you typed in (even answering a
command's question), one with a command still going, and one with any other
process on its terminal (a job an earlier command left in the background, or a
helper your prompt keeps) are never taken over. On Windows Threadlines can't
see which processes a tab holds, so only a tab whose shell never started gets
used there.

The Run buttons for your project's scripts in the chat header, and the setup
script a new worktree runs, take a free tab the same way. They type into the
shell that's there, so it also has to be in the folder and environment the
script needs. Clicking Run on the same script again, once it has finished, uses
the same tab.

Every run is in the thread's folder (its worktree when it
has one), with the same environment the terminal drawer gives any tab. On
macOS and Linux a command written for bash or zsh runs in your shell when it
is one of those, or in zsh, bash or sh otherwise, and the tab then carries on
in your own shell. On Windows commands run in PowerShell: a block written for
bash runs there only when it means the same in both shells, and can be copied
otherwise.

## Turning it off

Settings, Threads, Command requests turns off the agent tool: agents stop
getting `ask_user_to_run`, and cards already in threads stay. The Run buttons
on code blocks stay, since they only act when you click them.

## How it works

- `packages/shared/src/shellCommandSafety.ts` reads a command and decides Run,
  Put in terminal, or nothing. The server checks every run against it again.
- The terminal manager (`apps/server/src/terminal/`) picks the tab
  (`chooseFreeTab`) under the thread's terminal lock, from the tabs the client
  lists in drawer order. A tab counts as typed in once its shell gets any
  input other than the terminal's own replies (cursor and device reports,
  color answers) and scripts Threadlines types (`origin: "script"` writes). It
  is busy while a command typed into it may still run (until subprocess
  polling has seen it idle a few times), while a script that picked it is yet
  to be typed, and while `ps` shows any other process on its terminal or under
  its shell. The run is recorded (`onTabChosen`) before anything in the tab
  changes; a tab typed in meanwhile is left alone and the run fails. Taking a
  tab over stops its idle shell and keeps what it showed.
  It starts a run as
  `<shell> -i -c <wrapper>`. The wrapper, in `commandRunShell.ts`, takes the
  command from an environment variable, prints it dimmed and a start marker
  (output is kept from there, so shell startup noise and the echo stay out),
  runs it in a subshell, prints an end-of-run marker carrying the run id and
  exit status (OSC 6973, stripped from the terminal history), then execs a
  normal interactive shell. An insert
  waits for the shell's line editor to switch on bracketed paste, then pastes.
  After the user's Enter it is followed until the command it started ends.
  PowerShell's prompt marker says when. A POSIX shell that switches bracketed
  paste on and off says when its line editor reads again; the process table
  then says whether that's the shell's own prompt (it is the terminal's
  foreground job again, `+` in its `ps` state) or a program in front of it
  that reads lines too (a REPL, ssh, a nested shell), which keeps it going.
  A job left in the background isn't part of it, and a builtin waiting for
  input (`read`) runs until the prompt is back. A line typed ahead ends it at
  the first prompt when the shell takes that line right away there (an
  answer typed to the command, like an ssh password, doesn't count: the
  prompt that follows stays up). The output stops where that prompt began.
  Without shell hooks some cases still read wrong: a builtin with its own
  line editor (`read -e`, `vared`) or a shell without job control looks done
  early, and a command started within the moment it takes to check the
  process table keeps the run going until it ends too. A shell that never reports its
  line editor is done once polling sees nothing under it a few times. Its
  output is the tab's history from the insert on. When the tab can't follow
  the line just entered, the run stays "submitted", as every insert did on
  older servers (`followsInsertedCommands` tells clients which kind they
  have).
- Requests and runs are orchestration events (`thread.command-requested`,
  `thread.command-run-started`, `thread.command-run-updated`), kept in
  `projection_thread_command_requests` and `projection_thread_command_runs`.
  A run's output is a server-only event and column; clients never receive it.
  Reverting a turn drops its cards and runs; a fork starts without them, and
  its agent is told they existed.
- Sending output is one decision (`thread.command-run.deliver-output`) that
  either steers into the agent's running turn or queues the message, and marks
  the run sent in the same step. A provider that refuses a steer says why
  (`steerRejectedError` in `apps/server/src/provider/Errors.ts`): the turn
  ended, so the message becomes the next turn, or the turn is finishing, so it
  waits in the queue. Any other refusal takes the output back to "not sent"
  (`heldReason: "undelivered"`). A server restart marks runs it cut off as
  stopped and sends any finished output that never went out.
- `ask_user_to_run` is served at `/mcp/commands` (`threadlines_commands`), its
  own MCP server so Codex can approve it without asking, as pages do.
