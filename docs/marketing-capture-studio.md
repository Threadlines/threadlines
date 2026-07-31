# Marketing Capture Studio

The Marketing Studio is a disposable desktop profile, three synthetic repositories, and
a deterministic media pipeline for recording Threadlines without exposing personal
projects, sessions, browser state, or filesystem paths.

The studio favors real product behavior over decorative fixtures:

- Orbit is a runnable local product at `http://127.0.0.1:4173/` with live reload.
- Thread histories contain real orchestration messages, sessions, turns, approvals,
  pending input, plans, background work, completions, and failures.
- Git branches, worktrees, staged files, history, and pull-request status use the same
  application paths as normal work.
- The primary capture window has exact platform-neutral geometry.
- Native macOS, Windows, and Linux controls are reserved for explicit platform-proof
  screenshots.

## Start the studio

From the Threadlines checkout:

```sh
vp run marketing:studio
```

The default root deliberately avoids the operator's username:

- macOS: `/Users/Shared/Threadlines Marketing Studio`
- Windows: `%PUBLIC%\Documents\Threadlines Marketing Studio`
- Linux: `/tmp/Threadlines Marketing Studio`

Set `THREADLINES_MARKETING_STUDIO_DIR` to use another reviewed location. A location under
the personal home directory fails capture preflight unless
`--allow-personal-path` is supplied explicitly.

The studio contains:

```text
Threadlines Marketing Studio/
├── Orbit/                 runnable synthetic product and primary Git repository
├── Lumen/                 synthetic feature-delivery project
├── Northstar/             synthetic observability project
├── .worktrees/            branch worktrees used by seeded threads
├── Capture Plan.json      copy of the source-controlled scene manifest
├── Captures/
│   ├── Masters/           untouched source recordings and clean PNG stills
│   ├── Exports/           generated desktop/mobile delivery assets
│   ├── Posters/           lossless poster masters
│   └── QA/                reports, contact sheets, OCR, and review frames
└── .threadlines/          isolated server and orchestration state
```

The Chromium profile is isolated separately in the platform application-data directory.
The studio never reads the regular Threadlines project registry or browser profile.
GitHub responses come from a local deterministic fixture and do not use a personal
GitHub login.

Print every resolved path:

```sh
vp run marketing:studio:paths
```

The source-controlled capture plan is
`scripts/fixtures/marketing-studio/capture-scenes.json`. It declares release, geometry,
theme, window mode, cursor mode, project, thread, browser URL, source-control state,
duration, visible labels, and story for each shot. Change the manifest rather than
relying on a private shot checklist.

## Neutral motion versus native platform proof

Primary feature videos use the neutral studio:

```sh
vp run marketing:studio
```

Capture mode creates a frameless window with an exact `1600 × 934` content area, disables
resizing and shadows, ignores persisted/maximized state, centers the window, and removes
the macOS traffic-light clearance from the web layout. At 2× display scale, the source
surface is `3200 × 1868`.

Do not composite replacement traffic lights or reconstruct native corners. Neutral motion
is one honest cross-platform representation of the product.

For a genuine macOS screenshot:

```sh
vp run marketing:studio:native
```

Use the `platform-macos` scene and capture the whole native window with an OS or OBS window
source. The clean-still command intentionally refuses native scenes because renderer-only
screenshots cannot include genuine OS controls. Repeat the native still on Windows and
Linux for the download page or platform strip.

## Recording specification

| Setting              | Required value                                    |
| -------------------- | ------------------------------------------------- |
| Logical content area | `1600 × 934`                                      |
| Display scale        | `2×`                                              |
| Source dimensions    | `3200 × 1868`                                     |
| Frame rate           | true constant `60 fps`                            |
| Color                | SDR, BT.709                                       |
| Audio                | disabled                                          |
| Motion source        | individual Threadlines window                     |
| Preferred master     | ProRes 422 HQ or FFV1/lossless-quality source     |
| Delivery             | VP9 Profile 0 WebM and H.264 High MP4             |
| Mobile delivery      | `1600 × 934`                                      |
| Keyframe interval    | two seconds                                       |
| Poster               | first trimmed frame; PNG master and WebP delivery |

