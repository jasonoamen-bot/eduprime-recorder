#!/bin/sh
# Makes the 5-minute test video + audio used by the load test (uses the ffmpeg inside the recorder image).
set -e
M=/opt/eduprime-recorder/bench/media
mkdir -p "$M"
docker run --rm --user root -v "$M:/m" --entrypoint ffmpeg eduprime-recorder:server -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x480:rate=30" -t 300 -c:v libvpx -b:v 600k -g 60 -deadline realtime -cpu-used 8 -an -f ivf /m/video.ivf
docker run --rm --user root -v "$M:/m" --entrypoint ffmpeg eduprime-recorder:server -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:duration=300" -af "volume=0.3,apulsator=hz=0.5" -c:a libopus -b:a 48k -ar 48000 -ac 2 -f ogg /m/audio.ogg
ls -lh "$M"
