# Launch videos

A Remotion project for the launch videos: silent, 30 fps edits in three formats, cut from real app footage recorded by `../source/take.ts` (see its README). There are two stories: Rooms (0.5.0) and agents starting threads (0.6.0). Each story's compositions start with its name; the table shows Rooms, and every `Rooms...` id has a `Threads...` twin (`ThreadsPromoLandscape` is ~51 s, portrait and square ~52 s).

| Composition           | Size      | Length | Use                |
| --------------------- | --------- | ------ | ------------------ |
| `RoomsPromoLandscape` | 1920x1080 | ~53 s  | website, YouTube   |
| `RoomsPromoPortrait`  | 1080x1350 | ~52 s  | 4:5 feeds          |
| `RoomsPromoSquare`    | 1080x1080 | ~52 s  | square feeds       |
| `render:x` (ffmpeg)   | 1080x1080 | ~51 s  | X                  |
| `RoomsPoster*`        | same      | still  | poster PNG sources |
| `RoomsSiteClip`       | 1600x934  | ~46 s  | homepage hero      |
| `RoomsSiteClipTall`   | 800x1000  | ~45 s  | homepage on phones |

This folder is its own npm package, outside the pnpm workspace. Remotion is pinned to 4.0.530: the published 4.0.531 ships an empty `@remotion/cli/dist/render-queue/queue.js`, which breaks the Studio.

## Preview and render

```sh
npm install
npx remotion studio          # or: npm run studio
npm run render               # all three videos, then the posters
```

The raw takes (`public/{rooms,threads}-{wide,tall}.mp4`) aren't committed. Record and export them first with `../source` (see its README); their marks and tracks (`src/takes/*.json`) are committed so the edit compiles.

Every script below has a `threads` twin for the 0.6.0 video: `npm run render:threads`, `render:threads:landscape` (`:portrait`, `:square`, `:posters`), `render:threads:x` and `render:threads:site`, writing `out/threads-*`.

`npm run render` writes `out/rooms-promo-{landscape,portrait,square}.mp4` and `out/rooms-promo-{landscape,portrait,square}-poster.png`. One format at a time: `npm run render:landscape` (or `:portrait`, `:square`, `:posters`). `npm run render:x` cuts `out/rooms-promo-x.mp4` from the square render for X: X shows a video's first frame before it plays and can't pick another, so this cut starts on the finished title card (1.8 s into the intro, held 0.8 s) instead of the logo drawing in. Move the 1.8 if the intro's timing changes. Encoding settings live in `remotion.config.ts` (H.264, yuv420p, CRF 18, bt709, no audio).

`npm run render:site` writes the homepage clips: `out/rooms-site.mp4` and `out/rooms-site-tall.mp4` (the scenes alone, the window filling the frame, labels kept, CRF 23) with their poster PNGs. The site serves them from `apps/marketing/public/Screenshots/rooms/` with WebP posters, and the 0.5.0 changelog page plays a CRF 23 landscape promo from `apps/marketing/public/changelog/v0.5.0/`.

## How the edit is built

- **Stories** (`src/stories.ts`). A story is its two takes, its scenes, the words on its title cards and its release; everything else is shared. `Promo`, the posters and the site clips take a story id.
- **Takes** (`src/takes.ts`, `public/<story>-{wide,tall}.mp4`, `src/takes/`: `{wide,tall}.json` for Rooms, `threads-{wide,tall}.json`). Landscape plays the wide take (the 1600x934 window at 2x); portrait and square play the tall take (the app laid out at 480x800, so its text stays large in a narrow frame). Each take's JSON holds its marks (when each story moment happened), clicks, and tracks: where key elements (the picker, the message box, the request card, each agent's messages) were on screen every 50 ms. `../source/encode-take.py --export <id>` writes both files.
- **Plans** (`src/plan.ts`, `src/scenes.ts` for Rooms, `src/scenes-threads.ts`). Each scene is a list of steps over its take, anchored to marks: `play(from, to, rate)` or `hold(at, seconds)`. Actions play near real time, travel between them is quicker, and payoffs get holds so they can be read. Wherever the thread jumps inside a played range (a card docking, a summary appearing), the plan crossfades across the jump instead of showing it.
- **Scenes** (`src/components/scenes/`). Rooms: three scenes tell one story, "Charged twice" (see `../storyboard.html`). Add a model opens on the user's report of the bug and Opus's first answer, spotlights the model picker while GPT-6-Astra joins, then holds on the message box while the user types "@opus" and asks the two to work together. Work together frames Opus's question to Astra and Astra's answer, follows Opus reproducing and fixing the bug, and settles on question, answer and result. Talk to any agent shows the user asking Astra to check the fix and holds still, close on the question and Astra's answer. One label at a time explains each step ("Opus can't find the cause", "Sending to Opus", "Opus asks Astra", "Astra finds the cause", "Opus fixes it", "Sending to Astra", "Astra checks the fix"); each is pinned just after the last line of the sentence it explains (the take records where that line ends) or above the agent button, so it never covers the chat. The scenes are one continuous take, so they cut straight into each other; only the intro and outro fade.
- **Scenes, agents start threads** ("Slow checkout", `../storyboard-child-threads.html`). Ask first opens on your question and Opus's plan, closes on the request box while its three threads are read ("Opus asks first"), and pulls back to "Started 3 threads" after the click on Start. Three at once goes to the sidebar, where Opus's row opens into the three threads ("Each in its own worktree"), then into one thread (its title, "Started by", the request and its agent at work), and back. The answers come back rests on the newest rows while each answer lands and Opus says a line after each, lights the third ("Sol's thread finds the cause") and settles on it and the result.
- **Shared pieces** (`src/components/`). `Stage` (the window, its camera and float), `TakeVideo` (a plan's footage), `overlays.tsx` (spotlight, click ring, note), `Caption`, `Intro`, `Outro`, `Background`.
- **Camera** (`src/camera.ts`). Keyframes by scene frame: glide to frame a rect (usually a tracked element) and hold. It never shows past the window's edges.

Everything is drawn from `useCurrentFrame()`; there are no CSS animations. Copy lives in the scene lists (captions) and `src/stories.ts` (intro, outro, and `release`, shown as "NEW IN 0.5.0" in the intro and "v0.5.0" on the end card). A title or line too long for a format is set smaller to stay on one line (`TitleBlock`).

## Replacing the footage

Record new takes with `../source/take.ts`, export them with `encode-take.py --export wide|tall`, and render. Scene ranges, camera targets and the picker spotlight all follow the new marks and tracks. If a scene reads a mark or track that a new story no longer produces, the render fails with its name.

## Checking a render

Pull frames from a render and look at them before shipping:

```sh
ffmpeg -ss 35 -i out/rooms-promo-landscape.mp4 -frames:v 1 frame-35.png
```
