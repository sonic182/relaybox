# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack install --global pnpm@11.24.0

# ZenStack `zen generate` resolves env('DB_URL') while parsing the schema; it never connects.
ENV DB_URL=postgresql://postgres:postgres@localhost:5432/relaybox_dev

# Build tools only if a native dependency falls back to node-gyp; sharp ships prebuilds.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY zenstack ./zenstack
COPY public/swagger.yml ./public/swagger.yml
RUN pnpm run zen:generate \
    && pnpm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack install --global pnpm@11.24.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod \
    && pnpm store prune

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY zenstack/migrations ./zenstack/migrations
COPY docker ./docker
RUN chmod +x docker/entrypoint.sh \
    && mkdir -p /app/media /app/sessions /app/logs \
    && chown node:node /app/media /app/sessions /app/logs

# Baileys credentials and signal keys persist here across restarts.
VOLUME /app/sessions

EXPOSE 3000
USER node
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
