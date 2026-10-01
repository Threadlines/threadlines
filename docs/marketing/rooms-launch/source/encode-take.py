"""Encodes a take's screencast frames as constant 30 fps video on the take's
own clock, so the marks in take.json line up with video time exactly. With
--export, also writes it into the edit as public/rooms-<id>.mp4 plus its marks
and clicks as src/takes/<id>.json.

    python3 encode-take.py /tmp/rooms-promo/takes/<name> [--export wide|tall]
"""

import json
import os
import subprocess
import sys

FPS = 30

take_dir = sys.argv[1]
export_id = sys.argv[sys.argv.index("--export") + 1] if "--export" in sys.argv else None
video_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "video")
take = json.load(open(os.path.join(take_dir, "take.json")))

# frames.txt: "file 'x'" / "duration d" pairs, starting at take.firstFrameAt.
frames = []
at = take["firstFrameAt"]
lines = open(os.path.join(take_dir, "frames.txt")).read().splitlines()
for index, line in enumerate(lines):
    if line.startswith("file ") and index + 1 < len(lines) and lines[index + 1].startswith("duration "):
        frames.append((at, line[6:-1]))
        at += float(lines[index + 1].split()[1])

cfr = os.path.join(take_dir, "cfr")
os.makedirs(cfr, exist_ok=True)
for name in os.listdir(cfr):
    os.remove(os.path.join(cfr, name))
count = int(take["seconds"] * FPS)
cursor = 0
for tick in range(count):
    t = tick / FPS
    while cursor + 1 < len(frames) and frames[cursor + 1][0] <= t:
        cursor += 1
    os.symlink(os.path.join(take_dir, frames[cursor][1]), os.path.join(cfr, f"{tick:06d}.jpg"))

subprocess.run(
    [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", str(FPS), "-i", os.path.join(cfr, "%06d.jpg"),
        "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", os.path.join(take_dir, "take.mp4"),
    ],
    check=True,
)
if export_id is not None:
    # Takes aren't committed, so a fresh checkout has no public/ yet.
    os.makedirs(os.path.join(video_dir, "public"), exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-framerate", str(FPS), "-i", os.path.join(cfr, "%06d.jpg"),
            "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", "-an",
            os.path.join(video_dir, "public", f"rooms-{export_id}.mp4"),
        ],
        check=True,
    )
    log = {
        "seconds": round(take["seconds"], 3),
        "marks": {mark["name"]: round(mark["at"], 3) for mark in take["marks"]},
        "clicks": [
            {"at": round(click["at"], 3), "x": round(click["x"]), "y": round(click["y"])}
            for click in take["clicks"]
        ],
        "tracks": take.get("tracks", {}),
    }
    with open(os.path.join(video_dir, "src", "takes", f"{export_id}.json"), "w") as out:
        json.dump(log, out, indent=2)
        out.write("\n")

print(json.dumps({"frames": len(frames), "ticks": count, "seconds": count / FPS}))
