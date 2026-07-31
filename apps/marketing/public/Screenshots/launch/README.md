# Threadlines marketing capture retake

This folder contains the refreshed marketing set. The primary 0.3.0 workspace, sidebar,
and browser clips come from the deterministic neutral capture studio at 3200×1868 and a
constant 60 fps. Each scene has matching `-dark` and `-light` captures, and responsive
1600×934 variants carry the `-mobile` suffix after the theme.
`activity-header-dark`, `rich-subagent-chat`, and `project-files-edit` are also
3200×1868 Retina exports; the remaining legacy clips are 1600×934. Matching poster
frames are stored in `Posters/`.

WebM is the primary format. The new responsive 0.3.0 clips use VP9 Profile 0,
8-bit `yuv420p`, CRF 30 with no bitrate cap; the earlier Retina clips retain their
Profile 2, 10-bit masters. MP4 is the Safari fallback: H.264 High profile,
8-bit `yuv420p`, CRF 18 with the slow preset.

The 0.3.0 sidebar has five live threads across three projects: input, working, and
background each have a distinct signal, while two threads are deliberately idle. Eleven
older threads sit under Wrapped. New neutral captures are frameless by design and do not
use a composited traffic-light plate.

## Recommended site use

- `workspace-four-panel-overview-{dark,light}` — primary 0.3.0 homepage pair with the
  cross-project sidebar, active conversation, matching Orbit browser, and source control
  in one frame. The take collapses pending input, reviews browser activity, opens a
  source-control diff, and returns to the overview. The standalone PNG remains the
  social-card source.
- `sidebar-attention-states-{dark,light}` — five live threads: amber input needed, blue
  recently started working, cyan background, and two quiet threads with no status
  treatment.
- `agent-browser-workflow-{dark,light}` — annotates the live service-health heading in
  the matching-theme Orbit browser, attaches the real element note to the composer, and
  shows the agent applying the requested compact green status treatment in place.
- `activity-header-dark` — strongest hero candidate. Opens the compact activity dropdown with 4/6 tasks, two active subagents, and one background run, then moves through the live work without expanding the six-step list or leaving focus rings.
- `rich-subagent-chat` — full conversation with a substantial Scout subagent result and follow-up responses.
- `project-files-edit` — browses the project tree, opens a tab, enters editing by double-click, saves a small change, then selects an exact line range and attaches it to chat; the current edit icon remains visible in the toolbar.
- `source-control-by-file` — switches through individual file diffs, then returns to the per-file source-control view.
- `git-history-visual` — keeps Scout's completed release-risk review visible beside the graph, pauses for a hover preview, clicks through three commits in one persistent detail card, then closes it; `main` and `v0.9.0-rc.1` remain on separate commits.
- `code-selection-to-chat` — selects a code range and attaches it to the composer.
- `chat-highlight-note` — highlights assistant text, adds a note, reopens it from the composer, edits it, and saves.
- `terminal-selection-to-chat` — selects real terminal output, attaches it, and opens the exact-line preview from the composer.
- `activity-header-light` — light-theme counterpart to the activity hero.

## Standalone light screenshots

- `activity-header-light-static.png` — open activity dropdown.
- `source-control-overview-light.png` — file-level changes and visual Git graph.
- `project-files-editor-light.png` — the file viewer in edit mode with saved code visible.

## Model coverage

- Fable 5 / High appears in the activity, rich-chat, project-file, note, terminal, and Git-history scenes.
- GPT-5.6-Sol / Max appears in the source-control scene.

## Folder layout

- `*.mp4` — broadly compatible website video.
- `*.webm` — smaller modern-browser alternative.
- `Posters/*.webp` — selected poster frame at the matching video resolution.
- `*.png` at this folder level — standalone light-mode screenshots.
- `poster-contact-sheet.png` — quick visual review of the complete poster and still set.

The lossless source captures remain in the Threadlines Marketing Studio archive.
