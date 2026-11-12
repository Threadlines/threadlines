# Launch videos

The launch promos and the tools that made them: Rooms for 0.5.0 (`storyboard.html`), agents starting their own threads for 0.6.0 (`storyboard-child-threads.html`), Fleet for 0.8.0 (`source/story-fleet.ts`, two computers) and themes for 0.10.0 (`source/story-themes.ts`, with square clips for X). `source/` records the real app playing a scripted story (no agent runs, no usage spent), and `video/` edits the recordings into the finished videos and the homepage clips. The folder keeps the name of the first video.

## Making the next video

1. **Plan the story.** Copy a storyboard and fill it in: one real problem, the lines each agent would actually say, three or so scenes. Get it reviewed before recording; changing a story after recording means recording again.
2. **Script it** as a new story module in `source/` (`story.ts` and `story-child-threads.ts` are the two so far) and add it to `STORIES` in `take.ts`. The user's side goes through the real UI (`ui.sendTo`, `ui.clickStart`); the agents' side is the commands the server would produce, including what its background services do. Name each moment with `ui.mark` and each element the camera or a label needs with `ui.track`. Write its dry run and run it until the decider accepts the whole story: the story can only do what the app allows.
3. **Rehearse, then record** a wide and a tall take (`source/README.md`). `PROMO_SHOTS=<dir>` saves a screenshot at every mark of a rehearsal; look at them, then check the last frame of each recorded take.
4. **Edit** in `video/`: add the story to `src/stories.ts` (its title cards and release), its scene steps in a `src/scenes-<story>.ts`, its camera and labels in `src/components/scenes/`. Preview in the Studio.
5. **Render** (`npm run render:<story>`, `:x`, `:site`) and pull frames to check before shipping.

The recorder loads the server's decider and projector, and the web app's store, by path. When those move or change shape, `source/engine.ts` and `source/take.ts` fail with the missing name; update them there.

## Re-recording the homepage hero

The video at the top of the homepage is the Rooms story's site clip (`npm run render:site`), not a release video. Record it again when the app's look changes, not for each release: run the dry run, a rehearsal with `PROMO_SHOTS`, both takes, then `render:site`, and copy the clips and WebP posters over `apps/marketing/public/Screenshots/rooms/`. The edit needs no changes while the story keeps its marks.

It was re-recorded again on Oct 28 2026 for the left bar (0.8.0). Its wide clip now shows the whole window, so the layout around the chat is in view (`siteWholeWindow` in `video/src/stories.ts`); the phone clip keeps its close-ups, since at that width the layout is the chat alone.

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

## What we learned on 0.8.0

- **Two computers.** A second Threadlines server, added to the studio app as a saved computer and linked to it, plays the other computer (`--pc-home`). The recorder runs a second engine for that computer's threads and applies its events under its own environment. The PC's real thread list never hears of the scripted thread, so any reload of it fails the take, as on 0.6.0. Its descriptor and link platform are dressed in the renderer only (Windows glyph, its own name as system name, the app's version), so the server is the same code as the Mac's.
- **What the event path leaves out.** The app learns another computer's new thread from that computer's thread list, which carries `remoteOrigin` (the thread that started it here). Applied as events, it didn't (the app's store dropped it; fixed in #689), and the thread showed as its own row instead of under its parent. The take still adds it the way the thread list would, which is harmless once the store keeps it. An empty scripted thread also needs `threadDetailLoadedById`, or it reads "Loading conversation".
- **Story.** Will wanted the opening message typed on screen, so viewers know the problem, and the reason for the other computer said in so many words ("So it could be a Windows problem"). A child thread on another computer shows the cloud like every thread that isn't on this computer (fixed in the app for this video).
- **Stills.** `PROMO_HOLD_AT=<mark>` pauses a rehearsal at a moment so stills of the live state can be taken, then the story carries on.
- **Lengths.** About 52 s for the promo, 45 s for the site cut.

## What we learned on 0.10.0

- **Live art has to be recorded as the app runs in front.** Behind other apps a theme's art drops to 10 frames a second, and the studio's window usually is behind them. A story that exports `IN_FRONT` gets the app's "is this window in front" check answered yes for the take (`take.ts` serves that one module changed; nothing on disk changes). The first cut's rain stuttered because of this.
- **60 frames a second for art.** The starters draw 20 times a second, which lands on every third frame at 60 and can't land evenly at 30. The themes composition renders at 60 while every plan, camera move and label stays timed in 30ths (`video/src/frame.ts`: `useFrame`, `useOutScale`), and its take is encoded with `--fps 60`. Play stretches where art is the thing to look at at real speed (or 1.5x or 3x), or the cadence breaks again.
- **Even out the art's frames.** Where nothing moves but art (the opening), the story names the span (`STEADY_MARKS`) and rests the corner pixel (`ui.steady`), and `encode-take.py` shows the span's frames in the order captured, one period of the art's rate each, so a frame that reached the recorder late keeps its place. Its printout says how many frames it found: 100 in 5 seconds at 20 a second is a clean capture, and it says so when the count is off.
- **Leave out, don't speed up.** `skip(from, to)` in a scene's steps crossfades over seconds the story doesn't need (a long look already had, a pointer's trip). Speeding those up made the first cut feel rushed.
- **Story.** Switching themes through the /theme strip misled: the ring stays on the theme you've kept while others preview. The starters now show on the new-thread screen, cut together, and /theme is its own short scene. Say that the starters are only a start and a theme can be anything you ask for. A scene about a second subject (sharing one theme, then another theme's trick) read as out of place and was cut from the video; its steps are kept (`THEMES_SHARE_SCENE`).
- **Clips for X** (`video/src/Clip.tsx`, `npm run render:themes:clips`): square, cut from the wide take by framing part of the window, a few scenes and the end card. X shows a video's first frame as its picture, so a clip opens on the app with its caption already in place, and the Honu clip opens on a moment of the finished theme.
- **Leave the studio as you found it.** A story that changes the studio outside its thread (a theme, a setting, the library) reads what it is about to change and puts it back in `restore()`, and removes only what it added: the studio app can be connected to other computers, and a library entry removed here is removed there. A take that fails before its own cleanup still gives the app its real "in front" answer back.
- **The app's own quirks in a take.** The timeline recycles its rows, so pick a row's button by its words ("Try it"), not by position in the page. Typing "@name" in the message box opens the file-mention menu. The slash menu lists the recording computer's own plugin commands under /theme (hidden for the take). The Share dialog remembers the last credit typed (cleared before a take). A theme that fails the readability check (4.5:1) is refused, as it should be: the stand-in files have to pass too.
- **Lengths.** 72 seconds for the video (five scenes), 16 and 33 for the clips.
