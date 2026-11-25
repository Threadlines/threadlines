# Threadlines design language: quiet workspace, native controls

Status: approved by Will, Oct 5 2026 (mockup "G", kept in
`docs/design/design-language-directions.html`, board G). Applies to the app:
web, desktop and the phone view. The marketing site keeps its own rules (see
the end of this file).

## The idea

Threadlines is a workspace people sit in all day. It should feel like a calm,
well-made Mac app: one continuous surface to read and work on, quiet grouping
where settings and lists need it, and controls that look like controls.

Three rules carry the whole system:

1. **Quiet fills group related things. Borders mark only necessary
   boundaries. Shadows mean something floats above.**
2. **Controls in content are solid. Controls in toolbars and lists are plain
   until hover.** This is the line macOS draws. Content means settings,
   dialogs, setup flows, panel bodies, notices, empty states and forms inside
   popovers: there a control is a raised button, a dropdown, a switch or a
   pressed-in field. Toolbars and lists mean the chat header, composer chips,
   the sidebar, panel headers, row actions in lists and in the conversation,
   and menus: there a control has no fill until the pointer is on it.
3. **Icons are plain glyphs, never in tiles. Color means something:** on,
   selected, send, a provider's own mark, or a status. Nothing is colored for
   decoration.

Everything below is these rules made specific.

## Surfaces

The elevation ladder in `index.css` (deepest to highest; dark / light):

| Token                     | Dark  | Light | Used for                                         |
| ------------------------- | ----- | ----- | ------------------------------------------------ |
| `--app-chrome-background` | 0.19  | 0.95  | gutters behind panels, the setup screen's chrome |
| `--frame`                 | 0.26  | 0.95  | the window frame: the title row and the rail     |
| `--background` (canvas)   | 0.228 | 0.98  | the work panel: page lists, threads, full pages  |
| `--rail` / `--sidebar`    | 0.26  | 0.965 | docked side panels (diff, browser, tasks)        |
| `--card`                  | 0.292 | white | the composer box and raised items inside panels  |
| `--popover`               | 0.312 | white | menus, popovers, dialogs, toasts (with a shadow) |

- **A frame, and one work panel inside it.** The title row (window controls,
  the app's name, the list toggle, back, forward) and the navigation rail
  under it form one L-shaped frame in `--frame` that wraps the window's
  top-left. Everything you work in sits in one panel beside the rail: the
  page's list and the page share the canvas, split by a `--border` hairline,
  and the panel meets the frame with a hairline on its top and left and the
  one rounded corner in the app (top-left, 10px). It runs to the window's
  right and bottom edges. In dark mode the frame is a step lighter than the
  panel, never a black stripe; in light mode it is the soft grey around the
  near-white canvas. Muted text on the frame keeps 4.5:1 in both (5.4:1 dark,
  5.2:1 light).
- **The title row's right part belongs to the open page**, the way Mail,
  Notes and Finder put their toolbars in the title bar. After the app's name
  and the frame's own buttons, a page puts its header there
  (`TitleBarContent`): a thread's project, title and actions, Settings'
  Restore defaults. It starts over the page's content column (past the list
  while it shows, plus a header's 20px), never nearer the frame's buttons
  than 12px, and slides with the list on the list's own curve. It ends 12px
  from the window's edge on macOS and clear of the Windows and Linux window
  controls. Pages with no controls of their own (Fleet, Pull Requests,
  Usage) leave it empty. The work panel then has no header row at all.
  When the row runs short, the app's name folds away first; a header still
  too wide for what's left (measured: its chips and buttons, plus room for a
  thread's title) gets a row of its own under the title row. The desktop app
  keeps this layout at any window width, down to its 480px minimum; only a
  phone (a browser narrower than `md`) gets the page's own header with the
  sidebar trigger. Empty space in the row moves the window; its controls
  never do. The app's name leads the row, before the buttons, so it never
  reads as the first step of the page's project / title path.
- **The list floats in a narrow window.** When keeping the list beside the
  page would leave the page under 560px, the list floats over the page
  instead: closed until opened, shadowed because it floats, and put away by
  a press on the page, Escape, or picking something. The page doesn't move,
  and the user's choice to show the list beside the page waits for a wider
  window.
- **The work panel is continuous.** The list, the page and the docked side
  panels (diff, source control, browser, tasks) sit edge to edge inside it,
  joined by one `--border` line. No floating rounded panes, no gaps between
  regions.
- **Headers in the panel end in a fade, not a rule.** Where a page keeps a
  header in the panel (a narrow window), it has no bottom border; content scrolling under it passes into a short, light
  fade (`HeaderEdgeFade`), the same way the thread list's rows pass under its
  search row. On a thread the fade sits on the conversation itself, never on
  the browser or side panels docked beside it. A rule there would meet the list's divider in a square T, so
  the divider runs as one clean line from the panel's top to its bottom.
  (The phone header, with no list beside it, keeps its rule.)
- **Controls keep off a screen's side strips.** Some screens hold a strip
  back down a side: the notch side of a phone held sideways, and the status
  dock (clock, battery, signal) down the right edge of an iPhone Duo, folded
  or open. The strip runs the screen's whole height (`--safe-area-left` and
  `--safe-area-right` in `index.css`, 0 everywhere else), though the dock only
  hangs from the top of it. A surface that touches that side of the window
  carries its fill into the strip and keeps its content and controls out:
  headers, family tabs, the conversation, the scroll-to-bottom button, the
  composer, a page's body (`page-gutters`), the right panel's sheet, and a
  phone's bottom sheets.
  A layer fixed to the window (a dialog, a toast, the command palette) stays
  off it, and so does a menu or popover opening beside its button
  (`sideStrips.ts`).
