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
| `--app-chrome-background` | 0.19  | 0.95  | window frame behind everything                   |
| `--background` (canvas)   | 0.228 | 0.98  | the thread, settings pages, full pages           |
| `--rail` / `--sidebar`    | 0.26  | 0.965 | the left sidebar and docked side panels          |
| `--card`                  | 0.292 | white | the composer box and raised items inside panels  |
| `--popover`               | 0.312 | white | menus, popovers, dialogs, toasts (with a shadow) |

- **The workspace is continuous.** The sidebar, the thread and the docked
  side panels (diff, source control, browser, tasks) sit edge to edge, joined
  by one `--border` line. No floating rounded panes, no gaps between regions.
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
| Text field (`Input`, `Textarea`, `InputGroup`, `NumberField`)                             | pressed in: `--field` fill and `--field-shadow` (inset ring plus a soft inner shadow), 6px radius.                                                                                                                                                                    |
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
  eyebrow labels.
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

## Spacing

| Where                                              | Value                                                           |
| -------------------------------------------------- | --------------------------------------------------------------- |
| Settings column                                    | max 720px (wide pages such as Plugins: 960px), 32px top padding |
| Page header to first section, and between sections | 28px                                                            |
| Section title to its group                         | 8px                                                             |
| Group rows                                         | 10px / 14px padding, at least 52px tall with a description      |
| Dense list rows (two-column grids)                 | 10px / 14px padding, at least 48px tall                         |

## Radii

Controls 6px (`rounded-lg`), groups 10px (`rounded-3xl`), the composer and
dialogs 12px (`rounded-4xl`), menus and popovers as the primitives draw them.
Nothing else gets a new radius.

## Light and dark

Every token has a light and a dark value; check both before shipping. In dark
mode solidity comes from a top highlight; in light mode from a hairline ring
and a soft drop, the way macOS draws its controls.

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

- The thread sidebar keeps today's inbox design exactly.
- Menus, popovers, hover cards and toasts keep their shadows (they float).
- The sign-in, error and connection screens keep their centered floating
  card: on an otherwise empty window it is a dialog.
- Plugin and app artwork may bring its own tile: it is the vendor's logo, not
  our decoration. Our own fallback glyphs are plain.

## Marketing site

The marketing site keeps its flat rules: structure from type, spacing and
hairlines; no cards except clickable tiles; one display-size element per page;
its own tokens (`--surface`, `--fg-*`).
