FROM node:22.23.1-bookworm-slim AS build-base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM build-base AS dependencies
RUN apt-get update \
  && apt-get install --yes --no-install-recommends gcc libc6-dev python3-minimal \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY scripts/check-toolchain.mjs scripts/check-toolchain.mjs
COPY docker/runtime.Dockerfile docker/runtime.Dockerfile
COPY apps/web/package.json apps/web/package.json
COPY apps/archive-worker/package.json apps/archive-worker/package.json
COPY apps/encode-worker/package.json apps/encode-worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/data-access/package.json packages/data-access/package.json
COPY packages/worker-runtime/package.json packages/worker-runtime/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm check:toolchain

FROM build-base AS dvdcss-reader-builder
ARG LIBDVDCSS_VERSION=1.6.0
ARG LIBDVDCSS_SHA256=7ea556c846b7bfc32d47b41cae56d1863a6b6d5f706bb162778d6f298490977c
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates curl gcc libc6-dev libssl-dev meson ninja-build pkg-config xz-utils \
  && rm -rf /var/lib/apt/lists/*
COPY docker/libdvdcss-sg-io.h /tmp/libdvdcss-sg-io.h
COPY docker/libdvdcss-sg-io.c /tmp/libdvdcss-sg-io.c
RUN curl --fail --location --silent --show-error \
    "https://download.videolan.org/pub/libdvdcss/${LIBDVDCSS_VERSION}/libdvdcss-${LIBDVDCSS_VERSION}.tar.xz" \
    --output /tmp/libdvdcss.tar.xz \
  && echo "${LIBDVDCSS_SHA256}  /tmp/libdvdcss.tar.xz" | sha256sum --check --strict \
  && mkdir --parents /tmp/libdvdcss-source \
  && tar --extract --file /tmp/libdvdcss.tar.xz \
    --directory /tmp/libdvdcss-source --strip-components 1 \
  && CFLAGS="-include /tmp/libdvdcss-sg-io.h" \
    meson setup /tmp/libdvdcss-build /tmp/libdvdcss-source \
    --buildtype=release --default-library=static \
    --libdir=lib \
    -Denable_docs=false -Denable_examples=false \
  && meson compile --clean --verbose --jobs 2 -C /tmp/libdvdcss-build \
  && meson install -C /tmp/libdvdcss-build
COPY docker/dvdcss-reader.c /tmp/dvdcss-reader.c
COPY docker/test-dvdcss-reader.mjs /tmp/test-dvdcss-reader.mjs
RUN gcc -std=c17 -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
    -Wall -Wextra -Werror -Wformat=2 \
    /tmp/dvdcss-reader.c /tmp/libdvdcss-sg-io.c \
    --output /usr/local/bin/rip-dvd-dvdcss-reader \
    $(pkg-config --cflags --libs libdvdcss) -lcrypto \
  && gcc -std=c17 -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
    -Wall -Wextra -Werror -Wformat=2 -fPIC -shared \
    /tmp/libdvdcss-sg-io.c \
    -Wl,-soname,libdvdcss-sg-io.so.0 -Wl,-z,defs \
    --output /usr/local/lib/libdvdcss-sg-io.so.0 \
  && CFLAGS="-include /tmp/libdvdcss-sg-io.h" \
    LDFLAGS="-L/usr/local/lib -Wl,--no-as-needed -l:libdvdcss-sg-io.so.0 -Wl,--as-needed" \
    LD_LIBRARY_PATH=/usr/local/lib \
    meson setup /tmp/libdvdcss-shared-build /tmp/libdvdcss-source \
    --buildtype=release --default-library=shared \
    --libdir=lib \
    -Denable_docs=false -Denable_examples=false \
  && meson compile --clean --verbose --jobs 2 -C /tmp/libdvdcss-shared-build \
  && meson install -C /tmp/libdvdcss-shared-build \
  && ldd /usr/local/bin/rip-dvd-dvdcss-reader \
  && ! ldd /usr/local/bin/rip-dvd-dvdcss-reader | grep --quiet libdvdcss \
  && LD_LIBRARY_PATH=/usr/local/lib ldd /usr/local/lib/libdvdcss.so.2 \
  && nm --dynamic --defined-only /usr/local/lib/libdvdcss.so.2 | grep --quiet ' dvdcss_open$' \
  && node /tmp/test-dvdcss-reader.mjs

FROM dependencies AS shared-builder
COPY tsconfig.base.json ./
COPY packages/config packages/config
COPY packages/data-access packages/data-access
COPY packages/worker-runtime packages/worker-runtime
RUN pnpm --filter @rip-dvd/config build \
  && pnpm --filter @rip-dvd/data-access build \
  && pnpm --filter @rip-dvd/worker-runtime build

FROM dependencies AS validation
COPY --from=dvdcss-reader-builder /usr/local/bin/rip-dvd-dvdcss-reader /usr/local/bin/rip-dvd-dvdcss-reader
COPY . .
RUN pnpm check \
  && pnpm db:check \
  && pnpm build

FROM shared-builder AS web-builder
COPY apps/web apps/web
RUN pnpm --filter @rip-dvd/web build
# Migration-only recursive filesystem traversal must not enter the web runtime
# graph or standalone artifact.
RUN ! grep --recursive --include="*.nft.json" --quiet \
    "internal/legacy-sidecars.js" apps/web/.next
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
RUN pnpm --filter @rip-dvd/archive-worker build \
  && pnpm --filter @rip-dvd/archive-worker --prod deploy --legacy /archive-worker

FROM shared-builder AS encode-worker-builder
COPY apps/encode-worker apps/encode-worker
RUN pnpm --filter @rip-dvd/encode-worker build \
  && pnpm --filter @rip-dvd/encode-worker --prod deploy --legacy /encode-worker

FROM shared-builder AS deployment-tools-builder
RUN pnpm --filter @rip-dvd/data-access --prod deploy --legacy /deployment-tools

FROM node:22.23.1-bookworm-slim AS runtime-base
ENV NODE_ENV="production"
WORKDIR /app
RUN mkdir --parents /data && chown node:node /data

FROM runtime-base AS deployment-tools
RUN apt-get update \
  && apt-get install --yes --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deployment-tools-builder --chown=node:node /deployment-tools ./packages/data-access
COPY --chown=node:node scripts/migrate-database.mjs ./scripts/migrate-database.mjs
COPY --chown=node:node docker/backup-sqlite.sh ./scripts/backup-sqlite.sh
USER node

FROM runtime-base AS web
ENV HOSTNAME="0.0.0.0"
ENV PORT="3000"
RUN mkdir --parents /media/movies /media/originals \
  && chown node:node /media/movies /media/originals
COPY --from=web-builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=shared-builder --chown=node:node /app/packages/data-access/drizzle ./packages/data-access/drizzle
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
COPY --chown=node:node docker/worker-priority-entrypoint.sh ./scripts/worker-priority-entrypoint.sh

FROM worker-runtime-base AS archive-worker
RUN apt-get update \
  && apt-get install --yes --no-install-recommends libssl3 lsdvd util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && lsblk --json --output PATH,TYPE,TRAN,VENDOR,MODEL,SERIAL >/dev/null \
  && node -e "const { constants } = require('node:fs'); if (!Number.isInteger(constants.O_NONBLOCK)) process.exit(1)"
RUN mkdir --parents /media/originals \
  && chown node:node /media/originals
COPY --from=dvdcss-reader-builder /usr/local/bin/rip-dvd-dvdcss-reader /usr/local/bin/rip-dvd-dvdcss-reader
COPY --from=dvdcss-reader-builder /usr/local/lib/libdvdcss.so.2.4.0 /usr/local/lib/libdvdcss.so.2
COPY --from=dvdcss-reader-builder /usr/local/lib/libdvdcss-sg-io.so.0 /usr/local/lib/libdvdcss-sg-io.so.0
COPY docker/lsdvd-with-css.sh /usr/local/bin/rip-dvd-lsdvd
COPY --from=dvdcss-reader-builder /tmp/libdvdcss.tar.xz /usr/share/doc/rip-dvd-dvdcss-reader/libdvdcss-1.6.0.tar.xz
COPY --from=dvdcss-reader-builder /tmp/libdvdcss-source/COPYING /usr/share/doc/rip-dvd-dvdcss-reader/COPYING
COPY docker/dvdcss-reader.c /usr/share/doc/rip-dvd-dvdcss-reader/dvdcss-reader.c
COPY docker/libdvdcss-sg-io.h /usr/share/doc/rip-dvd-dvdcss-reader/libdvdcss-sg-io.h
COPY docker/libdvdcss-sg-io.c /usr/share/doc/rip-dvd-dvdcss-reader/libdvdcss-sg-io.c
COPY --from=archive-worker-builder --chown=node:node /archive-worker ./apps/archive-worker
RUN chmod 0555 /usr/local/bin/rip-dvd-lsdvd \
  && ldconfig \
  && ldconfig -p | grep --quiet 'libdvdcss.so.2'
ENV DVDCSS_CACHE="off"
USER node
ENTRYPOINT ["sh", "/app/scripts/worker-priority-entrypoint.sh"]
CMD ["node", "apps/archive-worker/dist/index.js"]

FROM worker-runtime-base AS encode-worker
RUN apt-get update \
  && apt-get install --yes --no-install-recommends handbrake-cli ffmpeg util-linux \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir --parents /media/movies /media/originals \
  && chown node:node /media/movies /media/originals
COPY --from=encode-worker-builder --chown=node:node /encode-worker ./apps/encode-worker
USER node
ENTRYPOINT ["sh", "/app/scripts/worker-priority-entrypoint.sh"]
CMD ["node", "apps/encode-worker/dist/index.js"]
