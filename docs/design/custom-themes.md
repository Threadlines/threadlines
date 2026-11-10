# Custom themes

Status: plan rev 4 (Nov 5 2026), approved by Will to build, including the
animation rule exception and the six starter names. Rev 4 adds the
Performance section (fast drawing modes, a frame rate that follows the window, the app
always wins, power and heat, energy labels). Sol's last check (four P2s) is folded in: the tint bound is a per-channel color box (now taken from
the blurred frost, patch by patch, on the GPU), it covers every text color drawn over glass, and WebGL2 failure
or context loss falls back to the still. Will's scope picks (Nov 5): colors,
live backdrop and glass, plus fonts; layout and spacing stay Threadlines'. Art
shows everywhere behind glass, with a setting for how much shows inside
threads. The art reacts to agent activity. Themes are files first, a public
gallery after. A theme is saved once and shows up on every device; each device
picks its own.

Rev 2 takes Sol's fourteen findings on rev 1. The big change: agent-written
art no longer runs in the frame that draws the glass. It runs in a worker
the frame can kill, and the frame (our code only) decides how much tint text
needs from the pixels the art actually drew. Also new: one trial protocol
for every way a theme gets applied, content-addressed storage with tombstones,
page-style per-turn offers, fonts embedded in the file, opaque sticky headers
and side panels, and the backdrop bridge typed in contracts.

Rev 3 takes Sol's seven on rev 2: the tint is measured as min/max on the
pixels actually shown, with every text area inside a zone's full-strength
core; the still fallback uses one layout-independent tint; worker replies are
matched by worker generation (their `source` is null); status and destructive
pairs match what badge and button render; the desktop CPU watchdog only acts
when the backdrop has its renderer to itself; library entries have their own
identity apart from content, with a total revision order for reconciling.

A throwaway prototype (CSS and a canvas injected into the dev app, not product
code) produced the screenshots this plan was tuned on, and a sandbox probe
checked the worker design in this Chromium build. Results are in "What the
prototypes proved".

## The problem

Today a user picks Light, Dark or System. People want the app they sit in all
day to feel like theirs, and agents are good at making art. A user should be
able to say "make Threadlines feel like a winter night" to any agent and get a
theme they can try, keep, share and delete. The theme must never cost them
readability, battery, or privacy, and a broken or hostile theme must not be
able to break the app.

## What a theme is

One file (`.threadlines-theme`, JSON). Everything except the name, base and
colors is optional.

| Layer    | What it holds                                                                                                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colors   | `base` (`light` or `dark`) plus about 12 seed colors (background, foreground, muted text, accent, accent text, border, success, warning, danger, info, code background, selection). Optional overrides for a listed subset of tokens, a code-syntax palette, a 16-color terminal palette. |
| Fonts    | Optional UI and mono font, embedded as woff2 bytes (at most 2 fonts, 400 KB each). An agent names a Google Fonts or Bunny family; the server downloads it once when the theme is first saved. After that the file is self-contained and works offline.                                    |
| Glass    | How much tint the frame, thread list, reading column and composer get (0 to 1), and the blur radius. Only used when there is a backdrop. These are floors the user's Glass slider moves; readability can raise them, never lower them.                                                    |
| Backdrop | Optional live art: a script for the draw contract below, a frame rate (12 to 30, default 24), and a still image the runtime captures.                                                                                                                                                     |

Also stored: `name`, `prompt` (what made it, for "Copy prompt"), `credits`
(author, an https link and a license, set when its author exports it; see
Sharing), `createdBy` (agent and thread, or "imported"), `createdAt`. The
**content hash** covers everything except name, prompt, origin and date,
over a canonical JSON form (credits count: a library stores content once per
hash, and a license belongs with the content it covers). Size limits: 3 MB per file, art script at
most 200 KB, an embedded font 400 KB, a still 1.5 MB of data URL and at most
4096 pixels a side (9.2 million in all). The check reads what embedded files
hold, not only what they say: a font must start as WOFF2, a still as a PNG
whose size header is within those limits.

`deriveThemeTokens(seeds, base)` in `packages/shared/src/themes/` expands the
seeds into the full token set (about 85 colors), following the elevation
ladder in `index.css` (frame, canvas, rail, card, popover in OKLCH lightness
steps from the seed background) and composing every `*-foreground` from the
seeds. Overrides may replace only listed tokens; every override goes through
the readability check again.

## What the user sees

**Asking an agent.** "Make me a theme like a winter night." The agent builds
it with `preview_theme` until the checks pass, then calls `show_theme`. A
theme row appears in the chat, in the family of agent page rows: a still
thumbnail, the name, "dark · live art", and **Try it**.

