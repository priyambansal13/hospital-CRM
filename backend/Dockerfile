# syntax=docker/dockerfile:1.7
# One image recipe for every MediCare service:
#   docker build --build-arg SERVICE=tenant-service -t medicare/tenant-service .
# The image runs the service (default) or its migrations: `node dist/migrate.js all` (Kubernetes pre-upgrade Job).
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@12.11.2 >/dev/null
WORKDIR /repo

FROM base AS build
ARG SERVICE
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json turbo.json ./
RUN pnpm fetch
COPY libs ./libs
COPY services/${SERVICE} ./services/${SERVICE}
RUN pnpm install --offline --frozen-lockfile --filter "@mc/${SERVICE}..."
RUN pnpm exec turbo run build --filter "@mc/${SERVICE}..."
RUN pnpm deploy --legacy --filter "@mc/${SERVICE}" --prod /out \
 && cp -r services/${SERVICE}/dist /out/ \
 && if [ -d services/${SERVICE}/migrations ]; then cp -r services/${SERVICE}/migrations /out/; fi \
 && rm -rf /out/src /out/test /out/*.tsbuildinfo /out/vitest.config.ts

FROM node:24-slim AS runtime
ARG SERVICE
ENV NODE_ENV=production SERVICE_NAME=${SERVICE} MODULES_DIR=/app/modules
WORKDIR /app
COPY --from=build --chown=node:node /out .
# module manifests + starting plan catalogue (read by entitlement-service and subscription-service; harmless elsewhere)
COPY --chown=node:node modules ./modules
USER node
CMD ["node", "dist/main.js"]
