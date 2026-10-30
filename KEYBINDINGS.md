# Keybindings

Change shortcuts in **Settings › Keybindings**, or edit the file it saves to:

- `~/.threadlines/userdata/keybindings.json` (under `THREADLINES_HOME` if you set it)

The file must be a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts)

## Defaults

```json
[
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+f", "command": "terminal.find", "when": "terminalFocus" },
  { "key": "mod+d", "command": "diff.toggle", "when": "!terminalFocus" },
  { "key": "mod+k", "command": "commandPalette.toggle", "when": "!terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+o", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "chat.newLocal", "when": "!terminalFocus" },
  { "key": "mod+f", "command": "chat.find", "when": "!terminalFocus" },
  { "key": "mod+shift+m", "command": "modelPicker.toggle", "when": "!terminalFocus" },
  { "key": "mod+s", "command": "composer.stash", "when": "!terminalFocus" },
  { "key": "mod+o", "command": "editor.openFavorite" },
  { "key": "mod+b", "command": "sidebar.toggle", "when": "!terminalFocus" },
  { "key": "mod+shift+f", "command": "navigate.fleet", "when": "!terminalFocus" },
  { "key": "mod+shift+s", "command": "navigate.scheduled", "when": "!terminalFocus" },
  { "key": "mod+[", "command": "navigate.back", "when": "!terminalFocus" },
  { "key": "mod+]", "command": "navigate.forward", "when": "!terminalFocus" },
  { "key": "mod+shift+[", "command": "thread.previous" },
  { "key": "mod+shift+]", "command": "thread.next" }
]
```

`mod+1` through `mod+9` run `thread.jump.1` through `thread.jump.9`. While the
model picker is open (`"when": "modelPickerOpen"`), the same keys run
`modelPicker.jump.1` through `modelPicker.jump.9` instead.

The source of truth is [`DEFAULT_KEYBINDINGS` in `packages/shared/src/keybindings.ts`](packages/shared/src/keybindings.ts).

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `terminal.find`: search the focused terminal's output
- `diff.toggle`: show or hide the panel on the right of a thread (changes, browser, files and the other tabs)
- `commandPalette.toggle`: open or close the global command palette
- `chat.new`: create a new chat thread where the "Start in" setting says (Settings › Threads, default `local`). With `local`, a thread started from one in a worktree stays in that worktree
- `chat.newLocal`: create a new chat thread for the active project from the "Start in" setting alone, never continuing the active thread's worktree
- `chat.find`: find text in the current chat
- `modelPicker.toggle`: open or close the composer's model picker
- `modelPicker.jump.1` … `modelPicker.jump.9`: pick the model at that position in the open model picker
- `composer.stash`: stash the composer's prompt for later; with an empty composer, open the stash list
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `sidebar.toggle`: show or hide the sidebar list next to the left bar
- `navigate.fleet`: open Fleet
- `navigate.scheduled`: open Scheduled
- `navigate.back` / `navigate.forward`: go back or forward through the places you've opened
- `thread.previous` / `thread.next`: open the thread above or below the current one in the sidebar
- `thread.jump.1` … `thread.jump.9`: open the thread at that position in the sidebar
- `script.{id}.run`: run a project script by id (for example `script.test.run`)

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

### `when` Conditions

Currently available context keys:

- `terminalFocus`
- `terminalOpen`
- `modelPickerOpen`

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "terminalFocus || terminalOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
