# The Kynimo MCP server (apps/mcp) with the pinned Chromium and FFmpeg it renders and exports with.
#
#   docker build -t kynimo-mcp .
#   docker compose up            # local use: see docker-compose.yml
#
# Without KYNIMO_OAUTH_ISSUER the container serves one local account with no sign-in; with it, the
# server runs with OAuth (ADR-0033). docker/start.mjs holds that choice.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# Everything the server is built from. Only the server and the packages it depends on are installed.
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/mcp/package.json apps/mcp/
COPY packages packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter kynimo --filter "@kynimo/mcp..."
COPY apps/mcp apps/mcp
RUN pnpm turbo run build --filter=@kynimo/mcp
# Drop what only the build needed (TypeScript, Vite, Vitest).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@kynimo/mcp..."

FROM base AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8787
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
# The Chromium build this Playwright version pins, with the system libraries it needs.
RUN pnpm --filter @kynimo/capture exec playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright
COPY docker/start.mjs docker/healthcheck.mjs /app/docker/
# Projects, uploaded assets and exports of the local account live here (no database configured).
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "/app/docker/healthcheck.mjs"]
# tini reaps Chromium's and FFmpeg's children and passes SIGTERM on, so a stop is graceful.
ENTRYPOINT ["tini", "--", "node", "/app/docker/start.mjs"]
