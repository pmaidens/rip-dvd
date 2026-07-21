FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/archive-worker/package.json apps/archive-worker/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY tsconfig.base.json ./
COPY apps/archive-worker apps/archive-worker
COPY packages/config packages/config
RUN pnpm --filter @rip-dvd/config build && pnpm --filter @rip-dvd/archive-worker build

FROM node:22-bookworm-slim AS runner
RUN apt-get update \
  && apt-get install --yes --no-install-recommends lsdvd util-linux \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV="production"
WORKDIR /app
RUN mkdir --parents /data && chown node:node /data
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/archive-worker ./apps/archive-worker
COPY --from=builder --chown=node:node /app/packages/config ./packages/config
USER node
CMD ["node", "apps/archive-worker/dist/index.js"]
