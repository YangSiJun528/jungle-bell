FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV JB_WEB_ROOT=/app/apps/web/dist
ENV JB_DB_PATH=/app/data/jungle-bell.sqlite

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "apps/api/dist/server.js"]