- **Each destination brings its own list** (`destinationLists.tsx`): the
  thread inbox on Threads, your chats on General Chats, computers on Fleet,
  the sections on Settings. Pull Requests and Usage have none and take the
  panel's full width; the list toggle stays where it is, disabled. Hiding
  the list moves only the page's left edge: no button in the frame moves.
- **The composer is the one raised box on the canvas**: `--card`, 12px radius
  (`rounded-4xl`), a 1px `--border` line. In light mode it also keeps the
  soft `elevate-raised` drop, because a white box on the near-white canvas
  does not read without it; in dark the lighter fill is enough. Its own chips
  stay plain.
- **Things that float get a shadow**: menus and popovers use
  `elevate-popover`, dialogs and the command palette `elevate-overlay`.
  Nothing that sits in the page has a shadow, except the tiny one that makes
  a form control solid.

## Groups

A group is a quiet filled block holding related rows: a settings section, an
installed-plugins list, an agent's account details. It replaces both the old
bordered card and the fully flat list.

- Fill `--group`, radius 10px (`rounded-3xl`), a 1px inset ring
  `--group-ring`. No border line, no shadow.
- Rows inside are separated by inset hairlines (`--group-divider`) that start
  at the row's text edge and run to the group's right edge.
- The section title sits above the group, outside it, aligned with the row
  text (4px in from the group edge).
- Use `SettingsSection` / `SettingsRow` (`components/settings/settingsLayout.tsx`)
  or the `SettingsGroup` primitive they are built on. Custom rows inside a
  group take `SETTINGS_GROUP_ROW_CLASS` for the divider. Don't hand-roll the
  look.
- A list that must stay one keyed list while headings split it into groups
  (Providers: a row moving between "In use" and "Not in use" must not
  remount) marks its rows `data-group-row`; CSS in `index.css` draws the same
  group behind each run of rows.
- Anywhere else that needs the fill (a detail block in the conversation or in
  a dialog) uses the `surface-group` utility.

