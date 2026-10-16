# Muse Code

Muse Code is Meta's coding agent. Threadlines runs it through Muse's own app connection
(`muse serve`), so it uses your Muse plan the same way the `muse` command in your terminal does.

## Install, Update and Sign In

Open `Settings -> Providers` and turn Muse Code on.

- `Install` runs Meta's own installer (`curl -fsSL https://dev.meta.ai/install.sh | bash`, or the
  PowerShell installer on Windows). Threadlines never bundles Muse.
- `Update` uses the same updater the `muse` command uses. A Homebrew install updates with
  `brew upgrade --cask muse-code`; on Windows it runs the installer again.
- `Sign in` runs `muse login` and opens Meta's sign-in page. The sign-in is the same one your
  terminal uses, so there is no separate sign-out in Threadlines: run `muse logout` in a terminal.

Threadlines needs Muse Code 1.4.8 or newer. Muse updates itself in the background; Threadlines
stops that while a chat runs, so the program never changes under a running chat.

## Who Pays

| Signed in with                                          | Who pays                |
| ------------------------------------------------------- | ----------------------- |
| Your Meta account                                       | Your Muse plan          |
| A saved API key, or a key in the provider's environment | Per use, billed by Meta |

Muse uses an API key ahead of your Meta account whenever it has one. Threadlines ignores a
`META_API_KEY` it inherits from your shell, and by default refuses to run Muse on any key at all,
so a key saved long ago never bills you by surprise. If Threadlines can't tell how Muse is signed
in, it doesn't run Muse either, and the Muse Code row says so. To run on a key on purpose, turn on
`Allow API key billing` on the Muse Code row's `Account` tab.

## Share Chats for Training

Muse plans start in Contributor mode: Meta may use your chats to train its models, and in return
your plan lasts longer. With it off, your chats stay out of training and use your plan up faster.
Meta's terms say code you must keep confidential should not go to Contributor mode.

The switch is on the Muse Code row's `Account` tab, and the setup screen asks once. It is the same
setting as Muse's own (`contributor_mode_enabled` in `~/.config/muse/settings.json`), so changing
it in one place changes the other. A change applies to your next message; work already running
finishes under the old setting.

## Access Levels and Plan Mode

| Threadlines       | Muse                                                               |
| ----------------- | ------------------------------------------------------------------ |
| Supervised        | Ask me: edits inside the project run, commands and the rest ask    |
| Auto-accept edits | The same as Supervised                                             |
| Auto              | Auto-review: Muse's own reviewer decides, and asks you when unsure |
| Full access       | Unrestricted, sandbox off                                          |
| Plan mode         | Read-only: no file changes; the answer is a plan you can implement |

Muse's strictest setting never asks before edits inside the project: its sandbox keeps them
there. A compound command (`a && b`) is asked about part by part, so one command can ask more
than once; each request names its part.

Switching access level or plan mode restarts Muse for that chat between messages. If Muse is still
running background work (a subagent, a workflow, a background command), the switch waits: stop
the work or let it finish, then send again.

## What Works

Streaming replies and thinking summaries, commands with their output, file edits with line counts,
approvals (including multi-step ones), questions, subagents and workflows, background commands,
the to-do list, context usage and compaction, steering a running turn, Stop (which also stops
subagents, workflows and background commands), the browser panel and room tools, images, and your
plan's 5-hour and weekly usage on the Usage page.

## Known Limits

- Reverting a turn trims Threadlines' history only; Muse still remembers the reverted turns.
- Forking works from the latest turn. A fork from an earlier turn starts a new Muse chat from a
  recap instead.
- No extra accounts: Muse keeps one sign-in per computer.
- No side answers in rooms: Muse loads your own hooks, plugins and MCP servers in every chat, so a
  read-only side answer cannot be promised.
- Subagents' own conversations may show only their brief and result.
- After its answer, Muse can spend up to a minute on its own checks; the chat shows it working
  until Muse ends the turn.
- Windows is supported by Muse but not yet tested with Threadlines.