The export command rejects a nominal 120/240 fps recording whose average timing is not
60 fps. It also rejects H.264 4:2:0 as a source master by default. Those files are useful
delivery encodes, but colored UI text and hairline borders should not begin the editing
pipeline after 4:2:0 compression.

The complete `1600 × 934` window must fit inside one display in logical points. The
default `1512 × 982` mode on a 3024-pixel MacBook display is too narrow: centering the
window leaves 88 horizontal points outside the display, and macOS pads the missing edge
black in a window recording. Select the 2× “More Space” mode (`1800 × 1169` on that
panel), or use a Retina external display with enough logical space, before launching the
studio. Preflight rejects any window that crosses a display edge.

### OBS setup on macOS

Use OBS's macOS Screen Capture source in Window mode:

1. Select only the Threadlines window, never the full display.
2. Keep OBS and its controls on a second display.
3. Set Base Canvas and Output Resolution to `3200 × 1868`.
4. Set Common FPS Value to `60`.
5. Disable output rescaling, HDR, audio tracks, and microphone capture.
6. Turn off True Tone, Night Shift, auto brightness, and notification banners.
7. Record MKV for crash recovery. Select ProRes 422 HQ when available; otherwise use a
   lossless or visually indistinguishable intraframe setting that does not reduce the
   source to H.264 4:2:0.
8. Include the cursor only for a story where it performs an action. Exclude or park it for
   scroll-only footage.

Capture one second of stillness before and after the action. Keep masters uncropped.
Rehearse and retake human cursor movement; do not synthesize a perfectly smooth cursor or
repair controls with a clean plate.

### Native pointer profile

Use the normal small macOS pointer for scenes whose manifest says `"cursorMode": "native"`.
It is the system pointer with a black fill and thin white outline, not a special dark-mode
asset.

Before recording, open **System Settings → Accessibility → Display → Pointer**:

1. Put Pointer size at the default/first position.
2. Choose Reset Colors so the outline is white and the fill is black.
3. Turn off Shake mouse pointer to locate for the recording session. A quick rehearsal
   sweep can otherwise make the pointer balloon in the middle of a take.

In the recorder, select the raw system/native cursor at `100%`. Disable cursor
replacement, enlargement, smoothing, magnetic movement, click rings, and highlights. In
OBS, use the source's **Show cursor** checkbox only for scenes marked `native`; turn it
off for scenes marked `hidden`.

Record a three-second calibration pass over both the light sidebar and dark browser
surface. Review it at 100% before the real take. If the pointer is mostly white, enlarged,
or changes size while moving, fix the OS/recorder setting instead of correcting it in
post.

## Scene workflow

Every featured motion story has separate `-dark` and `-light` scene IDs. Record both
members of a pair: preparation switches the Threadlines UI theme, and browser scenes
load the same theme in the synthetic Orbit preview. The marketing page selects the
matching asset whenever its theme changes.

Launch the studio in one terminal. In another terminal, prepare a scene:

```sh
vp run marketing:capture:prepare -- --scene workspace-four-panel-overview-dark
```

Preparation fixes the scene theme, stores the active scene marker, opens the named
thread, arranges the browser, and opens or closes source control exactly as declared.
Review the frame, then run:

```sh
vp run marketing:capture:preflight -- --scene workspace-four-panel-overview-dark
```

Preflight fails unless all of the following are true:

- The path contains an owned Marketing Studio.
- Orbit, Lumen, and Northstar are isolated Git repositories with expected fake remotes
  and reserved `.example` author addresses.
- Git history passes `gitleaks`.
- `ffmpeg`, `ffprobe`, and `gitleaks` are installed.
- The Orbit local app is responding.
- Neutral/native mode matches the scene.
- The active project and thread match exactly.
- Logical dimensions, display scale, theme, browser URL, source-control state, and
  expected visible labels match the manifest.

The result is written to `Captures/QA/<scene>-preflight.json` with the Threadlines source
revision and runtime geometry.

### Clean stills

For a neutral scene:

```sh
vp run marketing:capture:still -- --scene workspace-four-panel-overview-dark
```

