"""Render the silent app hero with fixed crops and short dissolves.

    py docs/marketing/stable-release/source/build-guided-hero.py --prepare
    py docs/marketing/stable-release/source/build-guided-hero.py

Only output/guided-hero is written. Source footage plays at its recorded speed.
Reading holds repeat the last frame. There are no added headers, borders, panels,
or camera moves. Every poster comes from the exact first decoded video frame.
"""

import argparse
import json
from pathlib import Path
import shutil
import subprocess

import imageio_ffmpeg
from PIL import ImageFont


ROOT = Path(__file__).resolve().parents[4]
SOURCE = Path(__file__).resolve().parent
SITE = ROOT / "apps/marketing/public/Screenshots/stable-launch"
OUT = ROOT / "output/guided-hero"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
WIDTH, HEIGHT, FPS = 1600, 934, 30
BG, FG, MUTED, LINE = "#09090b", "#fafafa", "#a1a1aa", "#27272a"
FONTS = Path("C:/Windows/Fonts")
FLAGS = [
    "-an", "-r", "30", "-c:v", "libx264", "-threads", "2", "-preset", "medium",
    "-crf", "18", "-pix_fmt", "yuv420p", "-color_range", "tv",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-movflags", "+faststart",
]


def run(*args):
    subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *map(str, args)],
        check=True,
    )


def font(size, bold=False, mono=False):
    """Shared font helper retained for the other standalone media exporters."""
    name = "consola.ttf" if mono else "seguisb.ttf" if bold else "segoeui.ttf"
    return ImageFont.truetype(str(FONTS / name), size)


def text(draw, xy, value, size, color=FG, bold=False, mono=False):
    draw.text(xy, value, fill=color, font=font(size, bold, mono), anchor="lt")


def metadata(path):
    reader = imageio_ffmpeg.read_frames(str(path))
    value = next(reader)
    reader.close()
    return value


def crop_filter(shot):
    x, y, width = shot["crop"]
    height = round(width * HEIGHT / WIDTH)
    return (
        f"format=yuv444p,crop={width}:{height}:{x}:{y}:exact=1,"
        f"scale={WIDTH}:{HEIGHT}:flags=lanczos:out_color_matrix=bt709:out_range=tv,"
        "setsar=1,format=yuv420p"
    )


def validate(edit):
    if not edit["shots"]:
        raise ValueError("At least one recorded shot is required")
    if edit["transitionSeconds"] <= 0 or edit["loopSeconds"] <= edit["transitionSeconds"]:
        raise ValueError("The loop needs a held frame after its dissolve")
    for shot in edit["shots"]:
        if shot["scene"] not in {"inbox", "pull-requests", "source-control"}:
            raise ValueError("Only approved hero footage can be used")
        duration = metadata(SITE / (shot["scene"] + ".mp4"))["duration"]
        if shot["start"] < 0 or shot["sourceSeconds"] <= 0 or shot["holdSeconds"] < 0:
            raise ValueError("Invalid shot timing")
        if shot["start"] + shot["sourceSeconds"] > duration + 0.05:
            raise ValueError(f"Shot extends past {shot['scene']}")
        x, y, width = shot["crop"]
        height = round(width * HEIGHT / WIDTH)
        if min(x, y) < 0 or width <= 0 or x + width > WIDTH or y + height > HEIGHT:
            raise ValueError("A locked crop exceeds the recorded app")
        if shot["sourceSeconds"] + shot["holdSeconds"] <= edit["transitionSeconds"]:
            raise ValueError("A dissolve cannot consume an entire shot")


def prepare(edit):
    OUT.mkdir(parents=True, exist_ok=True)
    for index, shot in enumerate(edit["shots"]):
        run("-ss", shot["start"], "-i", SITE / (shot["scene"] + ".mp4"),
            "-vf", crop_filter(shot), "-frames:v", "1", OUT / f"shot-{index}-preview.png")
    shutil.copyfile(OUT / "shot-0-preview.png", OUT / "design-preview.png")


