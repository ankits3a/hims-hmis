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
#   2. copy the configs INTO the deploy directory, and derive the backup credentials
#   3. db up, waited to healthy on its own compose healthcheck
#   4. pgBackRest: stanza created, archiving CHECKED end to end (D8)
#   5. migrations FROM INSIDE THE IMAGE (D2)
#   -- SEAM: first-boot cursor seeding (D10) belongs here; see the marker below --
#   6. api, worker and caddy up
#   7. the backup and restore-drill cron entries
#   8. /health green THROUGH Caddy over HTTPS on the real hostname
#
# Production runs from the DEPLOY DIRECTORY, never from this checkout. The images are built here
# and then run from the daemon by tag, and compose is invoked against the copied files — so a
# `git checkout` in /opt/hmis cannot mutate what production is serving.
#
# D4/GC1 portability: docker, compose, postgres, caddy, pgbackrest, curl, ss, openssl. Nothing
# provider-specific. On on-prem metal the hostname in the Caddyfile and the five backup values in
# /opt/hmis-prod/.env.r2 are RE-POINTED; no line here is rewritten.
#
# Sequential ownership: T3 creates it · T4 adds the backup fabric (db image, pgbackrest config and
# credentials, stanza, cron) · T6 fills the seeding seam.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$REPO_DIR/docker/prod"
DEPLOY_DIR="${HMIS_DEPLOY_DIR:-/opt/hmis-prod}"
PROJECT="hmis-prod"
SERVER_IMAGE="hmis-prod/server:latest"
WEB_IMAGE="hmis-prod/web:latest"
DB_IMAGE="hmis-prod/db:latest"
DB_HEALTH_TIMEOUT="${HMIS_DB_HEALTH_TIMEOUT:-180}"
# D8. The stanza name is also written into the db service's archive_command in the compose file
# and into the [hmis] section of pgbackrest.conf; changing it means changing all three.
STANZA="hmis"
# Overridable so the generated cron file can be inspected without writing to /etc on a box that is
# only being rehearsed against.
CRON_FILE="${HMIS_CRON_FILE:-/etc/cron.d/hmis-prod-backup}"
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
step "0/8 pre-flight"
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

# D8/GC2. The object-store credentials are a SEPARATE root-only file: merging them into .env would
# put a backup credential into every api and worker container for no reason at all.
R2_ENV="$DEPLOY_DIR/.env.r2"
[ -f "$R2_ENV" ] || die "$R2_ENV is missing. pgBackRest has nowhere to write. It holds five keys —
    R2_ENDPOINT, R2_BUCKET, R2_REGION, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY — and nothing else;
    see docker/prod/.env.prod.example for the shape. chmod 600 it."
R2_MODE="$(stat -c '%a' "$R2_ENV")"
[ "$R2_MODE" = "600" ] || die "$R2_ENV is mode $R2_MODE; GC2 wants 600. Run: chmod 600 $R2_ENV"
command -v openssl >/dev/null 2>&1 || die "openssl is required for the repo cipher passphrase"
note "backup credentials present and 600"

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
step "1/8 building images from the checkout ($REPO_DIR)"
# ----------------------------------------------------------------------------------------------
docker build --tag "$SERVER_IMAGE" "$REPO_DIR"
docker build --tag "$WEB_IMAGE" --target web "$REPO_DIR"
# FORK-C: postgres:16 plus pgbackrest, because archive_command executes inside the postgres
# server's own container and a sidecar therefore cannot archive at all.
docker build --tag "$DB_IMAGE" --file "$SRC_DIR/db.Dockerfile" "$REPO_DIR"
note "built $SERVER_IMAGE, $WEB_IMAGE and $DB_IMAGE"