This captures the renderer directly through the Electron debugging surface, verifies the
PNG is exactly `3200 × 1868`, and saves the untouched image plus a SHA-256 sidecar in
`Captures/Masters`.

### Motion masters

On macOS, record the prepared window directly from the manifest:

```sh
vp run marketing:capture:record -- --scene workspace-four-panel-overview-dark
```

The recorder resolves the exact Threadlines window rather than the display, performs the
scene's deterministic actions, and retains the raw macOS capture under
`Captures/Masters/Raw/`. It then creates a true constant-60-fps FFV1 master:

```text
Captures/Masters/workspace-four-panel-overview-dark.mkv
```

Scenes marked `hidden` keep the pointer outside the window. Scenes marked `native` use
the small system pointer and its real movement. OBS remains a manual cross-platform
fallback; use the manifest scene ID as the filename and do not trim, denoise, sharpen,
rescale, or use an H.264 delivery encode as the archive master.

Generate delivery assets:

```sh
vp run marketing:media:export -- --scene workspace-four-panel-overview-dark
```

Or pass an explicit source:

```sh
vp run marketing:media:export -- \
  --scene workspace-four-panel-overview-dark \
  --input "/reviewed/path/workspace-four-panel-overview-dark.mov"
```

The exporter creates:

- `3200 × 1868` H.264 MP4 with fast start.
- `3200 × 1868` VP9 Profile 0 WebM.
- `1600 × 934` mobile variants.
- Lossless PNG and delivery WebP posters.
- First, middle, and last QA frames.
- A contact sheet.
- SHA-256, codec, frame-rate, dimensions, pixel-format, color, and audio verification.
- OCR text and a sensitive-path/token scan on macOS, or with Tesseract when available.

Run verification again without re-encoding:

```sh
vp run marketing:media:postflight -- --scene workspace-four-panel-overview-dark
```

The final human review remains mandatory. Inspect the QA frames and contact sheet at full
size for notifications, account names, private paths, recorder overlays, accidental
tooltips, and cursor artifacts.

## Publish-safe project policy

Use real interactions, not a private daily worktree.

The safest choices are:

1. The synthetic runnable Orbit project.
2. A fresh clone of a completely public repository.
3. An allowlisted export copied into a new repository with synthetic history.

For a private source project, export approved files only. Do not clone its private Git
history into the studio. Remove `.env` files, cloud configuration, SSH data, submodules,
LFS objects, remotes, issue references, authors, and account-specific URLs. Rebuild Git
history with a reserved `.example` identity and local-only remote.

The governing rule is:

> If an accidental click, hover, terminal expansion, or full-frame capture would be
> unacceptable, the project cannot enter the studio.

Blurring is not a safety strategy because the original master still contains the data.

## Seeded realism

The inbox is intentionally inhabited but restrained: five threads are live, three have
a current signal, and two are quiet.

- Checkout recovery waits for a regional baseline choice.
- Project file editing has only recently started working.
- Deploy health continues a longer regional check in the background.
- Usage insights and Rollout cohorts contain finished context but have no status pill.
- The remaining eleven older threads sit under Wrapped.

These are real orchestration projections rather than DOM-only demo labels. Opening the
threads reveals reviewed prompts and assistant output, and Orbit's browser preview is
served by a real local process with live reload.

Keep evergreen scenes free of exact release versions, dates, or model names when they are
not part of the story. Release scenes can show 0.3.0-specific UI. Capture horizontal
website footage and vertical social footage separately instead of deriving both from one
composition.

## Reset

Reset is guarded by ownership markers and an explicit force flag:

```sh
vp run marketing:studio:reset -- --force
```

It deletes only the owned studio and isolated app-data roots, rebuilds all synthetic
history, and restores the canonical staged and unstaged changes. Stop the studio before
resetting.

Older studios created under `~/Threadlines Marketing Studio` are not moved or deleted
automatically. Review and archive their masters, then use the guarded reset with an
explicit `THREADLINES_MARKETING_STUDIO_DIR` if they should be removed.

## Legacy corner audit

Previously published assets that contain composited macOS corner plates can still be
checked with:

```sh
vp run marketing:media:audit-corners
```

New neutral motion and genuine native platform stills should not require that repair
workflow.
