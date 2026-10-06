#!/bin/sh
# usage: render-site-clips.sh name still.png pan_phase_x pan_phase_y   (FFMPEG=/path/to/ffmpeg if it is not on PATH)
# Writes name.mp4 (H.264, crf 33) and name.webm (VP9, crf 44): 1024 x 576, 8 s, 24 fps, no audio, about 200 to 300 KB each.
# The three that ship: silkroad 0.5 2.0, library 2.2 0.3, valley 4.0 1.2.
# A slow push-in and drift that starts and ends on the whole still (zoom 1.0 at frame 0 and at the end of the loop), so the
# first frame IS the poster and the loop is seamless. Light and colour breathe once per loop and are neutral at frame 0.
FF=${FFMPEG:-ffmpeg}
N=192; T=8
name=$1; src=$2; px=$3; py=$4
tmp=$(mktemp -d)
$FF -hide_banner -loglevel error -y -loop 1 -framerate 24 -i "$src" -vf "scale=3072:-1:flags=lanczos,zoompan=z='1+0.1*(1-cos(2*PI*on/$N))/2':x='(iw-iw/zoom)*(0.5+0.5*sin(2*PI*on/$N+$px))':y='(ih-ih/zoom)*(0.5+0.5*sin(2*PI*on/$N+$py))':d=1:s=1024x576:fps=24,eq=brightness='0.02*sin(2*PI*t/$T)':saturation='1+0.05*(1-cos(2*PI*t/$T))':contrast='1+0.03*sin(2*PI*t/$T)':eval=frame,format=yuv420p" -frames:v $N -c:v libx264 -crf 0 -preset veryfast -an "$tmp/master.mp4"
$FF -hide_banner -loglevel error -y -i "$tmp/master.mp4" -c:v libx264 -preset slow -crf 33 -movflags +faststart -an $name.mp4
$FF -hide_banner -loglevel error -y -i "$tmp/master.mp4" -c:v libvpx-vp9 -b:v 0 -crf 44 -row-mt 1 -deadline good -cpu-used 1 -pix_fmt yuv420p -an $name.webm
rm -rf "$tmp"