Groups are for settings and lists of like items on a page. The conversation,
the sidebar and side panels are already surfaces: inside them a group is only
for a bounded detail block (the changed files of a turn, a proposed plan, a
fork's carried-over context, a detail block in a panel), never to box
ordinary rows or prose.

Inside a group, secondary text is a step brighter in dark mode (the group
re-declares `--muted-foreground`), so descriptions keep 4.5:1 contrast even
in a group inside a dialog.

Cards (a filled, bordered, raised box) remain only for **clickable tiles**
(a choice between a few big options) and **input surfaces** (the composer).

## Controls

### Content controls: solid

Used in settings rows, dialogs, setup flows, panel bodies, notices, empty
states, forms inside popovers and detail blocks.

| Control                                                                                   | Look                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button (`variant="outline"`; the name is historical, it draws the solid button)           | `--control` fill, `--control-shadow` (a 0.5px top highlight in dark, a hairline ring in light, plus a 1px drop), 6px radius. Hover `--control-hover`; pressed, and while its menu is open, `--control-pressed` with `--control-shadow-pressed` (no drop).             |
| Primary button (`variant="default"`)                                                      | accent fill, white text, same highlight and drop. One per view at most: the action that completes the form (Save, Connect, Create).                                                                                                                                   |
| Destructive action (`variant="destructive-outline"`)                                      | a solid button with red text. A filled red button (`variant="destructive"`) only confirms inside a destructive alert dialog.                                                                                                                                          |
| Dropdown (`SelectTrigger`, `SelectButton`, menu and popover triggers drawn as a dropdown) | the solid button look with up-down chevrons on the right. Custom triggers end with `DropdownChevron` (`ui/select.tsx`): the up-down pair when solid, a small down chevron when plain.                                                                                 |
| Switch                                                                                    | 34x20 track (dense lists: 28x17), white knob with a soft drop. Off track `--switch-off`, on track the accent.                                                                                                                                                         |
| Checkbox and radio                                                                        | solid when empty, accent fill with a white mark when chosen.                                                                                                                                                                                                          |
| Text field (`Input`, `Textarea`, `InputGroup`, `NumberField`)                             | pressed in: a shallow slot, `--field` a shade off the group and `--field-shadow` (a thin inset ring and a thin shadow along the top edge), 6px radius. Placeholders are hints: `--placeholder` grey and italic (base layer), never mistaken for typed text.           |
| Segmented control (`SegmentedControl`)                                                    | a pressed-in track with 2px padding; the chosen segment is a raised solid piece, the others plain text. For 2 to 4 options that switch a filter or a mode. When the options are open-ended (provider accounts, projects) and can exceed four, use a dropdown instead. |

Heights: controls in a settings row are `size="sm"` (28px on desktop) or
`size="xs"` (24px) in dense lists. Pick one per row; never mix heights in a
single row.

Text fields are pressed in wherever they appear, toolbars included: a field
is a field.

### Which treatment: decide by role

Location alone is ambiguous (a settings page has headers and lists too), so
decide by what the control does:

| Role                                                              | Treatment                                      | Examples                                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Sets a value                                                      | solid                                          | a setting's switch, dropdown or field                                                         |
| Completes a form                                                  | primary (one per view)                         | Save, Connect, Create                                                                         |
| Acts on one item, shown at rest in content                        | solid                                          | Sign out on an account row, Use a reset, Browse catalog in a section header, a notice's Retry |
| Acts on one item, revealed on hover in a list or the conversation | plain                                          | Copy, Retry, Revert, Branch, a row's ⋯ menu                                                   |
| Acts on the whole page or panel, in its header                    | plain                                          | Check again, Open setup, Restore defaults, a panel's view toggles                             |
| Opens a row's detail                                              | plain chevron, or the whole row is the control | a plugin row, a provider row                                                                  |
| Menu item                                                         | plain                                          | everything inside a menu                                                                      |
| Sets a value inside a sentence                                    | inline picker (dotted underline)               | the new thread screen's setup line and its project name                                       |

### Toolbar and list controls: plain until hover

Chat header, composer chips, sidebar, panel headers, row actions (in lists and
in the conversation, such as Copy, Retry, Revert), menu items.

- `variant="ghost"`: no fill, no border. Hover and open/pressed get the
  `--accent` wash. Color shift only (no lift, scale or shadow).
- Icons are muted until hover.
- Toggles in a toolbar use `Toggle variant="default"` (plain; on is a
  `--control-active` fill). A mode switch with 2 to 4 options may be a
  segmented control, toolbars included.
- A toolbar never uses `outline` or `default` buttons. If one action in a
  toolbar must stand out, it is the only primary in the view (Send, Stop).

### Tabs

Page-level sections (Plugins / Skills, an agent's Account / Usage / Models)
use underline tabs: plain text, the chosen tab in `--foreground` with a 2px
underline, the rest in `--muted-foreground`. Not pills, not boxes.

### Pickers inside a sentence

Where a choice reads as part of a sentence ("What's next in _threadlines_?",
"Runs in _a new worktree_ from _main_"), the picker is the chosen value as
text with a dotted underline: no box, no chevron. Hover and open turn the
underline and the text to `--foreground`; the menu it opens is a normal menu.
Use `SelectInlineTrigger` (or `inlinePickerTriggerClassName` for a combobox
or menu trigger) from `ui/select.tsx`.

This is for a sentence the screen is built around, such as the new thread
screen. A settings row, a form or a toolbar uses the solid dropdown or the
plain chip, even when its label happens to read like a sentence.

## Type

| Role                                  | Size / line                | Weight | Color      |
| ------------------------------------- | -------------------------- | ------ | ---------- |
| Page title                            | 22 / 28, tracking -0.015em | 600    | foreground |
| Page description (optional, one line) | 13 / 18                    | 400    | muted      |
| Section title                         | 15 / 20                    | 600    | foreground |
| Section description (optional)        | 12.5 / 18                  | 400    | muted      |
| Row title                             | 13.5 / 19                  | 500    | foreground |
| Row description                       | 12.5 / 18                  | 400    | muted      |
| Meta (versions, dates, counts, ids)   | 10.5–11, `font-mono`       | 400    | muted      |

- One page title per page. Section titles are sentence case, not uppercase
  eyebrow labels. If a heading feels impressive, it is too big.
- Copy is scannable: lead with the feature name and keep descriptions to one
  sentence (about two rendered lines). Users skim changelogs and UIs; they
  don't read them.
- Secondary text is opaque `--muted-foreground`, never faded with opacity
  (`/70`, `/80`): faded grey falls under 4.5:1 contrast on the darker
  surfaces.
- Conversation text keeps today's size. The thread's density is its own
  decision.

## Color

- **One accent, "deep navy"** (`--primary`): the brand navy `#00347d` in
  light mode, and the same navy turned up one step in dark mode, where navy
  as is sinks into the dark surfaces. It is deliberately darker than the blue
  most apps use. It fills what is on or primary: switch and checkbox on, the
  send button, primary buttons, Plan mode's ring.
- **Two secondary blues.** Text blue (`--primary-readable`) for links, the
  update tag, the "working" label and the selected settings page's icon: it
  must be lighter than the accent in dark mode to be readable. Dot blue
  (`--primary-graph`) for unread dots, usage bars and charts: in dark mode it
  is the logo's own blue (`#6e94fa`), so the app and the logo share a color.
- Provider logos keep their own colors. Status uses `--success`,
  `--warning`, `--destructive` and only for status.
- Modes the user turned on may carry their own color as an "on" state: Plan
  mode's accent ring around the composer, Ultracode's violet.
- Selection that isn't "on" is neutral: the chosen segment of a segmented
  control is a raised grey piece, the open thread in the sidebar a soft fill.
- No colored icon tiles, no colored section icons, no tinted cards.

## Selection and hover

- Sidebar thread rows: soft `--sidebar-accent` fill on the open thread, no
  marker line.
- Settings menu: soft fill, and the item's icon turns accent blue. No marker
  line.
- Selected, hover and active are three distinct treatments, checked in dark
  mode (see `polish-checklist.md`).

## Loops

Anything that moves makes the browser draw the window again, and a loop left
to itself moves on every refresh of the screen. So a loop that never stops
must not move that often:

- A loop that glides (the working dots, the status word's sheen) sets
  `--loop-fps: 30` on its element. It is then shown 30 poses a second, in
  step with every other such loop so they share the same redraws, and 10
  while another app is in front (`lib/steppedLoops.ts`). The motion is
  its own, only sampled: each pose stands where the designed loop would be.
  Measured Nov 2026 on a 143 Hz screen, the working anchor's dots and sheen
  took 29% of a CPU core left to themselves and 10% stepped (four anchors:
  37% and 12%).
- A loop that moves in a few steps and rests between them (the thread halos,
  the status pulse: `steps()` in its keyframes) needs nothing. Those two
  together cost 4%, and stepping them at 30 would cost more.
- Motion that ends (a hop between states, a panel opening) runs at the
  screen's own rate.

## Spacing

| Where                                              | Value                                                           |
| -------------------------------------------------- | --------------------------------------------------------------- |
| Settings column                                    | max 720px (wide pages such as Plugins: 960px), 32px top padding |
| Page header to first section, and between sections | 28px                                                            |
| Section title to its group                         | 8px                                                             |
| Group rows                                         | 10px / 14px padding, at least 52px tall with a description      |
| Dense list rows (two-column grids)                 | 10px / 14px padding, at least 48px tall                         |

Keep tight vertical rhythm: if a page scrolls mostly through whitespace, shrink
the gaps, not the content.

## Radii

Controls 6px (`rounded-lg`), groups 10px (`rounded-3xl`), the composer and
dialogs 12px (`rounded-4xl`), menus and popovers as the primitives draw them.
Nothing else gets a new radius.

## Light and dark

Every token has a light and a dark value; check both before shipping. In dark
mode solidity comes from a top highlight; in light mode from a hairline ring
and a soft drop, the way macOS draws its controls.

Custom themes (docs/design/custom-themes.md) replace the color tokens with
one set derived from a theme's seed colors, on the base it names (light or
dark). Build with tokens and they follow. Two rules for surfaces under a
theme with live art: anything that must hide what scrolls beneath it (a
sticky header, a fade, a copy button over code) uses `--surface-solid`, never
`--background`, which glass makes see-through; and floating things (menus,
popovers, dialogs, toasts) stay opaque. A new token a theme should change
belongs in `THEME_TOKEN_NAMES` (packages/shared themes/tokens.ts) with its
derivation, and a new text-on-surface pair in `THEME_CONTRAST_PAIRS`.

New tokens (in `index.css`, next to the elevation ladder). Fills are
translucent so a group or control reads the same on the canvas, in a side
panel or inside a dialog.

| Token                               | Dark                                                 | Light                                                         |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `--group`                           | white 4.5%                                           | black 3.5%                                                    |
| `--group-ring`                      | white 5%                                             | black 5%                                                      |
| `--group-divider`                   | white 7%                                             | black 7%                                                      |
| `--control`                         | white 10%                                            | white                                                         |
| `--control-hover`                   | white 14%                                            | oklch 0.975                                                   |
| `--control-pressed`                 | white 7%                                             | oklch 0.95                                                    |
| `--control-shadow`                  | inset 0 0.5px 0 white 16%, 0 1px 1.5px black 35%     | 0 0 0 0.5px black 16%, 0 1px 1.5px black 10%                  |
| `--control-shadow-pressed`          | inset 0 0.5px 0 white 8%                             | 0 0 0 0.5px black 16% (the edge stays, the drop goes)         |
| `--field`                           | black 24%                                            | white                                                         |
| `--field-shadow`                    | inset 0 0 0 1px white 12%, inset 0 1px 2px black 30% | inset 0 0 0 1px black 18%, inset 0 1px 1px black 5%           |
| `--switch-off`                      | white 22%                                            | black 20%                                                     |
| `--segmented-track`                 | same as `--field`                                    | black 6% (a white field would swallow the white chosen piece) |
| `--muted-foreground` inside a group | oklch 0.74                                           | unchanged (0.5)                                               |
| `--app-accent-blue` (accent)        | oklch 0.48 0.18 261 (#1855c1)                        | `--brand-navy` (#00347d)                                      |
| `--primary-hover`                   | oklch 0.53 0.19 261                                  | oklch 0.4 0.15 260                                            |
| `--brand-navy`                      | #00347d                                              | same                                                          |

The accent is the brand navy: as is in light mode (white text on it is
11.7:1), and one step brighter in dark mode (white text 6.8:1), where an "on"
switch in plain navy is darker than an "off" one and nearly disappears into
the group behind it (1.3:1; the dark value reaches 2.2:1). Will chose navy
because blue is overused in UI; five options were compared before settling
on this one, so don't brighten it toward generic app blue. Hover and pressed
states of accent fills use the opaque `--primary-hover`, a step lighter,
never a translucent `bg-primary/90`. The thread sidebar's multi-select tint
and its update card use `--brand-navy` directly, so they look the same in
both modes and exactly as they did before this language.

Contrast targets, checked by compositing the translucent tokens over every
surface they can sit on (canvas, rail, card, popover): secondary text 4.5:1;
a switch's off track and a field's edge must stay visible against the group
(the light values above are the floor; they were raised after measuring
1.3:1).

## Where it lives

- Tokens: `apps/web/src/index.css`.
- Form controls: `components/ui/` (`button`, `select`, `switch`, `checkbox`,
  `radio-group`, `input`, `textarea`, `input-group`, `number-field`,
  `combobox`, `segmented-control`). Screens never restyle a control locally;
  if a control needs a new look, it becomes a variant here.
- Groups and settings pages: `components/settings/settingsLayout.tsx`
  (`SettingsPageHeader`, `SettingsSection`, `SettingsRow`, `SettingsGroup`).
- Underline tabs: `components/ui/page-tabs.tsx`.
- Pickers inside a sentence: `SelectInlineTrigger` in `components/ui/select.tsx`.

## Exceptions kept on purpose

- The thread inbox keeps today's row design exactly. The navigation rail at
  the window's left edge is part of the frame: plain toolbar buttons on
  `--frame` with New thread always first, the selected destination a soft
  `--sidebar-accent` fill (hover a lighter one, pressed between the two), and
  status color only in its counts (amber needs you, a blue dot for unread or
  work). Hiding the list keeps the rail and the title row as they are.
- The title row's and rail's buttons are 30px and 34px, every one with a
  tooltip that names it and gives its shortcut; a disabled one keeps its
  tooltip, which says why.
- Menus, popovers, hover cards and toasts keep their shadows (they float).
- The sign-in, error and connection screens keep their centered floating
  card: on an otherwise empty window it is a dialog.
- Plugin and app artwork may bring its own tile: it is the vendor's logo, not
  our decoration. Our own fallback glyphs are plain.

## Marketing site

The marketing site (`apps/marketing`) is quieter than the app and flatter:
structure from type, spacing and hairlines; no cards except clickable tiles.
The homepage has no eyebrow labels, pills or chips above its headings; the
other pages still carry their small labels until they are redone.

- **Light and dark follow the computer.** Every site token in
  `layouts/Layout.astro` (`--bg`, `--fg-*`, `--border`, `--surface`, ...) has a
  light and a dark value through `light-dark()`. The footer's System, Light,
  Dark control stores `tl-theme` (`light` or `dark`; System removes it), and
  the head script applies it and `theme-color` before first paint. The nav's
  sun and moon switch is the same choice in two parts: a radio group (arrow
  keys move and pick) that goes through the footer's handler, so the two, the
  `theme-color` tags and `tl-themechange` stay in step. Check every page in
  both.
- **The cloth.** Every page sits on a fine basket weave (`.page::before`,
  `--nt-weave`), quieter on phones; the homepage's help band is a twill on a
  slightly deeper cloth (`--nt-band`). Both are masks over a token color, so
  they follow light and dark.
- **Type.** Schibsted Grotesk; JetBrains Mono only for code-like detail.
  The homepage headline is the one display size. Below it, three sizes:
  headings (`clamp(2rem, 3.4vw, 2.75rem)`), body (18px) and small (14px).
  No text under 13px on the opening screen.
- **One primary button style.** Ink with white text in light, near-white
  with ink text in dark (`.btn`, `--btn-*`), at most one per section. The
  accent (hue 264) is for link hover, focus rings and live marks, never for
  buttons.
- **Nine threads.** The homepage is drawn as threads
  (`src/scripts/threads/`). Each of the nine agents has a logo at the top of
  the hero (`components/HeroAgents.astro`: two groups either side of the
  headline from 1060px, one row above it below that) and a thread in its own
  color (`--t0`..`--t8`: one lightness and chroma, nine hues). The threads
  frame the headline like gathered curtains, cross in the twist (two flat
  bands of separate lines crossing over and under twice, about 98px tall and
  41px wide), and run into a ring on the top edge of the live window, over
  the thread's name. A trunk leaves the window's bottom ring and runs down the
  page to the last Download button; at Rooms, Threads and Fleet colored
  strands leave it and tap back in through pieces of the app
  (`components/HelpFeatures.astro`), each of the six tools hangs off it on a short
  branch, and it draws itself in as the page scrolls. Wherever a strand
  stands for an agent it starts at that agent's logo, at every width: where a
  logo can't stand beside the trunk, room is kept for it above its panel.
  The geometry is pure and tested (`geometry.ts`); the hand-tuned numbers
  (the twist, the spring) live there and in `spring.ts`.
- **The heartbeat.** Each thread carries one round dot in its own color,
  one arrival a second. When one reaches the ring, the ring flashes, a
  ripple runs along the window's edge, the window's working dots answer in
  that color, and the bottom ring answers 380ms later; the pulse carries on
  down the trunk. Pulses share their thread's geometry (so they stay on a
  pulled string and pass under the front band at each crossing). Each is
  drawn on a short stretch (160px) cut from its lane and moved along it by
  dash offset; the stretch is cut again only when the pulse runs off it. One
  loop, at most 30 frames a second, timed by one clock: a pulse draws only
  while it is on screen, its flashes are timed by the same clock, the loop
  stops in a hidden tab and under reduced motion, and nothing comes back out
  of step. Flashes animate only opacity and transform; their color is set
  once per arrival. Measured in Chrome on a desktop Mac, with no theme art:
  about 35ms of main-thread time a second with the hero on screen and 33 at
  the help band (the app's "medium" for theme art), repainting under 0.6
  screens of pixels a second. Moving a dash along each whole line (the
  mockup's way) cost about 27 to 30ms a second but repainted 16 to 111
  screens a second; cutting the dashes afresh every frame cost more style
  work. Measure again if you add a lane or a flash.
- **Strings.** The hero threads behave like strings: a quick pass of the
  mouse flicks one a few pixels, a press stretches it up to about 28px, and
  it eases back. Paths are rewritten only while a thread is displaced, by one
  loop that stops at rest. Only a primary pointer that lands on a thread is
  captured, never on a link, button or text; text selection is turned off
  only while a string is held. Touch gets a small flick on a tap and nothing
  else, so scrolling and pinch zoom stay the browser's. Reduced motion: no
  ringing.
- **Starting early.** The threads script is inlined right after the hero
  (compiled at build by the `virtual:threads-boot` plugin in
  `astro.config.mjs`), so the drawing pours in as the hero paints, and
  starts the trunk once its markup exists. The first measurement is
  provisional: fonts loading, resize and rotation, the window crossing its
  breakpoints and a theme moving the thread's name all measure again without
  replaying the entrance or resetting the pulses. Without JavaScript nothing
  is drawn and the logos, text and window still stand.
- **The hero window is a live Threadlines window** (`components/HeroWindow.astro`),
  drawn in the page's own markup and themed by the app's theme code at build
  time (`lib/heroThemes.ts`): starters from `@threadlines/shared`, Showcase
  files kept byte for byte from Threadlines/themes in `src/themes/showcase/`
  (their SHA-256 is checked at build), and Honu Lagoon in `src/themes/`. Art
  runs in the app's own backdrop frame, driven the way the app's host drives
  it, at Glass 80 with the app's own slider math
  (`@threadlines/shared/themeGlassFloors`); panels are solid until the art
  draws, and stay solid if it can't. The pieces of the app down the page wear
  the same theme (`.hw-tokens`) and parts (`styles/window-parts.css`). The
  words around the picker (the line about asking an agent for a theme, each
  theme's line, the draft in the window's message box, the asks "Yours"
  types) live beside the theme list in `lib/heroThemes.ts`. The picker is a
  glass strip of theme tiles laid over the window just above its message
  box, each tile a small picture of the theme's art made at build time
  (`pages/hero/thumbs/`). It is the only control; the window under it is a
  picture (`role="img"`). Hovering a tile previews the theme, a click or the
  arrow keys keep it, and without scripts the strip is hidden. The frame and each theme's art load
  only after the page is idle.
- **Real stills elsewhere.** Sections show captures of the current app
  (`public/Screenshots/`), each with a hairline edge so dark captures sit on
  a light page. Pick the capture that shows what the text says.
- **No video until a click.** Demos open in a dialog and tool clips replace
  their still in place, both built on click. Nothing autoplays.
- **Motion** is one-time (the entrance, the threads pouring in, each panel
  playing once in view), 140 to 240ms on hover and focus with named
  properties in every `transition`, and the page is complete with reduced
  motion. What keeps running is the heartbeat and the hero art, each under
  its own frame-rate cap; both stop under reduced motion (the art draws one
  frame and holds).
