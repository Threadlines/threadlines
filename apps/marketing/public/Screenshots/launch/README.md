# Threadlines marketing capture retake

This folder contains the refreshed marketing set captured against the July 11, 2026 layout. Every video is exported at 1600×934, 60 fps in both H.264 MP4 and VP9 WebM. Matching poster frames are in `Posters/`.

The staged sidebar has two expanded projects and one collapsed project, five or more threads per project, merged and branch indicators, and a running-terminal cue. The native-looking red, yellow, and green macOS controls are centered consistently across every export; the screen-control badge is not present in the final files.

## Recommended site use

- `activity-header-dark` — strongest hero candidate. Opens the compact activity dropdown with 4/6 tasks, two active subagents, and one background run.
- `rich-subagent-chat` — full conversation with a substantial Scout subagent result and follow-up responses.
- `project-files-edit` — tabbed project-file browser with syntax highlighting, editing, line selection, and attach-to-chat controls.
- `source-control-by-file` — switches through individual file diffs, then returns to the per-file source-control view.
- `git-history-visual` — pauses for the hover preview, clicks through three commits in one persistent detail card, then closes the final card; `main` and `v0.9.0-rc.1` remain on separate commits.
- `code-selection-to-chat` — selects a code range and attaches it to the composer.
- `chat-highlight-note` — highlights assistant text, adds a note, reopens it from the composer, edits it, and saves.
- `terminal-selection-to-chat` — selects real terminal output, attaches it, and opens the exact-line preview from the composer.
- `activity-header-light` — light-theme counterpart to the activity hero.

## Standalone light screenshots

- `activity-header-light-static.png` — open activity dropdown.
- `source-control-overview-light.png` — file-level changes and visual Git graph.
- `project-files-editor-light.png` — the file viewer in edit mode with saved code visible.

## Model coverage

- Fable 5 / High appears in the activity, rich-chat, project-file, note, and terminal scenes.
- GPT-5.6-Sol / Max appears in the source-control and Git-history scenes.

## Folder layout

- `*.mp4` — broadly compatible website video.
- `*.webm` — smaller modern-browser alternative.
- `Posters/*.png` — selected 1600×934 poster frame for each video.
- `*.png` at this folder level — standalone light-mode screenshots.
- `poster-contact-sheet.png` — quick visual review of the complete poster and still set.

The lossless source captures remain in the external Threadlines Marketing Studio archive and are intentionally not duplicated in this repository.
