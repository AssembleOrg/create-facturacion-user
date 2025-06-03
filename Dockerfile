# Etapa base: Node + Alpine
FROM node:18.19.0-alpine3.19

# 1) Instala dependencias de sistema necesarias para Puppeteer/Chromium
RUN apk update && apk add --no-cache \
    bash \
    openssl \
    zip \
    wget \
    ca-certificates \
    nss \
    freetype \
    harfbuzz \
    ttf-freefont \
    chromium

# 2) Actualiza certificados de CA
RUN update-ca-certificates

# 3) Indica a Puppeteer que use Chromium del sistema (evita descargar uno propio)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 4) Crea el directorio de trabajo
WORKDIR /usr/src/app

# 5) Copia los archivos de dependencias y las instala
COPY package*.json ./
RUN npm install


RUN mkdir -p /usr/src/app/static/uploads

# 6) Copia el resto del código fuente
COPY . .

# 7) Compila el proyecto (si usas TypeScript/NestJS)
RUN npm run build

# 8) Expone el puerto que use tu aplicación (por ejemplo 3000 para NestJS)
EXPOSE 3000

# 9) Comando por defecto para iniciar la aplicación compilada
CMD ["node", "dist/main.js"]
