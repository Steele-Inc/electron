# Specify balena's maintained core image for Raspberry Pi3, Node 10.16, and Ubuntu Bionic
FROM balenalib/raspberrypi3-ubuntu-node:10.16-bionic
ENV DEBIAN_FRONTEND noninteractive

# Install necessary modules to support Electron.js runtime, including xorg display and supporting libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
  apt-utils \
  clang \
  xserver-xorg-core \
  xserver-xorg-input-all \
  xserver-xorg-video-fbdev \
  xorg \
  libxcb-image0 \
  libxcb-util1 \
  xdg-utils \
  libdbus-1-dev \
  libgtk2.0-dev \
  libnotify-dev \
  libgnome-keyring-dev \
  libgconf2-dev \
  libasound2-dev \
  libcap-dev \
  libcups2-dev \
  libxtst-dev \
  libxss1 \
  libnss3-dev \
  libsmbclient \
  libssh-4 \
  fbset \
  python3.8 \
  libexpat-dev && rm -rf /var/lib/apt/lists/*

#To eliminate "node-gyp rebuild" error
# RUN npm install --global npm@latest
# RUN npm install --global node-gyp@latest
RUN npm install -g node-gyp
RUN npm config set node_gyp $(npm prefix -g)/lib/node_modules/node-gyp/bin/node-gyp.js


# Set app working directory
WORKDIR /usr/src/app

# Move package.json to app dir for dependency installation
COPY ./package.json .
COPY ./node-rpio ./node-rpio
RUN npm install ./node-rpio
RUN npm install && npm cache clean --force && rm -rf /tmp/*

# Copy over app source code
COPY . .
# Systemd
ENV INITSYSTEM on

# set Xorg and FLUXBOX preferences
RUN mkdir ~/.fluxbox
RUN echo "xset s off" > ~?.fluxbox/startup && echo "xserver-command=X -s 0 dpms" >> ~/.fluxbox/startup
# Set xserver to run
RUN echo "#!/bin/bash" > /etc/X11/xinit/xserverrc \
  echo "" >> /etc/X11/xinit/xserverrc \
  echo 'exec /usr/bin/X -s 0 dpms -nocursor -nolisten tcp "$@"' >> /etc/X11/xinit/xserverrc

# Start Electron app using a script
CMD ["bash", "/usr/src/app/start.sh"]