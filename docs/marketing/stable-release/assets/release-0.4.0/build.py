"""Export a continuous real-app PR page workflow; all output is preview media."""
from pathlib import Path
import subprocess
import json
import imageio_ffmpeg
from PIL import Image
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
TAKE = ROOT / 'output/playwright/release-pr-page-03'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
FLAGS = ['-an', '-r', '30', '-c:v', 'libx264', '-threads', '2', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
def run(*args):
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', *map(str,args)],check=True)
def text(value, size, y, color='d4d4d8'):
    return ("drawtext=fontfile='C\\:/Windows/Fonts/segoeui.ttf':"+f"text='{value}':fontsize={size}:fontcolor=0x{color}:x=(w-tw)/2:y={y}")
wide = HERE / 'next-stable-pr-preview-landscape.mp4'
run('-f','concat','-safe','0','-i',TAKE/'frames.txt','-vf','scale=1600:934:flags=lanczos:in_color_matrix=bt601:out_color_matrix=bt709:in_range=pc:out_range=tv,format=yuv420p,setsar=1,fps=30',*FLAGS,wide)
square = HERE / 'next-stable-pr-preview-square.mp4'
run('-i',wide,'-vf','scale=1080:630:flags=lanczos,pad=1080:1080:0:225:color=0x09090b,setsar=1,'+text('Pull requests. Checks. A fix request.',28,154)+','+text('Demo check states / Release preview',19,905,'a1a1aa'),*FLAGS,square)
results=[]
for video in (wide,square):
    poster = video.with_name(video.stem+'-poster.png')
    run('-i',video,'-frames:v','1',poster)
    reader=imageio_ffmpeg.read_frames(str(video),pix_fmt='rgb24')
    meta=next(reader)
    first=next(reader)
    frames=1+sum(1 for _ in reader)
    exact=first==Image.open(poster).convert('RGB').tobytes()
    assert exact
    results.append({'file':video.name,'seconds':meta['duration'],'dimensions':meta['size'],'fps':meta['fps'],'frames':frames,'bytes':video.stat().st_size,'fullDecode':True,'posterExact':exact,'audio':False})
run('-i',square,'-vf','fps=1/3,scale=360:-1,tile=3x4','-frames:v','1',HERE/'review-sheet.jpg')
(HERE/'render-report.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results))
