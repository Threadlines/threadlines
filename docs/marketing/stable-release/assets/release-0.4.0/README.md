# Pull Requests page release preview

This clip is prepared for the 0.4.0 stable release. Verify the public downloads before scheduling its post. The video has no baked version or availability claim.

- `next-stable-pr-preview-square.mp4`: 1080 x 1080, 30 fps, about 29 seconds, silent H.264.
- `next-stable-pr-preview-landscape.mp4`: 1600 x 934, same continuous workflow and timing.
- Matching `-poster.png` images are the exact first decoded frame.
- `index.html` provides local playback. `review-sheet.jpg` and `render-report.json` record inspection results.

The pointer opens **Pull Requests from the sidebar**, opens an actual page row, follows the **running Browser tests check**, waits for the staged failure, then clicks **Fix Browser tests with an agent**. The real app opens the linked thread and fills its composer with the failing check, description, PR title, number and branch. A short request is typed above that context. The take stops before sending.

The app stays visible throughout. There are no title slides, end cards, decorative containers, camera zooms or edits that cut off the PR identity. The square version has one small heading in the empty margin and a quiet `Demo check states / Release preview` label. The landscape version is plain app footage. The continuous action plays at its recorded speed, with reading holds.

The checks are deterministic demo states in the actual app. Their running-to-failure timing does not represent a real GitHub Actions run. The app calls this section Checks, not Actions. No real CI run, job-log viewer, successful fix, dictation or automatic-fix run is claimed. No provider turn or GitHub write is part of the recorded workflow. Credentials are not needed or included.

Latest public stable was verified as [v0.3.8](https://github.com/Threadlines/threadlines/releases/tag/v0.3.8), published September 1, 2026. The PR page and review handoff are new since then: #210, followed by composer PR/CI work in #244 and #246. Relevant sources: `PullRequestsView.tsx`, `PullRequestSummaryTab.tsx`, `PullRequestDetailPanel.tsx`, and `pullRequestHandoffs.logic.ts` under `apps/web/src/components/pull-requests/`.

Capture source: `../../source/stage-release-pr-page.mjs` and `../../source/record-release-pr-page.mjs`. They use the owned isolated Release Studio and never the normal Threadlines data. Raw frames stay in ignored `output/playwright/release-pr-page-03/`. `build.py` exports only the two deliverable videos, matching posters and review artifacts. It replaces the rejected text-slide preview under the same filenames so it cannot be uploaded by mistake.

Keep the post as a draft until the stable release has shipped. The finished request remains unsent in the isolated demo composer.