# ----------------------------------------------------------------------------------------------
step "2/8 copying configs into $DEPLOY_DIR"
# ----------------------------------------------------------------------------------------------
install -m 0644 "$SRC_DIR/docker-compose.prod.yml" "$DEPLOY_DIR/docker-compose.prod.yml"
# The Caddyfile goes into a DIRECTORY that the caddy service mounts whole. A single-file bind
# mount would pin the container to this file's inode, and install(1) replaces the inode — the
# edge would keep serving the previous config for as long as the container lived. See the
# comment on the volume in docker-compose.prod.yml; it was measured, not predicted.
install -D -m 0644 "$SRC_DIR/Caddyfile" "$DEPLOY_DIR/caddy/Caddyfile"
# Same shape, same reason: the db service mounts $DEPLOY_DIR/pgbackrest as a directory.
install -D -m 0644 "$SRC_DIR/pgbackrest/pgbackrest.conf" "$DEPLOY_DIR/pgbackrest/pgbackrest.conf"
install -D -m 0750 "$SRC_DIR/drill/restore-drill.sh" "$DEPLOY_DIR/drill/restore-drill.sh"
install -d -m 0750 "$DEPLOY_DIR/log"
# T6 installs the prometheus/ and grafana/ trees here.
note "docker-compose.prod.yml, caddy/Caddyfile, pgbackrest/pgbackrest.conf, drill/restore-drill.sh"

# --- the backup credentials, derived rather than duplicated --------------------------------------
# GC2: the five owner-supplied values live in $R2_ENV and ONLY there. They are translated here into
# the six PGBACKREST_* names the binary reads, written to a 600 file that only the db service
# loads, and never echoed — not by this script, not into a log, not into a report.
#
# D4/GC1: this translation is the whole of the provider coupling. Point $R2_ENV at MinIO on the NAS
# and re-run; no file in git changes.
r2_get() { sed -n "s/^$1=//p" "$R2_ENV" | head -n 1; }
R2_ENDPOINT_HOST="$(r2_get R2_ENDPOINT | sed -E 's#^https?://##; s#/+$##')"
R2_BUCKET_V="$(r2_get R2_BUCKET)"
R2_REGION_V="$(r2_get R2_REGION)"
R2_KEY_V="$(r2_get R2_ACCESS_KEY_ID)"
R2_SECRET_V="$(r2_get R2_SECRET_ACCESS_KEY)"
for pair in "R2_ENDPOINT=$R2_ENDPOINT_HOST" "R2_BUCKET=$R2_BUCKET_V" "R2_REGION=$R2_REGION_V" \
            "R2_ACCESS_KEY_ID=$R2_KEY_V" "R2_SECRET_ACCESS_KEY=$R2_SECRET_V"; do
  [ -n "${pair#*=}" ] || die "${pair%%=*} is empty in $R2_ENV. Refusing to deploy a backup
    destination that cannot be reached — an untested remote leg is worse than an obvious hole."
done

PGBR_ENV="$DEPLOY_DIR/.env.pgbackrest"
# THE CIPHER PASSPHRASE IS GENERATED EXACTLY ONCE AND THEN PRESERVED FOR EVER. Every byte already
# in the repository is encrypted with it (spec E-2); regenerating it would silently orphan every
# existing backup while every new one kept succeeding, which is the worst failure shape available
# here. So: read it back if it is there, and only mint one if it is not.
CIPHER_PASS=""
if [ -f "$PGBR_ENV" ]; then
  CIPHER_PASS="$(sed -n 's/^PGBACKREST_REPO1_CIPHER_PASS=//p' "$PGBR_ENV" | head -n 1)"
fi
if [ -z "$CIPHER_PASS" ]; then
  CIPHER_PASS="$(openssl rand -hex 32)"
  note "MINTED A NEW REPOSITORY CIPHER PASSPHRASE in $PGBR_ENV (this happens once)."
  note "ESCROW IT with SECRET_KEY by the runbook's procedure. Without it every backup in the"
  note "object store is unreadable ciphertext, including by you."
fi
( umask 077
  cat > "$PGBR_ENV" <<EOF
# GENERATED BY deploy.sh FROM $R2_ENV — DO NOT EDIT, DO NOT COPY, DO NOT COMMIT.
# Loaded by the hmis-prod db service only. The passphrase below is preserved across deploys.
PGBACKREST_REPO1_S3_ENDPOINT=$R2_ENDPOINT_HOST
PGBACKREST_REPO1_S3_BUCKET=$R2_BUCKET_V
PGBACKREST_REPO1_S3_REGION=$R2_REGION_V
PGBACKREST_REPO1_S3_KEY=$R2_KEY_V
PGBACKREST_REPO1_S3_KEY_SECRET=$R2_SECRET_V
PGBACKREST_REPO1_CIPHER_PASS=$CIPHER_PASS
EOF
)
chmod 600 "$PGBR_ENV"
unset CIPHER_PASS R2_KEY_V R2_SECRET_V
note "backup credentials derived into $(basename "$PGBR_ENV") (600)"

