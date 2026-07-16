# Marketing Capture Studio

The Marketing Studio is a disposable desktop profile and synthetic repository for
recording Threadlines without exposing personal projects, sessions, branch names, or
browser state. It runs beside the normal release app and uses independent ports and data
directories.

## Start the studio

From the Threadlines source checkout:

```sh
vp run marketing:studio
```

The first launch creates the studio at:

```text
~/Threadlines Marketing Studio/
├── Orbit/                 primary synthetic Git repository
├── Lumen/                 companion project with an amber favicon
├── Northstar/             companion project with a cyan favicon
├── .worktrees/            branch worktrees behind the seeded thread history
├── Captures/
│   ├── Masters/           untouched recordings and full-resolution screenshots
│   ├── Exports/           cropped and compressed site assets
│   └── Posters/           video poster frames
└── .threadlines/          isolated server and session state
```

On macOS, the isolated Electron browser profile lives at
~/Library/Application Support/threadlines-marketing-studio so Chromium's sandboxed
network process can write its cache. Other platforms use their standard application-data
directory. It has its own ownership marker and is cleared by the guarded reset.

Use a different location by setting THREADLINES_MARKETING_STUDIO_DIR before running a
studio command. THREADLINES_MARKETING_STUDIO_APP_DATA_DIR can move the browser profile;
its final directory name must contain only letters, numbers, dots, dashes, or underscores.

The launch profile is intentionally isolated in four ways:

- THREADLINES_DEV_INSTANCE gives it deterministic ports separate from normal development.
- THREADLINES_HOME separates project, thread, session, server, and window state.
- THREADLINES_DESKTOP_APP_DATA_DIR and THREADLINES_DESKTOP_USER_DATA_DIR_NAME separate
  Electron browser state from every other development profile.
- THREADLINES_DESKTOP_BACKEND_CWD makes Orbit the auto-bootstrapped project.

All three repositories include a root favicon.svg, using the same favicon discovery path
as real projects. The studio seeds intentionally uneven thread histories: four threads in
Orbit, three in Northstar, and two in Lumen. Three branch-backed threads resolve through
the normal Git-status path to merged pull requests, so the violet merged icon in the
sidebar is the real Threadlines status indicator rather than decorative capture markup.
The GitHub responses come from an isolated deterministic fixture on the studio's PATH;
they never use a personal GitHub login or require network access.

The seeded threads also provide two deliberate model treatments for capture variety:

- Claude Fable 5 at High: Project file editing, Release guard, Deploy health, Trace
  sampling, and Evaluation cache.
- GPT-5.6-Sol at Max: Checkout recovery, Usage insights, Group noisy alerts, and Rollout
  cohorts.

The composer reads these from each thread's real model selection, so switching threads is
enough to change both the model and reasoning chips for a shot.

Print all resolved locations without creating or launching anything:

```sh
vp run marketing:studio:paths
```

## Reset to the canonical shot state

The reset command refuses to run unless the directory contains the studio ownership
marker and the explicit force flag is present:

```sh
vp run marketing:studio:reset -- --force
```

It deletes only the two owned studio directories, rebuilds the Orbit history, and
restores the intended working tree:

- src/theme.ts is staged.
- docs/release-checklist.md is modified but unstaged.
- src/components/CheckoutSummary.tsx is modified but unstaged.
- src/lib/retry.ts is modified but unstaged.
- feature/usage-insights is merged.
- fix/checkout-timeout and feature/project-files remain open.
- v0.7.0, v0.8.0, and v0.9.0-rc.1 provide readable graph landmarks.

The setup command is otherwise idempotent. Relaunching does not erase capture state.
Stop the running studio before resetting it.

## Master capture standard

The studio maximizes its window to the current display's usable area on every launch.
Keep every full-app master at that native geometry:

- Window: maximized, with the macOS menu and normal window controls still available.
- Screenshot output: the display's native Retina resolution.
- Video: 60 fps when possible; 30 fps is acceptable for a smaller web export.
- Still format: PNG master.
- Video masters: the recorder's highest-quality source format.
- Site exports: WebM first, MP4 fallback, plus a WebP poster (quality 82; PNG stays the
  master format, but PNG posters are too heavy to ship as the hero LCP image).
- Posters are the exported clip's FIRST frame, extracted after trimming. Clips autoplay
  in place when they scroll into view, so any other poster frame produces a visible
  jump the moment playback starts. Keep end-state money frames as standalone stills.
- Record one second of stillness before the first action and after the final state.
- Site exports loop. Trim them so no more than ~1.5 seconds of stillness remains at
  either end; a long static tail reads as a frozen page, not a hold.
- Show the pointer only when it performs the story's actions. For scroll-only clips,
  exclude the cursor from the capture (or park it off-window) — an idle drifting
  pointer pulls attention and makes the loop feel driven by a ghost operator. Leave
  the composer unfocused unless typing is part of the story, so no caret blinks.

Do not crop masters. Save the full maximized window and derive crops from it. This keeps
replacements flexible if the release-site layout changes.

Before recording:

