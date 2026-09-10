# Six weeks of Threadlines posts

Start with three posts a week on X. Each post explains one thing someone can do in Threadlines. You do not need to become a daily content creator.

The main message is **keep coding agents and the work they produce together**. This kit covers the current product, including familiar features that have not had much promotion since the early releases. It is useful after launch week too.

Account: `@threadlinesdev`, connected in Buffer. Target release: **0.4.0 on September 10, 2026**. Verify the stable downloads and updated site before scheduling the launch announcement. Buffer is the source of truth for current draft and queue status.

## Launch day

Lead with the workspace overview and a short 0.4.0 announcement. Link to the stable download. The release adds the Pull Requests page and failed-check handoff, local English dictation, optional PR auto-fix, and setup improvements. Confirm this list against the reviewed release notes before scheduling.

Follow with the [full PR workflow](assets/release-0.4.0/index.html), [first-run walkthrough](assets/onboarding/preview.html), and [three-image post](assets/triptych/index.html). The PR clip shows staged check results and stops with the fix request in the composer. The onboarding clip shows tool readiness, an already selected project, and an unsent first prompt.

Aim for the launch post at 10 a.m. Eastern on September 10, then use the next Monday, Wednesday, and Friday slots for the follow-ups. If release verification runs past that time, choose a later time today. Never backdate a post or announce a release whose downloads are not ready. Keep the remaining evergreen posts as drafts.

## Your first three posts

1. Open [the preview](index.html). Watch the workspace overview, then the portrait pull request and inbox videos. These are the files selected for your first three posts.
2. Open the channel's **Drafts** tab in Buffer. All 18 posts are saved there with their matching media. [x-posts.csv](x-posts.csv) remains the six-week order and a local backup.
3. Check that the stable download is live and includes what those demos show. Choose your first posting day. `day_offset` means days after that date, not days of the month.
4. Schedule rows 1, 2, and 3. Stop there for this week. The remaining rows can stay as drafts.

The first post introduces the workspace with the 30-second workspace tour. The second shows a pull request beside the conversation. The third shows how you keep track of work across projects. That is enough to give someone a clear first look.

The [three-image post](assets/triptych/index.html) is an additional draft. It uses three full app captures on coordinated backgrounds, with the original app text and favicons preserved. Use it as an alternative workspace introduction or a later recap, rather than scheduling both introductions on the same day.

The evergreen CSV copy has no version number or availability claim. The launch announcement can say "0.4.0 is out" only after the release is published and verified.

The CSV is a manual planning tracker, not a promised Buffer import format. Change `Draft` to `Scheduled` after checking the queue. After publication, change it to `Posted` and paste the post link into `posted_url`. The `alt_text` column describes the visual; add it to image posts and adjust it if you choose different media.

## Schedule with Buffer

Buffer is connected to `@threadlinesdev`. The channel has three posting slots: Monday, Wednesday, and Friday at **10:00 a.m. America/New_York**. These are empty slots, not scheduled posts.

1. Release and verify the stable app before scheduling any of these posts.
2. Open **Drafts** for `@threadlinesdev` in Buffer and review the next three posts against the CSV order. Draft creation order can differ from the campaign order.
3. Play each attached video or open each image. Check the copy and supplied image alt text.
4. Choose a launch day. Schedule the first post for that date, then place the next two in the following chosen slots. Check every displayed date before saving.
5. Open the queue and confirm the account, media, dates, and New York timezone. Only then mark those rows `Scheduled` in the CSV.
6. Leave the remaining posts in Drafts. After each post is sent, record its X link in `posted_url`.

You can ask the posting assistant to prepare, revise, or schedule a named draft. For example: "The stable release is live. Schedule the workspace, PR review, and inbox drafts starting Monday at 10 a.m. Eastern." The assistant can use the saved encrypted Buffer credential on this PC. You do not need to copy the key into a conversation again.

