# Settings: Threads tab, default agent and room for new threads

Status: built, Oct 4 2026. Mockup Will approved: `/tmp/tl-settings-mockups/index.html`
(board "New layout"). Will's picks: new Threads tab; default room agents join
from the start (those threads have no revert, with a note); "subagent" means
the other agents in a room.

## What the user gets

1. **Agent** (Settings › Threads › New threads): the model and reasoning a new
   thread starts with. First choice "Last used" keeps today's behavior (the
   per-device sticky model). Reset returns to Last used.
2. **Room** (same section): other agents every new thread starts with, each
   with its own model, reasoning and optional name ("Reviewer"). Disabled with
   a note while Rooms is off. Note under the list: threads that start with
   other agents can't be reverted.
3. **Start in**: today's "New threads" Local / New worktree row, moved.
4. New tab layout, flat sections (no rounded cards) on every settings tab,
   left menu in three groups, shorter descriptions on General and Threads.

## Settings (contracts, server-owned)

`packages/contracts/src/settings.ts`, `ServerSettings`:

- `newThreadModelSelection: NullOr(ModelSelection)`, default `null` (= last used).
- `newThreadRoomAgents: Array(NewThreadRoomAgent)`, default `[]`, where
  `NewThreadRoomAgent = { modelSelection: ModelSelection, role?: RoomAgentRole }`.

Server-owned like `enableRooms`, so every device using the computer (phone link
included) gets the same defaults, and the ids name that computer's provider
instances. `ServerSettingsPatch` gets both keys as whole-value replacements;
`applyServerSettingsPatch` replaces them explicitly (deepMerge would merge a
stale `options` into a new selection and turns arrays into objects).

Settings page edits only the primary computer (as today for every server
setting). A draft on a saved computer reads that computer's settings.

## Applying defaults (web)

Every new-thread surface (sidebar button, hotkeys, palette, "/" landing, empty
states, PR view, chats view) goes through `useNewThreadState` in
`apps/web/src/hooks/useHandleNewThread.ts`, which calls `applyStickyState` in
its three branches (reuse stored empty draft, reuse current empty draft, mint
new). Each call becomes `applyNewThreadDefaults(draftId, projectRef.environmentId)`:

