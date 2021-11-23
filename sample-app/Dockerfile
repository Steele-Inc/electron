# FROM balena-electron-env
# FROM balenablocks/armv7hf-balena-electron-env
FROM balenablocks/armv7hf-balena-electron-env:v1.2.6

COPY package.json package-lock.json ./
RUN npm i --production
RUN npm i electron
COPY index.js index.html renderer.js start.sh ./

RUN npm install

# CMD ["bash", "./start.sh"]

# CMD ["bash", "/usr/src/app/start.sh"]
