# Rooms launch footage

Records the app footage for `../video`. One thread in the Marketing Capture Studio plays the whole story, "Charged twice" (planned in `../storyboard.html`): some customers are charged twice at checkout and Opus 5.5 can't reproduce it. The user adds GPT-6-Astra, types "@opus" and asks the two to work together. Opus asks Astra (a room ask, answered on the side), Astra names the cause, and Opus reproduces and fixes it. Then the user types "@astra" and asks Astra to check the fix, which Astra does in its own turn.

No agent runs. The thread is created on the studio server; after that, every command for it (the user's clicks included) is caught in the renderer and decided by `engine.ts`, which runs the server's own decider and projector and applies the events to the renderer's store. So the screen shows exactly what the app shows for those events, and no quota is spent.

| File             | What it does                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `engine.ts`      | A stand-in server for the one thread: the real decider and projector, events to a sink.  |
| `story.ts`       | The script: the agents' side as the commands the server would produce, and scene marks.  |
| `dry-run.ts`     | The whole story through the decider with the clicks synthesized. Refusals show up here.  |
| `take.ts`        | Drives the studio over CDP: clicks, typing, a drawn pointer, 2x screencast frames.       |
| `encode-take.py` | Frames to constant 30 fps video on the take's clock; `--export` writes it into the edit. |

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

Then render in `../video` (`npm run render`). The exported takes stay out of git (`../video/.gitignore`), so a fresh checkout records its own. Every take starts and ends by deleting the promo thread and reloading the renderer, so takes can be repeated and the studio is left clean. The story's pauses are reading time: the edit mostly plays the take at real speed. Frames go to `/tmp/rooms-promo/takes/<name>` (about 1 GB a take).

Check the last frame of each export before rendering (`ffmpeg -sseof -0.5 -i ../video/public/rooms-wide.mp4 -frames:v 1 last.png`): it should show Opus's finished turn. The screencast only sends a frame for a paint after its last ack, so `take.ts` repaints one corner pixel 10 times a second to keep the final state from being dropped.
