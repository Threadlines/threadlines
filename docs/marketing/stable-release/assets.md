# Asset notes

Open [the preview](index.html) first. The kit covers the current product with a workspace overview, five feature clips in three formats, and the ten-topic library of wider demos and images. It uses the four approved project names and original favicons, with recreated conversations. No private conversation history, manuals, production records, or game address are included.

## Which file to use

Use `assets/launch-overview.mp4` to introduce Threadlines. It is a 30-second workspace tour showing the app with locked framing, reading holds, and short dissolves.

For a feature post on X, use the portrait video listed in `x-posts.csv`. Portrait is the default creative choice for this kit. Square is an alternate layout, and landscape is used on the website. There is no claim that one format gets better reach.

These dimensions and 30 fps exports fit the resolution, aspect-ratio, and frame-rate ranges in [X's video guide](https://help.x.com/en/using-x/x-videos), checked September 10, 2026.

## Feature videos

Each story is about 9 to 12 seconds and has three silent H.264 MP4 versions at 30 fps:

| Format                  | Size        | File pattern                              |
| ----------------------- | ----------- | ----------------------------------------- |
| Portrait, default for X | 1080 x 1350 | `assets/spotlights/<scene>-portrait.mp4`  |
| Square, alternate       | 1080 x 1080 | `assets/spotlights/<scene>-square.mp4`    |
| Landscape               | 1600 x 934  | `assets/spotlights/<scene>-landscape.mp4` |

The five scene names are `inbox`, `pull-requests`, `source-control`, `browser`, and `context`. Each video has a PNG poster named `<scene>-<format>-poster.png`. Still images are supplied as `<scene>-portrait.png` and `<scene>-square.png` in the same folder. Framing follows the action. The site videos keep the full workspace visible. Narrower versions fit wider views when controls span the screen, and use a close view only when the surrounding steps remain clear.

## Wider demo library

The wider library uses silent H.264 MP4 files at 1600 x 934, delivered at 30 fps, and 1600 x 934 social PNGs. Each video has a PNG thumbnail named `<name>-video-poster.png`. The workspace overview is 30 seconds. The other nine wider demos are generally about 7 to 14 seconds; the file's duration is authoritative.

| Topic                | Social video                 | Social image                        | Thumbnail prefix  |
| -------------------- | ---------------------------- | ----------------------------------- | ----------------- |
| Workspace            | `assets/launch-overview.mp4` | `assets/launch-social.png`          | `launch`          |
| Thread inbox         | `assets/inbox.mp4`           | `assets/inbox-social.png`           | `inbox`           |
| Pull requests and CI | `assets/pull-requests.mp4`   | `assets/pull-requests-social.png`   | `pull-requests`   |
| Desktop browser      | `assets/browser.mp4`         | `assets/browser-social.png`         | `browser`         |
| Project files        | `assets/files.mp4`           | `assets/files-social.png`           | `files`           |
| Exact context        | `assets/context.mp4`         | `assets/context-social.png`         | `context`         |
| Source control       | `assets/source-control.mp4`  | `assets/source-control-social.png`  | `source-control`  |
| Git history          | `assets/git-history.mp4`     | `assets/git-history-social.png`     | `git-history`     |
| Provider switching   | `assets/provider-switch.mp4` | `assets/provider-switch-social.png` | `provider-switch` |
| Tasks and activity   | `assets/activity.mp4`        | `assets/activity-social.png`        | `activity`        |

The website versions live in `apps/marketing/public/Screenshots/stable-launch/`, relative to the repository root. Each topic has an MP4 and WebP poster. The workspace pair is `workspace.mp4` and `workspace.webp`; the other nine wider demos use the topic basenames in the table. The five feature website pairs are `spotlight-<scene>.mp4` and `spotlight-<scene>.webp`. The original wider files remain available.

The homepage uses the workspace overview and the five landscape feature videos, with the other topics available in their related tabs. Dark app footage stays dark in both site themes. Only visible, active clips autoplay; a pause button is available on each frame. Reduced motion disables autoplay, and expanded previews have playback controls.

## How the captures were made

The real app renders a deterministic demo fixture. The fixture stages active and finished threads, Wrapped items, terminal indicators, an open PR, and CI checks. The final takes keep terminal drawers closed while preserving the sidebar terminal indicators. Those labels and results are demonstration data. They are not live private thread state or proof that a real PR passed its checks.

The visible pointer follows the same automated mouse input that operates the app. It is drawn in the captured renderer; it is not the operating-system cursor. The recordings include no desktop, microphone, or system audio. Other applications and the physical mouse can be used during capture. Keep the demo window restored, avoid interacting with it, and do not minimize it; a minimized renderer can stall the capture.

The workspace overview is a 30-second edit of the inbox, PR review and CI, and changed files. The app framing is locked through each shot, with short dissolves between shots and holds for reading. Actions play at their original speed; the edit does not slow them down by repeating frames. Each poster matches its video's first frame to avoid a jump when playback starts. The PR view keeps its identity, open status, and checks together. The context clip retains the line selection, cursor travel, Add selection to chat click, and composer result. Wider views fit inside square and portrait exports without cutting off required controls. These clips explain a workflow; they do not measure agent response time, terminal runtime, or CI speed. The 30 fps delivery encode comes from renderer captures with variable frame timing.

The videos and stills show the app itself. There are no baked titles, headers, labels, decorative containers, or inset app panels. The website may round the media's outer corners in its own layout. No private address should appear when a viewer expands a video or opens an image at full resolution.

The Git history clip opens commit detail popovers to follow branch history. The browser clip expands the public FACPManuals homepage, uses Find in page, and attaches a screenshot to chat. It does not stay in a narrow side preview. The provider clip opens the picker, selects the Claude provider named Fable, and shows the "Switch to Claude?" recap confirmation. It stops before confirming the handoff.

## Project icons

The packaged originals are byte-identical copies of the project assets:

| Project          | Kit source               | Original project file                                                  |
| ---------------- | ------------------------ | ---------------------------------------------------------------------- |
| Threadlines      | `source/threadlines.ico` | `apps/web/public/favicon.ico`                                          |
| facpmanuals-next | `source/facpmanuals.svg` | `public/assets/images/favicon.svg`, the SVG declared by its app layout |
| game-idea        | `source/game-idea.ico`   | `public/favicon.ico`                                                   |
| wilfredoleon.com | `source/portfolio.svg`   | `public/favicon.svg`                                                   |

Each pair was checked by SHA-256. The capture projects use these files directly through Threadlines' favicon resolver. The game has no public link in this kit.

## Make another take

`source/setup-capture.mjs` creates only the owned `Threadlines Release Studio` under Public Documents. It copies a few reviewed marketing source files from this repo, creates small local repositories, registers the four project names, and seeds recreated threads through the existing orchestration seeder. It never opens the normal Threadlines data directory. Existing seeded conversation text is not overwritten because the seeder deduplicates commands.

Use `pnpm exec vp exec node docs/marketing/stable-release/source/setup-capture.mjs` from the repo root with a supported Node version. The app profile and provider transcript homes must stay isolated. A locally authenticated Codex provider avoids a sign-in notice; credentials are not included in this kit. Keep any temporary authentication inside the isolated profile and remove it after the capture session.

Launch `pnpm exec vp run dev:desktop` with these values scoped to that child process:

```text
THREADLINES_HOME=<Public Documents>/Threadlines Release Studio/.threadlines
THREADLINES_DEV_INSTANCE=release-materials
THREADLINES_DESKTOP_APP_DATA_DIR=<Public Documents>/Threadlines Release Studio
THREADLINES_DESKTOP_USER_DATA_DIR_NAME=desktop-profile
THREADLINES_DESKTOP_BACKEND_CWD=<Public Documents>/Threadlines Release Studio/Threadlines
THREADLINES_DESKTOP_MARKETING_CAPTURE=1
THREADLINES_CAPTURE_DEBUG_PORT=9225
THREADLINES_DESKTOP_OPEN_DEVTOOLS=0
THREADLINES_DESKTOP_RESTART_ON_REBUILD=0
```

Open the release-page thread and set the left sidebar to about 325 pixels. Check all four names and favicons before staging a take. The capture scripts check for the isolated app at port 6039 and its debugging connection at port 9225; if the dev runner chooses a different app port, update the checked target before recording.

`source/stage-states.mjs` prepares the renderer-only demo state after desktop startup. It does not send provider turns or write PRs to GitHub. It expires after 30 minutes; re-run it for another session. Pass `--clear` to restore the renderer's baseline. These staged states are only for the capture instance.

The revised capture entry point is `source/record-scenes.mjs`, using `source/capture-session.mjs` to move the pointer and record the renderer. `source/record-window.mjs` is the original cursor-free take, retained as source history; it does not produce the revised pointer-led demos. Use a new take name for each run and review the scene's starting UI before recording. For example:

```text
pnpm exec vp exec node docs/marketing/stable-release/source/stage-states.mjs
pnpm exec vp exec node docs/marketing/stable-release/source/record-scenes.mjs workspace refresh-workspace-2
```

This creates `output/playwright/refresh-workspace-2/` with frames and capture timing. Scene names match the website basenames in the manifest. Each scene needs its expected starting panels open; rehearse the actions before capturing a new variant.

## Export the reviewed takes

Run this command from the repository root, with a supported Node version and Python's `imageio-ffmpeg` and `Pillow` packages installed:

```text
py docs/marketing/stable-release/source/export-refresh.py
```

The exporter reads `docs/marketing/stable-release/source/refresh-takes.json` for the reviewed takes under `output/playwright`. `docs/marketing/stable-release/source/hero-edit.json` controls the workspace overview, and `docs/marketing/stable-release/source/feature-spotlights.json` controls the five feature clips and their formats. Update these files when replacing a take or changing an edit.

This one command builds and installs the overview, wider demos, feature videos, first-frame posters, and plain app stills. The wider images are 1600 x 934. Portrait and square images retain their matching video dimensions. All final media shows app footage directly, without a separate title or backdrop render.

To rebuild only the feature videos after changing their edit settings:

```text
py docs/marketing/stable-release/source/export-refresh.py spotlights
```

The feature builder uses `output/feature-spotlights` for generated work before the exporter installs final files into `assets/spotlights` and the marketing site's `Screenshots/stable-launch` directory. Raw takes and render work stay local and are ignored by Git. Final kit and website assets, scripts, and edit settings remain visible to source control.

Review each output at full size, including its first and last frames, before packaging or publishing. H.264 is used because the earlier VP9 trial failed playback in the Windows browser check.

Keep the next release number and date out of the artwork until confirmed. The app shown is a development checkout; feature posts must match the public stable download before they are scheduled.
