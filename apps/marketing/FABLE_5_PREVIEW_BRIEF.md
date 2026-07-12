# Fable 5 brief: refresh the `/preview` release page

## Objective

Review and improve `apps/marketing/src/pages/preview.astro` using the approved launch media in `apps/marketing/public/Screenshots/launch/`.

Keep the current page's strongest qualities: the dark visual language, animated Git-line motif, restrained typography, provider-switching story, reliability section, and open-source positioning. Rework the media presentation and feature hierarchy so the page demonstrates Threadlines' concrete product advantages instead of reading like a generic coding-agent GUI.

Do not modify the desktop/web product while doing this work. Keep the scope to `apps/marketing`.

## Product story to prioritize

1. **Visible agent activity** — the compact activity header exposes a 4/6 task list, two subagents with model and reasoning labels, and a background run with a Stop action.
2. **Exact-context steering** — users can select assistant text, terminal output, or code lines; attach that exact context; add a note; and later edit the note from the composer.
3. **Project files are first-class** — the project-file popover has tabs, browsing, syntax highlighting, line selection, editing, saving, and attachment to chat. It is not a narrow side-panel file list.
4. **Source control, not merely a diff drawer** — changes are grouped per file and folder with staged/unstaged state, per-file review and actions, plus a visual Git graph with branches, tags, hover previews, and persistent commit details.
5. **Subagents report into the conversation** — substantial subagent results render as readable first-class timeline content.
6. **Provider flexibility** — retain the existing Claude/Codex switching and usage-meter story.

Use concrete capability language. Avoid unverifiable claims such as “the only GUI” and avoid naming competitors.

## Approved media

All motion assets run at a constant 60 fps and have matching 10-bit VP9 Profile 2 WebM files (primary) plus H.264 High-profile MP4 files (Safari fallback). `activity-header-dark`, `rich-subagent-chat`, and `project-files-edit` are 3200×1868 Retina exports; the remaining clips are 1600×934. Posters use the same dimensions as their matching video and the same basename under `Posters/`.

Base URL: `/Screenshots/launch`

| Basename                     | What it demonstrates                                                                      | Suggested role                          |
| ---------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| `activity-header-dark`       | Compact activity button and dropdown with tasks, subagents, and a background run          | Strongest hero candidate                |
| `rich-subagent-chat`         | Full conversation with a substantial Scout subagent result                                | Activity/subagent section               |
| `chat-highlight-note`        | Highlight text, add a note, attach it, reopen it, edit it, and save                       | Exact-context section                   |
| `terminal-selection-to-chat` | Select terminal output, attach it, and reopen the exact-line preview                      | Exact-context section                   |
| `code-selection-to-chat`     | Select a code range and attach it to the composer                                         | Exact-context or project-files section  |
| `project-files-edit`         | Browse the tree, open a tab, double-click to edit, save, select lines, and attach to chat | Dedicated project-files showcase        |
| `source-control-by-file`     | Review changes file by file and return to the grouped source-control tree                 | Source-control showcase                 |
| `git-history-visual`         | Hover a commit preview, click through persistent commit details, and close the final card | Git-history showcase                    |
| `activity-header-light`      | Light-theme version of the activity flow                                                  | Optional theme proof, not primary media |

Standalone light screenshots are also available:

- `/Screenshots/launch/activity-header-light-static.png`
- `/Screenshots/launch/source-control-overview-light.png`
- `/Screenshots/launch/project-files-editor-light.png`

The complete visual index is `/Screenshots/launch/poster-contact-sheet.png`. Asset notes are in `/Screenshots/launch/README.md` in the public folder.

## Recommended page hierarchy

1. Keep the current hero copy or refine it lightly, but replace the old static hero capture with a wide, restrained presentation of `activity-header-dark`. Let the poster render immediately and let motion begin without shifting layout.
2. Turn “Steer, don't re-prompt” into an exact-context showcase that can move among the chat-note, terminal-selection, and code-selection flows.
3. Add a dedicated project-files section. Suggested framing: **“The project is part of the conversation.”** Explain tabs, line selection, editing, saving, and attaching exact context.
4. Use `rich-subagent-chat` for the existing “Nothing runs invisibly” story, while the hero already demonstrates the activity dropdown.
5. Keep the provider-switching section, unless a small ordering change improves the narrative.
6. Give source control more room and split the story into two clearly labeled views: **changes by file** and **visual history/commit detail**. Suggested framing: **“Source control, not a diff drawer.”**
7. Keep the reliability, build-philosophy, and open-source sections, tightening only where needed to control total page length.
8. Treat light mode as optional supporting proof near the bottom. The release page is dark-first, so do not interrupt the main flow with several bright frames.

This is a hierarchy recommendation, not a requirement to place every asset on the page. Prefer a clear story over a wall of demos.

## Media and layout requirements

- The captures are approximately 16:9 (`1600 / 934`). The current `3 / 2` slide stage and 24-pixel inset make the product UI too small. Add a wide showcase treatment that preserves the native aspect ratio and gives important full-app captures up to roughly 1200–1400 px of width.
- Do not squeeze source-control or project-file captures into a roughly 500 px column; their labels become unreadable. Copy may sit above a wide frame or use a narrower copy column beside a substantially wider media column.
- Use each poster with `<video poster="...">`, WebM first and MP4 second. Use `muted`, `playsinline`, and `loop` where looping is appropriate.
- Avoid having every video run at once. Use `preload="metadata"` or `preload="none"`, start/pause videos based on viewport visibility, and keep the poster as the reduced-motion fallback.
- Respect `prefers-reduced-motion`; show a poster or a user-initiated play state instead of autoplaying.
- Preserve layout dimensions before media loads to avoid CLS.
- Make every showcase understandable from its heading, short copy, poster, and accessible label. Do not rely on motion alone.
- Keep tap/click-to-expand behavior for detailed captures and make it work for video posters as well as images.
- Verify desktop, tablet, and phone layouts. On small screens, prioritize a legible poster and full-screen expansion over aggressive cropping.

## Scope and acceptance checks

- Work only in `apps/marketing`.
- Reuse the approved captures without editing, recoloring, or adding fake UI overlays.
- Remove obsolete screenshot references from `/preview` only when the new media fully replaces them; do not delete the old files in this pass.
- Preserve `/download`, release lookup behavior, analytics, metadata, and the rest of the site.
- Run `vp fmt`, `vp lint`, `vp run typecheck`, and a marketing production build.
- Inspect `/preview` at desktop and mobile widths after implementation and report the final asset-to-section mapping.

## Copy-paste task prompt

> Please refresh the Threadlines release page at `apps/marketing/src/pages/preview.astro`. First read `apps/marketing/FABLE_5_PREVIEW_BRIEF.md` and `apps/marketing/public/Screenshots/launch/README.md`, then inspect the current `/preview` implementation and its rendered desktop/mobile layout. Implement the redesign within `apps/marketing` using the approved assets under `/Screenshots/launch`. Preserve the current dark visual identity and strongest existing sections, but make the unique activity, exact-context, project-file, per-file source-control, visual Git-history, and rich-subagent workflows the core story. Follow the media, performance, accessibility, responsive-layout, and verification requirements in the brief. Do not modify the Threadlines product UI or the capture files. When finished, summarize the new section order, list which asset appears in each section, and report all validation results.
