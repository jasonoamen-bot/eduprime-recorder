# The image only adds the SYSTEM software (browser, ffmpeg, virtual screen/sound).
# The compiled code and production node_modules are prepared outside Docker by
# `scripts/prepare-image.ps1` / `npm run image:prepare`, so a slow or flaky
# connection never has to download npm packages inside a build.
#
#   chromium: renders the class page      xvfb: virtual screen
#   pulseaudio: virtual sound card         ffmpeg: films screen + sound
#   tini: reaps the zombie processes browsers leave behind
FROM node:22-bookworm-slim

RUN apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      chromium ffmpeg xvfb pulseaudio pulseaudio-utils \
      fonts-noto-core fonts-noto-color-emoji fonts-liberation \
      tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1001 recorder \
 && mkdir -p /data/spool /tmp/.X11-unix /tmp/runtime \
 && chmod 1777 /tmp/.X11-unix \
 && chown -R recorder /data /tmp/runtime

WORKDIR /app
COPY .stage/node_modules ./node_modules
COPY dist ./dist
COPY package.json ./
COPY fixtures ./fixtures
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER recorder
ENV NODE_ENV=production \
    XDG_RUNTIME_DIR=/tmp/runtime \
    SPOOL_DIR=/data/spool \
    CHROMIUM_PATH=/usr/bin/chromium
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