1. Use the isolated Threadlines (Dev) app and confirm the visible project is Orbit.
2. Confirm the window is maximized; the studio restores this on every launch.
3. Close unrelated popovers and keep only the tabs needed for the story.
4. Put the pointer in neutral empty space before the first frame.
5. Avoid hovering controls long enough to show accidental tooltips.
6. Prefer one deliberate action per beat; the UI should be readable without narration.

### Preserve the native window corners

The rounded window frame is system-rendered on macOS. Do not recreate its corner with a
hard circular mask or a guessed numeric radius. If a recording badge obscures the window
controls, derive the replacement plate from the untouched opposite corner at the same
resolution so the continuous curve, border, and antialiasing remain native. Composite the
traffic lights above that native corner raster rather than replacing the curve itself.

Before publishing refreshed media, compare both top corners and both vertical edges:

```sh
vp run marketing:media:audit-corners
```

The audit checks every launch poster, MP4, WebM, and standalone still. A corner plate must
match the opposite edge's antialias and solid-border transition within the small tolerance
needed for video chroma subsampling.

## Capture stories

### 01 — Project files are a workspace, not a side panel

Target: an 8–10 second clip plus a full-frame still.

1. Open the Project file editing thread; its composer should show Claude Fable 5 and High.
2. Start with the file popover closed.
3. Open Browse project files.
4. Search for featureFlags.
5. Open src/config/featureFlags.ts.
6. Open src/components/CheckoutSummary.tsx so two proper tabs are visible.
7. Return to featureFlags.ts, enter edit mode, change releaseGuard from false to true,
   and save.
8. Hold on the saved state with both tabs visible.

The important frame is the end: popover, file tree/search, stable tabs, editor controls,
and the surrounding conversation should all be visible together.

Reset the studio after this clip so the source-control assets return to their canonical
four-file state.

### 02 — Exact code context into chat

Target: a 6–8 second clip and a tight still of the selection action.

1. Open the Checkout recovery thread; its composer should show GPT-5.6-Sol and Max.
2. Open src/components/CheckoutSummary.tsx.
3. Select the total calculation and the nearby render lines.
4. Use Add selection to chat.
5. Close the file popover.
6. Hold on the composer with the structured file-and-line attachment visible.

Keep the selection small enough that the attachment label and source range remain
readable. This is stronger than attaching an entire file because the viewer immediately
understands the precision.

### 03 — Source control organized by file

Target: an 8–10 second clip and one portrait crop for the feature carousel.

1. Use the Checkout recovery thread so GPT-5.6-Sol and Max remain visible.
2. Open Source Control with the canonical staged and unstaged groups visible.
3. Expand CheckoutSummary.tsx and inspect its additions and deletions.
4. Move to retry.ts, then back to the grouped file list.
5. Reveal the per-file undo action on retry.ts.
6. Hold before clicking, or click only when the clip explicitly demonstrates recovery.

The clip should make the hierarchy obvious: staged changes, unstaged changes, individual
files, file-level diffs, and file-level recovery. Avoid opening the commit action menu in
this story; it competes with the differentiated part of the UI.

### 04 — Git history you can understand visually

Target: a 12–16 second clip and a full-height graph crop.

1. Use the Release guard thread and keep Scout's completed release-risk review visible
   so the graph is shown beside a real subagent result, not an empty conversation.
2. Open the Git graph within Source Control.
3. Pause on the merge lane connecting feature/usage-insights.
4. Select the checkout timeout commit on its unmerged branch.
5. Open commit detail so author, SHA, message, and changed files are readable.
6. Return to the graph and hold on all three branch lanes.

The branch and tag labels were deliberately kept short for this frame. Keep the panel
wide enough that labels do not truncate.

### 05 — A subagent reporting back (hero loop)

Target: an 8–10 second clip plus the end-state frame as the poster.

1. Open the Release guard thread; its composer should show Claude Fable 5 and High.
2. Keep Source Control open on the right so the changes list and commit graph frame
   the conversation.
3. Start at the top of the thread with the opening user message visible.
4. Scroll down at a steady reading pace until Scout's completed release-risk review
   and the follow-up exchange fill the frame.
5. Hold on the end state: Scout's subagent card, the rollout-policy reply, and the
   graph all visible together.

This is the autoplaying hero loop: capture it cursor-less (the only motion is the
scroll), leave the composer unfocused, and keep the hold short — the loop restarts
from the top-of-thread state, so a long freeze reads as a stall. Like every looping
export, the poster is the trimmed clip's first frame.

## Suggested site asset names

Use names based on the story, not the UI implementation:

```text
project-files-workspace.png
project-files-edit.webm
project-files-edit.mp4
project-files-edit-poster.png
code-selection-to-chat.png
code-selection-to-chat.webm
source-control-by-file.png
source-control-by-file.webm
git-history-visual.png
git-history-visual.webm
```

Keep intermediate attempts in Captures/Masters. Only reviewed crops and encodes belong in
Captures/Exports, and nothing is copied into apps/marketing/public until the site work is
explicitly started.
