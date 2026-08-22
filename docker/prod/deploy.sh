#!/usr/bin/env bash
#
# Plan 11a / D13 — bring up, or re-converge, the `hmis-prod` stack.
#
# IDEMPOTENT: run it as often as you like. Every step is a no-op when it is already true, and a
# re-deploy over a running stack is the normal case, not the exceptional one.
#
# The sequence, minus one step:
#
#   0. pre-flight — refuse unless the deploy directory exists, its .env is present and 600, and
#      80/443 are free or already held by this stack's own caddy
#   1. build the images FROM THE CHECKOUT
#   2. copy the configs INTO the deploy directory
#   3. db up, waited to healthy on its own compose healthcheck
#   4. migrations FROM INSIDE THE IMAGE (D2)
#   -- SEAM: first-boot cursor seeding (D10) belongs here; see the marker below --
#   5. api, worker and caddy up
#   6. /health green THROUGH Caddy over HTTPS on the real hostname
#
# Production runs from the DEPLOY DIRECTORY, never from this checkout. The images are built here
# and then run from the daemon by tag, and compose is invoked against the copied files — so a
# `git checkout` in /opt/hmis cannot mutate what production is serving.
#
# D4/GC1 portability: docker, compose, postgres, caddy, curl, ss. Nothing provider-specific. On
# on-prem metal the hostname in the Caddyfile and the backup endpoint in the deploy .env are
# RE-POINTED; no line here is rewritten.
#
# Sequential ownership: T3 creates it · T4 adds the weekly restore-drill cron entry · T6 fills
# the seeding seam.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$REPO_DIR/docker/prod"
DEPLOY_DIR="${HMIS_DEPLOY_DIR:-/opt/hmis-prod}"
PROJECT="hmis-prod"
SERVER_IMAGE="hmis-prod/server:latest"
WEB_IMAGE="hmis-prod/web:latest"
DB_HEALTH_TIMEOUT="${HMIS_DB_HEALTH_TIMEOUT:-180}"
# A first bring-up has to wait for an ACME order; a re-deploy answers in seconds.
EDGE_HEALTH_TIMEOUT="${HMIS_EDGE_HEALTH_TIMEOUT:-240}"

die() { printf 'deploy.sh: FATAL: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

compose() {
  docker compose -p "$PROJECT" \
    -f "$DEPLOY_DIR/docker-compose.prod.yml" \
    --project-directory "$DEPLOY_DIR" "$@"
}

# Something is listening on port $1, on any interface.
port_in_use() {
  ss -lntH 2>/dev/null | awk '{ print $4 }' | sed 's/.*://' | grep -qx "$1"
}

# ...and that something is our own caddy. Asked by container LABEL rather than through compose,
# because on a first run there is no compose file in the deploy directory yet.
our_caddy_running() {
  [ -n "$(docker ps -q \
      --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.service=caddy")" ]
}

# ----------------------------------------------------------------------------------------------
step "0/6 pre-flight"
# ----------------------------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed"
command -v curl >/dev/null 2>&1 || die "curl is required for the /health gate"
command -v ss >/dev/null 2>&1 || die "ss (iproute2) is required for the 80/443 pre-flight"

# Deliberately NOT created here. The production .env and the backup credentials live in this
# directory; a script that conjures it would just as happily deploy against an empty one.
[ -d "$DEPLOY_DIR" ] || die "deploy directory $DEPLOY_DIR does not exist. Create it first:
      mkdir -p $DEPLOY_DIR && chmod 700 $DEPLOY_DIR
    then put the environment file in place (see docker/prod/.env.prod.example)."

ENV_FILE="$DEPLOY_DIR/.env"
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing. Copy docker/prod/.env.prod.example to it, run the
    SECRET_KEY ceremony (D11: openssl rand -hex 32), fill the database password, then chmod 600."
ENV_MODE="$(stat -c '%a' "$ENV_FILE")"
[ "$ENV_MODE" = "600" ] || die "$ENV_FILE is mode $ENV_MODE; GC2 wants 600. Run: chmod 600 $ENV_FILE"
note "deploy directory $DEPLOY_DIR, environment file present and 600"

for port in 80 443; do
  if port_in_use "$port"; then
    our_caddy_running \
      || die "port $port is already in use and it is not this stack's caddy. Refusing to deploy.
    Find the listener with:  ss -lntp | grep ':$port '"
    note "port $port is held by this stack's own caddy — re-deploy, continuing"
  else
    note "port $port free"
  fi
done

# ----------------------------------------------------------------------------------------------
step "1/6 building images from the checkout ($REPO_DIR)"
# ----------------------------------------------------------------------------------------------
docker build --tag "$SERVER_IMAGE" "$REPO_DIR"
docker build --tag "$WEB_IMAGE" --target web "$REPO_DIR"
note "built $SERVER_IMAGE and $WEB_IMAGE"

# ----------------------------------------------------------------------------------------------
step "2/6 copying configs into $DEPLOY_DIR"
# ----------------------------------------------------------------------------------------------
install -m 0644 "$SRC_DIR/docker-compose.prod.yml" "$DEPLOY_DIR/docker-compose.prod.yml"
# The Caddyfile goes into a DIRECTORY that the caddy service mounts whole. A single-file bind
# mount would pin the container to this file's inode, and install(1) replaces the inode — the
# edge would keep serving the previous config for as long as the container lived. See the
# comment on the volume in docker-compose.prod.yml; it was measured, not predicted.
install -D -m 0644 "$SRC_DIR/Caddyfile" "$DEPLOY_DIR/caddy/Caddyfile"
# T4 installs pgbackrest.conf here; T6 installs the prometheus/ and grafana/ trees.
note "docker-compose.prod.yml, caddy/Caddyfile"

# ----------------------------------------------------------------------------------------------
step "3/6 database up"
# ----------------------------------------------------------------------------------------------
compose up -d db
deadline=$(( $(date +%s) + DB_HEALTH_TIMEOUT ))
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q db)" 2>/dev/null)" = "healthy" ]; do
  [ "$(date +%s)" -lt "$deadline" ] || die "db did not report healthy within ${DB_HEALTH_TIMEOUT}s"
  sleep 2
