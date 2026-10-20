# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build

WORKDIR /app
# Keep the package manager reproducible without depending on host Node/pnpm.
RUN npm install --global pnpm@11.28.5
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY shared ./shared
# tsconfig.json includes this catalog type-check as part of the frontend build.
COPY tests/backend/i18nCatalogs.test.ts ./tests/backend/i18nCatalogs.test.ts
RUN pnpm run build

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/app/data/app.db \
    MEDIA_DIR=/app/data/media

# tsx is currently a devDependency but is also the existing production runner.
# Keep the locked dependency tree; no package is installed at container startup.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY shared ./shared
RUN mkdir -p /app/data/media && chown -R node:node /app/data

USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "--disable-warning=ExperimentalWarning", "server/index.ts"]
