# First-run setup

The landscape clip is 22.8 seconds at 1600 × 934. The square cut is 20 seconds at 1080 × 1080. Both are silent H.264 MP4 files at 30 fps, with a visible cursor. Posters are the first decoded frame.

The real app shows its setup checklist, the Install control for a missing Claude installation, Codex ready, Git available, optional GitHub sign-in, and an existing Threadlines folder. The cursor points to Install without clicking it, then clicks Start first thread and types a short request. The request is never sent.

The landscape keeps the full app. The square uses one fixed crop around the main canvas. It preserves every checklist row, action, and the complete composer while removing the empty sidebar and title bar. No camera motion, title slides, or text transitions were added.

Suggested post:

> First run should tell you what to do next. Threadlines checks your coding agents and Git tools, shows what needs installing or signing in, and gets you to your first thread. You only need one agent ready to begin. https://www.threadlines.dev/download

Suggested page caption:

> See what's ready, what needs setup, and how to start your first thread.

Recording notes:

- This is a recreated first-run state in the isolated release studio. The provider readiness and optional GitHub sign-in state are fixtures, not evidence of an install or login completed during recording.
- Git availability was read from the studio. No real account label is shown. No private conversation is used.
- The Threadlines folder was already selected before the clip begins. Do not describe this take as showing the folder chooser or a full fresh installation.
- No installer was run, no provider was signed in, and no provider turn was sent. Installer, provider auth, and orchestration write calls were blocked for the recording. The GitHub sign-in control was not clicked.
- This is a product walkthrough, not an announcement that a stable release has shipped. The visible development build version is not a release promise.
- Full MP4 decoding passed for both exports. Contact sheets and the first poster were visually checked.

Sources: `../../source/record-onboarding.mjs` and `../../source/export-onboarding.py`.
