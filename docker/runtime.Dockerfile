FROM node:22.23.1-bookworm-slim AS build-base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM build-base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/archive-worker/package.json apps/archive-worker/package.json
COPY apps/encode-worker/package.json apps/encode-worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/worker-runtime/package.json packages/worker-runtime/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS shared-builder
COPY tsconfig.base.json ./
COPY packages/config packages/config
COPY packages/worker-runtime packages/worker-runtime
RUN pnpm --filter @rip-dvd/config build \
  && pnpm --filter @rip-dvd/worker-runtime build

FROM shared-builder AS web-builder
COPY apps/web apps/web
RUN pnpm --filter @rip-dvd/web build
# Next's standalone tracer omits Sharp's dynamically loaded libvips shared
# objects. Restore only those native runtime files to the traced output.
RUN for source in node_modules/.pnpm/@img+sharp-libvips-linux-*/node_modules/@img/sharp-libvips-linux-*/lib; do \
    test -d "$source"; \
    package_root="${source%%/node_modules/*}"; \
    package_directory="${package_root##*/}"; \
    package_parent="${source%/lib}"; \
    package_name="${package_parent##*/}"; \
    destination="apps/web/.next/standalone/node_modules/.pnpm/${package_directory}/node_modules/@img/${package_name}/lib"; \
    mkdir --parents "$destination"; \
    cp --archive "$source/." "$destination/"; \
  done

FROM shared-builder AS archive-worker-builder
COPY apps/archive-worker apps/archive-worker
RUN pnpm --filter @rip-dvd/archive-worker build

FROM shared-builder AS encode-worker-builder
COPY apps/encode-worker apps/encode-worker
RUN pnpm --filter @rip-dvd/encode-worker build

FROM node:22.23.1-bookworm-slim AS runtime-base
ENV NODE_ENV="production"
WORKDIR /app
RUN mkdir --parents /data && chown node:node /data

FROM runtime-base AS web
ENV HOSTNAME="0.0.0.0"
ENV PORT="3000"
RUN mkdir --parents /media/movies /media/originals \
  && chown node:node /media/movies /media/originals
COPY --from=web-builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# Sharp 0.35 loads libvips through the system dynamic loader. Keep the traced
# package as the source of truth and expose its versioned shared object through
# a standard loader directory without duplicating it in the image.
RUN ln --symbolic \
    /app/node_modules/.pnpm/@img+sharp-libvips-linux-*/node_modules/@img/sharp-libvips-linux-*/lib/libvips-cpp.so.* \
    /usr/local/lib/ \
  && ldconfig
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM runtime-base AS worker-runtime-base
COPY --from=shared-builder --chown=node:node /app/packages/config/package.json ./packages/config/package.json
COPY --from=shared-builder --chown=node:node /app/packages/config/dist ./packages/config/dist
COPY --from=shared-builder --chown=node:node /app/packages/worker-runtime/package.json ./packages/worker-runtime/package.json
COPY --from=shared-builder --chown=node:node /app/packages/worker-runtime/dist ./packages/worker-runtime/dist
RUN mkdir --parents packages/worker-runtime/node_modules/@rip-dvd \
  && ln --symbolic ../../../config packages/worker-runtime/node_modules/@rip-dvd/config

FROM worker-runtime-base AS archive-worker
RUN apt-get update \
  && apt-get install --yes --no-install-recommends lsdvd util-linux \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir --parents /media/originals \
  && chown node:node /media/originals
COPY --from=archive-worker-builder --chown=node:node /app/apps/archive-worker/package.json ./apps/archive-worker/package.json
COPY --from=archive-worker-builder --chown=node:node /app/apps/archive-worker/dist ./apps/archive-worker/dist
RUN mkdir --parents apps/archive-worker/node_modules/@rip-dvd \
  && ln --symbolic ../../../../packages/worker-runtime apps/archive-worker/node_modules/@rip-dvd/worker-runtime
USER node
CMD ["node", "apps/archive-worker/dist/index.js"]

FROM worker-runtime-base AS encode-worker
RUN apt-get update \
  && apt-get install --yes --no-install-recommends handbrake-cli ffmpeg util-linux \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir --parents /media/movies /media/originals \
  && chown node:node /media/movies /media/originals
COPY --from=encode-worker-builder --chown=node:node /app/apps/encode-worker/package.json ./apps/encode-worker/package.json
COPY --from=encode-worker-builder --chown=node:node /app/apps/encode-worker/dist ./apps/encode-worker/dist
RUN mkdir --parents apps/encode-worker/node_modules/@rip-dvd \
  && ln --symbolic ../../../../packages/worker-runtime apps/encode-worker/node_modules/@rip-dvd/worker-runtime
USER node
CMD ["node", "apps/encode-worker/dist/index.js"]
