"""Export the actual onboarding take at native speed, without title cards or zooms."""
import importlib.util
import json
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parents[3]
spec = importlib.util.spec_from_file_location('video_tools', SOURCE / 'build-guided-hero.py')
art = importlib.util.module_from_spec(spec)
spec.loader.exec_module(art)
TAKE = ROOT / 'output/playwright/onboarding-first-thread-1'
OUT = ROOT / 'docs/marketing/stable-release/assets/onboarding'
OUT.mkdir(parents=True, exist_ok=True)
report = []
for shape, (w, h) in {'landscape': (1600, 934), 'square': (1080, 1080)}.items():
    video = OUT / f'onboarding-{shape}.mp4'
    # The square removes only the empty sidebar and outer margin. The complete
    # setup checklist and composer remain visible within a single fixed frame.
    # No input is sped up. Posters match the first decoded video frame.
    crop = 'crop=1056:882:432:52,' if shape == 'square' else ''
    duration = ['-t', '20'] if shape == 'square' else []
    art.run('-f', 'concat', '-safe', '0', '-i', TAKE / 'frames.txt', '-vf',
        f'fps=30,{crop}scale={w}:{h}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2,'
        f'pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1',
        *duration, *art.FLAGS, video)
    art.run('-i', video, '-frames:v', '1', OUT / f'onboarding-{shape}-poster.png')
    data = art.metadata(video)
    art.run('-i', video, '-vf', f"fps=6/{data['duration']},scale=480:-1,tile=3x2", '-frames:v', '1',
        OUT / f'onboarding-{shape}-contact-sheet.png')
    art.run('-i', video, '-f', 'null', '-')
    report.append({'file': video.name, 'duration': data['duration'], 'size': data['size'], 'bytes': video.stat().st_size})
(OUT / 'render-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
