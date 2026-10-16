# Grok

Grok Build is xAI's coding agent. Threadlines runs the `grok` program you'd use in a terminal, so
your Grok settings, rules and skills come along.

## Install and Update

`Install` on the Grok row in `Settings -> Providers` runs xAI's own installer, stable channel:

```bash
# macOS and Linux
curl -fsSL https://x.ai/cli/install.sh | bash
# Windows (PowerShell)
irm https://x.ai/cli/install.ps1 | iex
```

It puts `grok` in `~/.grok/bin` and adds that folder to your shell profile, as it would in a
terminal. Threadlines finds it there straight away, with no restart. On macOS and Linux the install
doesn't link `grok` and `agent` into `~/.local/bin`, so Cursor's `agent` command stays Cursor's.

`Update` updates Grok the way it was installed: `brew upgrade --cask grok-build` for Homebrew,
`scoop update grok-cli` for Scoop, `winget upgrade --id xAI.GrokBuild -e` for WinGet, and
`grok update` for xAI's installer or npm. It never switches your release channel.

If `grok` lives somewhere else, set `Binary path` on the Configuration tab.

## Signing In

Open the Grok row and pick a method under `Sign-in method` on the `Account` tab.

| Method            | Who pays                         | What you need              |
| ----------------- | -------------------------------- | -------------------------- |
| Grok subscription | Your SuperGrok or X Premium plan | Your xAI account           |
| xAI API key       | Per use, billed by xAI           | A key from the xAI console |

Grok subscription is the default, and it's what `Sign in with Grok` on the setup screen and in the
chat uses. The setup screen's `Other ways` link opens the method choice in Settings.

### Grok Subscription

`Sign in with Grok` runs Grok's own sign-in, with no terminal. Threadlines opens xAI's sign-in page
with the code already filled in; approve it there. The page works from any device, so you can sign
in from a phone or another computer. Grok also opens the page on the computer that runs
Threadlines, so you may see it twice.

Now and then xAI sends the sign-in through a page that ends on an address only the Threadlines
computer can reach (`http://127.0.0.1:…`). If you signed in on another device, copy that address
into the field under the sign-in and press `Finish sign-in`.

The default Grok uses `~/.grok`, the same sign-in as Grok in your terminal. Signing in here signs
your terminal in too, and the other way around.

### xAI API Key

Pick `xAI API key`, paste a key from the [xAI console](https://console.x.ai), and press
`Switch to xAI API key`. xAI bills every request to you. The Usage page counts the tokens; the
xAI console shows what they cost.

The key is saved like every other Threadlines secret: in a private file on the computer that runs
Threadlines (readable only by your user account), never in `settings.json`, and never sent back to
the app. `Replace key` and `Remove key` are on the Account tab, and `Check key` checks the key.

Grok prefers a stored sign-in to a key, so a Grok on a key runs in a Grok folder of its own with
no sign-in in it. That folder links your settings, rules, skills and chats from `~/.grok`, so they
carry over, and your terminal's sign-in never takes the key's place.

With a Grok subscription, an xAI key in your shell (`XAI_API_KEY`) is kept away from Grok, so a
stray key can't bill you per use. A key saved on the provider stays saved when you switch back to
the subscription, ready for the next switch.

## Usage

On a Grok subscription, the Grok row, the model picker and the composer show how much of your
plan's credits this week (or month) are used, and when they reset. The numbers are xAI's own.
The Usage page counts Grok's tokens from its saved chats, whichever way it's billed.

## Extra Accounts

`Add another Grok account` (the Grok row, or the `+` at the top of the page) adds a second Grok
with its own folder (`GROK_HOME`) and its own sign-in, separate from the one your terminal uses.
Each account picks its own method.

Only an extra account has `Sign out`, on its Account tab. The default Grok has none: its sign-in is
your terminal's too, and Threadlines leaves it alone. Removing an extra account signs it out and
deletes the folder Threadlines made for it. An account in a folder you picked yourself keeps that
folder and its sign-in.

## What Threadlines Sets for Grok

- **No background updates.** Grok's own updater is off while Threadlines runs it, so the program
  never changes under a running chat. Updating is the `Update` click above.
- **Opening a project trusts it.** Grok loads the project's `AGENTS.md`, MCP servers and hooks, as
  Claude and Codex do. Hooks and MCP servers run code, so open only projects you trust.
- **Permission modes.** `Approval required` asks before commands and edits. `Auto` lets Grok's own
  check decide and asks about what it blocks. `Full access` approves everything. Grok has no mode
  that accepts edits only.
- **Plan mode.** The plan toggle puts Grok in its plan mode. A finished plan shows as a plan card,
  and Grok waits until you build or revise it from there.
- **Questions.** Questions Grok asks show as question cards.
- **Background shells and subagents.** Commands Grok runs in the background and the subagents it
  starts show in the chat. When they finish, Grok picks the chat back up by itself. `Stop` also
  stops it waking up for work the stopped turn left behind.
- **Models and reasoning.** The model picker lists Grok's own models, each with its own reasoning
  levels.
- **Revert and fork.** Reverting a turn restores your files and rewinds Grok's conversation to
  before that message, so Grok forgets what was reverted. Forking a chat copies Grok's conversation
  up to the fork point. When Grok can't place a message (one sent before this version of
  Threadlines), a revert says Grok still remembers, and a fork starts from a recap of the chat. So
  does a fork from a reply that Grok followed with one of its own.

## Not Supported Yet

- **MCP servers that ask you something.** A question from an MCP server mid-turn is declined, and
  the turn goes on.
