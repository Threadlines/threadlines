# Settings search

Status: plan, rev 2 (Oct 30 2026). Design approved by Will from the mockup
(option B, real controls in results, page not popover). Rev 2 takes Sol's ten
findings on rev 1 (see "Rev 2 changes" at the end).

## What the user gets

- A search field at the top of the settings menu (desktop) and above the
  section list (phone index). ⌘F (the `chat.find` binding) focuses it while
  Settings is open.
- Typing swaps the page for **Search results**: one group of matching rows,
  best match first. Each row is the **real row**: its switch, dropdown,
  field or button works right there. Under its description a gray line says
  where it lives ("General › Terminal") and, when an everyday word found it,
  why ("· matches “font size”"). Clicking that line opens the page and
  highlights the row (the existing place arrival, `#place=<id>&n=`).
- The menu stays put (option B): an "All results N" item on top, every
  section in its usual spot, sections with matches in foreground text with a
  count, the rest muted. Clicking a lit section narrows the results to it
  ("2 of 8 matches … in Plugins & Skills. Show all"); clicking a muted one
  leaves the search and opens that page.
- Esc in the field clears the search; Esc in an empty field leaves Settings,
  as Esc does today. Clearing returns to the page you were on.
- No matches: "No matches" / "Nothing in Settings matches “x”."
- The menu loses its bottom row (Back + version tag): the rail, the title
  row's back arrow and Esc already leave Settings; the rail's update button
  carries version and updates on desktop, and General › Privacy & about
  shows the version in a browser. The menu only renders where the rail does.
- Restore defaults hides while searching.

## What is searched

1. **Places** (`@threadlines/shared/appPlaces`): every settings row, section
   and settings page. The catalog already has titles, abouts, keywords,
   parents, `appliesWhen`, and every row renders with `data-place`.
2. **Providers**: each configured provider instance, by its name, its
   driver's name and its models' names (so "opus" finds Claude). Shown as a
   link row: the provider's mark, name and status line, opening
   `/settings/providers?instance=<id>` (the existing reveal).
3. **Keyboard shortcuts** (desktop app and web, not the phone app): each
   command by its label ("Terminal: Toggle"), with its keys. Link row opening
   Keybindings with the page's own filter seeded (`?q=<label>`, new
   `validateSearch` on that route).

Not searched by name: plugins, MCP connections, instruction files, devices
(skills are, see Rev 2). Their sections are places (Installed plugins, Skills, Connections,
Hooks, Instruction files, Devices that can use this computer…) with keywords,
so "mcp", "skills", "CLAUDE.md", "phone" land on the right section. Naming
each plugin or skill would need the extension inventory, and every inventory
read spawns provider processes on the server (`providerExtensions.ts`), so a
search must not trigger it.

## Matching (shared)

`packages/shared/src/placeSearch.ts`, used by the settings search and by the
server's `app_guide` (which keeps its own question-style scoring but takes
the tokenizer from here, so both read words the same way).

- Query words are AND-ed: every word must match some field. The last word
  matches as a prefix from its first letter (typing "te" already narrows);
  earlier words match whole words or prefixes of 2+ letters. Matching is at
  word starts only ("phone" never hits "microphone").
- Fields and weights: title 3, keywords 3, section title 2 (a row inherits
  its section's title, so "terminal" lists Terminal › Text size), about 1.
  Page titles are not inherited (otherwise "threads" lists every row on the
  Threads page); a page matches as its own entry.
- Rank: score, then a row before its section before its page, then catalog
  order. Shortcut entries rank below settings with equal score.
- Each match says whether its title matched and, if a keyword carried it,
  which keyword (for "· matches “dark mode”").
- Catalog: add keywords where everyday words differ from titles (theme: dark
  mode, light mode; terminal text size: font size, zoom; keep awake: sleep;
  usage analytics: telemetry; etc.).

## Real rows in results: the row registry

`apps/web/src/components/settings/settingsRowRegistry.tsx`:

```ts
type SettingsRowEntry =
  | { readonly kind: "live"; readonly Row: ComponentType; readonly shown?: (s: SettingsSurface) => boolean }
  | { readonly kind: "link"; readonly shown?: (s: SettingsSurface) => boolean };
// SettingsSurface = { phone: boolean (hosted phone app); electron: boolean }
export const SETTINGS_ROWS: Record<SettingsRowPlaceId, SettingsRowEntry>;
```

- **Live** rows are self-contained components that read their own state via
  hooks. Most already are (Threads, Stream replies, Keep awake, Terminal,
  Open links, Sites, Usage analytics, Clear browser data, Dictation, desktop
  background rows). The inline rows in `GeneralSettingsPanel`, the Archives
  cleanup rows, Source Control's rows and `WritingModelRows` (two rows in
  one) are split into one component each.
- **Link** rows are rows whose state belongs to their page (the Plugins
  scope picker's Advanced rows, Agent Instructions' project picker,
  Connections rows bound to the page's relay/network state, the outside
  agents rows). In results they draw as a plain row (title, about, path
  line, chevron) that opens the place.
- **Pages render the same components through the registry**
  (`<RegisteredSettingsRow place="general.agentsPanel" />`), which applies
  `shown`. So a page and the search agree on which rows exist on this
  surface; the conditions move out of page JSX into the registry.
