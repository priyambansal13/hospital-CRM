# syntax=docker/dockerfile:1.7
# One image recipe for every zone (Next.js standalone output):
#   docker build --build-arg ZONE=shell -t medicare/zone-shell .
# The shell's rewrites are fixed at build time from ZONE_URL_TEMPLATE; the default points at Kubernetes service names
# (zone-<name>:3000), so the same image runs in every namespace/environment.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@12.11.2 >/dev/null
WORKDIR /repo

FROM base AS build
ARG ZONE
ARG ZONE_URL_TEMPLATE=http://zone-{name}:3000
ENV ZONE_URL_TEMPLATE=${ZONE_URL_TEMPLATE}
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json turbo.json zones.json ./
RUN pnpm fetch
COPY packages ./packages
COPY apps/zone-${ZONE} ./apps/zone-${ZONE}
RUN pnpm install --offline --frozen-lockfile --filter "@mc/zone-${ZONE}..."
RUN pnpm exec turbo run build --filter "@mc/zone-${ZONE}..."

FROM node:24-slim AS runtime
ARG ZONE
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/zone-${ZONE}/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/zone-${ZONE}/.next/static ./apps/zone-${ZONE}/.next/static
RUN ln -s /app/apps/zone-${ZONE}/server.js /app/server.js
USER node
EXPOSE 3000
CMD ["node", "server.js"]
