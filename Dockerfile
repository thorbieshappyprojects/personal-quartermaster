# syntax=docker/dockerfile:1.7
# Image for app and jobs. Contains code only: no secrets, no data.

FROM node:22-trixie-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN pnpm --filter @pq/web --filter @pq/api build
# sharp is native and not bundled: install exactly the locked version, for this platform, into /out.
RUN SHARP_VERSION=$(node -p "require('./apps/api/node_modules/sharp/package.json').version") \
 && mkdir -p /out && cd /out && printf '{"private":true,"type":"module"}' > package.json \
 && npm install --omit=dev --no-audit --no-fund --no-package-lock "sharp@${SHARP_VERSION}" \
 && rm package.json

FROM node:22-trixie-slim
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/thorbieshappyprojects/personal-quartermaster" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
ENV NODE_ENV=production \
    PORT=3000 \
    MIGRATIONS_DIR=/app/dist/migrations \
    WEB_DIR=/app/web \
    MEDIA_DIR=/data/media \
    GIT_COMMIT=${GIT_COMMIT}
WORKDIR /app
COPY --from=build /src/apps/api/dist/ /app/dist/
COPY --from=build /out/node_modules/ /app/node_modules/
COPY --from=build /src/apps/web/dist/ /app/web/
COPY LICENSE /app/LICENSE
RUN printf '#!/bin/sh\nexec node --enable-source-maps /app/dist/cli.mjs "$@"\n' > /usr/local/bin/pq \
 && chmod 755 /usr/local/bin/pq \
 && mkdir -p /data/media && chown node:node /data/media \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "/app/dist/healthcheck.mjs"]
CMD ["node", "--enable-source-maps", "/app/dist/main.mjs"]
