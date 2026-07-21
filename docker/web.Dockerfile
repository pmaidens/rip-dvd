FROM node:22.23.1-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/config packages/config
RUN pnpm --filter @rip-dvd/config build && pnpm --filter @rip-dvd/web build

FROM node:22.23.1-bookworm-slim AS runner
ENV NODE_ENV="production"
ENV HOSTNAME="0.0.0.0"
ENV PORT="3000"
WORKDIR /app
RUN mkdir --parents /data /media/movies /media/originals \
  && chown node:node /data /media/movies /media/originals
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
