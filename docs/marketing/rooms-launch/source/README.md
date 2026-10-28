# Launch footage

Records the app footage for `../video`, one story per video, in the Marketing Capture Studio:

- **Rooms, "Charged twice"** (`story.ts`, planned in `../storyboard.html`): some customers are charged twice at checkout and Opus 5.5 can't reproduce it. The user adds GPT-6.1-Sol, types "@opus" and asks the two to work together. Opus asks Sol (a room ask, answered on the side), Sol names the cause, and Opus reproduces and fixes it. Then the user types "@sol" and asks Sol to check the fix, which Sol does in its own turn.
- **Agents start threads, "Slow checkout"** (`story-child-threads.ts`, planned in `../storyboard-child-threads.html`): checkout got slow. Opus 5.5 asks to start three threads, one per suspect, each on its own model; the user clicks Start; the three show under Opus's thread in the sidebar and the user opens one; their answers come back to Opus one by one, the third names the cause, and Opus fixes it.

- **Fleet, "Screenshots on Windows"** (`story-fleet.ts`, 0.8.0): you ask Opus 5.5 on the MacBook Pro why an agent on your Windows PC couldn't take browser screenshots. It works on the Mac, so Opus asks to start a thread on the Windows PC; you click Start; the PC's thread (GPT-6.1-Sol) runs a probe there, you look inside it and at Fleet, and its answer comes back and changes Opus's plan. Two computers: the studio is the Mac, and a second Threadlines server, linked to it and set to allow its agents, is the PC.

No agent runs. The promo thread is created on the studio server; after that, every command for it (the user's clicks included) is caught in the renderer and decided by `engine.ts`, which runs the server's own decider and projector and applies the events to the renderer's store. So the screen shows exactly what the app shows for those events, and no quota is spent.

The child-threads story is `isolated` (see `STORIES` in `take.ts`): its three child threads exist only in the engine and the renderer, because only the server's own services may create a child thread. For such a story the recorder also answers every thread-detail subscription for the take's threads itself (the studio server's copy would replace the story when a thread is opened), makes a real worktree in the studio's Orbit repo for each child and removes it afterwards, and fails a take during which the app reloaded its thread list from the server (that drops threads only the engine knows).

| File                       | What it does                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `engine.ts`                | A stand-in server for the take's threads: the real decider and projector, events to a sink. |
| `story.ts`                 | Rooms: the agents' side as the commands the server would produce, and scene marks.          |
| `story-child-threads.ts`   | Agents start threads: the same, plus the server's child-thread setup and answer delivery.   |
| `dry-run.ts`               | The Rooms story through the decider with the clicks synthesized. Refusals show up here.     |
| `dry-run-child-threads.ts` | The same for the child-threads story.                                                       |
| `story-fleet.ts`           | Fleet: both computers' commands, the link's start and report, and the PC's thread.          |
| `dry-run-fleet.ts`         | The same for the Fleet story, with one engine per computer.                                 |
| `take.ts`                  | Drives the studio over CDP: clicks, typing, a drawn pointer, 2x screencast frames.          |
| `encode-take.py`           | Frames to constant 30 fps video on the take's clock; `--export` writes it into the edit.    |

## Recording

```sh
node scripts/marketing-studio.ts launch                  # from the repo root; CDP on 9223
cd docs/marketing/rooms-launch/source
node dry-run.ts                                          # optional: check the story first
node take.ts wide-1                                      # 1600x934 window
python3 encode-take.py /tmp/rooms-promo/takes/wide-1 --export wide
node take.ts tall-1 --viewport=480x800                   # phone-width layout
python3 encode-take.py /tmp/rooms-promo/takes/tall-1 --export tall
node take.ts --cleanup                                   # remove the promo thread
```

For the 0.8.0 story, start a second server as the PC (its own `THREADLINES_HOME` with `"computerName": "Windows PC"` in its `settings.json`, and a `git clone --shared` of the Threadlines repo as its project), add it to the studio app (Settings › Connections, or `addSavedEnvironment` in the renderer), link the two from Fleet, set "MacBook Pro's agents can start work on Windows PC" to Allowed, and give the studio the same project. Then `node dry-run-fleet.ts` and `node take.ts <name> --story=fleet --pc-home=<PC home>` (add `--viewport=480x800` for the tall take). `PROMO_HOLD_AT=family-open` holds a rehearsal there, with the PC's thread at work, until `/tmp/rooms-promo/hold` is deleted: time for stills.

For the 0.6.0 story, add `--story=child-threads` to every `take.ts` line and run `node dry-run-child-threads.ts`; a rehearsal with screenshots is `PROMO_SHOTS=/tmp/promo-shots node take.ts <name> --story=child-threads --rehearse`. `encode-take.py` reads the story from the take, so its exports land beside the Rooms ones (`public/threads-wide.mp4`, `src/takes/threads-wide.json`) instead of over them.

Then render in `../video` (`npm run render`, or `npm run render:threads`). The exported takes stay out of git (`../video/.gitignore`), so a fresh checkout records its own. Every take starts and ends by deleting the promo thread and reloading the renderer, so takes can be repeated and the studio is left clean. The story's pauses are reading time: the edit mostly plays the take at real speed. Frames go to `/tmp/rooms-promo/takes/<name>` (about 1 GB a take).

Check the last frame of each export before rendering (`ffmpeg -sseof -0.5 -i ../video/public/rooms-wide.mp4 -frames:v 1 last.png`): it should show the finished last turn. The screencast only sends a frame for a paint after its last ack, so `take.ts` repaints one corner pixel 10 times a second to keep the final state from being dropped.