- **Drift check** (extends `settingsPlaces.test.ts`): the registry's keys are
  exactly the catalog's rows on settings pages, and a live row's component
  renders `SettingsRow place=<its id>`.
- Sections and pages that match appear as link rows (Installed plugins,
  Community agents, Archived threads, Keybindings…).

`SettingsRow` reads a small context set only by the results list: when
present it draws the path line under the description and marks the query
words in the catalog title. Pages never set it, so they are unchanged.

## Where things live

- Query and narrowing scope: a small zustand store
  (`settingsSearchStore.ts`), cleared when the settings layout unmounts. The
  menu (in the app sidebar) and the content (`settings.tsx` layout) both read
  it. Not in the URL: every keystroke would be a navigation that re-renders
  every page's search selectors.
- Results: `settings.tsx` renders `SettingsSearchResults` while the query is
  non-empty and keeps the `<Outlet />` mounted but `hidden`, so a half-done
  page (a provider sign-in, a typed field) survives a search and clearing
  returns to it. The page's scroll position is saved and restored around the
  hide.
- The phone index (`settings.index.tsx`) uses the same store and results
  component; rows stack as they do on phone pages. The section pages on a
  phone keep their header (no field there).
- ⌘F: the settings layout resolves `chat.find` through the keybindings (no
  chat is mounted on Settings) and focuses the field. The Keybindings page
  drops its own ⌘F listener; its header filter stays as a click target and
  takes the new `?q=` seed.

## Tests

- shared: `placeSearch` (AND, last-word prefix, word starts only, section
  inheritance, page not inherited, keyword reason, ranking).
- web unit: registry drift check; providers and shortcuts entries.
- browser: type a query → a real switch in the results toggles the setting;
  the menu shows counts and narrows on click; a muted section opens its page;
  the path line opens the page and highlights the row; Esc clears then
  leaves; the phone index searches.
- server: `app_guide` tests stay green after the tokenizer move.

## Hit every surface

Desktop app and web (same layout), the phone (hosted app: phone surface,
index search), narrow desktop windows (index search, no menu). Command
palette: unchanged in this build (a settings result source there is a
follow-up idea, not asked for).

## Rev 2 changes (Sol's review of rev 1)

1. **One owner for results per layout.** Where the settings menu shows (the
   rail's breakpoint), the layout owns field and results and hides the
   `<Outlet />`. Where it doesn't (phone, narrow window), the index route
   owns both; nothing hides it. ⌘F on a narrow section page opens the index
   and focuses its field; with the settings list collapsed, ⌘F opens it first.
2. **Rows mounted twice share state.** `DesktopBackgroundRows` keeps a
   per-instance snapshot; it moves to one shared subscription and splits into
   one component per place. Terminal and Dictation split the same way.
3. **Two contracts.** `live` entries: one component, used by the page and by
   results. `link` entries: the page keeps its own JSX for the real row;
   results draw a link summary. Link entries are the agreed exceptions to
   "real controls" (heavy or page-owned): Connections' device and network
   rows, the outside-agents rows, Plugins › Advanced, Agent Instructions'
   project picker, Archive inactive threads now. Every other row is live.
4. **Availability is reactive and central.** `useSettingsPlaceShown()`
   answers "is this place on screen here" from the surface (phone app,
   desktop app), catalog `appliesWhen`, and live conditions (background
   running supported, dictation support and downloaded models, alerts
   support and paired computers, owner access and outside-agents
   capability). Row components and the search both ask it, so counts never
   include a row that renders nothing; sections and pages are filtered the
   same way.
5. **Catalog gaps filled, drift check strengthened.** New rows: Source
   Control › Version control › Fetch interval, and the three alert kinds.
   Checks: every catalog row on a settings page has a registry entry; every
   `<SettingsRow` in settings sources has a `place` unless it is on a short
   list of data-built rows; a live place's `place="<id>"` appears once (its
   component) and pages render it through `<SettingsPlaceRow place="<id>">`.
6. **Shortcut links land on a match.** The Keybindings filter also matches
   command labels; the seed (`?q=`) applies whenever it changes (the page may
   already be mounted) and opens the header filter.
7. **Leaving search through a result.** The path line clears query and scope
   first, then navigates with the place hash, so the arrival finds the page's
   row, not the result's. Saved scroll is restored only when a search is
   cleared in place, never over an arrival.
8. **Escape, centrally** (settings layout): an open popup consumes it first
   (`defaultPrevented`); else an active search clears; else editable targets
   other than the empty search field keep it; else Settings closes.
9. **Page words qualify, never enumerate.** A row's page title counts for a
   query word only when another word matched the row itself, so "source
   control pr templates" finds Follow PR templates while "threads" alone does
   not list the whole page.
10. **Phone results say where and for which computer.** On the phone app the
    path follows the phone layout (Stream replies and Usage analytics sit
    under This computer there), and computer-scoped places add "· your paired
    computer".

Also: the tokenizer shared with `app_guide` is only the word split (lowercase,
dotted names kept); the guide keeps its stop words, minimum length and
scoring. Skills are searched by name after all: provider snapshots already
carry them (`ServerProvider.skills`), so no inventory read is needed. They
link to Plugins & Skills › Skills. ⌘F respects `defaultPrevented` (shortcut
recording) and passes the real terminal context.