def encode_shot(index, shot):
    seconds = shot["sourceSeconds"] + shot["holdSeconds"]
    target = OUT / f"shot-{index}.mp4"
    filters = (
        f"setpts=PTS-STARTPTS,trim=duration={shot['sourceSeconds']},"
        f"{crop_filter(shot)},fps={FPS},"
        f"tpad=stop_mode=clone:stop_duration={shot['holdSeconds'] + .1},trim=duration={seconds}"
    )
    run("-ss", shot["start"], "-i", SITE / (shot["scene"] + ".mp4"),
        "-vf", filters, "-frames:v", round(seconds * FPS), *FLAGS, target)
    print(f"Rendered fixed {shot['scene']} crop: {seconds:.1f}s", flush=True)
    return target


def finish(edit, shots):
    # The loop target is the first encoded shot's first decoded frame. It gives
    # the final dissolve an identical camera position, cursor, and app state.
    run("-i", shots[0], "-frames:v", "1", OUT / "loop-target.png")
    loop = OUT / "loop.mp4"
    run("-i", shots[0], "-vf",
        f"trim=end_frame=1,setpts=PTS-STARTPTS,fps={FPS},tpad=stop_mode=clone:stop_duration={edit['loopSeconds'] + .1}",
        "-frames:v", round(edit["loopSeconds"] * FPS), *FLAGS, loop)
    files = shots + [loop]
    lengths = [shot["sourceSeconds"] + shot["holdSeconds"] for shot in edit["shots"]] + [edit["loopSeconds"]]
    inputs = []
    filters = []
    for index, file in enumerate(files):
        inputs.extend(["-i", file])
        filters.append(f"[{index}:v]settb=1/{FPS},setpts=PTS-STARTPTS,fps={FPS},format=yuv444p[v{index}]")
    previous = "v0"
    duration = lengths[0]
    transitions = []
    for index in range(1, len(files)):
        offset = duration - edit["transitionSeconds"]
        name = f"mix{index}"
        filters.append(
            f"[{previous}][v{index}]xfade=transition=fade:duration={edit['transitionSeconds']}:offset={offset:.6f},fps={FPS},settb=1/{FPS}[{name}]"
        )
        transitions.append({"start": round(offset, 6), "end": round(duration, 6)})
        previous = name
        duration += lengths[index] - edit["transitionSeconds"]
    filters.append(f"[{previous}]tpad=stop_mode=clone:stop_duration=0.1,format=yuv420p[out]")
    hero = OUT / "workspace.mp4"
    run(*inputs, "-filter_complex_threads", "1", "-filter_complex", ";".join(filters),
        "-map", "[out]", "-frames:v", round(duration * FPS), *FLAGS, hero)
    shutil.copyfile(hero, OUT / "launch-overview.mp4")
    run("-i", hero, "-frames:v", "1", OUT / "workspace-frame.png")
    for name in ["launch-video-poster.png", "launch-social.png", "design-preview.png"]:
        shutil.copyfile(OUT / "workspace-frame.png", OUT / name)
    # Lossless WebP retains the same pixels as the decoded opening frame.
    run("-i", OUT / "workspace-frame.png", "-frames:v", "1", "-lossless", "1", OUT / "workspace.webp")
    total = metadata(hero)["duration"]
    run("-i", hero, "-vf", f"fps=12/{total},scale=533:-1,tile=3x4", "-frames:v", "1", OUT / "contact-sheet.png")
    report = {"seconds": total, "transitions": transitions, "sourceSpeed": 1, "camera": "locked crops", "poster": "first decoded frame"}
    (OUT / "render-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Full-frame app hero: {total:.1f}s. Outputs: {OUT}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare", action="store_true", help="Only render the fixed shot previews")
    parser.add_argument("--edit", type=Path, default=SOURCE / "hero-edit.json")
    args = parser.parse_args()
    edit = json.loads(args.edit.read_text(encoding="utf-8"))
    validate(edit)
    prepare(edit)
    if not args.prepare:
        finish(edit, [encode_shot(index, shot) for index, shot in enumerate(edit["shots"])])
