# Launch videos

The launch promos and the tools that made them: Rooms for 0.5.0 (`storyboard.html`) and agents starting their own threads for 0.6.0 (`storyboard-child-threads.html`). `source/` records the real app playing a scripted story (no agent runs, no usage spent), and `video/` edits the recordings into the finished videos and the homepage clips. The folder keeps the name of the first video.

## Making the next video

1. **Plan the story.** Copy a storyboard and fill it in: one real problem, the lines each agent would actually say, three or so scenes. Get it reviewed before recording; changing a story after recording means recording again.
2. **Script it** as a new story module in `source/` (`story.ts` and `story-child-threads.ts` are the two so far) and add it to `STORIES` in `take.ts`. The user's side goes through the real UI (`ui.sendTo`, `ui.clickStart`); the agents' side is the commands the server would produce, including what its background services do. Name each moment with `ui.mark` and each element the camera or a label needs with `ui.track`. Write its dry run and run it until the decider accepts the whole story: the story can only do what the app allows.
3. **Rehearse, then record** a wide and a tall take (`source/README.md`). `PROMO_SHOTS=<dir>` saves a screenshot at every mark of a rehearsal; look at them, then check the last frame of each recorded take.
4. **Edit** in `video/`: add the story to `src/stories.ts` (its title cards and release), its scene steps in a `src/scenes-<story>.ts`, its camera and labels in `src/components/scenes/`. Preview in the Studio.
5. **Render** (`npm run render:<story>`, `:x`, `:site`) and pull frames to check before shipping.

The recorder loads the server's decider and projector, and the web app's store, by path. When those move or change shape, `source/engine.ts` and `source/take.ts` fail with the missing name; update them there.

## Re-recording the homepage hero

The video at the top of the homepage is the Rooms story's site clip (`npm run render:site`), not a release video. Record it again when the app's look changes, not for each release: run the dry run, a rehearsal with `PROMO_SHOTS`, both takes, then `render:site`, and copy the clips and WebP posters over `apps/marketing/public/Screenshots/rooms/`. The edit needs no changes while the story keeps its marks.

It was re-recorded on Oct 8 2026 for the redesign, with GPT-6.1-Sol in place of GPT-6-Astra (`storyboard.html` still shows the 0.5.0 plan with Astra). An added agent starts on its model's default reasoning, Low for GPT-6.1-Sol, so `addSol` in `take.ts` sends `thread.participant.update` with `SOL_OPTIONS` right after the add: the same command the message box's reasoning control sends, applied before the next paint so the default never shows.

## What we learned on 0.5.0

- **Length.** 46 s felt rushed and about 61 s too long; about 52 s worked. Actions can play at 1.2 to 2.4x, but every line an agent says needs a hold long enough to read it.
- **Labels.** One at a time, pinned just after the line it explains or above a button. A label must never cover the chat.
- **Story.** Show agents working together on a real bug with a cause and a fix. A model switcher or a feature tour reads as less than it is.
- **Intro.** Words appear at once and hold; 4 s worked. Text that animated in quickly was missed, and 5.5 s felt long.
- **Camera.** Hold still after a payoff. Pulling back right after an answer shrinks it before anyone can read it.
- **Recording.** The screencast can drop the last paint, so check the last frame of each take. A failing test inside the story shows "1 check failed" in the turn summary; reproduce a bug with a script instead.
- **X.** X can't pick a thumbnail and shows the first frame, so the X cut (`npm run render:x`) opens on the finished title card. Square fills more of a phone feed than 16:9 and isn't cropped on desktop.

## What we learned on 0.6.0

- **A story with more than one thread** needs the recorder to be the only server for all of them (`isolated` in `take.ts`): threads only the engine knows are dropped the moment the app reloads its thread list from the studio server, and opening a thread fetches the server's copy of it. The recorder blocks the second and refuses to use a take where the first happened.
- **Replay the server's background work at its own pace.** A child's answer is queued for its parent, and when the parent is idle the server sends it at once, as a separate step a moment later. Scripting a 2 s pause between the two left a "Paused from..." line on screen that the app shows for a blink at most. The take applies both steps in one burst (`engine.batch`) and puts the reading pause where the app has it: while the parent's agent is working on the answer.
- **Click a sidebar row on its title.** Hovering a row shows its wrap-up button in the middle, and a click there files the thread under Wrapped.
- **Lengths.** About 51 s wide and 52 s tall, inside the range that worked for 0.5.0.
- **Title cards** fit a longer title by setting it smaller on one line; "Agents start threads" needed that in the narrow formats.
