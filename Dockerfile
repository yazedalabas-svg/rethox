FROM node:26-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python-is-python3 build-essential ffmpeg \
  && python3 -m pip install --break-system-packages --no-cache-dir edge-tts \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
