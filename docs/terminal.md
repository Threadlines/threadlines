# The terminal in a thread

Each thread has a terminal drawer under the chat. Its shells run on the
server (`apps/server/src/terminal/`), and every device connected to that server
sees the same tabs. Suggested commands that run in it are described in
`terminal-command-runs.md`.

## Tabs belong to the server

The server keeps each thread's tab list: which tabs exist, in what order, the
number each one is called by ("Terminal 2", kept while the tab exists), and
the folder its shell started in. It lives next to the saved history, in
`<logs>/terminals/terminal_<thread>.tabs.json`. A thread whose history predates
tab lists gets one built from its history files the first time it is read, so
nobody loses a tab on upgrade. A tab joins the list when its shell first
starts and leaves it when it is killed, or when its shell exits cleanly
(`exit`). A shell that fails stays, with its output and how it ended, until
someone restarts or closes it, also after the server lets go of it to save
memory (its output is on disk; how it ended is kept beside the list).

Each device keeps only how it lays the drawer out: which tabs sit side by
side, the active tab, whether the drawer is open, its height
(`terminalStateStore.ts`). It takes the tab list from the server and never
switches tabs or opens the drawer because of something another device did. A
tab this device just opened stays in its list until the server lists it (a
minute at most). When a thread's last tabs close on another device, the
drawer closes here too, also on a device that comes back later with it saved
open; left open, it would start a shell and undo that. The
device that starts something (a script, a suggested command, a new
worktree's setup script) brings its tab forward itself.

## Opening a tab never stops it

`terminal.open` shows a tab as it is. A live shell is never stopped because
the thread's folder or environment changed (a checkout switch, a worktree);
the snapshot says where it really runs, and the drawer offers "Restart here".
With `attach`, open never makes a tab the server doesn't list (one closed on
another device stays closed) and leaves an ended shell ended. A device opens
every tab with `attach` except one it asked for itself: `+`, a split, or the
drawer opened on a thread without tabs. A tab the server made for it (a
script, a suggested command) is shown, not made. Restart starts a new shell
below the old output; Clear output empties it.

## Streams

A connection subscribes once with `mode: "metadata"`: a `catalog` of every
thread's tabs first, then `tabs` when a list changes, plus activity and
lifecycle events without output or history. A thread's output comes on its own
stream (`mode: "thread"`), held while something shows that thread
(`terminalStreams.ts`). It starts with `subscribed`, sent once the listener can
miss nothing: a tab opens after it, and opens again after every new one (a
reconnect, a restarted server), drawing itself from the server's copy. A
connection that falls behind (2,000 waiting events) has its output dropped and
then gets `resync`, which redraws its tabs (`threadStreamDelivery.ts`).

A tab opens once both are in: the `subscribed` marker and the tab lists, so
it knows whether the server lists it.

Older clients subscribe without a mode and get everything, as before. Older
servers ignore the mode and send everything on the first stream, so the
client takes output from there. A server says which kind it is
(`terminalTabLists` among its capabilities), and only a new one sends a
`catalog`, which always wins. Both are asked again when the connection comes
back, since the server may have been replaced. While neither has said, a tab
opens anyway after a moment.

## Who controls a tab

Two devices can show the same tab. The one someone is using controls it: it
claims the tab when its terminal gets focus or is typed in. Its size wins, and
only it answers the terminal's queries (cursor position, colors), so the shell
never reads a second answer as typing. Another device's resizes are ignored
until it claims the tab, or the controlling connection goes away; the server
remembers them, so typing there takes the tab over at that device's size.

## What a tab is doing

The server names a running command from the line typed at the shell's prompt,
and only there: the line editor's bracketed paste switch (`ESC[?2004h` and
`l`) says when a POSIX shell is reading a line while none of its commands runs
or is starting (a REPL or a shell over ssh turns the same switch on), and
PowerShell reads one whenever no command of it runs. Text typed into a running
program (a password for `sudo` or `ssh`) never becomes a label, nor does a
line begun before the prompt was back. When a shell doesn't say where its
prompt is, the label is the process name from the process table. A command
entered and not yet seen running or done marks the tab `commandPending`, so
killing or restarting it asks first; the device it was typed on asks from the
moment Enter is pressed, before the server has answered.

## After a restart

A shell never outlives the server, so a server that stops (an update, a crash,
a quit) stops whatever ran in it. The tab list keeps the line typed at the
prompt that is running in each tab, saved as it changes (`runningCommand`), so
even a crash leaves it behind. It is the line exactly as typed, and only when
every key could be followed: a line finished with Tab completion or taken
from history isn't kept, since running it again could run something else.
Nothing changes it once the server starts shutting down. When the server starts, a tab that had one
lists it as `interruptedCommand`, and the drawer offers "Run again"
(`terminal.resolveInterrupted`). The server types it in only on an empty line
with nothing running, and otherwise says why not. The offer goes, on every
device, once it is run, dismissed, a line is entered in the tab, or a
suggested command takes the tab. Every desktop question before Threadlines
restarts or quits (installing an update, quitting, changing how devices
connect in Settings) names the terminals still running something.

## History

Each tab keeps its last 5,000 lines and at most 1 MiB, so a progress bar that
redraws without ever printing a newline can't grow it forever. It is saved at
most every 750 ms per tab while output flows, and right away on close, exit,
restart and when the server shuts down. Every save carries a version, so a late save never overwrites
newer history or brings back a deleted file.

## The drawer

A header row holds the tabs (a dot and the running command, or how a failed
shell ended), `+`, find, split, a menu (Restart, Clear output, Kill) and hide.
A notice above a tab's output says when its shell started in another folder
or has ended. Cmd/Ctrl+F in the terminal finds in its output. On touch screens
a row of keys gives Esc, Tab, a sticky Ctrl, the arrows and Ctrl+C. Text size
and screen reader support are in Settings, General, Terminal; the command
palette has every terminal action.
