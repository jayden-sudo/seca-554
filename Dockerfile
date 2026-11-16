FROM ghcr.io/puppeteer/puppeteer:25.17.0
USER root
WORKDIR /app
COPY package*.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
USER pptruser
ENTRYPOINT ["node", "dist/index.js"]