# ----------------------------------------------------------------------------------------------
step "3/8 database up"
# ----------------------------------------------------------------------------------------------
compose up -d db
deadline=$(( $(date +%s) + DB_HEALTH_TIMEOUT ))
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q db)" 2>/dev/null)" = "healthy" ]; do
  [ "$(date +%s)" -lt "$deadline" ] || die "db did not report healthy within ${DB_HEALTH_TIMEOUT}s"
  sleep 2
done
note "db healthy"

# ----------------------------------------------------------------------------------------------
step "4/8 pgBackRest stanza and archiving check (D8)"
# ----------------------------------------------------------------------------------------------
# Both commands are idempotent and both are gates. `stanza-create` says "stanza already exists and
# is valid" on every run after the first. `check` is the one that matters: it forces a WAL switch
# and confirms the segment actually arrived in the repository, so a deploy cannot report success
# over a backup fabric that is quietly archiving into the void. It is also the first thing that
# would notice a credential rotation nobody carried into $R2_ENV.
compose exec -T --user postgres db pgbackrest --stanza="$STANZA" stanza-create
compose exec -T --user postgres db pgbackrest --stanza="$STANZA" check
note "stanza $STANZA created/valid and WAL archiving verified end to end"

# ----------------------------------------------------------------------------------------------
step "5/8 migrations, run from inside the image (D2)"
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
step "6/8 api, worker and caddy up"
# ----------------------------------------------------------------------------------------------
# Whole-project `up`: api, worker and caddy today (db is already up from step 3), plus whatever
# T6 adds to the compose file later, with no edit to this line.
compose up -d

# The Caddyfile reaches the container through a BIND-MOUNTED DIRECTORY (T3-1 — a single-file mount
# pinned the container to a replaced inode and served stale config for the life of the container).
# So `up -d` sees no config change when only the file's contents changed and leaves the running
# caddy on the old edge config, which would make step 2 a lie on every re-deploy. Reload it in
# place instead: zero downtime, a no-op when the config is already current, and it fails loudly on
# a Caddyfile that does not parse. The retry is for the first bring-up, where the admin endpoint
# may not be listening the instant the container starts.
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
step "7/8 backup and restore-drill cron"
# ----------------------------------------------------------------------------------------------
# D8. The weekly restore drill is a HOST CRON ENTRY and deliberately not a Scheduler job: the
# worker must hold no restore privilege and must never block for minutes on a restore. The nightly
# full rides in the same file because the two are one fabric — a drill with nothing to restore is
# theatre, and a backup nobody restores is a belief.
( umask 022
  cat > "$CRON_FILE" <<EOF
# hmis-prod backups — GENERATED BY docker/prod/deploy.sh. Edit that file, not this one; the next
# deploy overwrites this.
#
# THE TIMES ARE UTC because this host runs on UTC, with the IST time named beside each. CRON_TZ is
# deliberately not used: this cron build ships no crontab(5) man page and its CRON_TZ support could
# not be confirmed on the box, and a silently ignored CRON_TZ would move both jobs from the small
# hours into the hospital's working day. If the host timezone is ever changed, change these.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Nightly full, 21:00 UTC = 02:30 IST. Continuous WAL archiving covers everything between them, and
# \`expire\` runs at the end of each backup against the two retention settings in pgbackrest.conf.
0 21 * * * root docker exec --user postgres ${PROJECT}-db-1 pgbackrest --stanza=$STANZA --type=full backup >> $DEPLOY_DIR/log/backup.log 2>&1

# THE WEEKLY RESTORE DRILL, 22:00 UTC Saturday = 03:30 IST Sunday — an hour after Saturday night's
# full, so there is always a fresh one to restore. It restores for real (GC7).
0 22 * * 6 root $DEPLOY_DIR/drill/restore-drill.sh >> $DEPLOY_DIR/log/restore-drill.log 2>&1
EOF
)
chmod 0644 "$CRON_FILE"
note "cron installed at $CRON_FILE (nightly full 02:30 IST · restore drill 03:30 IST Sunday)"
note "logs append to $DEPLOY_DIR/log/ — the runbook owns their rotation"

# ----------------------------------------------------------------------------------------------
step "8/8 /health through Caddy over HTTPS"
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