1. `applyStickyState(draftId)` as today.
2. Model: if the computer's `newThreadModelSelection` is set and usable, write it
   into the draft with `setModelSelection` (explicit options, so sticky options
   don't leak in). `setModelSelection` does not touch sticky state, so "Last
   used" still means the last model the user picked.
3. Room: if `newThreadRoomAgents` is non-empty and Rooms is on for that
   computer, replace the draft's room with fresh participants (new
   `ThreadParticipantId`s, handles from `nextRoomAgentName` numbered past the
   main agent's model name and earlier agents, as the picker's `add` does),
   keeping only usable agents. If the default room is empty, the draft's room
   is left alone (today's behavior). Agents in a draft are setup, not invested
   work, so re-applying on "new thread" matches how the model is re-applied.

"Usable" (pure function, new module `apps/web/src/newThreadDefaults.ts`):
skipped only when we know it can't run: that computer's provider list has
loaded and the instance is missing or turned off. Before providers load (the
"/" landing at startup) the default is trusted; the composer's existing
fallback handles a provider that turns out unusable, same as a stale sticky
model today. Server config for a computer is read at call time: the app-wide
`getServerConfig()` when it is the primary computer or its environment id
matches (on a phone it mirrors whichever paired computer is on screen), else
`useSavedEnvironmentRuntimeStore.getState().byId[id]?.serverConfig`.

The first send already creates the thread with the draft's room in one command
(`thread.create` participants), so nothing changes server-side.

## Settings UI

- `settingsNavigation.ts`: add `/settings/threads` (label Threads, MessagesSquare
  icon) to visible + hosted-static (phone) paths; order and groups:
  General, Threads, Archives | Providers, Plugins & Skills, Agent Instructions |
  Source Control, Connections, Keybindings. Groups drawn as thin dividers in
  `SettingsSidebarNav` and the mobile index (`settings.index.tsx`).
- New route `routes/settings.threads.tsx`, panel in new file
  `components/settings/ThreadsSettings.tsx`:
  - New threads: Agent, Room, Start in.
  - Rooms: Rooms switch, Agents bringing in other agents (moved).
  - Titles & writing: Writing model, Backup writing model (moved from General,
    renamed from "Text generation model").
  - When a thread is done: Wrap up merged threads, Confirm archive, Confirm
    delete (moved).
  - Phone (hosted-static) shows the same tab; computer-owned sections say
    "Applies to your paired computer" in the section description.
- General keeps: Appearance (theme, time format) · Chat & diffs (stream replies,
  changed files in chat, wrap diff lines, hide whitespace) · Dictation · This
  computer (keep awake, add project starts in, sites agents can visit, clear
  browser data) · Privacy & about (version + update track, usage analytics,
  diagnostics). Phone General drops the moved rows.
- Agent control: generalize `TextGenerationModelControl` into a
  `ModelSelectionControl` (picker + reasoning, `omitOptionIds` optional; the
  text-generation wrapper keeps omitting Ultracode). `ProviderModelPicker` gets
  two small optional props: `notice` passthrough (used for the "Last used" row
  at the top of the card) and `triggerContent` (used for the "Last used" button
  face and the "Add agent" button). Controlled `open` closes it after picks.
- Room list: one line per agent (picker + reasoning, name box committing on
  blur/Enter up to `ROOM_AGENT_ROLE_MAX_LENGTH`, remove button); "Add agent"
  picker. Warning line on an agent or the Agent row when that computer's
  provider is missing or off.
- `useSettingsRestore`: include both new keys (labels "New thread agent", "New
  thread room"); Restore defaults shows on Threads as well as General.
- Deep link `ComposerPullRequestRow` "Settings" → `/settings/threads#wrap-up-merged-threads`.
- `SettingsSection` / `SettingsRow` (settingsLayout.tsx): flat. No card border,
  background or shadow; a `--border` line under the section heading and
  hairlines between rows; heading and rows share one left edge. Applies to all
  tabs; every tab gets a visual pass for misaligned custom children. The
  Providers panel already strips the card via `contentClassName`.

## Hit every surface

- Entry points: all new-thread surfaces share `useNewThreadState`; settings on
  desktop rail, narrow-window index, phone index.
- Clients: web + desktop share the code; phone (hosted static) gets the tab.
- Providers: picker and reasoning come from each instance's own model list and
  traits, so every driver works; ACP drivers without reasoning just show no
  reasoning control.
- Contracts: two server setting keys + patch keys.
- Reverse states: Last used, reset buttons, remove agent, Rooms off disables
  the room default, Restore defaults covers both.

## Tests

- contracts/settings.test.ts: decode defaults; patch replaces (no stale options,
  array stays an array) via shared applyServerSettingsPatch test.
- newThreadDefaults unit tests: last used vs set, provider missing/off skip,
  providers not loaded trusts default, rooms off, handle numbering.
- composerDraftStore / useHandleNewThread browser test: new thread opens with
  the default model + room; reused empty draft gets it re-applied.
- SettingsPanels.browser.tsx: rows moved (update existing selectors), Threads
  tab renders, Room list add/remove/rename writes the setting, Rooms off
  disables; SettingsSidebarNav.test for order/groups.

## Changes after Sol's reviews (plan review: 7 findings; diff reviews: 4, 5 and 1; all verified and taken)

1. One atomic store action `applyNewThreadDefaults(target, { modelSelection, room })`
   replaces the separate calls. Model: sticky as today; if there is no sticky
   history the draft's model is cleared (it can only have come from an old
   default); a set default replaces that instance's entry exactly. Room: "new
   thread" always sets the draft room to the current default room, and clears it
   when the default room is empty (a removed default never lingers).
2. The default is written as-is, not through `setModelSelection` (which keeps old
   options when the new selection has none).
3. When the target computer's config hasn't arrived (cold start "/" landing,
   phone), the draft opens at once with the last-used model, and the
   computer's defaults follow when its settings come (at most 3 s), unless the
   user has started on the draft by then (typed, attached, picked a model or
   edited agents): late settings never override the user.
4. Defaults are applied after the draft is assigned to its project (the remap
   drops a room when the project changes). Moving a draft to another computer
   (composer's computer picker) applies that computer's room default, and its
   model default unless the user picked the model: drafts carry a persisted
   `modelPicked` flag, set by the composer's model and reasoning pickers and
   cleared when a new thread starts over. A request superseded by a newer one
   for the same draft (moved again) does nothing.
5. Agents are filtered against the computer's providers when applied (config is
   known after step 3), and the first send drops participants whose provider is
   missing or turned off, so a dead agent never becomes a permanent member.
6. "Implement in a new thread" adds the default room agents (its model stays the
   plan's agent, an explicit choice). Source Control review threads are native
   provider reviews and stay as they are.
7. Restore defaults also covers `wrapUpThreadsOnPullRequestSettled`.

## Not in scope

Editing a saved computer's settings from this page; a "Make default" action in
the chat model picker (pitched, not asked for); restyling copy on other tabs.
