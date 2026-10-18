# Imagen oficial de Playwright (Ubuntu noble + Node 24 + Chromium y sus libs),
# igual que multas-next y afip-hub. Antes era node:18-alpine + apk chromium +
# puppeteer. El tag DEBE coincidir con "playwright" en package.json (1.62.1).
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Los navegadores ya vienen en la imagen (/ms-playwright, PLAYWRIGHT_BROWSERS_PATH).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# 1) tini como PID 1: cosecha los procesos huérfanos de Chromium (sin él quedan
#    zombies ocupando PIDs hasta agotar pids.max del contenedor).
#    python3/make/g++: better-sqlite3 11.x no publica binario precompilado para
#    Node 24 (el de la imagen) y lo compila con node-gyp durante npm install.
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# 2) Crea el directorio de trabajo
WORKDIR /usr/src/app

# 3) Copia los archivos de dependencias y las instala
COPY package*.json ./
RUN npm install

RUN mkdir -p /usr/src/app/static/uploads

# 4) Copia el resto del código fuente
COPY . .

# 5) Compila el proyecto (NestJS)
RUN npm run build

# 6) Expone el puerto que usa la aplicación
EXPOSE 3000

# 7) Comando por defecto para iniciar la aplicación compilada.
# nest build emite en dist/src/main.js (hay .ts en la raíz — run-batch/run-nosp —
# que hacen que tsc preserve la estructura), NO en dist/main.js.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/main.js"]
