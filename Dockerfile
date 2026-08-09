# 聚合收件箱 —— 含 ffmpeg 的运行镜像（素材库缩略图/元数据）
# 用法: docker build -t wechat-inbox:ffmpeg .
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
CMD ["node", "index.js"]