**Trying.** Every first application of a custom theme on a device is a
trial, wherever it starts (the chat row, the `/theme` strip, the Settings
gallery, an agent's `settings_change`, an imported file). A bar floats at
the top of the window: "Keep Aurora? Keep · Undo · switches back in 15s".
While the `/theme` picker shows a preview, the countdown waits (the picker's
✕ and Esc are its way back) and starts over if the picker closes another way.
Keep commits
it as this device's theme and saves it to the library. A new version of a
theme an agent already offered in that chat (show_theme on the same page)
updates the copy kept from an earlier version instead: the bar asks "Update
Speedcube?", with Keep both to add it as another entry (the /theme picker's
Keep reads Update then too). The theme records its offer (`createdBy.offer`,
the thread and page); the entry kept from it remembers it (`offerKey`, on the
entry since migration 107, set on save, never changed and carried through
merges, since two offers can make identical content, stored once; entries kept
before have none and aren't guessed from content). A Duplicate is the user's
own copy and doesn't take the offer. Of the entries kept from that offer, the
one changed last by revision order is updated; a new version identical to a
theme already kept switches to that one instead. Update is `themes.replace`: the same entry and name with the new
content, at a new revision, which reaches other computers like any change.
Like a rename, an update made where a delete on another computer hasn't
arrived yet wins over it and brings the entry back. Undo, Esc, the
countdown, reloading, or closing the window all leave the committed theme in
place. The bar and its buttons render with the built-in tokens, not the
candidate's, so they stay readable under any theme. Switching back to a
theme this device already kept skips the trial.

**Switching.** Four ways in:

- `/theme` in the composer opens a strip of thumbnails above the message box
  (built-ins, starters, yours, "New theme…"). Arrow keys or a click preview
  (a trial); Keep (shown while previewing), Enter or a second click keeps;
  the ✕ or Esc goes back. While a theme with art shows, the Glass slider sits
  beside the strip's title. The keys work without labels; the buttons'
  tooltips name them.
- Command palette: "Change theme…" submenu, and "Use default theme".
- Settings › Appearance, its own page since November 2026 (it had been a
  section of General, where the gallery filled the first screen): one Themes
  section with New theme and Import theme file on its title line; Glass (a
  slider, Solid to Clear, the theme's own in the middle) and Motion (Live,
  Still) side by side in one group, a compact form of their rows (the
  settings search still draws them as full rows); a line on the art (its cost
  here, or that the theme has none, always there so the gallery never moves);
  then the gallery under plain filters (All, Yours, Starters, Built in), yours
  first. A Showcase of shared themes would join it later as a second view.
- An agent asked to "switch to Meadow" uses `settings_change` on
  `appearance.theme`, whose choices become dynamic (System, Light, Dark and the
  library's names, checked like `model`). Accepting the card starts the same
  trial when the theme is new to this device; the device result reports the
  switch, and a later Undo is the user's own change.

**Library actions** (row menu in Settings): Rename, Duplicate, Export file…,
Copy prompt, Delete. Starters are read-only: their menu has Duplicate (a copy
in your themes, to change), Export file… and Copy prompt. Your themes come
first in the gallery and the picker; New theme sits in the Theme row and in
the picker's header.

**Escape hatches.** Command palette "Use default theme", desktop View menu
"Reset theme", and `?theme=default` on web bypass the saved choice. Settings
is reachable with ⌘, under any theme.

## Where the art shows

On the new-thread screen the art shows at full strength around a soft
frosted patch behind the heading, the composer and the links under it. The
home screen with no thread open (the first one a new user sees) works the
same way: a patch behind its heading, line and buttons, and one behind the
links under them. Where the new-thread screen keeps its composer at the
bottom (a phone, or a pane too small for the roomy layout,
`data-draft-stacked`), every line of text in the column gets its own patch
(whatever the column holds: a notice, the goal editor above the composer and
its fields, the line under it) and the composer its hard one, so the art shows there too,
beside a short line as well as between blocks. Lines are grouped into fewer
patches when there would be more than the frame's zones allow, and past that
the column is frosted whole. The moment the first message is sent the
patches give way to the reading column without the usual measuring wait.
Until Nov 9 that screen was frosted whole like a thread, which left a phone
no screen where the art showed clear.
Inside a thread the reading column (composer width plus a margin) is frosted
and tinted; the art shows crisp in the margins, and frosted through the
thread list, title row and rail. The Glass slider (`themeGlass`, 0 to 100,
a device setting) moves every surface's tint floor at once: frame, thread
list, column, composer and pages. 0 is Solid (every floor opaque), 50 the
theme's own glass, 100 Clear (no floor, no frost, no tint at all),
linear between. It replaced "Art in threads" (None, Some, Full, the reading
column only), whose choices carry over as 0, 50 and 75. Up to 75,
readability can always raise a tint. Text over the art keeps 4.5:1 up to
the theme's own, easing to 3:1 by 75; a theme whose `glass.readability` is
`relaxed` (art-first themes, where the look matters more than long reading,
Will's call for themes like Honu Lagoon) keeps 3:1 throughout. The last
quarter gives readability up on purpose (Will asked for a Clear that is
really clear, Nov 2026): its `clarity` (0 at 75, 1 at 100) fades the frost
and the tint readability adds over the floor, in the frame and in the CSS
over a still alike, so Clear shows the art as it is and busy art can make
text hard to read. Text on solid surfaces (sticky headers, code, menus)
keeps its checks either way. Dragging moves the glass live: the zones get
new floors, and the frame takes new text ratios and clarity with a `glass`
message instead of starting over; the setting is saved when the drag ends. Settings and every other page (Usage, Scheduled,
Pull requests, General chats, Fleet) work like a thread: each marks its
scrolling area and column (`glassPage.ts`), the column is frosted and tinted
the full height of the page at the column's floor, and the art shows
beside it. A page that marks nothing is
frosted whole, so art never shows raw behind its text. The composer and the panels it opens above itself (the theme picker, the
new-theme hint) are glass too, each over a patch rounded like its outline.

Opaque in glass mode: popovers, menus, dialogs, toasts, the diff, browser,
terminal and file panels (their renderers force their own fills, and code
reads best on a solid surface), sticky headers, and the trial bar.

## The backdrop runtime

Three layers, each knowing less than the one above:

1. **The app (trusted).** Owns a sandboxed iframe behind the window
   (`sandbox="allow-scripts"`, opaque origin, `inert`, `aria-hidden`,
   `tabindex=-1`, `pointer-events: none`), the still-image fallback, and the
   CSS that tints glass surfaces. It posts layout zones, activity state and
   motion settings to the frame and watches the frame's heartbeat.
2. **The frame (our code only).** A document built like the agent page wrapper
   (`packages/shared/src/agentPageDocument.ts`) but with no agent content in
   it: CSP `default-src 'none'; script-src 'unsafe-inline'; worker-src blob:`,
   WebRTC removed as in pages. It owns the visible canvas, runs the clock,
   composites, frosts and tints, and starts and kills the art worker. Nothing
   the art writes can reach this realm except decoded messages.
3. **The art worker (untrusted).** A dedicated worker made from a blob URL
   inside the frame, so it has the frame's opaque origin and inherits its CSP.
   A worker has no DOM, no navigable location, no WebRTC, and here no network.
   It gets our prelude, then the theme's script, which picks one of three
   drawing modes:

   ```js
   // Character grid: the theme fills cells, Threadlines draws them on the GPU.
   threadlines.backdrop({
     mode: "grid",
     cell: { width: 11, height: 15 },
     glyphs: " .·:;+=xX%#",
     // Optional: fontSize, fontWeight; gap: 1 or 2 device px of seam between
     // cells' backgrounds; background: up to 8 colors under the art (grid and
     // pixels), turned by backgroundAngle (CSS degrees, 180 by default).
     draw(grid, { t, dt, cols, rows, state, palette }) {
       // grid.glyph: Int16Array (index into glyphs, -1 = empty)
       // grid.fg, grid.bg: Uint8Array RGBA per cell
     },
   });

   // Pixel art: a small RGBA buffer, scaled up with crisp pixels.
   threadlines.backdrop({ mode: "pixels", width: 320, height: 180, draw(pixels, info) {} });

   // Free drawing on an OffscreenCanvas, under a stricter budget.
   threadlines.backdrop({ mode: "canvas", context: "2d", draw(ctx, info) {} });
   ```

   `grid` and `pixels` are the fast paths and what the starters use; see
   Performance.

**Frames are pulled, not pushed.** The frame sends a tick; the worker runs
`draw` once and answers with its buffers (grid, pixels; transferred, not
copied) or `transferToImageBitmap()` (canvas). The worker never decides when
to draw, so the frame rate is the frame's clock. Worker
replies carry no `source` (it is null for dedicated workers), so the frame
binds its handler to the current worker and tags every tick with a worker
generation; replies from an older generation are dropped. The prelude runs
before the theme's script in the same blob and removes `requestAnimationFrame`,
`Worker`, `SharedWorker` and `importScripts` and locks timers (setting and
clearing them, on the global and the prototypes above it), as defense in depth
(so art can't spread to more cores). The theme's top-level declarations
exist before any of the blob runs, so the prelude reaches the global only
through the blob's top-level `this`, takes each built-in it uses once, refusing
art that declared one of their names (the message names it), and keeps its own
copies: art can't swap its clock, its timers or its reply channel later
either. Its clock starts when a tick arrives and the posting of each frame
counts too, so work the art hides in a patched getter or iterator on that path
is counted, and an error the art made unreadable still goes out. Enforcement
does not depend on any of this:

- **Paused means terminated.** When the window is hidden or minimized, after 2
  minutes with no input and no agent working, under "Motion: Still", Reduce
  Motion, or on phones, the frame keeps the last bitmap and terminates the
  worker. A theme can't spend anything while paused, save one tail: a worker
  caught in a busy loop keeps its core for about 2 seconds after
  `terminate()` before Chromium forces it to stop. Resuming starts a new
  worker and continues `t` from where it stopped (setup runs again).
- **Still keeps the frame.** Under "Motion: Still" or Reduce Motion, and
  always on phones, the frame stays: it draws one frame of the art at the
  screen's own size (or keeps the one on screen when Still is chosen),
  terminates the worker, and stands on it,
  frosting and tinting it patch by patch like the live art, so Still keeps
  Live's colors and glass. It recomposites only when the layout moves, and
  draws one new frame once the window settles at a new size. Until its first
  frame, the app's 3-second watchdog expects progress as for live art. The
  first build removed the frame and showed the still image under one
  whole-page CSS tint, which washed busy art out. The cost is the frame's
  graphics memory while it stands. Art the computer found too heavy (the
  desktop CPU watchdog's last verdict) is still too, but loses its frame:
  the still image shows.
- **Phones draw for their own screen.** Phones never animate the art
  (battery), and until Nov 9 they showed the still image, a 1440×900 picture
  cropped to its middle, which is the calm part art keeps empty: art by an
  edge vanished. Now a phone runs the art in the frame as Still does, so the
  theme's script lays its scene out for the phone's width and height. The
  zones are remeasured when the on-screen keyboard shrinks or pans the
  visible page (`visualViewport`), which doesn't resize the window, so the
  standing frame recomposites without drawing again. Pixels art with a fixed
  width and height keeps its picture and is cropped around its middle to
  cover a tall screen; `scale` follows the screen. A frame that fails (no
  WebGL2, the watchdog) falls back to the still image, as anywhere.
- **Missed ticks.** A tick not answered within two frame intervals counts as a
  miss. Three misses in a row halve the frame rate; continued misses
  terminate the worker and show the still, with "Paused: this theme's art is
  too heavy for this computer" in Appearance and a "Try again" button.
- **The budget** covers the whole pipeline: the worker's work on the frame
  (the prelude times setup, draw and packing with a clock it took before the
  theme's script ran, and adds any work the art left queued in promise
  callbacks after the reply, to the next frame) plus the frame's own
  compositing. Not the round trip: in
  the desktop app the reply waits on a busy page, and that wait is not the
  art's cost (late replies still count as missed ticks). Over 5 seconds the art may use 60 ms of work a second (the heavy
  label's line) before stepping down, and steps back up under half of that.
  Per second, not per frame: a core that wakes a few times a second runs
  each frame slowly, and a per-frame limit held such art down for good.
  Over budget only ever slows the art, never stops it:
  a busy computer (a long build) makes light art look heavy too. Only missed
  ticks and the desktop CPU watchdog stop it. Canvas backing stores are capped (device pixel ratio
  at most 2, at most 4 megapixels; above that the art renders smaller and is
  scaled). Grids are capped at 20,000 cells, pixel buffers at 640×400.
- **Desktop CPU watchdog.** A worker that answers ticks on time but spins
  between them is invisible to tick timing. On desktop the main process finds
  the backdrop frame's OS process through `webFrameMain` and samples its CPU
  with `app.getAppMetrics()` every 2 seconds. Over 15% of a core for 10
  seconds halves the art's rate (`slowdown` in the conditions, a floor under
  the budget's own steps); another 10 seconds over halves it again, and only
  a third verdict sends the frame to still with the same notice. The process
  costs more than the art's own measure (a full-rate grid art read 3-4% by
  its clock and 8-11% by the process), so a theme near the line crossed it
  whenever the computer was busy, and stopping outright left the glass solid.
  A new theme or "Try again" starts over at full rate. Chromium groups
  sandboxed sibling frames into one process, and agent pages are sandboxed
  frames too, so each sample first checks that no other frame lives in that
  process; when one does, the sample is skipped (the watchdog never blames the
  backdrop for a page's work). If shared processes turn out to be the common
  case, the fallback is a dedicated `WebContentsView` under a transparent main
  view, decided during the build. In a plain browser there is no CPU signal;
  there the limits are ticks, pausing, and the same Activity Monitor any web
  page answers to. The guide says so.
- **Failure.** If `setup` or `draw` throws, the worker errors, the frame
  can't get a WebGL2 context, the context is lost (`webglcontextlost`; one
  restore is tried on `webglcontextrestored`), or the frame's heartbeat to
  the app stops for 3 seconds, the app removes the iframe and shows the
  still. The heartbeat carries the frame's last rendered frame number, so a
  frame that answers but has stopped drawing counts as failed too. In the probe, a busy loop in the worker and one in the
  sandboxed frame's own thread both left the app's timers on time (the
  sandboxed frame got its own process), so a hung theme can't freeze the app
  that removes it. The same probe in a window set up like the desktop main
  window (Electron 45.2.1, Nov 9) agrees: the frame got its own process, and
  a 3-second busy loop on its thread delayed the page's timers by 1 ms. The
  browser test suite's headless Chromium differs: there the frame shares the
  page's main thread, so tests see the frame's own work, and its waits on the
  GPU, in the page's timers.

**Frosting and tint happen in the frame.** The frame draws with WebGL2: the
grid as one instanced draw call over a glyph atlas built once, pixels as one
nearest-neighbor texture, canvas bitmaps as one texture. The app posts calm
zones (hard rectangles for the frame, list and composer, the composer's
rounded like its outline so no square corner of tint shows past it;
feathered shapes for the reading column and the new-thread patch) whenever
layout changes. The
frame blurs a quarter-resolution copy in a two-pass shader, masks it to the
zones and adds the tint, all on the GPU. Where the zones reach is drawn once,
when the zones or the window change, into a **zone mask** the size of the
canvas: zones that tint alike (the same color, floor and tint map channel)
form a class, each class has one channel (four to a layer), 1 inside a core
and under that how far a feather or an antialiased edge has faded. Every
frame's composite reads the mask instead of working each zone's shape out
again for each pixel, so a frame's cost no longer grows with the number of
zones (the first build's did: see Performance), only a little with a fifth
kind of zone, which takes a second layer. A layer is one more texture the
size of the canvas (33 MB at 4K). The tint is set **patch by patch**,
8 × 8 CSS px at a time, as the higher of the zone's floor and what readability
needs **for the frost just shown under that patch**:

- Every zone has a full-strength core that contains all text the app can put
  there (the app sends text areas, the frame adds the feather outside them),
  so feathering never thins the tint under text.
- The bound is a **per-channel box**, not a luminance range: the minimum and
  maximum of red, green and blue separately. Any blend of colors inside the
  box stays inside it, and luminance only grows with each channel, so the
  box's darkest and brightest corners bound every blended pixel. (A luminance
  range alone doesn't: pure red and a mid green can each pass against black
  text while their half-and-half blend fails.)
- The box comes from **the frost itself**, after the blur, on the GPU
  (`TINT_MAP_FS`): for each patch, the frosted texels any pixel there can
  sample, widened by one patch so reading the map between patches never dips
  under what a pixel needs. That is exactly what the screen shows under text,
  whatever the mode and whatever the art drew, and it lets the blur do its
  work: sharp dark glyphs next to bright water average out, and a patch over
  light water needs less tint than one over a dark creature. (The first build
  bounded the raw art over the blur's footprint, one tint per zone: safe, but
  every zone frosted for its darkest corner, nearly solid.) Text zones always
  get a blur of at least 8 px.
- A patch's tint is the lowest that keeps **every text color the app draws
  over glass** at its required ratio against both corners: foreground and
  muted text, link and accent text, and the status text colors (warnings
  render straight onto the reading surface, `MessagesTimeline.tsx`). The CPU
  folds those colors into two limits (how bright the glass must be for the
  dark ones, how dark for the light ones); the search steps up from the
  floor, since a color can pass, fail and pass again as the tint rises. The
  map holds four tint colors and floors, one per channel; a zone past the
  fourth stays opaque. Each channel is drawn only over the patches its zones
  can read (a zone's reach and a patch more each way, since the composite
  reads the map smoothed between patches). A theme's text colors set how far the art can show:
  darker status and accent colors on a light theme need far less frost.
- Nothing is read back to the CPU: the map is drawn and used in the same
  frame, so the tint is never a frame late and the GPU never waits on the page.

Because this runs in our code on what the art actually produced, it holds at
any size, at any moment, after any `turn-done` pulse, for any art, and its
cost counts against the budget. Zones still update while paused: the frame
recomposites and remeasures the kept bitmap.

**The fallback can't remeasure,** so it doesn't depend on layout: when the
app shows the still image (a failed frame, art found too heavy, the moment
before the frame draws), it computes one tint from
the per-channel box of the whole still and applies it to every text surface.
With no still, text surfaces are opaque.

CSS `backdrop-filter` is not used for glass: in this Electron build its blur
ignores `mask-image`, so a feathered column shows as a hard box (seen in the
prototype), and the art's frame would be read twice.

**State goes one way.** The app posts `{ working, waiting, idle }` counts
across every connected computer
(`selectRunningSidebarThreadsAcrossEnvironments`) and a `turn-done` pulse
(the Dock badge's finished signal). The frame passes them to `draw` as
`state`. The art never sees titles, text, paths or anything else.
`palette` is the theme's resolved colors.

**The bridge is typed.** `packages/contracts/src/themes.ts` defines
`BackdropHostMessage` (zones, state, pulse, size, motion, palette),
`BackdropFrameMessage` (ready, heartbeat, stats, still, failure) and the
frame↔worker messages, with bounded sizes. Each side decodes only the
direction it expects. The app accepts only messages whose `source` is its own
frame's window; the frame accepts only its parent's, and worker replies only
through the current worker's handler with the current generation.

## Performance

The risk is real but it isn't the app's smoothness: art never runs on the
app's thread (the probe showed a hung worker costs the app nothing). The
risk is battery, fans and the GPU on weaker machines, and the honu-style
approach (a `fillText` per glyph, every frame, a full-screen blur) is the
expensive way to do it. Measured in the prototype on the same Aurora art at
1440×900 @2x: 8.5 ms per frame drawn with `fillText` plus canvas blur, 0.7 ms
drawn as a GPU character grid (about 12 times less, the draw call itself
under 0.1 ms). The design leans on that:

- **Fast modes first.** Starters and the guide's examples use `grid` or
  `pixels`. `canvas` stays for art that needs it, under the stricter budget.
- **Frame rate follows where you are.** While the Threadlines window is in
  front, the art runs at the theme's own rate (at most 30): the first build
  ran 10 fps there, and moving art at 10 (5 on battery) reads as lag. Behind
  another app it drops to 10 fps, 15 while agents work, with a burst to the
  theme's rate for 2 seconds after a `turn-done` pulse. A theme can ask for
  less, never more than 30.
- **The app always wins.** While the user resizes the window or drags a
  divider, the layout changes every step (and with the window, the art's
  canvas), so the app posts `busy` and the frame holds its last frame. It
  resumes 400 ms after the last busy signal. Typing and scrolling don't hold
  the art. The first build held it for them too, and that freeze was the most
  visible thing about the art. Measured in Chromium on a MacBook Pro (Nov 6,
  production build, Aurora and Dunes against no art at all), keys took as
  long to show up (24 ms typical, 32 ms at worst) and scrolling dropped as
  many frames (6%) with the art running as with it held or off: it runs in
  its own process. A reply streaming into the open thread doesn't hold or
  slow it either: the same check with a stand-in agent streaming a long
  markdown reply dropped as few frames (2 to 4 in 5 seconds at 120 Hz) with
  the art at full rate as with it slowed to 12 fps or off. (The first build
  held the art for the whole reply, which read as a random freeze.)
- **Power and heat.** On battery the frame rate stays at or under 20 (desktop `powerMonitor`
  `on-battery`/`on-ac`; on web `navigator.getBattery()` where it exists). When
  macOS reports a `serious` or `critical` thermal state, or the CPU speed
  limit drops, the art goes still until it recovers.
- **Nothing runs unseen.** Hidden, minimized or fully covered windows, a
  full-window panel or Settings page over the art, and 2 idle minutes all
  terminate the worker. When the art resumes, a new worker starts the art's
  own state over (`setup` reruns), so the frame keeps a copy of the picture
  on screen and dissolves it into the restarted art over 500 ms instead of
  snapping. A theme's first frame (switching themes, turning Motion back on,
  which remounts the frame) fades the same way from the theme's still, which
  the app shows until then: `init` carries it, and the art waits up to a
  second for it to decode (the still shows meanwhile). A fade holds while
  the art is held or paused. The copy (one full-window texture) lives only
  for the fade.
- **An energy label.** The runtime keeps a running average of work per second
  (frame cost times frame rate, on the CPU: see The GPU's share). Appearance shows each theme's label on this
  computer (Light, Medium, Heavy) next to its thumbnail, and `preview_theme`
  reports the same number to the agent. Heavy themes step down on their own.
- **No GPU read backs.** Tints are worked out on the GPU from the frost
  (small passes at an eighth of the window, over each zone's patches) and
  used in the same frame.
- **The GPU's share.** The frame's own measure is its work on the CPU; what
  its draws cost the GPU shows nowhere in it, and on integrated graphics that
  is the larger part. Measured Nov 9 2026 on a 12700K, Tokyo Rain in a real
  Chrome window, each stage drawn in a loop that ends in a read back
  (milliseconds of GPU time a frame):

  | Canvas          | Zones        | RTX 3070 Ti, now | UHD 770, first build | UHD 770, now |
  | --------------- | ------------ | ---------------- | -------------------- | ------------ |
  | 1270×937        | 5 (3 kinds)  | 0.3              | 2.7                  | 1.5          |
  | 1270×937        | 12 (6 kinds) | 0.2              | 4.9                  | 1.8          |
  | 2560×1440       | 5            | 0.3              | 8.1                  | 4.0          |
  | 2560×1440       | 12           | 0.4              | 15.0                 | 5.0          |
  | 2880×1800 (@2x) | 5            | 0.5              | 10.0                 | 5.8          |
  | 3840×2160 (@2x) | 5            | 0.5              | 16.3                 | 8.9          |

  At 20 frames a second the first build took a third of the UHD 770 at 4K.
  Three things were most of it, and none changed the picture (a standing
  frame before and after differs by at most 2 of 255 a channel; where two
  overlapping zones' tints tie, the line between them can sit a pixel over):
  - The composite worked every zone's shape out for every pixel, every
    frame: 0.3 ms a zone at 1270×937 on the UHD 770, so a new-thread screen
    with a patch a line cost several times a thread. Now it reads the zone
    mask.
  - Every tint color's pass covered the whole window. Now each covers its
    own zones' patches.
  - The quarter-resolution copy was read from the art's smaller copies,
    rebuilt whole every frame. Now it averages the art itself, and the
    smaller copies are made only when a still is captured.

  A grid whose cells all paint their own background and reach every edge of
  the window is also drawn alone, without the ground under it or blending
  (a tenth of a Tokyo Rain frame).

- **The rate a theme asks for is the rate it gets.** Ticks are timers, and a
  timer fires late (up to 16 ms on Windows). The first build counted each
  tick's interval from when the last one went out, so the lateness added up:
  a 20 fps theme ran at 17 on Windows and a 30 fps theme at 24. Each tick is
  now due an interval after the last was due; a tick a whole interval late
  starts the count over, so a stall is never made up in a burst.
- **For scale.** On that computer the whole of Tokyo Rain at 20 fps cost 2%
  of a core in the frame's process and 2.5% in the GPU process, under 0.5%
  of the 3070 Ti, and no change in watts that could be told from noise. One
  thing in the app moving on every refresh of a 143 Hz screen costs several
  times that, because each refresh then draws the window again: the art
  draws it 20 times a second.

## Glass in the app

Glass mode turns on only when the active theme has a backdrop
(`html[data-glass]`). Users who never pick one see no change.

- Glass surfaces: frame (`AppTitleBar`, `NavigationRail`, `SidebarProvider`),
  work panel (`app-panel`), thread list (`sidebar-inner`), `SidebarInset` and
  the ChatView root, composer. The stacked `bg-background` layers (panel,
  inset, ChatView root) collapse to one transparent stack; the frame paints
  the tint, so alpha never compounds.
- A new token `--surface-solid` (the theme's opaque base) replaces
  `--background` wherever something needs to hide what's behind it: sticky
  turn headers (`surface-group-solid`), sticky table heads, the diff's sticky
  header, `--pele-bg`, codeblock copy buttons, and the `color-mix(...
  var(--background))` rules in `index.css`. Sticky headers stay opaque, since
  frosting the art can't blur thread text scrolling under them.
- Fades that blend into the background (the timeline bottom fade at
  `MessagesTimeline.tsx:2158`, header edge fades, sidebar fades, the
  proposed-plan fade) are hidden in glass mode; the prototype showed them as
  bright bands.
- `syncBrowserChromeTheme`, the iPhone status bar strip and the theme-color
  meta read `--surface-solid`, never a translucent value.

## Applying a theme

- **Choice per device.** Each device commits its own choice, which "Same
  theme on all my devices" (see Storage and devices) keeps in step with the
  user's other devices. `threadlines:theme` holds `system`, `light`, `dark`,
  or `{ kind: "custom", hash, name }`. Every place that assumes three values
  (useTheme's `getStored`, the `index.html` pre-paint script, `THEME_LABELS`,
  `THEME_OPTIONS`, `isTheme` in settingsChangeClaims, the restore/dirty check,
  `DesktopTheme`) learns the shape. `resolvedTheme` stays `light | dark` (the
  theme's base), so its about 20 consumers and the 166 `dark:` variants keep
  working.
- **Trial state** lives in memory per window, apart from the committed
  choice. A storage event from another window that commits a choice ends this
  window's trial and adopts the new choice; a trial's countdown only ever
  reverts itself (it carries a trial id).
- **No flash.** The device caches resolved tokens, fonts and still by hash
  (IndexedDB; the active and last five used), plus a small localStorage record
  for the pre-paint script, which paints the cached base color and still
  before React loads instead of hardcoded `#161616`.
- **Tokens.** One `<style id="tl-theme">` on `html[data-theme]`. Changes go
  through a small theme store that components subscribe to; they don't infer
  it from DOM mutations.
- **Startup cost.** Startup carries the theme store and what applies tokens
  it already has, nothing more. Everything else is a chunk of its own,
  fetched after first paint: the library's sync once the app is signed in;
  the color math that derives tokens, the device cache and library reads,
  embedded font loading, the starters, the art and the trial bar when a
  custom theme is shown or tried (agent pages bring the font code with
  them). Until then the pre-paint record's tokens stand in. The art and the
  library's sync fail quietly if their code can't download (OptionalChunk).
  The startup closure budget (`scripts/check-web-bundle-size.ts`) is the
  check.
- **Terminal.** `ThreadTerminalDrawer` (whose observer only watches `class`
  and `style`) and `ProviderConnectTerminal` (no theme subscription today)
  subscribe to the store, take the theme's ANSI palette and mono font, and
  refit after the font loads.
- **Fonts.** Loaded from the cached bytes with `FontFace`; no runtime network.
  `--font-sans` and `--font-mono` are mapped `@theme inline`, so the
  `font-sans` / `font-mono` utilities hold literal stacks: map them
  non-inline. The terminal's `TERMINAL_FONT_FAMILY` reads the theme. Agent
  pages get the fonts as `@font-face` data URLs from the wrapper (their CSP
  gains `font-src data:`) instead of only `AGENT_PAGE_DEFAULT_FONTS`.
  Diagrams (`MarkdownDiagram.tsx`, cached by source today) add the theme hash
  to their cache key.
- **Agent pages.** `useAgentPageTheme` memoizes on `resolvedTheme` only; its
  key gains the theme hash so a same-base switch re-reads tokens.
- **Code.** A theme's code palette becomes a generated Shiki theme
  (`tl-custom-<hash>`) registered with the highlight worker and the diff
  renderer; their caches key on theme name. Without one, the base's Pierre
  theme is used. (Prototype: green UI with purple code looked wrong.)
- **Desktop.** The bridge keeps the native preference apart from colors:
  `{ nativeSource: system | light | dark, colors?: { windowBackground,
  titleBarSymbol } }`. Built-in System stays `system` so the OS keeps
  driving it; a custom theme sets its base. `syncWindowAppearance`
  (`DesktopWindow.ts`, which re-applies built-in colors on native updates
  today) uses the stored custom colors when present, and the desktop keeps
  them in `client-settings.json` so the window opens in the right color.
- **Status colors.** Amber, emerald and red stay (color means status) unless
  the theme overrides `--success`, `--warning`, `--destructive`, `--info`;
  either way they go through the readability check.

## Readability check

`THEME_CONTRAST_PAIRS` in `packages/shared/src/themes/` lists the pairs the
UI actually renders, as data, with translucent tokens composited over the
surface they sit on before measuring:

- Text on surfaces: foreground and muted text on background, card, group,
  popover, sidebar and frame; each `*-foreground` on the surface it is
  actually used on (card, popover, sidebar-accent, secondary, accent,
  primary).
- Status as rendered: badges put `*-foreground` on the status color at 8%
  (light) or 16% (dark) over the surface (`badge.tsx`); filled destructive
  buttons and badges put white on `--destructive` and on it at 90%
  (`button.tsx`, `badge.tsx`). Status text at 4.5:1, status dots and icons at
  3:1.
- Interaction states: primary-hover, control, control-hover and
  control-pressed with their text; selection with foreground; focus ring
  against its surface.
- Code palette on the code background and terminal ANSI colors on the
  terminal background at 4.5:1 (black and white excepted against their own
  extreme).
- Borders, inputs and switch tracks at 1.3:1 against what they sit on.

Each row names the component and line it mirrors, and changing a component's
color classes means updating its row. The built-in light and dark themes must
pass the same table (a test), which keeps the table honest. A failing pair is an error: `show_theme` and import
refuse it and say which pair failed and what value would pass. Over-art
readability isn't checked here; the frame guarantees it at render time (see
the runtime).

## Agent tools

Two tools on the pages MCP endpoint (`threadlines_pages`), next to
`show_page` and `preview_page`. Claude's allow list (`CLAUDE_PAGE_TOOL_IDS`,
installed by `ClaudeAdapter`) names only the two page tools, so both new ids
are added; Codex's auto-approve covers the whole endpoint; ACP, OpenCode, Pi
and Muse get the endpoint as they do for pages. Availability and approval are
tested per provider.

- `preview_theme({ theme })` validates, runs the readability check, renders a
  theme **specimen** in the preview browser in the thread, new-thread and
  Settings layouts at 1440×900 and a phone thread at 390×844 (the art drawing
  one frame there, as phones do), measures the art's cost over 2 seconds, and
  returns screenshots
  plus a report (failed pairs, frame cost, console errors). The preview
  browser gets a fixed-viewport mode and multi-frame capture (CDP is already
  there). The specimen is a small self-contained mock of the app built from
  the same token, glass and runtime code; it is visual feedback for the agent,
  not a safety check (safety lives in the token table and the frame's tint).
  A browser test compares the specimen's main surface colors with the real
  app's for one theme so drift shows up.
- `show_theme({ theme, offerId? })` refuses errors, stores the version, and
  posts the theme row through `thread.theme.offer` → `thread.theme-offered`,
  projected next to pages and added to `isThreadDetailEvent` in `ws.ts`. It
  follows the page rules exactly: latched to the caller's turn, re-checked
  after the work (`AgentPages.ts` post-work ownership check) and refused by
  the decider once the turn is reverted; showing the same `offerId` again in
  the same turn replaces the row, in a later turn adds a new row ("Updated")
  and keeps the earlier one for revert. Offer files live beside page files
  and go through the same sweep. Like pages, forks keep a text mention and
  moved threads don't carry offers; a kept theme is in the library either way.

Gating: on when agent pages are on (`enableAgentPages`). The app guide gets a
`themes` topic (what a theme is, the draw contract, the art rules: calm
center, slow motion, a seamless loop, palette from the art, motion that adds
up speed × `dt` and eases into the working look so nothing jumps, stay under
the budget, no network) and places for the new Appearance rows.

## Storage and devices

- **Entries and content are separate.** A library entry is what the user
  sees and manages: `entryId` (a UUID minted once, the same on every computer
  it reaches), `name`, `hash` of its content, and a revision. Content is
  stored once per hash and never changes. Two entries can share a hash
  (Duplicate makes a new entry with the same content), and deleting one entry
  never touches another. Each server keeps `theme_entries` and
  `theme_contents` tables. RPCs `themes.subscribe` (entry summaries,
  tombstones included), `themes.read(hash)`, `themes.save`, `themes.rename`,
  `themes.delete`, `themes.restore`, validated on the server. Every import
  makes a new entry; ids inside files are ignored.
- **One order for every change.** Each entry carries `revision` (a counter:
  every rename, delete or restore sets it to one more than the highest it has
  seen) and `revisedBy` (the computer's id). The higher `(revision,
  revisedBy)` wins, compared the same way everywhere, so computers always
  converge. A deletion is a tombstone state with a revision; "Save again"
  after a deletion is a restore with a newer revision.
- **Every device on a computer** (desktop window, browser tabs, phone) sees
  that computer's library through the subscription.
- **Same theme on all my devices** (a device switch, on by default, Nov 9).
  Each computer also keeps one shared pick beside the library (`theme_pick`,
  migration 108): the theme (a built-in, a starter, or a library entry with
  its hash, name and base, and the `pickId` of the one choice it came from)
  and a `(revision, revisedBy)` in the same order as entries, so the app
  reconciles it like an entry, sending the winner (with a library theme's
  content when a computer lacks it, and the content again to one whose
  snapshot says `pickHasContent: false`) to computers holding an older one. A
  server too old to keep one sends no `pick` in its snapshot and is left out.
  On a device (themePickSync.ts, whose logic is `createThemePickSync`, tested
  apart from the browser against several windows and a computer):
  - What the device knows is one note in storage, shared by its windows:
    `taken` (it shows this pick), `unsent` (the user picked a theme here and
    no computer has it yet), `local` (the user's own theme with the switch
    on, not shared) or `off` (the switch is off). Every window runs the same
    rules on that note and comes to the same step, so no window is in charge
    and a step taken twice changes nothing.
  - A theme the user commits (a pick, Keep, a settings change; not a pick
    applied from elsewhere) becomes the `unsent` note, written before the
    device's theme so no window sees the theme under the old note. Its window
    sends it with `themes.pick`, above every pick it has heard of (also from
    a computer that has since dropped off), carrying a `pickId`; one send at
    a time, so a window's picks reach the computer in the order they were
    made. The pick is done when a computer answers for it or the shared pick
    carries its id. A computer that already held that theme, picked by
    someone else, answers with their pick; this one then goes again, above
    it, so every choice has an id of its own. A failed send is tried again
    after 30 seconds, or at the next pick; a send unanswered for 15 seconds
    counts as lost. If the window
    is gone (15 seconds without an attempt), another sends it, also after a
    reload. A pick from elsewhere doesn't replace it on screen while it is on
    its way; it gives way only when it couldn't be sent for a minute and
    someone else picked meanwhile.
  - A pick newer than the one the note knows is applied, after any trial in
    that window, never an older one, and never by a window under
    `?theme=default`. The theme is written before the note, so a window
    closed between the two leaves the pick to be noted, not lost; the note is
    written only if no other window wrote it meanwhile (the user picking
    there), so that pick stands. A theme
    kept on this device only, or picked before the
    settings had loaded, is `local`: it stays until a newer pick comes.
  - Every note carries `past`, the ids of the device's last 32 picks. A send
    can land late (a slow connection, a second attempt, another window's), so
    one of them can come back as the newest shared pick. That is never news:
    the device sends what it shows again, above it, or just keeps a theme
    that is its own.
  - A window that sees the switch off writes `off`, which drops a pick that
    hadn't gone; nothing picked while it is off is shared later. With the
    switch on, a note that says `off` means the device joins: once every
    followed computer has reported, it takes the shared pick, or keeps its
    theme when there is none. It never offers its own theme; that is shared
    the next time the user picks. A note that went `off` in the last 5
    seconds waits first, since a window that hadn't heard of the switch yet
    may have written it; a window that hears of the switch late finds the
    note already moved on and changes nothing.
  - The first build's single key is carried over once: the pick it showed
    isn't taken again, and a pick it hadn't sent yet is sent.
  - Left as they are: a device that took a pick from a computer which dropped
    off before the others had it ignores their older picks until that
    computer is back or someone picks again; a send that failed but landed,
    sent again within the minute, goes above a pick made elsewhere in
    between; two windows writing the note in the same instant leave
    whichever wrote last; a window that hasn't heard of a switch change yet
    shares or keeps a theme picked in it by the old value; what the device
    shows again over its own late pick also goes above a pick made elsewhere
    in that moment; a send still out after 32 later picks isn't known as the
    device's own; and a pick applied by one window ends a trial running in
    another, like any theme change there.
    Nothing changes until someone picks a theme after updating: no device's
    look is guessed and pushed to the others.
- **Deleting changes no other device's look.** A device keeps using a cached
  theme that was deleted elsewhere; Appearance shows "Not in your library
  anymore · Save again · Switch". Deleting the theme this device uses asks
  "Switch this device to Dark?" first. Windows on one device share its choice.
- **Missing everything.** If a device's chosen hash is in no cache and no
  connected computer has it, the device uses the theme's base and says so.
  The device's choice records the entry id and the hash; a rename elsewhere
  updates the label, and the hash keeps the look stable.
- **Starters** ship inside the app (`packages/shared`), read-only, never in
  the table.
- **Files.** Export writes the `.threadlines-theme`. Import (Settings, drop on
  the window, or `show_theme` given a file path) validates and shows the
  still with "Live art made by someone else. It runs walled off with no
  internet." before the trial.

## Starter themes

Six, all ours: **Aurora** (dark, ASCII night sky, live), **Lantern Lake**
(dark but not too dark, a pixel lake at dusk with a lit cabin and fireflies,
live), **Meadow** (light,
grass, clouds over hills, seeds and butterflies, live), **Phosphor** (dark,
green terminal colors, mono font, static scanlines, no live art),
**Snowfield** (light, ASCII snow over pines, live), **Tokyo Rain** (dark, a
neon alley in the rain, two embedded OFL fonts, live). Each is tuned under
the budget, passes the table, and is a reference in the guide topic.

Retired, still found by id so a device that chose one keeps it, but no
longer listed (`RETIRED_STARTER_THEMES`): **Dunes** (gave way to Meadow),
**Night Rain** (gave way to Tokyo Rain, which began as Will's own theme),
**Ember**.

## Sharing

A theme file is the unit people share, by hand or through the Showcase. Export file… opens a dialog that makes the file ready to
share (`themeForSharing`, packages/shared/src/themes/sharing.ts):

- It never says which thread made the theme: `createdBy` is left out (an
  import stamps its own origin anyway).
- The prompt stays out unless the author turns on "Include the prompt"; the
  dialog shows it, so they see what they'd share.
- Credits: a theme that already has them (every starter, credited
  Threadlines under MIT; someone else's theme) keeps them, so re-sharing
  passes the credit on. One without takes its author's: a name, a link (https
  only) and CC BY 4.0 or CC0. This device remembers them for the next export.
  Agents never set credits.
- Importing shows the credit, a link that opens in the browser, and what the
  license lets you do.

Credits count toward the content hash (a license belongs with its content).
A build from before credits drops the field when it decodes a theme, so it
hashes a credited theme differently and refuses it in a merge: until such a
computer updates, credited themes (every duplicated starter included) don't
reach it, and the sender retries once a minute. Only nightlies from Nov 6 to
Nov 9, 2026 are affected; no stable release had themes yet.

**Fields a build doesn't know** (Nov 9, 2026, before themes reached
stable): every part of the format decodes with a rest record
(`keepingUnknownKeys` in packages/contracts/src/themes.ts), so a field a
newer build added, at the top or inside a part, is kept as it came: checked
for size with the rest, counted in the hash, stored, synced, exported and
shared. Builds from this one on agree on a newer theme's hash, so adding a
field no longer breaks sync. Its TypeScript type stays the known fields.
The rule for a new field: a build that doesn't know it will carry it
everywhere, sharing included, so anything private goes under `createdBy`,
which sharing always leaves out.

## Showcase

Themes people shared, browsable and tryable in the app (Nov 9, 2026). It
lives in a public repository, Threadlines/themes, with no server or account
of ours: sharing is a pull request from the person's own GitHub account, and
the list is a file the repository's workflow rebuilds on every merge.

**The repository.** `themes/<folder>/` holds `theme.threadlines-theme`,
`thumbnail.png` (320×200), `meta.json` (`sharedBy`, the login that shared
it, and `featured`, which maintainers set) and a generated `NOTICE.md`
(credit, license, each font's copyright and license). `index.json` lists
every theme with what a tile needs (name, base, three colors, credits, who
shared it, featured, the day it was added) and, for its file and picture,
the path, byte count and SHA-256. `licenses/` carries the OFL 1.1 and
Apache 2.0 texts. `scripts/theme-showcase.ts` here does both jobs, run by
the repository's workflows from a pinned Threadlines commit (never code from
the pull request): `check` on every pull request, `index` after a merge.

**The rules** (`packages/shared/src/themes/showcase.ts`, shared by the app,
the server and the checks):

- Only fields this build knows (`unknownThemeFields`): nothing a newer build
  added can slip out unreviewed. `createdBy` is never there.
- A license others can use: CC BY 4.0 or CC0. A starter's MIT copy is
  refused (everyone has the starters).
- Embedded fonts keep their notice inside the font: the WOFF2 name table
  (`fontNotice.ts`) must carry a copyright (name 0) and an OFL or Apache
  license (name 13 or 14), which is how OFL's "keep the notice" is met.
  Google and Bunny subsets keep both.
- The picture is a plain PNG of 320×200, at most 160 KB, with no chunk
  that could carry text, every checksum right and its image data unpacking
  to exactly its rows (where zlib is at hand: the server and the checks).
  The app draws it: a theme with art by its art alone, laid out at 640×400
  as the starters' thumbnails are; one without (or whose art fails, or whose
  frame is too busy to fit) by the new-thread specimen. It drops what a
  browser screenshot adds (`plainPng`).
- A pull request from anyone but a maintainer may add theme folders, change
  only folders it shared, claim only its own login, and touch nothing else.

**Reading it.** The server fetches `index.json` and every file from
raw.githubusercontent.com/Threadlines/themes/main only, following no
redirect, each within its size cap, and uses a file only when its size and
SHA-256 match the list (a theme also its content hash). The list stays fresh
for 30 minutes and is kept when a later fetch fails; the view says the list
may be old, with Try again. A list in a newer format says to update.

**What the user sees.** Settings › Appearance has Your themes and Showcase
side by side above the gallery, each with its own filters (Showcase: All,
Featured when there is one, Dark, Light). A Showcase tile shows its picture,
name and credit ("by Mira", or the login that shared it); clicking it starts
the usual trial, and Keep saves it to the library (`theme.saved` with origin
`showcase`). A library theme's menu has Share to Showcase… (beside Export
file…, which stays for sharing by hand). Its dialog shows the picture, the
fonts and their licenses, the same credit fields as export, Include the
prompt, and the GitHub account it would post as (Sign in when there is
none), plus anything that stops it from being shared. Share opens the pull
request; the tile then says In review, In the Showcase or Not added.

**Sharing, step by step** (`apps/server/src/themes/ThemeShowcase.ts`). The
server rebuilds the file itself from the library entry (never the client's
copy), checks the account is the one the person saw, records the share
(`theme_showcase_submissions`, migration 106), forks the repository (GitHub
returns the existing fork), writes the folder as one commit on branch
`showcase/<share id>`, and opens the pull request, or finds the one that
branch already has. Every step can be taken again: sending the same share
twice updates one branch and finds one pull request, and a pull request
GitHub opened without answering is looked for before saying so. The account
is checked again just before the pull request, which is what makes it
public. A share's state follows its pull request, looked up at most every
five minutes.

**Takedown.** An issue form in the repository; maintainers remove the folder.

## Rule changes (approved by Will, Nov 5)

- AGENTS.md: "No continuously repainting animations". Live backdrops are a
  user-chosen exception: off unless a theme with art is picked, frame-capped,
  terminated when paused, budgeted, watched. The rule gets one line naming
  the exception and its limits.
- design-language.md requires light and dark values for every token. Custom
  themes have one base each; the built-ins keep both.

## Hit every surface

- Entry points: chat row and trial bar, `/theme`, palette, Settings,
  `settings_change`, file drop, desktop View menu reset, `?theme=default`.
- Clients: web, desktop (window color, title bar, View menu, CPU watchdog),
  phone (one frame of the art at the phone's size, status bar color).
- Providers: through the pages endpoint, with Claude's allow list updated;
  community agents via the ACP core, no special casing.
- Contracts: `packages/contracts/src/themes.ts` (manifest, summary, RPCs, tool
  inputs, the offer command and event, the bridge messages, device settings
  `themeArt` and `themeMotion`).
- Reverse states: Undo and countdown, delete in use (asks), deleted elsewhere
  (keeps, says so), art too heavy (notice, Try again), art failed (still,
  says so), revert of the turn that offered it, missing cache.
- App guide: places for each new row, the `themes` topic, `appearance.theme`
  choices made dynamic.

## What the prototypes proved

- Seeds and a few overrides retint the whole app: three trial themes (dark
  with art, light with art, mono font without art) restyled every surface we
  looked at without touching component code.
- Code highlighting follows the base flag through `setThemePreference`; code
  colors don't follow the palette.
- `from-background` fades and stacked `bg-background` layers break under glass.
- CSS `backdrop-filter` ignores `mask-image` feathering in this Electron build.
- Text directly on busy art is unreadable without a calm zone; muted text over
  Dunes' brown sand was weak at the fixed tint, which is what the measured
  tint fixes.
- Aurora cost 8.5 ms per frame (median) at 1440×900 @2x, 24 fps, about a fifth
  of a core, drawn with `fillText` and a canvas blur. The same art as a WebGL2
  character grid (7,860 cells, instanced over a glyph atlas) cost 0.7 ms to
  compute and under 0.1 ms to submit.
- Sandbox probe in the Threadlines browser panel (same Chromium): a blob
  worker inside a `sandbox="allow-scripts"` srcdoc frame runs with origin
  `null`; `fetch`, `importScripts`, WebSocket and a Google Fonts `FontFace`
  were all blocked by the inherited CSP; the worker has no `location.replace`;
  a 3-second busy loop in the worker, and one in the frame's own thread, each
  delayed the app's timers by 2 ms or less. `terminate()` looked immediate,
  but measured by CPU time (Nov 9, Electron 45.2.1) a worker in a busy loop
  ran on for about 2 seconds after it.

## Tests

- Shared: `deriveThemeTokens` (ladder shape per base), `THEME_CONTRAST_PAIRS`
  (built-ins pass; known bad palettes fail, including a popover text equal to
  its fill), manifest validation and canonical hashing, the revision order
  (concurrent renames, rename against delete, restore after delete all
  converge to one result in any merge order).
- Server: theme entries and contents, Duplicate then delete one keeps the
  other, tombstones and RPCs; `show_theme` refusing failing
  themes; decider and projector for offers (same-turn replace, later-turn add,
  revert drops, refused after revert); Claude allow list contains the tools.
- Runtime, in the real browser suite: worker busy loop leaves the app's timers
  on time; worker `fetch`, WebSocket, `importScripts` and fonts blocked; missed
  ticks step down and then stop; art that declares a name the prelude needs is
  refused with that name; art that hides every global name with `let` still
  draws; deferred work still counts when the art patches `Math.max`, and work
  in a patched `MessageEvent` `data` getter or a getter on the grid it draws
  into counts; timers are gone from the whole prototype chain; an error the art
  made unreadable still fails it as a script error; a worker that never reports
  in fails; pausing terminates the worker; art that turns white ten seconds in
  keeps column text at 4.5:1; one-pixel white lines on black art keep it too;
  zone changes while paused recomposite; replies from a terminated worker
  generation are ignored.
- Web: trial → countdown → revert; Keep; reload mid-trial keeps the committed
  theme; a second window committing ends the first window's trial; `/theme`
  keyboard; glass off leaves default-theme surfaces unchanged; same-base
  switch refreshes the terminal and an open agent page; pre-paint reads the
  cached theme; deleted-elsewhere notice; missing-cache fallback.
- Desktop: System stays System; a custom theme's window color survives a
  native appearance change.
