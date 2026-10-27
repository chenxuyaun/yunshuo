# syntax=docker/dockerfile:1
# 云说 API / worker 共用镜像：直接在容器内用 tsx 运行 TypeScript。
# 迁移与 bootstrap 也复用该镜像，避免维护第二套构建产物。
FROM node:24-bookworm-slim AS base
RUN npm install -g pnpm@10.33.0
WORKDIR /app

FROM base AS deps
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

FROM deps AS runtime
COPY . .
RUN chown -R node:node /app
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@yunshuo/api", "start"]
