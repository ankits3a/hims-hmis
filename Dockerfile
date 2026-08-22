# Plan 11a / D2 + D3 — ONE artefact, several entrypoints.
#
# FORK-A is resolved by measurement: production runs COMPILED output, never `tsx`. Under `tsx`
# the API crashes at `OpdRealtimeRegistrar.onModuleInit` because esbuild does not emit
# `design:paramtypes` and Nest gets `undefined` where a dependency belongs (§2.58); `tsc` emits
# the metadata, so the compiled API starts clean. That is why this file compiles and never ships
# a transpile-on-boot runtime.
#
# The runtime image carries BOTH server processes and the migrator. The process is chosen by the
# container's COMMAND, not by a second build pipeline (D3 — the spec's "one codebase, several
# processes"):
#
#   api        node dist/src/main.js
#   worker     node dist/src/worker.js
#   migrate    node dist/scripts/migrate.js      (cwd carries drizzle/ + drizzle/meta/)
#
# Adding the ws hub or the renderer later (D1) is one more compose entry plus an entrypoint
# file — never a second pipeline.
#
# The SPA is the `web` stage: the same source, the same build, baked onto Caddy at /srv. Build
# it with `--target web`; a bare `docker build` yields the server runtime (the last stage).
#
# D4 (portability): nothing here is provider-specific. This builds and runs on any capable metal.

# ------------------------------------------------------------------------------------------
# base — node 22 (root package.json `"engines": { "node": ">=22" }`) with the pinned pnpm from
# corepack (`"packageManager": "pnpm@10.0.0"`). Debian slim rather than alpine: `argon2` is a
# native addon that ships glibc prebuilds, and musl would force a source build plus a whole
# toolchain into the image.
# ------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ------------------------------------------------------------------------------------------
# deps — the full workspace install from the FROZEN lockfile (a lockfile diff is a halt).
# Manifests only, so this layer stays cached until a package.json or the lockfile changes.
# ------------------------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/core/package.json apps/core/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

# ------------------------------------------------------------------------------------------
# build — compile contracts and core with `tsc` (emit to dist/, which is gitignored: rule 5),
# and bundle the SPA with vite. Contracts is built FIRST because core's compiled output resolves
# `@hmis/contracts` through that package's `main`, which now names ./dist/index.js.
# ------------------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/core apps/core
COPY apps/web apps/web
RUN pnpm --filter @hmis/contracts build
RUN pnpm --filter @hmis/core build
RUN pnpm --filter @hmis/web build

# ------------------------------------------------------------------------------------------
# web — the SPA on Caddy. D14: Caddy serves these files with an index.html fallback and
# reverse-proxies the API prefixes to api:3000. THE STATIC ROOT IS /srv — the Caddyfile must say
# `root * /srv`. The Caddyfile itself is deploy-directory config (D13), not baked in here, so it
# can be corrected without a rebuild.
# ------------------------------------------------------------------------------------------
FROM caddy:2-alpine AS web
COPY --from=build /app/apps/web/dist /srv

# ------------------------------------------------------------------------------------------
# prod-deps — the SAME frozen lockfile, production dependencies only. All three workspace
# manifests are present so `--frozen-lockfile` can still verify the lockfile is in sync;
# `--filter @hmis/core...` then resolves core plus the workspace packages it depends on
# (contracts), which keeps the SPA's React tree out of the server image.
# ------------------------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/core/package.json apps/core/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --prod --filter "@hmis/core..."

# ------------------------------------------------------------------------------------------
# runtime — the shipped server image: production node_modules, the two compiled dist trees, and
# the migrator's SQL. `drizzle/` (the *.sql files) and `drizzle/meta/` (the journal the migrator
# reads) MUST be here: `scripts/migrate.ts` calls `migrate(db, { migrationsFolder: "./drizzle" })`
# relative to the working directory, which is why WORKDIR is apps/core.
#
# No HEALTHCHECK here on purpose. D12 gives the api a `/health` healthcheck and the worker NONE
# (its liveness is its heartbeat row, which is what the alert rule reads), and one image serves
# both processes — so the check belongs in compose, per service. There is no curl or wget in this
# base image; a compose healthcheck uses node, e.g.
#   node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# ------------------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app ./
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/apps/core/dist ./apps/core/dist
COPY apps/core/drizzle ./apps/core/drizzle
WORKDIR /app/apps/core
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
