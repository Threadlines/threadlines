# Pi

Pi is an open-source coding agent ([pi.dev](https://pi.dev)) that works with almost any model
provider. Threadlines runs Pi in its app mode (`pi --mode rpc`), one Pi per chat, with a small
Threadlines extension loaded for approvals, plan mode and the room tools. Your own Pi settings,
extensions, skills and sign-ins apply as they do in your terminal.

## Install, Update and Sign In

Open `Settings -> Providers` and turn Pi on.

- If you have Pi 1.3.0 or newer (from Pi's installer, npm or Nix), Threadlines uses it.
- If you don't, `Install` puts Threadlines' own copy of Pi on this computer from npm, with
  Threadlines' own Node.js. You don't need Node.js yourself. A chat keeps the copy it started with
  until it restarts, so an update never changes Pi under a running chat.
- `Update` runs `pi update --self` for your own Pi (Nix: `nix profile upgrade pi`), and installs
  Pi's newest release for Threadlines' copy.
- `Sign in` lists what Pi can connect to: an account (ChatGPT, GitHub Copilot, SuperGrok and
  others) or an API key. Pick one and Threadlines takes the next step: it opens the sign-in page,
  shows the code to type when the provider uses one, or asks for the key in a password field. The
  setup screen asks the same in Pi's row; the chat sends you to Settings for it.
- Pi keeps the sign-in in its own folder (`~/.pi/agent`); Threadlines never reads it. A key you type
  goes straight to Pi, exactly as typed. (Pi's `!command` form for keys works only in Pi's own
  `/login`.)
- Claude Pro/Max is in the list, as it is in Pi's own `/login`. Anthropic bills Claude used through
  Pi from your plan's extra usage, not its included usage.
- To use Pi's own sign-in instead, open `Prefer your own terminal?`, choose `Open it here`, then
  type `/login`.
- An API key works without signing in: add it as an environment variable on the Pi row (for
  example `OPENAI_API_KEY`). Threadlines always stores it as a secret.

Pi is ready once it has at least one model it can use.

## Models and Thinking

The model picker lists every model Pi can use, grouped by provider, including ones your Pi
extensions add. `Pi default` is the model you set in Pi itself. The thinking picker offers the
levels each model supports.

Pi lists every model a provider has. Signed in with a ChatGPT plan, only the models Codex offers
run (GPT-6.1 Sol and its siblings); the others stop with an error from OpenAI. Pick one of them, or
set it as your default in Pi.

## Access Levels and Plan Mode

| Threadlines       | Pi                                                               |
| ----------------- | ---------------------------------------------------------------- |
| Supervised        | Reading runs; commands, file changes and other tools ask first   |
| Auto-accept edits | Reading and file changes run; commands and other tools ask first |
| Full access       | Everything runs                                                  |
| Plan mode         | Reading only; any change is declined and the answer is a plan    |

Pi has no Auto level. A chat set to Auto, for example by your default, runs as Auto-accept edits,
and the composer says so.

`Always allow this session` allows all file edits for the rest of the chat, or that exact command again.

Approvals are not a sandbox. Pi's own `!` shell commands and tools from other extensions don't
go through them. Pi loads a project's own extensions only if you trusted that project in Pi.

## What Works

Streaming replies and thinking, commands with their output, file edits with line counts,
approvals, questions from Pi extensions, steering a running turn, Stop, plan mode, revert (Pi
forgets reverted turns too), forking from any turn, compaction and context usage, Pi's skills and
prompt templates in the composer, the browser panel and room tools, images, chat titles and commit
messages, and Pi's spending on the Usage page.

## Known Limits

- No extra accounts: Pi keeps one folder of settings and sign-ins per computer.
- No side answers in rooms, reviews, goals or voice.
- A turn Pi starts by itself (from an extension) can't be reverted exactly. Threadlines trims its
  own history and says Pi still remembers.
- Pi's terminal-only commands (`/model`, `/login`, `/tree` and the like) don't run from the
  composer. Sign in from Settings instead.

## Moving From the Community Pi

If you added Pi from the community list (`pi-acp`), its row now says "Pi is now built in".
`Use the built-in Pi` turns the built-in one on and installs it if needed. The community copy keeps
working, and keeps getting updates, until you remove it. A chat moved to the built-in Pi continues
from a recap of the conversation.
