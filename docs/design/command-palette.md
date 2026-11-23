# Command palette and app search

Status: plan, rev 3 (Nov 18 2026). Building started Nov 23 2026, step 1 first.
Line numbers are as of main at e5293cd83 (Nov 23); find code by name when
they have moved. Rev 2 took Sol's seven findings,
rev 3 takes Astra's fourteen (both listed at the end). Mockup:
`command-palette-mockup.html` beside this file. It works, so type in it.

## Why

The palette is two things at once: the app's search (the sidebar's Search
field opens it) and its command list. Today it does neither well. Seen in a
running app on Nov 17:

- It opens on 30 commands. Recent threads start at row 31 and the box shows 8
  rows.
- It doesn't know settings. "font size" and "dark mode" find only threads
  with those words. "diff", "model" and "theme" find nothing, though each has
  a shortcut or a screen.
- Typing a path (`/src/auth.ts`) silently turns the search into Add project,
  and Enter then creates a project.
- "No matching commands, projects, or threads" shows while the message search
  is still running. A computer that failed to answer and an incomplete result
  list are never mentioned.
- Groups have a fixed order (commands, projects, threads), so a thread named
  exactly what you typed sits under every command that mentions the word.

The causes are structural:

- Every command is typed by hand inside one component
  (`CommandPaletteDialog.tsx`, 3,289 lines, from line 1688). The app already
  keeps a list of every settings row (`appPlaces.ts`) and every shortcut
  command (`contracts/keybindings.ts`), and the palette reads neither. That
  is how the theme commands were written (`themePaletteItems.tsx`, #827) and
  never plugged in, while the docs and the app guide say they exist.
- The same component is the Add project wizard (folder browser, clone from
  GitHub/GitLab/URL, pick a computer) and the Codex conversation importer. It
  decides which one it is from the text in the field
  (`isFilesystemBrowseQuery`, line 750).
- Ranking runs inside each group (`CommandPalette.logic.ts:347`), and the
  thread search's `truncated` and `failedEnvironmentIds` are dropped at
  line 1142.

## What stays

The server's message index and its ranking, snippets and jump-to-message,
quoted phrases, the highlighted thread loading ahead of Enter, the
`commandPalette.toggle` binding, the `>` shorthand, project-scoped thread
search from the sidebar, lazy loading of the palette's body, the
open-generation guard in the store, and how a command runs today (see
"Running a command").

## What the user gets

1. **It opens on where you'd go.** Recent shows the five threads you last had
   open on this device, newest first, the one on screen left out, so Search
   then Enter goes back to the thread you just left. Suggested shows four
   commands, the ones you use most here. Before there is any history they are
   New thread, Toggle terminal, Toggle diff and Add project, as far as each
   applies. An "All commands" row follows.
2. **One search over four kinds of thing**: threads (titles and messages),
   commands, settings, projects. The group holding the best match comes
   first. In the All view each group shows five rows and a "Show all N" row.
3. **Filters**: All, Threads, Commands, Settings, Projects, under the field.
   While you type each shows how many rows it holds. Tab and Shift+Tab move
   between them. Typing `>` first switches to Commands and leaves the field
   empty, so the filter has one state. Every "Show all N" row switches to
   that group's filter.
4. **Settings results** are link rows with the setting's name and where it
   lives ("General › Terminal") on the right. Enter opens the page with the
   row lit (the existing place arrival). Providers and skills come along, as
   in Settings search. Live controls stay in Settings search.
5. **Every command the app has**, including the ones missing today (table
   below), named the same in the palette and on the Keybindings page.
6. **It says what it's doing.** "Searching messages" at the foot of the list
   until the message search for the text now in the field settles, and "No
   matches" only after. "Couldn't search <computer name>" when one didn't
   answer. "The search on <computer name> may be incomplete. Add a word to
   narrow it." when that computer stopped early.
7. **A path is a suggestion.** Typing one adds an "Add project at <path>" row
   on top, and results stay underneath. Add project and "Bring in Codex
   conversation" become dialogs of their own, opened by a command.
8. **Typos get a second chance.** When nothing matches, command and setting
   names are tried letter by letter in order ("stngs" finds Open Settings),
   under "Close matches".
9. **A flatter, bigger box**: one surface, 640px wide, about 13 one-line rows.

Archived threads stay out of search in this build. Finding them needs the
thread page to open an archived thread, which it can't today. See "Archived
threads, a later build".

## Design decisions

### 1. One command catalog, in `packages/shared`

`packages/shared/src/appCommands.ts`, data only (no React, no icons), in the
manner of `appPlaces.ts`:

```ts
interface AppCommandSpec {
  readonly title: string; // exactly what the palette row says
  readonly about?: string; // one sentence, shown on wide rows and to agents
  readonly group: "thread" | "panels" | "project" | "goTo" | "app";
  readonly keywords?: ReadonlyArray<string>;
  /** "list": Enter opens a list to pick from (projects, themes, scripts, computers). */
  readonly kind?: "action" | "list";
  /** List commands whose items are also found from the main search. */
  readonly itemsSearchable?: true;
  /** One entry for a numbered shortcut family; "{n}" in the title is the number. */
  readonly numbered?: true;
  readonly appliesWhen?: "desktop" | "notPhone";
}
export const APP_COMMANDS = { "terminal.toggle": {...}, ... } as const satisfies Record<string, AppCommandSpec>;
export type AppCommandId = keyof typeof APP_COMMANDS;
```

- A command that has a shortcut uses the shortcut's id as its own
  (`terminal.toggle`, `diff.toggle`, `chat.new`). A type check requires every
  static `KeybindingCommand` to be a catalog key. The numbered families
  (`thread.jump.N`, `modelPicker.jump.N`) share one `numbered` entry each,
  titled "Jump to thread {n}", so the Keybindings page still tells Jump 1
  from Jump 9. A new shortcut command without a name no longer compiles.
- It lives in shared and not in `apps/web` because the Keybindings page and
  settings search label commands from it, and `app_guide` can list it for
  agents later without another move.
- Components that load at startup (ChatView, ChatComposer, Sidebar, the
  thread route) import only its types (`import type { AppCommandId }`). The
  catalog's data is read only from lazy chunks (the palette, Settings), so it
  adds nothing to startup.
- A static catalog and not only commands declared by components, because the
  names must exist when the owning screen isn't mounted (Keybindings page,
  the guide, the drift tests), and a list you can read in one file is how
  omissions get noticed.

