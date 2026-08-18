# Creator Inbox — runtime image with ffmpeg (library thumbnails / metadata)
# Usage: npm run build && docker build -t creator-inbox .
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/ ./
COPY dist/ ./dist/
ENV STATIC_DIR=/app/dist DB_PATH=/app/data/inbox.db
CMD ["node", "index.js"]
