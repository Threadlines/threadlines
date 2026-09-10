"""Export app-only clips with locked framing, native playback, and short dissolves.

    py docs/marketing/stable-release/source/build-feature-spotlights.py [scene]

The reviewed source videos are never changed. Generated files stay in output/.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil

SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parents[3]
SITE = ROOT / 'apps/marketing/public/Screenshots/stable-launch'
OUT = ROOT / 'output/feature-spotlights'
spec = importlib.util.spec_from_file_location('video_tools', SOURCE / 'build-guided-hero.py')
art = importlib.util.module_from_spec(spec)
spec.loader.exec_module(art)
FORMATS = {'portrait': (1080, 1350), 'square': (1080, 1080), 'landscape': (1600, 934)}
TRANSITION = 0.4


def crop(shot, shape):
    tw, th = FORMATS[shape]
    if shape in shot.get('frames', {}):
        x, y, width, height = shot['frames'][shape]
    else:
        x, y, width = shot['crops'][shape]
        width = round(width / 2) * 2
        height = round(width * th / tw / 2) * 2
    if x < 0 or y < 0 or x + width > 1600 or y + height > 934:
        raise ValueError(f'Crop outside source: {shape} {x,y,width,height}')
    return x, y, width, height


def render(name, scene, shape):
    tw, th = FORMATS[shape]
    shots = scene['shots']
    files = []
    for index, shot in enumerate(shots):
        x, y, width, height = crop(shot, shape)
        # Extra tail is consumed by the dissolve; input action keeps its timing.
        duration = shot['seconds'] + (TRANSITION if index < len(shots)-1 else 0)
        if shot['sourceSeconds'] > duration:
            raise ValueError('Shot is shorter than its source action')
        target = OUT / f'{name}-{shape}-shot-{index}.mp4'
        art.run('-ss', shot['start'], '-i', SITE / f'{name}.mp4', '-vf',
            f"trim=duration={shot['sourceSeconds']},setpts=PTS-STARTPTS,fps=30,"
            f"crop={width}:{height}:{x}:{y},scale={tw}:{th}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2,"
            f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,"
            f'tpad=stop_mode=clone:stop_duration={duration},trim=duration={duration},format=yuv420p',
            '-t', duration, *art.FLAGS, target)
        files.append(target)
    stem = f'{name}-{shape}'
    body = OUT / f'{stem}-body.mp4'
    if len(files) == 1:
        shutil.copyfile(files[0], body)
    else:
        inputs = []
        for file in files: inputs.extend(['-i', file])
        filters = [f'[{i}:v]settb=1/30,setpts=PTS-STARTPTS,fps=30[v{i}]' for i in range(len(files))]
        elapsed = shots[0]['seconds']
        current = 'v0'
        for i in range(1, len(files)):
            target = f'join{i}'
            filters.append(f'[{current}][v{i}]xfade=transition=fade:duration={TRANSITION}:offset={elapsed}[{target}]')
            elapsed += shots[i]['seconds']
            current = target
        art.run(*inputs, '-filter_complex_threads', '1', '-filter_complex', ';'.join(filters),
                '-map', f'[{current}]', *art.FLAGS, body)
    # Return to the opening frame during the final hold for a quiet loop boundary.
    duration = sum(shot['seconds'] for shot in shots)
    opening = OUT / f'{stem}-opening.png'
    art.run('-i', body, '-frames:v', '1', opening)
    video = OUT / f'{stem}.mp4'
    art.run('-i', body, '-loop', '1', '-framerate', '30', '-i', opening,
        '-filter_complex_threads', '1', '-filter_complex',
        f'[0:v]settb=1/30,setpts=PTS-STARTPTS,fps=30[a];[1:v]settb=1/30,setpts=PTS-STARTPTS,fps=30[b];'
        f'[a][b]xfade=transition=fade:duration={TRANSITION}:offset={duration-TRANSITION-1/30}[out]',
        '-map', '[out]', '-t', duration, *art.FLAGS, video)
    # A matching poster avoids a jump when playback starts.
    art.run('-i', video, '-frames:v', '1', OUT / f'{stem}-poster.png')
    if shape == 'landscape':
        art.run('-i', video, '-frames:v', '1', '-lossless', '1', OUT / f'{stem}.webp')
    else:
        art.run('-ss', min(scene['posterSecond'], duration-TRANSITION-.1), '-i', video,
                '-frames:v', '1', OUT / f'{stem}.png')
    art.run('-i', video, '-vf', f'fps=6/{duration},scale=360:-1,tile=3x2',
            '-frames:v', '1', OUT / f'{stem}-contact-sheet.png')
    print(f'{stem}: {duration:.1f}s', flush=True)
    return {'file': video.name, 'seconds': duration, 'size': [tw,th], 'bytes': video.stat().st_size}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scenes', nargs='*')
    args = parser.parse_args()
    manifest = json.loads((SOURCE / 'feature-spotlights.json').read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    for name, scene in manifest.items():
        if args.scenes and name not in args.scenes: continue
        duration = art.metadata(SITE / f'{name}.mp4')['duration']
        for shot in scene['shots']:
            if shot['start'] < 0 or shot['sourceSeconds'] <= 0 or shot['start'] + shot['sourceSeconds'] > duration + .05:
                raise ValueError(f'Shot outside {name}')
        for shape in FORMATS: results.append(render(name, scene, shape))
    report = OUT / 'render-report.json'
    previous = json.loads(report.read_text()) if report.exists() else []
    merged = {item['file']: item for item in previous + results}
    report.write_text(json.dumps(list(merged.values()), indent=2)+'\n')
