# Creator Inbox — multi-stage: build UI, run Node + ffmpeg.
# Usage: docker build -t creator-inbox .
FROM node:24-bookworm-slim AS ui
WORKDIR /src
COPY package.json package-lock.json tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/ ./
COPY --from=ui /src/node_modules ./node_modules
COPY --from=ui /src/dist ./dist
COPY docs/LOCAL-EMBEDDINGS-NOTICE.md ./LOCAL-EMBEDDINGS-NOTICE.md
ENV STATIC_DIR=/app/dist DB_PATH=/app/data/inbox.db GROWTH_EMBEDDING_CACHE=/app/data/model-cache
EXPOSE 8877
CMD ["node", "index.js"]
