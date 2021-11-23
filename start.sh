#!/bin/bash
export URL_LAUNCHER_NODE=1
export NODE_ENV=production
# By default Docker gives 64MB of shared memory, but to display heavy pages we need more:
umount /dev/shm && mount -t tmpfs shm /dev/shm

# use the locally installed electron module, rather than any that might be installed globally.
# this also gives control to package.json as to which exact version of electron to use.
# Below also sets an X instance with ONLY electronjs running, rather than a full desktop environment
# saving a lot of resources (especially since this is for a headless display without any UI).

rm /tmp/.X0-lock &>/dev/null || true

# Set whether we're using the PI TFT screen, rotation, etc. and start X else, using HDMI output, just start X
if [ ! -c /dev/fb1 ] && [ "TFT" = "1" ]; then
  modprobe spi-bcm2708 || true
  modprobe fbtft_device name=pitft verbose=0 rotate=${TFT_ROTATE:-0} || true
  sleep 1
  mknod /dev/fb1 c $(cat /sys/class/graphics/fb1/dev | tr ':' ' ') || true
  FRAMEBUFFER=/dev/fb1 startx /usr/src/app/node_modules/electron/dist/electron /usr/src/app --enable-logging --no-sandbox
else
  startx /usr/src/app/node_modules/electron/dist/electron /usr/src/app --enable-logging --no-sandbox