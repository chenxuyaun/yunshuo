# syntax=docker/dockerfile:1
# 云说 Web：Vite 构建静态资源，由 nginx 提供页面并反向代理 /api。
FROM node:24-bookworm-slim AS build
RUN npm install -g pnpm@10.33.0
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/gates/package.json packages/gates/package.json
COPY packages/model-gateway/package.json packages/model-gateway/package.json
COPY packages/retrieval/package.json packages/retrieval/package.json
COPY packages/tool-surface/package.json packages/tool-surface/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @yunshuo/web build

FROM nginx:1.27-alpine AS runtime
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
