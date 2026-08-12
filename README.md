# HMIS

Agentic hospital operating system. Specs: `docs/superpowers/specs/`.

## Run locally
1. `docker compose -f docker/docker-compose.dev.yml up -d`
2. `pnpm install && pnpm --filter @hmis/core db:migrate`
3. `pnpm --filter @hmis/core start:dev` → http://localhost:3000/health

## Verify (what CI runs)
`pnpm verify`  — typecheck + lint + tests (needs the compose DB up)

## Auth bootstrap
1. Copy `apps/core/.env.example` → `apps/core/.env` and fill it (`openssl rand -hex 32` for `SECRET_KEY`); `chmod 600`.
2. `pnpm --filter @hmis/core db:migrate`
3. `pnpm --filter @hmis/core seed:admin` (reads `ADMIN_*` from the env)
4. Agents: `pnpm --filter @hmis/core agent:create` (reads `AGENT_NAME`; prints the API key once)
