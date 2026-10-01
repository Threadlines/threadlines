# Rooms launch video

The Rooms promo for 0.5.0 and the tools that made it. `storyboard.html` is the plan, `source/` records the real app playing a scripted thread (no agent runs, no usage spent), and `video/` edits the recordings into the finished videos and the homepage clips.

## Making the next video

1. **Plan the story.** Copy `storyboard.html` and fill it in: one real problem, the lines each agent would actually say, three or so scenes. Get it reviewed before recording; changing a story after recording means recording again.
2. **Script it** in `source/story.ts`. The user's side goes through the real UI (`ui.addAstra`, `ui.sendTo`); the agents' side is the commands the server would produce. Name each moment with `ui.mark` and each element the camera or a label needs with `ui.track`. Run `node dry-run.ts` until the decider accepts the whole story: the story can only do what the app allows.
3. **Record** a wide and a tall take (`source/README.md`) and check the last frame of each.
4. **Edit** in `video/`: scene steps in `src/scenes.ts`, camera and labels in `src/components/scenes/`, copy in `src/config.ts` and `src/scenes.ts`. Preview in the Studio.
5. **Render** (`npm run render`, `render:x`, `render:site`) and pull frames to check before shipping.

The recorder loads the server's decider and projector, and the web app's store, by path. When those move or change shape, `source/engine.ts` and `source/take.ts` fail with the missing name; update them there.

## What we learned on 0.5.0

- **Length.** 46 s felt rushed and about 61 s too long; about 52 s worked. Actions can play at 1.2 to 2.4x, but every line an agent says needs a hold long enough to read it.
- **Labels.** One at a time, pinned just after the line it explains or above a button. A label must never cover the chat.
- **Story.** Show agents working together on a real bug with a cause and a fix. A model switcher or a feature tour reads as less than it is.
- **Intro.** Words appear at once and hold; 4 s worked. Text that animated in quickly was missed, and 5.5 s felt long.
- **Camera.** Hold still after a payoff. Pulling back right after an answer shrinks it before anyone can read it.
- **Recording.** The screencast can drop the last paint, so check the last frame of each take. A failing test inside the story shows "1 check failed" in the turn summary; reproduce a bug with a script instead.
- **X.** X can't pick a thumbnail and shows the first frame, so the X cut (`npm run render:x`) opens on the finished title card. Square fills more of a phone feed than 16:9 and isn't cropped on desktop.