done
note "db healthy"

# ----------------------------------------------------------------------------------------------
step "4/6 migrations, run from inside the image (D2)"
# ----------------------------------------------------------------------------------------------
# `run --rm` on the api service: same image, different command. The migrator's cwd is
# /app/apps/core, which is where drizzle/ and drizzle/meta/ live (T1-3).
compose run --rm api node dist/scripts/migrate.js

# ----------------------------------------------------------------------------------------------
# SEAM — FIRST-BOOT CURSOR SEEDING (D10) BELONGS HERE, AND IS DELIBERATELY ABSENT.
#
# D13's full sequence runs the cursor-seeding script between the migrations and the application
# services, so a first boot against a database that already carries history does not replay every
# event through the dispatcher. That script is T6's and does not exist yet; a call to it from this
# version of deploy.sh would fail T3's own from-zero bring-up drill.
#
# T6: add it immediately below this comment, in this position, as
#
#     compose run --rm api node dist/scripts/seed-cursors.js
#
# and delete this paragraph. It is idempotent by design, so it stays in the re-deploy path.
# ----------------------------------------------------------------------------------------------

# ----------------------------------------------------------------------------------------------
step "5/6 api, worker and caddy up"
# ----------------------------------------------------------------------------------------------
# Whole-project `up`: api, worker and caddy today (db is already up from step 3), plus whatever
# T4 and T6 add to the compose file later, with no edit to this line.
compose up -d

# The Caddyfile is a BIND-MOUNTED FILE, so `up -d` sees no config change when only its CONTENTS
# changed and leaves the running caddy on the old edge config — which would make step 2 a lie on
# every re-deploy. Reload it in place instead: zero downtime, a no-op when the config is already
# current, and it fails loudly on a Caddyfile that does not parse. The retry is for the first
# bring-up, where the admin endpoint may not be listening the instant the container starts.
if [ -n "$(compose ps -q caddy)" ]; then
  for attempt in 1 2 3 4 5; do
    if compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
      note "caddy reloaded from $DEPLOY_DIR/caddy/Caddyfile"
      break
    fi
    [ "$attempt" -lt 5 ] || die "caddy would not reload $DEPLOY_DIR/caddy/Caddyfile — see the output above"
    sleep 3
  done
fi

compose ps

# ----------------------------------------------------------------------------------------------
step "6/6 /health through Caddy over HTTPS"
# ----------------------------------------------------------------------------------------------
# The hostname is read out of the Caddyfile rather than configured twice — one source of truth,
# and re-pointing the stack at another name stays a one-file change (GC1).
SITE_HOST="$(awk 'NF == 2 && $2 == "{" && $1 ~ /^[A-Za-z0-9][A-Za-z0-9.-]*$/ && $1 ~ /\./ { print $1; exit }' \
  "$DEPLOY_DIR/caddy/Caddyfile")"
[ -n "$SITE_HOST" ] || die "could not read the site hostname out of $DEPLOY_DIR/caddy/Caddyfile"
note "site hostname $SITE_HOST"

deadline=$(( $(date +%s) + EDGE_HEALTH_TIMEOUT ))
until body="$(curl -fsS --max-time 10 "https://$SITE_HOST/health" 2>/dev/null)"; do
  [ "$(date +%s)" -lt "$deadline" ] \
    || die "https://$SITE_HOST/health did not answer within ${EDGE_HEALTH_TIMEOUT}s.
    On a first deploy this is usually ACME: read the caddy container log and confirm the hostname
    resolves to this box unproxied."
  sleep 3
done
note "HTTP 200 $body"

printf '\n==> hmis-prod is up: https://%s\n' "$SITE_HOST"
