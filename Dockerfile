FROM node:24-slim
# Headed Chrome (the site rejects headless) needs a display: run Chromium under Xvfb (see docker-entrypoint.sh).
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium xvfb fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci
COPY tsconfig.json docker-entrypoint.sh ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    SECA_BIND=0.0.0.0 \
    SECA_PORT=3000 \
    SECA_SESSION_DIR=/data/session
# Login session (cookies + Chrome profile) lives in /data so it survives restarts: mount a volume there.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["serve"]