[Buffer's free plan](https://buffer.com/pricing) allows three channels and ten queued posts per channel, checked September 9, 2026. Queue one week at a time and keep the rest as drafts. The local automation key expires November 9, 2026; renew it before continuing API work after that date.

## Use the default format first

For the five feature topics, the CSV points to `assets/spotlights/<scene>-portrait.mp4`. These 1080 x 1350 videos fit wider views where an action needs more context. They are the default for this posting plan, so you can upload the listed file without comparing formats.

If you prefer square, use the same scene's `-square.mp4` file under **Other formats and images** in the preview. It is 1080 x 1080. Portrait and square still images are there too. The landscape versions are useful for the marketing site and wider presentations. These are layout choices, not claims about X's ranking or reach.

## A routine you can keep

Reserve about 30 minutes once a week to read the next three drafts, choose media, and schedule them. The suggested 10:00 a.m. Eastern time is a convenient starting point, not a claim about the best time to post. Choose another time if it makes replies easier for you.

On posting days, spend about ten minutes answering replies. Answer the question asked. If someone reports a bug, ask for the operating system and app version, then move reproduction details into a GitHub issue. Avoid asking for private logs in public replies.

After week three, look for useful questions, profile visits, and link clicks where available. Note which features people did not understand. You can swap the next week's image for its video, explain the confusing part in a reply, or repeat a useful topic with a clearer example. You do not need to rewrite the whole plan.

After week six, keep the demos that explain the product well. Pick the next three posts from real questions or something you used that week. A missed posting day does not require a catch-up thread; move that row to the next open date.

## The six-week outline

| Week | Days       | Posts                                                    | Supplied media                                               |
| ---- | ---------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | 0, 2, 4    | Workspace, pull request review, thread inbox             | Workspace overview, portrait PR and inbox videos             |
| 2    | 7, 9, 11   | Desktop browser, project files, exact context            | Portrait browser and context videos, files image             |
| 3    | 14, 16, 18 | Source control, Git history, provider switching          | Portrait source-control video, history image, provider video |
| 4    | 21, 23, 25 | Agent activity, Wrapped threads, terminal activity       | Activity video, portrait inbox video reused                  |
| 5    | 28, 30, 32 | PR checks, focused follow-ups, real project organization | Portrait PR and context videos, workspace image              |
| 6    | 35, 37, 39 | Browser feedback, open source, a question for users      | Portrait browser video, workspace image, text only           |

The preview starts with the workspace overview and five feature clips. The ten-topic wider demo library and original social images remain below them. Reusing the inbox clip for thread states, Wrapped, and terminal activity is deliberate: each post explains a different detail. You do not need a new recording for every post.

## What these demos represent

The captures use the current app with four approved project names: `Threadlines`, `facpmanuals-next`, `game-idea`, and `wilfredoleon.com`. Their favicon files are the originals. Conversations are recreated around familiar work; private chat history and the game address are excluded.

Active and completed threads, PR badges, terminal indicators, and CI checks are staged demo state rendered by the real app. A visible pointer follows the automated input so the actions are easier to follow. The workspace overview is 30 seconds, showing the app with locked framing, reading holds, and short dissolves. Feature clips are about 9 to 12 seconds; the wider individual demos are generally about 7 to 14 seconds. Do not describe these as live agent runs, actual CI results, or evidence of how fast checks finish.

The workspace overview follows three parts of the app: the inbox, PR review and CI, and changed files. The final captures keep terminal drawers closed; sidebar icons still show terminal activity. The Git history demo opens commit detail popovers to follow branch history. The browser demo expands the public FACPManuals homepage, uses Find in page, and attaches a screenshot to the chat. The provider demo selects Claude and opens the recap confirmation; it stops before confirming the switch. Describe those actions when posting, without implying a completed provider handoff.

The videos and stills show the app itself, with no baked headings, captions, or inset panels. Each shot keeps its framing locked, and short dissolves soften the cuts. Actions stay at their original speed, with holds for reading. Posters match the first video frame to prevent a jump at playback. The website handles any outer corner rounding in its own layout.

Only the isolated demo renderer is captured, without microphone or system audio. You can use other apps and move the physical mouse while the automated take runs; avoid interacting with the demo app. Keep the demo window restored and do not minimize it, because capture can stall when it is minimized. The visible demo pointer is separate from your operating-system cursor.

For another take, use [the asset notes](assets.md). Keep the release number and date out of artwork until confirmed. If you later record an actual agent response or CI run, label time cuts so the video does not imply an instant result.

## Facts behind the copy

This plan covers the whole product, including established features. The CSV marks established topics `Evergreen`, newer PR topics `Confirm in stable`, and the feedback post `Conversation`. Evergreen means the story remains useful after launch; still check that the public download matches the clip. The table also records limits for future dictation and auto-fix posts, which are not part of these 18 drafts.

| Claim                                        | Source in this repository                                                                                                                                                                                                                                                  | Limit to keep in the copy                                                                                                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR hub, diffs, reviews, and feedback handoff | `apps/web/src/components/pull-requests/PullRequestDetailPanel.tsx`, `apps/web/src/components/pull-requests/PullRequestCodeTab.tsx`, `apps/web/src/components/pull-requests/PullRequestReviewBar.tsx`, `apps/web/src/components/pull-requests/pullRequestHandoffs.logic.ts` | Lead with GitHub for this launch; do not promise every host has identical review tools.                                                                                                                                                                                                  |
| PR state beside the composer                 | `apps/web/src/components/chat/ComposerPullRequestRow.tsx`                                                                                                                                                                                                                  | Shows checks and GitHub merge queue state. Wrapping up a thread is a per-thread choice.                                                                                                                                                                                                  |
| Opt-in PR auto-fix                           | `apps/server/src/orchestration/Layers/PullRequestAutoFixWatcher.ts`, `packages/shared/src/pullRequestAutoFix.ts`                                                                                                                                                           | GitHub only. Watches new failures and comments after its first observation. Checks about every two minutes. Caps automatic turns at three per thread/PR/server lifetime and skips busy or waiting threads. It asks the agent to fix, check, commit, and push; success is not guaranteed. |
| Local English dictation                      | `apps/web/src/dictation/useDictation.ts`, `apps/web/src/dictation/dictationModels.ts`, `apps/server/src/dictation/DictationEngine.ts`                                                                                                                                      | Requires a speech-model download. Processing runs on the connected environment's server. A remote server is a different machine, so do not say audio always stays on the device recording it.                                                                                            |
| Desktop browser selection and annotation     | `apps/marketing/src/pages/index.astro`, `apps/marketing/src/content/changelog/v0.3.8.md`                                                                                                                                                                                   | Existing feature. Built-in preview is desktop-only.                                                                                                                                                                                                                                      |
| Provider switching with a recap              | `apps/marketing/src/pages/index.astro`                                                                                                                                                                                                                                     | Existing feature. A recap and working tree carry over, not the other provider's complete native session state.                                                                                                                                                                           |
| Source-control panel and Git graph           | `apps/marketing/src/pages/index.astro`                                                                                                                                                                                                                                     | Existing feature. The source-control clip shows local Git review; use the separate pull-request clip for GitHub PRs.                                                                                                                                                                     |

Threadlines runs locally, but Claude Code and Codex use their own services and accounts. Keep "local workspace" separate from claims about offline or private AI.