### 2. Handlers are registered by whoever owns the behavior

`apps/web/src/commands/commandHandlers.ts`:

```ts
useCommandHandlers({
  "terminal.toggle": { run: () => runTerminalCommand("toggle") },
  "composer.stash": attachmentsDisabled ? null : { run: stashCurrentPrompt },
  "thread.pullRequest": pr ? { run: openPr, title: `Open pull request #${pr.number}` } : null,
  "project.runScript": { items: scriptItems }, // a "list" command
});
```

**Registered means available.** A command with no handler right now is not
offered. This replaces the long `if (...) actionItems.push(...)` chain. Each
rule moves next to the code it protects, with its comment.

**A handler is the guarded way in, never the bare function.** The shortcut
and button paths check things before they act, and the palette must not skip
them:

- A command the palette offers today registers what today's palette path ends
  in. The terminal commands register ChatView's `runTerminalCommand(kind)`
  (line 5114), which opens a closed drawer for Find, and asks before
  restarting or killing a busy shell. They do not register the keyboard
  branch, which returns when the drawer is closed.
- A command new to the palette registers what its button or shortcut calls,
  with that path's guard as the availability rule. Stash is not offered while
  `attachmentsDisabled` (ChatComposer.tsx:2492). The table in section 4 names
  each guard.
- Thread menu commands keep going through `useThreadMenu`, with its
  confirmations.

**What a handler can say**:

- `title`, to override the catalog's (the PR number, "Hide sidebar" or "Show
  sidebar").
- `disabledReason`, when a row should show but not run.
- `keepOpen`, for a command that works inside the palette.
- `afterFocusReturns`, for a command that needs focus back in the page first
  (find in chat, screenshot, the terminal commands, Add agent).
- `opensDialog`, for a command that hands over to another dialog (Add
  project, Codex import, move thread). The palette then skips its usual
  return of focus to the composer.
- `run` may resolve to `"cancelled"` (the user said no to Archive or Delete,
  or closed a dialog). Use on this device is counted only for a run that was
  not cancelled.

**What the palette observes, and what stays fresh.** ChatView re-renders on
every streamed token, and the palette must still see a command arrive while
it is open (the pull request lookup is asynchronous, a script can be
renamed):

- Observable: per command its id, title, disabled reason and flags, and for a
  list each item's id, title, description and disabled state. The hook
  compares this description with the last one in a layout effect and notifies
  subscribers only when it differs. It checks an items array by reference
  first, so an owner that memoizes its items pays one comparison. A streamed
  token changes none of it, so nothing is published. The only subscriber is
  the open palette.
- Fresh: the `run` functions live in a ref replaced on every render and are
  read at the moment of use.
- An open list page draws from the current items, not a copy taken when it
  opened. A script renamed while its list is open shows its new name.
- Enter resolves the row again by id (command id, or list id plus item id)
  against the current handlers, takes the function, then closes. If the row
  is gone the palette does nothing. `PaletteCommandSources` unmounts with the
  palette, so a function looked up after the close would be missing.

**Running a command** keeps today's order (`executeItem`, line 2990). The
palette closes unless the handler says `keepOpen`, and calls `run` in the
same tick. Only `afterFocusReturns` commands wait one frame, which is the
`requestAnimationFrame` each of them does by hand today. A list command
pushes its page and stays open ("New thread in…" stays a list).

**Two places register**:

- Components that own state: ChatView (terminal, find, scripts, files,
  browser panel, pull request), the thread route (diff and the right-panel
  tabs, through its `selectTab`), ChatComposer (model picker, stash,
  screenshot, plan and default mode), Sidebar (previous and next thread).
  This removes `terminalCommands.ts` and `composerCommands.ts`, the stores
  that exist only so the palette can ask ChatView to do something.
- `PaletteCommandSources`, a component inside the palette's lazy chunk,
  mounted while the palette is open. It calls one hook per feature, each in
  the feature's own folder (`theme/ui/themeCommands.tsx`,
  `fleet/fleetCommands.ts`, `commands/navigationCommands.ts`,
  `commands/threadCommands.ts` over `useThreadMenu`). These need only stores
  and `navigate`, and nothing uses them while the palette is closed.

**The palette stops reading the whole open thread.** Today it subscribes to
it (`CommandPaletteDialog.tsx:582`) for its availability rules, so every
token re-renders the open palette. Once the rules live with their owners the
palette needs none of it. A source that still needs a fact about the thread
selects that one field.

Icons are in `commands/commandIcons.tsx` in the palette chunk, typed
`Record<AppCommandId, LucideIcon>`, so a command without an icon doesn't
compile.

**Not in this build:** the eight keyboard listeners (`resolveShortcutCommand`
call sites) stay where they are. Folding them into one dispatcher changes
capture order and terminal pass-through and deserves its own change.

### 3. Names: one per command

`commandLabel()` (`KeybindingsSettings.logic.ts:270`) invents labels from ids
("Terminal: Toggle"). It reads the catalog title instead ("Toggle terminal").
Project scripts keep "Run script: <name>". The Keybindings filter and
settings search's shortcut entries follow, since both go through
`commandLabel`. **Visible change** on the Keybindings page: the list is
grouped by the catalog's `group`, so related commands still sit together.

Tooltips and the rail keep their own words for now (`AppTitleBar.tsx`,
`NavigationRail.tsx`). Where one differs from the catalog, the builder lists
it in the PR for a later pass.

### 4. Commands to add

All have a real action today and no palette row:

| Command                                                                 | Registers                                                 | Offered when                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| Toggle diff                                                             | the route's `selectTab("diff")` / hide, as `onToggleRail` | a thread is open                                     |
| Show source control / agents / threads panel                            | the route's `selectTab(tab)`, which also updates the URL  | that tab is available for the thread                 |
| Switch model                                                            | `toggleModelPicker` on the composer handle                | a composer is mounted, no approval holds its toolbar |
| Stash message                                                           | `stashCurrentPrompt`                                      | not `attachmentsDisabled`                            |
| Plan mode / Default mode                                                | `handleInteractionModeChange`                             | a composer is mounted                                |
| Open in editor                                                          | `openIn(cwd, preferredEditor)`                            | `canOpenInEditor` (the app's own computer)           |
| New local thread                                                        | `startNewLocalThreadFromContext`                          | as `chat.newLocal`                                   |
| Previous thread / Next thread                                           | Sidebar's traversal                                       | the sidebar has an adjacent thread                   |
| Back / Forward                                                          | `appHistory`                                              | there is history that way                            |
| Run script… (list, searchable)                                          | `runProjectScript`                                        | the project has scripts                              |
| Browse project files                                                    | `openActiveFileViewer`                                    | as the header's button                               |
| Toggle browser panel                                                    | `handleToggleBrowser`                                     | desktop app, not a general chat                      |
| Open computer in Fleet… (list, searchable)                              | navigate to that computer's page                          | more than one computer                               |
| Change theme… (list, searchable), Edit theme colors…, Use default theme | `themePaletteItems.tsx`, rewritten as `themeCommands.tsx` | always                                               |
| Show wrapped threads                                                    | `setInboxWrappedOpen`                                     | the inbox is on screen                               |

"Open computer in Fleet…" replaces today's one row per computer
(`CommandPaletteDialog.tsx:2005`). A single command id can't be several rows,
so each computer is an item of a searchable list, titled "Open <name> in
Fleet" as today, and typing a computer's name still finds it from the main
search.

Left out on purpose, as today: mark unread, separate, put back, stop children
(the comment at `CommandPaletteDialog.tsx:492`). "Open archived threads" is
not a command. It is a settings place and the Settings source finds it.

### 5. Search: sources, then one ordering

`apps/web/src/commands/paletteSearch.ts`, pure and unit-tested. Input: query,
filter, each source's entries, the message matches. Output: ordered sections.

| Source   | Entries                                                 | Decides what matches                                    |
| -------- | ------------------------------------------------------- | ------------------------------------------------------- |
| Threads  | title, project name, branch (client), messages (server) | `searchRanking` (unchanged: substrings, quoted phrases) |
| Commands | offered commands, plus items of searchable lists        | `placeSearch.matchSearchFields`                         |
| Settings | `settingsSearchIndex` minus its shortcut entries        | `placeSearch` (as Settings does)                        |
| Projects | name and path                                           | `placeSearch`                                           |

Commands move from substring matching to the word-start matching Settings
uses. "term" finds Terminal, "phone" no longer finds "microphone", and both
searches read words the same way.

**Tiers.** Each source's matcher decides whether a row matches. A separate
pure function, `matchTier(queryWords, fields)`, then places every matched row
on one scale. It does not read the matchers' own flags or ranges, which don't
say enough: `analyzeSearchText` reports the first place a phrase occurs, so
"term" in "Longterm terminal" looks like a mid-word match, and
`matchSearchFields` names a keyword even when another word needed the
section. `matchTier` works from the row's fields and the query's words (lower
case, quotes removed):

- title
- second fields: a command's or setting's keywords, a thread's project name
  and branch
- third fields: description, section, where it lives, a project's path

A row takes the first tier it fits:

0. the title is the query
1. the title starts with the query
2. every query word begins a word of the title
3. every query word is somewhere in the title
4. every query word begins a word of the title or the second fields
5. anything else its matcher accepted without a message (words spread across
   title and third fields, a word inside a branch name)
6. only a message matched

Every matched row lands in a tier, because 5 and 6 catch the rest.

Rows inside a section sort by tier, then by the source's own score in its own
direction (lower is better for threads, higher for places), then for commands
by use on this device. Tier comes first because `placeSearch` weighs a title
word and a keyword the same, so by score alone a much-used command found by a
keyword ("Connect an agent" carries "terminal") could sit above Toggle
terminal for "term".

Sections are ordered by their best row's tier. Ties go Threads, Commands,
Settings, Projects. Expected orders, all of them tests:

- "terminal", with a thread titled "Terminal": Threads (tier 0), then
  Commands (Toggle terminal, tier 2).
- "term", same data: Threads ("Terminal", tier 1), then Commands (tier 2).
- "term", thread "Longterm terminal" only: that thread is tier 2, and ties
  with Toggle terminal go to Threads.
- "term", no thread with it in a title: Commands first, and a thread that
  only mentions terminals in a message is tier 6.
- "toggle t": Commands (Toggle terminal, tier 1).
- "inal ror", thread "Terminal error": found, tier 3, below any tier 2.
- "payments", thread on branch `fix/payments` with another title: found,
  tier 4.
- "dark terminal", a setting with keyword "dark" in section Terminal: tier 5.
- "font size": the thread with those words in its title (tier 2), then
  Settings (Text size, by keyword, tier 4).
- `"font size"` in quotes: the same tiers as without them.
- A message match never sits above a title match in its section.

**Close matches.** Only when the whole result is empty and the query has
three letters or more, an in-order letter match (`scoreSubsequenceMatch`,
already in `searchRanking.ts`) over command and setting titles.

**The Settings source must behave as Settings search does.** Three things
today exist only inside the settings layout:

- Which places exist. `settingsSearchIndex` asks `SettingsSurfaceContext` and
  `SettingsPlaceSignalsProvider` (`routes/settings.tsx:158`). Outside them
  the defaults are the full desktop set with optimistic signals, so a hosted
  phone would be offered Keybindings. Both move into one
  `SettingsAvailabilityProvider` that the settings layout and the open
  palette mount with the same inputs.
- The reach probe. The one-time-link row depends on a check that runs only
  while the settings search store is active
  (`settingsPlaceAvailability.tsx:164`, `:204`). The provider takes "a search
  is active" and its session number from its host: the settings store in
  Settings, the palette's open generation in the palette.
- Where a result goes. Providers open `?instance=`, skills open the Skills
  section, places use the place arrival. That resolution moves out of
  `SettingsSearch.tsx` into a shared function. Settings keeps navigating with
  `replace: true`. The palette navigates without it, so Back returns to the
  chat you searched from.

**Status lines.** `threadSearchReactQuery.ts` keeps each computer's outcome
instead of OR-ing them: answered, failed, or stopped early. The server's
`truncated` is true both when it found more than the limit and when its
candidate scan filled up (`ThreadSearch.ts:161`), so it never proves more
matches exist. The line therefore says "may be incomplete", and counts show
the rows actually found, never "50+". "Searching messages" shows while the
text in the field is long enough to search messages and its own request
hasn't answered, the debounce wait included. An answer to an earlier text
doesn't count.

### 6. What the device remembers

Two small persisted stores, per device, never sent anywhere:

- `commandUsageStore`: per command id (and list item id), a count and a
  last-used time. Feeds Suggested and the tie-break.
- recent thread visits: the last 20 thread keys in the order opened, written
  when the thread in the route changes, not on a re-render (extend
  `lastVisitedThreadRoute.ts`, which keeps one). Feeds Recent. Threads that
  no longer exist are skipped. With no history the list falls back to latest
  activity, as today.

### 7. Add project and Codex import leave the palette

Two dialogs, each with a small store that loads at startup and a body that
loads on first open, the way the palette's does: `addProject/addProjectStore.ts`
with `AddProjectDialog.tsx`, and `codexImport/codexImportStore.ts` with
`CodexSessionImportDialog.tsx`. Both draw with the same `ui/command` parts
under a title, so they look like the palette's siblings and keep their keys.
The code moves, about 1,400 lines. Nothing is redesigned.

**What Add project is opened with**, all taken when it opens:

- `selection`: the setup screen's "pick a folder for me" callback and its
  computer, which stays locked (`AgentSetupScreen.tsx:749`).
- `initialPath`: from the palette's path row.
- `relativeBase`: the open project's computer and folder. A typed relative
  path resolves against it and only on that computer. Without one, a relative
  path is refused as today.
- The target computer's OS decides what counts as a path (Windows drive
  letters), as `browseEnvironmentPlatform` does today.
- A cold start waits for the computer list. A hosted phone with no paired
  computer goes straight to the pairing guidance
  (`resolveAddProjectUnavailableGuidance`).

**What Codex import is opened with**: the project (computer, id, name,
folder), the account when there is more than one (its picker moves along),
and the runtime mode of the open thread or draft at that moment. Its
paginated query keeps its key (computer, account, folder, search text), and
Load more, a failed import and retry stay inside the dialog.

**A finished operation belongs to the session that started it.** Today a
clone awaits the server and then reads the selection from the store
(`CommandPaletteDialog.tsx:2518`, `:2723`), so closing and reopening for
something else mid-clone can hand the result to the wrong caller. A Codex
import navigates even when its palette is gone (`:1594`). In the new stores
every open is a session with an id. An operation captures its session (id,
selection callback, computer, project, where focus returns) when it starts.
When it finishes:

- What the server did stands. The project exists.
- The worktree-pickup offer and the wait for the project to reach the store
  stay as they are.
- The callback, the navigation and the close happen only if that session is
  still the open one. Otherwise a toast says what was added, with a button to
  open it.

**Shortcuts and focus while a dialog is open.** The listeners that stand
down for the palette check `useCommandPaletteStore.getState().open`
(`ChatView.tsx:5000`, `routes/_chat.tsx:45`, `AppSidebarLayout.tsx:86`,
`ChatComposer.tsx:2492`). Once these flows are their own dialogs that check
no longer covers them, and a terminal or new-thread shortcut would act behind
a clone in progress. A small module, `commands/shortcutBlock.ts`, answers "is
a dialog that owns the keyboard open" for the palette and both new dialogs.
Every one of those listeners asks it, and the palette's own toggle shortcut
stands down while either dialog is open. On close each dialog returns focus
to where it was opened from: the setup screen's button, the sidebar's button,
or the composer when the palette launched it. The palette does not also send
focus to the composer on the way (`opensDialog`, section 2).

`commandPaletteStore` loses `openAddProject`, `projectSelection` and the
add-project intent. Callers move to `addProjectStore`: Sidebar (two),
`NoActiveThreadState`, `AgentSetupScreen`, and the Add project command.

In the palette, a query that `isFilesystemBrowseQuery` accepts adds the row
"Add project at <path>", which opens the dialog with the path filled in. One
more Enter than today for people who add projects by typing a path. In
exchange the search field never becomes a form.

Whether Add project should be a different design altogether is a separate
question.

### 8. Look

Follows `design-language.md`. The mockup is the reference.

- One `--popover` surface, 12px radius, `elevate-overlay`. The inner bordered
  panel goes (a box in a box). Field, filters, a hairline, the list, a
  hairline, the footer.
- 640px wide (576 today), the list up to `min(440px, 60vh)`.
- Rows are one line, 32px: icon, title (13.5px, 500), then on the right what
  it belongs to (project, command group while searching All, settings path)
  and the age or shortcut in mono 10.5px. A message match adds its snippet as
  a second line. Thread rows keep the sidebar's status marks.
- Filters are plain text buttons. The chosen one takes the soft `--accent`
  fill. Counts in mono.
- Section labels 11.5px, sentence case.
- All secondary text is opaque `--muted-foreground`. Today's rows fade it
  (`/60`, `/70`, `/80`, `opacity-64`), which the design language rules out.
- Footer: Move, Enter with the highlighted row's verb (Open thread, Run, Go
  to setting), Tab for filters. No footer on touch.
- Phone: the box is full width under the top edge, the filters scroll
  sideways, and what a row belongs to moves to a second line under its
  title, so rows are finger-sized.
- Field placeholder: "Search threads, commands and settings".
- **The highlight follows the row, not the position.** When message matches
  arrive late, a row the user moved to stays highlighted by its identity even
  if rows are inserted above it. If the user hasn't moved, the highlight
  stays on the first row.
- **Escape in stages**: it clears the text, then the filter, then closes.

## Archived threads, a later build

Rev 2 put archived threads into search. Two reviews showed it is a feature
of its own, so it is out of these four steps. What it needs, for whoever
plans it:

- The thread page must open an archived thread. Today the route sends you
  Home when the thread isn't in the shell list
  (`_chat.$environmentId.$threadId.tsx:1065`), and archived threads never are
  (`ProjectionSnapshotQuery.ts:1088`).
- Archived titles and rows come from a separate request
  (`archivedThreadsState.ts`), which uses `Promise.all`, so one computer
  failing loses the others' lists.
- Which computers and projects to ask must come from the known computers and
  the sidebar's project members, not from active threads
  (`CommandPaletteDialog.tsx:1114`). A project with only archived threads is
  otherwise never asked.
- The server needs an `includeArchived` input, and its answer must say
  whether it honored it. An older server ignores the unknown key and returns
  an ordinary empty list, which would read as "nothing archived matches".
  Any new field on a match must be optional, or older computers' results
  stop decoding.

Until then, an empty search ends with a row that opens Settings › Archived
threads.

## Hit every surface

- **Entry points**: the sidebar Search field, the inbox search icon, the
  Search button on the empty screen, the shortcut, the desktop View menu,
  project-scoped search from a sidebar project (opens on Threads with the
  project named in the field's left edge, as today). Add project: both
  sidebar buttons, the empty screen, the setup screen, the command, the path
  row.
- **Clients**: web, desktop, a narrow browser, and the hosted phone app. The
  last two are different Settings surfaces and both get a test.
  Desktop-only commands use `appliesWhen`.
- **Providers**: nothing provider-shaped. "Bring in Codex conversation" keeps
  its rule (a workspace project with a Codex account).
- **Contracts**: nothing crosses the wire in these four steps, so linked
  computers on older versions see no change.
- **Reverse states**: Escape in stages. A list page goes back with Backspace
  on an empty field and its back arrow. Each new dialog closes back to where
  it was opened from.
- **The app guide**: topics that say "in the command palette" are checked
  against the catalog (theme colors, lead chat, move threads, worktrees), and
  a short "Search and commands" topic says what the palette finds and how
  the filters work.

## Build order

Each step is its own PR, in this order, since they all pass through
`CommandPaletteDialog.tsx`. Each leaves the app at least as good as it found
it.

1. **Add project and Codex import move out** (section 7), with the shortcut
   block, the session guard and the focus returns. No new behavior except the
   path row. The palette file drops to about 1,700 lines.
2. **Catalog and handlers, and a root that opens on threads** (sections 1 to
   4, and `commandUsageStore` from 6). Every existing command moves to its
   owner, the missing ones arrive, and Keybindings takes its names from the
   catalog. Adding fifteen commands to today's commands-first list would push
   recent threads further down, so this step also reorders the opening list,
   in today's look: Recent threads (five, by latest activity), then Suggested
   (four), then an "All commands" row that switches to the `>` view. The
   whole-thread subscription goes.
3. **Search core** (section 5, and thread visits from 6): `paletteSearch.ts`,
   the Settings and Projects sources, tiers, the status lines, close matches.
   Still today's look. Groups show every match as they do now (no caps), and
   `>` is the only filter. Nothing here needs a control that arrives later.
4. **The new look** (section 8): the box, filters, five-row caps with "Show
   all", rows, the highlight rule, staged Escape, phone.

Optional step 0, ten lines, if wanted before the rest: call
`useThemePaletteItems` in today's dialog so the theme commands the docs
promise exist now.

## Tests

- shared: catalog type checks (every shortcut command named, unique titles,
  numbered families labeled per number).
- web unit:
  - `matchTier` and `paletteSearch`: the expected orders in section 5,
    section caps, close matches only on an empty result, per-computer status.
    The existing `CommandPalette.logic` thread cases carry over unchanged.
  - handler registry: registered means offered, a guard withdraws a command
    (stash while attachments are disabled), a command registered while the
    palette is open appears, a renamed list item shows its new name in an
    open list, re-rendering with the same description notifies nobody, Enter
    on a row that has gone does nothing, a cancelled run isn't counted.
  - both dialog stores: an operation that finishes after its session closed
    or was replaced doesn't call the callback, navigate or close.
- browser:
  - `ChatView.palette.browser.tsx`: existing cases keep passing (the Add
    agent focus case included), with the new placeholder in step 4. The Add
    project and Codex import cases move to the new dialogs' specs.
  - New dialogs: a shortcut pressed while one is open does nothing behind it,
    the palette shortcut doesn't open over it, focus returns to the opener
    (setup, sidebar, composer), a relative path resolves on the project's
    computer, two Codex accounts show the picker.
  - Palette: opens on recent threads, a setting result lands on its row and
    Back returns to the chat, "Searching messages" shows before a slow search
    answers and "No matches" does not, a failed computer is named, a typed
    path keeps results and its row opens Add project, a late message match
    doesn't move the highlight off a row the user chose.
  - One test lists which commands are offered on a thread and on the home
    screen (the drift check for handlers).
  - Settings source on three setups: the desktop app with a reachable
    computer (the one-time-link row appears), a narrow browser, the hosted
    phone app (Keybindings is not offered).
  - The open palette commits no React renders while a reply streams, counted
    with a `Profiler` around it. `readAfterEachPaint` samples frames and
    can't count commits.
- Gates as usual, the browser suite included. `scripts/check-web-bundle-size.ts`
  must show no growth in what loads at startup. The builder checks that the
  new stores, which do load at startup, pull in neither dialog body nor the
  catalog's data.

## Risks

- **Step 2 moves about 40 availability rules.** Each has a reason in a
  comment today. A rule lost in the move offers a command that lands on
  "unsupported". The offered-commands browser test is the guard. The builder
  moves rules verbatim and lists any it changed.
- **Step 1 moves live flows.** Clone, lookup and import have pending, retry
  and cancel states that only a browser test exercises. The moved specs must
  pass unchanged apart from how the dialog is opened.
- **Command matching changes** from substrings to word starts. A habit like
  typing "erminal" stops working. "term" and "kill t" keep working. Called
  out in release notes.
- **Keybindings labels change** (section 3).
- **Settings results that lead nowhere.** If the palette's availability
  inputs ever differ from the settings layout's, it offers a row the page
  hides. Section 5 makes them one provider, and the three-setup test checks
  it.

## Follow-ups, not in this plan

- Archived threads in search (its own section above).
- One keyboard dispatcher over the handler registry, replacing the eight
  listeners, and the desktop menu's action strings typed from the catalog.
- Tooltips and the rail taking their words from the catalog.
- Actions on a result without opening it (rename, pin or archive the
  highlighted thread), which `useThreadMenu.describe` already supports for
  any thread.
- Composer slash commands (`/model`, `/theme`, `/plan`) reading the catalog.
- `app_guide` answering "what commands are there" from the catalog.
- A redesign of Add project.
- One shared inbox derivation that the Sidebar, the desktop badge, the alert
  sounds and the palette all read. Today each runs its own copy on every
  streamed token.

## As built: step 1 (Nov 23 2026)

Add project and Codex import are their own dialogs (`components/addProject/`,
`components/codexImport/`), and `CommandPaletteDialog.tsx` is 1,704 lines.
Where the build differs from section 7:

- **The folder for relative paths** is read by the dialog when it opens and
  kept, instead of each opener passing a `relativeBase`. Every entry point
  gets it the same way, and a route change behind the dialog can't move it.
- **No title row.** The dialogs keep the palette's look, with a folder icon
  in the field on the first step where the back arrow was. A title waits for
  step 4's new box.
- **More listeners stand down** than the plan listed: the sidebar's thread
  jumps, open-in-editor, Settings' Find and Escape, the Terminals page, and
  the desktop menu's "toggle command palette".
- **A cold start also waits for the saved computers**, or a second computer
  that loads late is never offered.
- **A repository lookup continues only if its step is still on screen**, so a
  late answer can't bring back a clone the user backed out of (Astra's review
  of the diff).
- **Startup grew 3.6 KB gzip** (904.9 KB of the 915 KB budget). The two
  stores and the focus helper are about 1 KB. The rest is the bundler
  splitting code that already loaded at startup into more files. Neither
  dialog body loads at startup.

## As built: step 2 (Nov 23 2026)

The catalog is `packages/shared/src/appCommands.ts`, the registry
`apps/web/src/commands/commandHandlers.ts`, and the palette reads only what
owners register. Where the build differs from sections 1 to 4:

- **No `appliesWhen` field.** Every "where" is a registration rule, so the
  catalog holds names only.
- **Toggle diff is "Toggle panel".** `diff.toggle` (the shortcut) shows or
  hides the side panel on the tab it was left on, which is also what the
  header's button does and says. "diff" is one of its keywords.
  "Show diff" (`panel.diff`) opens the diff tab itself, beside the other
  panel tabs.
- **Plan and build mode** are "Switch to plan mode" and "Switch to build
  mode", and only the one you're not in is offered.
- **Lead chats are a list**, "Go to lead chat…", with one item per project
  that has a lead; typing "lead" still finds each from the main search.
- **The thread's pull request** comes from the thread route's own answer (the
  one the Pull request tab shows), not a second lookup in the palette.
- **The panel's tabs** are offered on drafts too, through the draft route's
  own tab selector.
- **Rules changed rather than moved**, each because the command would
  otherwise land on nothing: Capture screenshot is hidden while a question
  holds the composer; on the Terminals page, Find, Clear, Restart and Kill
  need an open terminal; New local thread is offered wherever its shortcut
  works, Home included; Show wrapped threads only where the inbox and its
  shelf are on screen.
- **`opensDialog` is only Add project and Codex import.** Move, Move
  threads and Rename keep the palette's return of focus to the composer,
  because their dialogs give focus back to whatever had it when they opened.
- **A cancelled run** is reported by Archive and Delete (the thread menu),
  Restart and Kill on a thread's terminal (its confirmation), Add project and
  Codex import (closed without adding), and Capture screenshot. Other dialogs
  count as used once opened. A list item counts for its list too.
- **Streaming.** The palette's rows and its command sources commit nothing
  while a reply streams: the palette ignores a thread's last-activity time
  when it has a user message (`sidebarThreadSummariesListEqual`), and "can a
  general chat start" no longer lists every chat (`useStartGeneralChat`).
  Wrap up, Reopen and the lead commands are the exception. They need the
  inbox, which re-derives on every token, so their source is mounted beside
  the palette, outside the Profiler, and still recomputes per token while the
  palette is open, as the old palette did.
- **Startup** went from 904.9 KB to 904.7 KB gzip. The catalog's data, the
  icons and the palette's sources are not in it.
- **Words that differ from the catalog**, left for the later pass: the
  header's "Toggle terminal drawer" (Toggle terminal); the rail's
  Terminals, Fleet, Scheduled, Usage, Settings, General Chats and Pull
  Requests (each "Open …" here); the title row's Back and Forward (Go back,
  Go forward).

## Rev 2 changes (Sol's review of rev 1)

1. **Older linked computers.** A new field on a search match must be
   optional. (Rev 3 moved the archived work out, and the note stays in its
   section.)
2. **Archived titles.** Archived threads aren't in the thread list.
3. **The registry sees changes while open.** What is offered is published
   when it changes, and what runs stays in a ref.
4. **Settings results match Settings.** One availability provider for the
   settings layout and the palette.
5. **Tiers are complete.** Rows sort by tier before score, with the expected
   orders written down.
6. **Every group can expand, and steps stand alone.** A Projects filter, and
   caps move to step 4 with the filters.
7. **The cut-off line is true.** The limit is per computer.

## Rev 3 changes (Astra's review of rev 2)

1. **Archived results could send you Home.** The thread page redirects for a
   thread that isn't in the list. Archived search is now a later build.
2. **Shortcuts behind the new dialogs.** One "a dialog owns the keyboard"
   check for the palette and both dialogs, and focus returns to the opener.
3. **Results going to the wrong caller.** Each open is a session, and an
   operation's callback, navigation and close belong to its session.
4. **"Include archived" could quietly return nothing.** Recorded as a
   requirement of the later build.
5. **The incomplete-results line.** The server's flag doesn't prove more
   matches exist, so the line says "may be incomplete" and counts are real.
   "Searching messages" follows the text now in the field.
6. **Handlers are the guarded way in.** Stash, Find in terminal, Restart and
   Kill keep their checks, a cancelled run isn't counted, and commands run in
   today's order.
7. **Lists stay current.** Item names are observed, an open list redraws, and
   Enter resolves the row again by id.
8. **Tiers from fields, not matcher flags.** `matchTier` covers branch
   matches, mixed fields, quoted queries and the "Longterm terminal" case.
9. **Rows a single id can't hold.** Fleet's per-computer rows are list items,
   panel commands use the route's tab selector so the URL follows, and
   numbered shortcuts keep their numbers.
10. **Settings search outside Settings.** The reach probe gets its "search is
    active" signal, results resolve through one shared function, and the
    palette doesn't replace history.
11. **What each dialog is opened with** is written down, relative paths and
    Codex accounts included.
12. **Performance checks that measure the right thing.** The palette drops
    its whole-thread subscription, renders are counted with a Profiler, and
    the dialog bodies load on first open.
13. **Step 2 no longer makes opening Search worse.** The threads-first
    opening list and the usage store land with the catalog.
14. **The mockup agrees with the plan.** Counts match what is listed, `>`
    becomes the Commands filter, Escape works in stages, and the highlight
    follows the row.
