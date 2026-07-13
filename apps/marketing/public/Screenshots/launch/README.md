# Threadlines marketing capture retake

This folder contains the refreshed marketing set captured against the July 12, 2026 layout. Every video is exported at a constant 60 fps. `activity-header-dark`, `rich-subagent-chat`, and `project-files-edit` are 3200×1868 Retina exports; the remaining clips are 1600×934. Matching poster frames use the same resolution as their clips and are stored in `Posters/`.

WebM is the primary format: VP9 Profile 2, 10-bit `yuv420p10le`, CRF 30 with no bitrate cap. MP4 is the Safari fallback: H.264 High profile, 8-bit `yuv420p`, CRF 18 with the slow preset.

The staged sidebar has two expanded projects and one collapsed project, five or more threads per project, merged and branch indicators, and a running-terminal cue. The calibrated traffic-light clean plate is used on unobstructed full-window captures; it preserves the normal control spacing and leaves the real sidebar toggle untouched. It is intentionally omitted from the two opaque file-viewer clips so it cannot appear to float above the viewer layer.

## Recommended site use

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
- `Posters/*.png` — selected poster frame at the matching video resolution.
- `*.png` at this folder level — standalone light-mode screenshots.
- `poster-contact-sheet.png` — quick visual review of the complete poster and still set.

The lossless source captures remain in the Threadlines Marketing Studio archive.
