"""Export reviewed app footage, its hero edit, and mobile clips.

Run from the repo root. Optional arguments select scene names, workspace, or
spotlights. Temporary recordings live under ignored output/playwright/.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[4]
KIT = ROOT / 'docs/marketing/stable-release'
SOURCE = KIT / 'source'
ASSETS = KIT / 'assets'
SITE = ROOT / 'apps/marketing/public/Screenshots/stable-launch'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def run(*args):
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', *map(str,args)],check=True)


def install_original(scene, info):
    video = SITE / f'{scene}.mp4'
    shutil.copyfile(video, ASSETS / f'{scene}.mp4')
    # Preview uses frame zero; standalone images can show the useful result.
    run('-i',video,'-frames:v','1','-lossless','1',SITE / f'{scene}.webp')
    run('-i',video,'-frames:v','1',ASSETS / f'{scene}-video-poster.png')
    run('-ss',info['stillSecond'],'-i',video,'-frames:v','1',ASSETS / f'{scene}-frame.png')
    shutil.copyfile(ASSETS / f'{scene}-frame.png', ASSETS / f'{scene}-social.png')


def install_hero():
    output = ROOT / 'output/guided-hero'
    for name in ['workspace.mp4','workspace.webp']:
        shutil.copyfile(output/name,SITE/name)
    for name in ['launch-overview.mp4','launch-video-poster.png','launch-social.png','workspace-frame.png']:
        shutil.copyfile(output/name,ASSETS/name)


def install_spotlights():
    output = ROOT / 'output/feature-spotlights'
    assets = ASSETS / 'spotlights'
    assets.mkdir(exist_ok=True)
    topics = json.loads((SOURCE/'feature-spotlights.json').read_text())
    for topic in topics:
        for shape in ['portrait','square','landscape']:
            for suffix in ['.mp4','-poster.png']:
                name=f'{topic}-{shape}{suffix}'
                shutil.copyfile(output/name,assets/name)
        for shape in ['portrait','square']:
            name=f'{topic}-{shape}.png'
            shutil.copyfile(output/name,assets/name)
        for suffix in ['.mp4','.webp']:
            shutil.copyfile(output/f'{topic}-landscape{suffix}',SITE/f'spotlight-{topic}{suffix}')


if __name__ == '__main__':
    manifest=json.loads((SOURCE/'refresh-takes.json').read_text())
    selected=set(sys.argv[1:])
    SITE.mkdir(parents=True,exist_ok=True)
    ASSETS.mkdir(parents=True,exist_ok=True)
    for scene,info in manifest.items():
        if info.get('guided') or selected and scene not in selected:continue
        take=(ROOT/'output/playwright'/info['take']).resolve()
        if not take.is_relative_to(ROOT/'output/playwright'):
            raise ValueError('Take outside capture workspace')
        trim=info.get('trimSeconds',0)
        flags=['-an','-c:v','libx264','-threads','2','-preset','medium','-crf','18',
            '-pix_fmt','yuv420p','-color_range','tv','-colorspace','bt709',
            '-color_primaries','bt709','-color_trc','bt709','-movflags','+faststart']
        run('-f','concat','-safe','0','-i',take/'frames.txt','-vf',
            f'trim=start={trim},setpts=PTS-STARTPTS,scale=1600:934:flags=lanczos:in_color_matrix=bt601:out_color_matrix=bt709:in_range=pc:out_range=tv,format=yuv420p,setsar=1,fps=30',
            *flags,SITE/f'{scene}.mp4')
        install_original(scene,info)
        print(f'{scene}: exported at original speed',flush=True)
    if not selected or 'workspace' in selected:
        subprocess.run([sys.executable,str(SOURCE/'build-guided-hero.py')],check=True)
        install_hero()
    if not selected or 'spotlights' in selected:
        subprocess.run([sys.executable,str(SOURCE/'build-feature-spotlights.py')],check=True)
        install_spotlights()
