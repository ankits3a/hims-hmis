#!/usr/bin/env bash
#
# Plan 11a / D13 — bring up, or re-converge, the `hmis-prod` stack.
#
# IDEMPOTENT: run it as often as you like. Every step is a no-op when it is already true, and a
# re-deploy over a running stack is the normal case, not the exceptional one.
#
# The sequence:
#
#   0. pre-flight — refuse unless the deploy directory exists, its .env is present and 600, and
#      80/443 are free or already held by this stack's own caddy
#   1. build the images FROM THE CHECKOUT
#   2. copy the configs INTO the deploy directory, and derive the backup credentials and the
#      alert routing (Plan 11c D10: alertmanager.yml is RENDERED from .env.smtp, never committed)
#   3. db up, waited to healthy on its own compose healthcheck
#   4. pgBackRest: stanza created, archiving CHECKED end to end (D8)
#   5. migrations FROM INSIDE THE IMAGE (D2), then CURSOR SEEDING (D10) — every production
#      consumer's cursor seeded at max(seq), so a first boot against a database that already
#      carries history does not replay it through the dispatcher — then CONFIGURATION SEEDING and
#      the CONFIGURATION GATE (Plan 11g / DD2): the deploy establishes the rows its own modules
#      throw without, and then refuses to continue if they are not there
#   6. api, worker and caddy up
#   7. the backup and restore-drill cron entries
#   8. the EDGE gate: /api/health green THROUGH Caddy over HTTPS on the real hostname, AND a
#      screen path served as HTML — both halves of the /api/* split proved, not assumed
#
# Production runs from the DEPLOY DIRECTORY, never from this checkout. The images are built here
# and then run from the daemon by tag, and compose is invoked against the copied files — so a
# `git checkout` in /opt/hmis cannot mutate what production is serving.
#
# D4/GC1 portability: docker, compose, postgres, caddy, pgbackrest, curl, ss, openssl. Nothing
# provider-specific. On on-prem metal the hostname in the Caddyfile, the five backup values in
# /opt/hmis-prod/.env.r2 and the six alert values in /opt/hmis-prod/.env.smtp are RE-POINTED; no
# line here is rewritten.
#
# Sequential ownership: T3 creates it · T4 adds the backup fabric (db image, pgbackrest config and
# credentials, stanza, cron) · T6 fills the seeding seam · Plan 11c T6 adds the alert path (the
# .env.smtp pre-flight, the alertmanager render, the second rule file, the restart-loop entry).

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
# Plan 11c / D10. `prom/alertmanager:v0.27.0` runs as `nobody`, and its /etc/passwd maps that to
# uid/gid 65534 (verified against the pinned tag, not assumed). The two files this script derives
# into $DEPLOY_DIR/alertmanager are chmod 600 — GC2, one of them is an SMTP password — so they must
# be OWNED by that uid or the container cannot read its own config. If a future tag changes its
# user, alertmanager will not start and step 6b will say so by name rather than silently degrading.
ALERTMANAGER_UID="${HMIS_ALERTMANAGER_UID:-65534}"
# Step 6b's settle window. Grafana provisioning and prometheus TSDB replay are the slow ones; a
# crash-looping container never becomes `running`, so this bounds how long a broken deploy takes
# to say so rather than how long a healthy one waits.
SERVICES_UP_TIMEOUT="${HMIS_SERVICES_UP_TIMEOUT:-120}"

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
command -v curl >/dev/null 2>&1 || die "curl is required for the /api/health gate"
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

# Plan 11c / D10 + GC2. THE ALERT SINK'S CREDENTIALS, a THIRD root-only file for the same reason
# .env.r2 is a second one: an SMTP password merged into .env would be handed to every api and
# worker container on the box for no reason at all. The shape is checked here and the VALUES are
# checked (and rendered) in step 2, exactly as the R2 pair is — presence and mode are a pre-flight
# question, emptiness is a derivation question.
#
# A MISSING FILE IS A `die`, NOT A SKIP, and that is the decision. A deploy that "succeeded" with
# no alert path is the worst outcome available here: every rule in prometheus/alerts.yml would go
# on evaluating correctly and reaching nobody, which is indistinguishable from a healthy hospital
# right up until the night it is not. Loud and refused beats quiet and inert.
SMTP_ENV="$DEPLOY_DIR/.env.smtp"
[ -f "$SMTP_ENV" ] || die "$SMTP_ENV is missing. Alertmanager has nowhere to send, so a critical
    alert would reach no human being. It holds six keys and nothing else:

        SMTP_HOST=smtp.example.net
        SMTP_PORT=587
        SMTP_USER=alerts@example.net
        SMTP_PASSWORD=<the mailbox or app password>
        ALERT_EMAIL_FROM=alerts@example.net
        ALERT_EMAIL_TO=<who is woken up at 03:00>

    PORT 587 WITH STARTTLS. On this box 465 and 25 are BLOCKED OUTBOUND (measured — a silent
    timeout, not a refusal), so a provider offering only implicit TLS on 465 needs a relay.
    Write the file, then: chmod 600 $SMTP_ENV
    See docker/prod/.env.prod.example for the same shape with the values left empty."
SMTP_MODE="$(stat -c '%a' "$SMTP_ENV")"
[ "$SMTP_MODE" = "600" ] || die "$SMTP_ENV is mode $SMTP_MODE; GC2 wants 600. Run: chmod 600 $SMTP_ENV"
note "alert credentials present and 600"

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
# The monitoring trees, same directory-mount shape as caddy/ and pgbackrest/ above.
#
# THESE SIX LINES WERE MISSING AND THE WHOLE MONITORING STACK WAS INERT IN PRODUCTION (ledger
# §2.72, Plan 11a gate report §7.1). T3 left a `# T6 installs the prometheus/ and grafana/ trees
# here.` comment where they belong; T6 added the four services to the compose file and, told by
# its brief to "change nothing else" in this script, correctly did not add them. The compose
# bind-mounts `./prometheus:/etc/prometheus:ro`, docker auto-created the missing source as an
# EMPTY DIRECTORY, the mount succeeded, and prometheus crash-looped on
# `open /etc/prometheus/prometheus.yml: no such file or directory` while this script exited 0.
# Grafana came up with no datasource and no dashboards, and postgres-exporter ran without
# `queries.yml` — so `hmis_scheduler_heartbeat_staleness_seconds`, the whole point of D9, did not
# exist and neither did the alert rules that read it.
install -D -m 0644 "$SRC_DIR/prometheus/prometheus.yml" "$DEPLOY_DIR/prometheus/prometheus.yml"
install -D -m 0644 "$SRC_DIR/prometheus/alerts.yml" "$DEPLOY_DIR/prometheus/alerts.yml"
# Plan 11c / D11 — the SECOND rule file (the restore-drill watcher). It is a separate file because
# `alerts.yml` is parity-pinned by apps/core/test/alerts-parity.test.ts against the scheduler's job
# registry; see alerts-backup.yml's own header. Forgetting this line is the §7.1 failure again in
# miniature: prometheus would load one rule file, evaluate three rules, and the drill would go on
# rotting unwatched while this script exited 0.
install -D -m 0644 "$SRC_DIR/prometheus/alerts-backup.yml" "$DEPLOY_DIR/prometheus/alerts-backup.yml"
# Plan 11d / D7 — the THIRD rule file (the alert path watching itself). The lesson of
# the two lines above, for the third time — and this time it is enforced rather than
# written down: apps/core/test/deploy-parity.test.ts fails the build if prometheus.yml loads a
# rule file this block does not install, or if this block installs one nothing loads.
install -D -m 0644 "$SRC_DIR/prometheus/alerts-meta.yml" "$DEPLOY_DIR/prometheus/alerts-meta.yml"
install -D -m 0644 "$SRC_DIR/postgres-exporter/queries.yml" "$DEPLOY_DIR/postgres-exporter/queries.yml"
install -D -m 0644 "$SRC_DIR/grafana/provisioning/datasources/prometheus.yml" \
  "$DEPLOY_DIR/grafana/provisioning/datasources/prometheus.yml"
install -D -m 0644 "$SRC_DIR/grafana/provisioning/dashboards/dashboards.yml" \
  "$DEPLOY_DIR/grafana/provisioning/dashboards/dashboards.yml"
install -D -m 0644 "$SRC_DIR/grafana/provisioning/dashboards/hmis.json" \
  "$DEPLOY_DIR/grafana/provisioning/dashboards/hmis.json"
note "docker-compose.prod.yml, caddy/Caddyfile, pgbackrest/pgbackrest.conf, drill/restore-drill.sh"
# D8 / §2.54. This line CARRIED A FOURTH hand-maintained copy of the rule-file census —
# `prometheus/{prometheus,alerts,alerts-backup,alerts-meta}.yml` — inside the very file written to
# unify the other two, and a brace-list is exactly the shape that goes stale in silence: a fifth
# rule file would be installed above and still be missing from this sentence. It is now DERIVED
# from what the block above actually put on disk, the same principle the backup credentials below
# are written to, so the census cannot disagree with the deploy.
note "prometheus/$(cd "$DEPLOY_DIR/prometheus" && echo *.yml | tr ' ' ',' ), postgres-exporter/queries.yml, grafana/provisioning/**"

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

# --- the alert path, rendered rather than committed (Plan 11c / D10) ------------------------------
# GC2, AND THE REPOSITORY IS PUBLIC: the SMTP host, the account, the password and — just as much —
# the owner's own email address are values that may not enter git. The committed artefact is a
# TEMPLATE carrying four `__TOKEN__` placeholders; the rendered config lives only here, chmod 600.
# This is the .env.r2 → .env.pgbackrest shape immediately above, applied to a different secret.
#
# THE PASSWORD IS NOT SUBSTITUTED INTO THE YAML. It goes to a separate file that the template's
# `smtp_auth_password_file` points at, so the derived alertmanager.yml — the file an operator opens
# when routing looks wrong — is not itself a credential.
#
# THE SUBSTITUTION IS BASH PARAMETER EXPANSION, NOT `sed`, deliberately: an email address or a
# password containing `/`, `&` or a backslash is a routine value and every one of those is special
# to sed's `s///`. `${var//pat/repl}` treats the replacement literally, so there is no escaping
# question to get wrong.
smtp_get() { sed -n "s/^$1=//p" "$SMTP_ENV" | head -n 1; }
SMTP_HOST_V="$(smtp_get SMTP_HOST)"
SMTP_PORT_V="$(smtp_get SMTP_PORT)"
SMTP_USER_V="$(smtp_get SMTP_USER)"
SMTP_PASSWORD_V="$(smtp_get SMTP_PASSWORD)"
ALERT_FROM_V="$(smtp_get ALERT_EMAIL_FROM)"
ALERT_TO_V="$(smtp_get ALERT_EMAIL_TO)"
# EVERY ONE OF THE SIX, INCLUDING THE PASSWORD. A key that is PRESENT AND EMPTY is the failure this
# catches — a file created by hand with the names filled in and one value still to come reads as a
# complete file to every check except this one, and Alertmanager would start, look healthy, and
# fail authentication only at the moment it first had something to say.
for pair in "SMTP_HOST=$SMTP_HOST_V" "SMTP_PORT=$SMTP_PORT_V" "SMTP_USER=$SMTP_USER_V" \
            "SMTP_PASSWORD=$SMTP_PASSWORD_V" "ALERT_EMAIL_FROM=$ALERT_FROM_V" \
            "ALERT_EMAIL_TO=$ALERT_TO_V"; do
  [ -n "${pair#*=}" ] || die "${pair%%=*} is empty in $SMTP_ENV. Refusing to deploy an alert path
    that cannot deliver — a critical alert nobody receives is worse than an obvious hole, because
    it looks exactly like a quiet night. All six keys must carry a value:

        SMTP_HOST · SMTP_PORT (587) · SMTP_USER · SMTP_PASSWORD ·
        ALERT_EMAIL_FROM · ALERT_EMAIL_TO"
done

install -d -m 0755 "$DEPLOY_DIR/alertmanager"
AM_YML="$DEPLOY_DIR/alertmanager/alertmanager.yml"
AM_PASS="$DEPLOY_DIR/alertmanager/smtp_password"
AM_TPL="$(cat "$SRC_DIR/alertmanager/alertmanager.yml.tpl")"
AM_TPL="${AM_TPL//__SMTP_SMARTHOST__/$SMTP_HOST_V:$SMTP_PORT_V}"
AM_TPL="${AM_TPL//__SMTP_AUTH_USERNAME__/$SMTP_USER_V}"
AM_TPL="${AM_TPL//__ALERT_EMAIL_FROM__/$ALERT_FROM_V}"
AM_TPL="${AM_TPL//__ALERT_EMAIL_TO__/$ALERT_TO_V}"
# A placeholder the template gained and this block did not learn about would ship as the literal
# string `__SOMETHING__` in a config field — Alertmanager would accept several of those happily
# and mail into the void. Refuse instead.
case "$AM_TPL" in
  *__SMTP_*|*__ALERT_*)
    die "alertmanager.yml.tpl still carries an unrendered __PLACEHOLDER__ after substitution.
    The template and this block have drifted: see docker/prod/alertmanager/alertmanager.yml.tpl."
    ;;
esac
( umask 077
  printf '%s\n' "$AM_TPL" > "$AM_YML"
  # NO TRAILING NEWLINE. Alertmanager trims whitespace around a password file's contents, but a
  # password is not a place to depend on somebody else's trimming.
  printf '%s' "$SMTP_PASSWORD_V" > "$AM_PASS"
)
chmod 600 "$AM_YML" "$AM_PASS"
# 600 AND ROOT-OWNED WOULD BE 600 AND UNREADABLE: the container runs as uid 65534 and reads both
# files itself. Ownership is what keeps them off every other account on the box while still being
# readable by the one process that needs them.
chown "$ALERTMANAGER_UID:$ALERTMANAGER_UID" "$AM_YML" "$AM_PASS"
unset SMTP_PASSWORD_V AM_TPL
note "alert routing derived into alertmanager/alertmanager.yml + smtp_password (600, uid $ALERTMANAGER_UID)"

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
step "cursor seeding, before any consumer's first cycle (D10)"
# ----------------------------------------------------------------------------------------------
# `event_cursors.last_seq` defaults to 0 and `runDispatchCycle` creates the row on first sight, so
# the first cycle after a consumer is registered would otherwise walk the ENTIRE event history at
# 100 rows/tick. This seeds every production consumer (`workerConsumers`'s keys) at `max(seq)`
# and NEVER LOWERS an existing cursor (V11), so it stays in the re-deploy path forever: a consumer
# already caught up is left exactly where it is.
compose run --rm api node dist/scripts/seed-cursors.js

# ----------------------------------------------------------------------------------------------
step "configuration seeding — the rows the modules throw without (Plan 11g / DD2)"
# ----------------------------------------------------------------------------------------------
# WHY THIS EXISTS. Until 2026-08-25 this script ran exactly ONE seed — the cursor seed above — and
# production was consequently deployed with `billing_config` EMPTY, `gst_settings` empty, zero
# approval types and zero role grants. Every invoice threw `billing_not_configured`; the nightly
# `runDailyClose` had been failing for a day with `billing_config row 'main' is missing`; and a
# doctor could not start a consultation, because the consult gate asks billing to price the fee.
# The 2026-08-24 synthetic smoke test found all of it, and the deploy reported healthy throughout.
# That is the report's D2, and its cause was this gap.
#
# ALL FIVE ARE NON-DESTRUCTIVE ON RE-RUN, and that property is what lets them live in the
# re-deploy path for ever rather than in a one-time bootstrap:
#   seed:roles   grants role permissions, skipping rows that exist   (its own header: "belongs in
#                the re-deploy path forever")
#   seed:ops     the three ops.* grants + the duty_manager/owner roles      (same)
#   seed:opd     opd_config, the OPD role keys, the departments      (onConflictDoNothing)
#   seed:billing billing_config, cashier/billing_manager, the two consult services, the five
#                billing approval types                             (onConflictDoNothing)
#   seed:tariff  gst_settings, five gst_config rows, four discount caps, the tariff_revision
#                approval type                                      (skip-if-present — it was the
#                ONE exception and Plan 11g brought it to the house convention, because it wrote
#                through onConflictDoUpdate and would have restored DEV PLACEHOLDER tax rates over
#                a CA's corrections on every deploy)
#   seed:membership  the O-1 grace-honor approval type              (skip-if-present). It seeds NO
#                catalog: every plan, card, coupon, partner and rate is a commissioning row loaded
#                from the owner's own files (Plan 09 / DD3), and a seed that wrote one would put
#                partner data into a public repository. Plan 09's `import-holder-book` is
#                DELIBERATELY NOT here for the same reason `seed:admin` is not: it is an operator
#                command run against a partner drop, and a deploy that imported a holder book would
#                be importing data nobody asked it for.
#   seed:formulary   ~26 classically severe interaction pairs and the moieties they name
#                (skip-if-present, Plan 16a T9). Unlike every seed above it, this one writes
#                CLINICAL content, so its idempotence rule is stricter than "do not duplicate":
#                a pair that already exists is LEFT ALONE, severity and all. §1.4's calibration
#                loop lets the DTC downgrade a pair the hospital finds mis-graded, and a deploy
#                that restored `severe` over that decision would undo a clinical ruling silently.
#                Its own test asserts exactly that, twice — a downgrade and a deactivation both
#                survive a re-run.
#
# `set -euo pipefail` is the gate half of this step: a seed that exits non-zero is a deploy that
# stops, at the line that names it.
# ORDER IS LOAD-BEARING, and it was wrong in this script's first version — caught by the Plan 11g
# close reviewer before it ever ran. `seed-roles`'s census checks a REACHABILITY INVARIANT that
# includes the nine permissions the model expects OTHER seeds to have granted: six `auth.*` from
# `seed:admin` and three `ops.*` from `seed:ops`. Run `seed-roles` first and those three `ops.*`
# grants cannot exist yet, so on a fresh box its verdict is NOT READY.
#
# `seed:admin` is deliberately NOT in this list: it mints the bootstrap administrator from
# `ADMIN_PASSWORD` and is an owner step, run once per environment by a human who holds that
# password (README's first-bring-up sequence). A deploy that created an administrator would be
# creating a credential nobody asked it for.
compose run --rm api node dist/scripts/seed-ops.js
compose run --rm api node dist/scripts/seed-opd.js
# The patients module's two approval types (`patient_merge`, `patient_unmerge`) plus the two role
# KEYS the merge lane names. It is HERE rather than in `seed:registration` — which is runbook step
# zero, takes UHID_PREFIX and is deliberately NOT in this list — because a registration that has to
# be remembered per environment is a registration that gets forgotten: `patient_merge` went
# unregistered from Plan 05 until 2026-08-26, and every merge request on the live box threw
# `unknown_type` the whole time.
compose run --rm api node dist/scripts/seed-patients.js
compose run --rm api node dist/scripts/seed-billing.js
compose run --rm api node dist/scripts/seed-tariff.js
compose run --rm api node dist/scripts/seed-membership.js
# PLAN 16a T9 — the severe-pair starter floor. It is a FLOOR, not a formulary: the DTC owns
# expansion and a licensed dataset arrives through `formulary_staging`, never as a bulk load.
compose run --rm api node dist/scripts/seed-formulary-interactions.js
# PLAN 14 T2 — the materials module's TWO approval types (`materials_near_expiry_acceptance`,
# `materials_vendor_bank_change`). It seeds NO item, vendor or store: those are hospital-specific
# master data with a GST rate and a legal name attached, registered through /materials/* (DD16),
# and a seed that invented them would put placeholder commercial data in a live item master.
#
# It is HERE rather than in a runbook step for the reason `seed-patients` is: `requestApproval`
# throws `unknown_type` for a key no `approval_types` row carries, so an approval type reaches a
# deployment ONLY through this path. Without it, `postGrn` on a near-expiry line throws at a bay
# with a lorry in it, and `requestBankChange` throws at the vendor desk — the exact shape of the
# `patient_merge` and `tariff_revision` gaps, both of which ran for weeks before a human noticed.
compose run --rm api node dist/scripts/seed-materials.js

# `seed-roles` IS RUN, AND ITS EXIT STATUS IS DELIBERATELY NOT THIS DEPLOY'S.
#
# Its non-zero is a verdict about role ASSIGNMENT — "no user holds role X", "a declared permission
# is held by nobody" — which is a statement about the hospital's staffing, not about whether the
# seed worked, and which no deploy can repair. Wiring it to `set -e` means a hospital that has not
# yet hired a nurse cannot deploy, and — worse — that removing one person's role through
# /admin/users silently arms a deploy that aborts halfway, after migrations and before the
# containers are recreated. The GRANTS it writes are what the deploy needs and they land either
# way; the VERDICT is for a human to read.
#
# `check-config-present` below is the deploy's hard gate, and it asks only about rows the modules
# throw without.
if compose run --rm api node dist/scripts/seed-roles.js; then
  note "seed:roles complete and READY"
else
  note "seed:roles reported NOT READY (exit $?) — the grants landed; the verdict is about who"
  note "  HOLDS the roles. Read its census above and fix it through /admin/users. Not fatal here."
fi
note "configuration seeds complete"

# ----------------------------------------------------------------------------------------------
step "configuration gate — refuse to continue without the rows the modules require (DD2)"
# ----------------------------------------------------------------------------------------------
# The seeds above ESTABLISH; this REFUSES, and the two catch different failures. A seed that was
# never added for a new module, a row deleted by hand, a restore from a backup taken before the
# configuration existed: none of those is a failing seed, and all of them are a hospital that
# cannot issue an invoice. This asks the question positively, through the modules' OWN loaders.
#
# It is NOT `validate:config`. That one is the GO-LIVE gate and refuses without a CA signature and
# an active tariff version — both correctly false today, both the owner's runbook items (O6). A
# deploy gate demanding them would refuse every deploy between now and the CA's signature.
compose run --rm api node dist/scripts/check-config-present.js
note "every configuration row the modules require is present"

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

# --- SERVICES THAT READ THEIR CONFIG ONLY AT STARTUP -------------------------------------------
# The same trap as the caddy reload above, and it bit for real: grafana and prometheus mount their
# config from a bind-mounted DIRECTORY, so step 2 replacing the files changes nothing in the
# service DEFINITION — `compose up -d` sees no reason to recreate them and leaves the running
# process on whatever it read at boot. Measured: grafana started 18:32:36 with an empty
# provisioning directory, the files landed at 19:07:52, the container could see them, and the API
# still reported zero datasources and zero dashboards 35 minutes later.
#
# Caddy has a first-class `reload`. These two do not, without either enabling a lifecycle endpoint
# or putting admin credentials in this script (GC2 says no), so they are RESTARTED. Both keep their
# state on volumes, both come back in seconds, and both are loopback-only — a blip costs nothing.
# Unconditional on purpose: "restart only if the config changed" is a second source of truth about
# what changed, and this script has just overwritten the files either way.
#
# ALERTMANAGER JOINS THEM (Plan 11c / D10) AND FOR THE SHARPER VERSION OF THE SAME REASON. It
# reads alertmanager.yml once, at startup; step 2 has just REWRITTEN that file from .env.smtp; and
# `compose up -d` does not recreate a service whose DEFINITION is unchanged — so a re-pointed
# mailbox, a rotated app password, or a corrected `ALERT_EMAIL_TO` would be installed on disk,
# visible in the container, and completely ignored by the running process, for as long as that
# container lived. That trap cost Plan 11a a second remediation with grafana and prometheus (§2.77)
# and it is worse here: the failure is silent until the first alert nobody receives. Alertmanager
# keeps its silence and notification logs on a NAMED volume (see the compose file), so a restart
# costs nothing but a second of gossip-free startup.
# POSTGRES-EXPORTER IS IN THIS LIST AND IT WAS MISSING, FOUND BY DEPLOYING (2026-08-23).
# Plan 11c T6 added `alertmanager` here and correctly cited §2.77 for it — and left out the
# other service whose config THIS PLAN ALSO CHANGED. D11's drill-age query is installed into
# postgres-exporter/queries.yml, that process parses queries.yml ONCE at startup, and
# `compose up -d` does not recreate a service whose DEFINITION is unchanged. So after a clean
# deploy the file was correct on disk, correct INSIDE the container (the mount is a directory),
# and not being served: `hmis_backup_last_drill_pass_age_seconds` had NO SERIES, which means
# `HmisBackupDrillOverdue` could never fire and the backup-drill watcher D11 exists to provide
# was INERT — the precise silence D11's own header says it was written to abolish.
#
# This is §2.77's third specimen (grafana, prometheus, now postgres-exporter) and the rule it
# teaches is not "remember this service": it is **every service whose config directory step 2
# installs must appear in this loop.** Adding a config file to a service is what puts it here.
# caddy is absent deliberately — it gets an explicit `reload` above, which is stronger.
for svc in prometheus grafana alertmanager postgres-exporter; do
  if [ -n "$(compose ps -q "$svc" 2>/dev/null)" ]; then
    compose restart "$svc" >/dev/null 2>&1 \
      || die "$svc would not restart after its config was installed — see: compose logs $svc"
    note "$svc restarted so it re-reads $DEPLOY_DIR/$svc"
  fi
done

compose ps

# --- EVERY DECLARED SERVICE IS ACTUALLY RUNNING ------------------------------------------------
# Ledger §2.74: this script once printed `==> hmis-prod is up` and exited 0 with prometheus in
# `Restarting (2)` beside it, because its only gate was `/health` — a statement about api, db and
# worker, and about NOTHING ELSE. Everything that gate looked at was genuinely healthy.
#
# The property to verify is "every service this compose declares is running", so ask THAT, of the
# whole set, rather than curling one route and generalising. A crash-looping container reports
# `restarting`, never `running`, so the check catches it by construction; the deadline is for
# containers still legitimately starting, and the restart counter is reported because a service
# that is `running` on its fourth attempt is also news.
step "6b/8 every declared service is up"
SERVICES="$(compose config --services | tr -d '\r')"
[ -n "$SERVICES" ] || die "could not enumerate services from $DEPLOY_DIR/docker-compose.prod.yml"
deadline=$(( $(date +%s) + SERVICES_UP_TIMEOUT ))
while :; do
  not_up=""
  for svc in $SERVICES; do
    cid="$(compose ps -q "$svc" 2>/dev/null)"
    if [ -z "$cid" ]; then not_up="$not_up $svc(no-container)"; continue; fi
    state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
    [ "$state" = "running" ] || not_up="$not_up $svc($state)"
  done
  [ -n "$not_up" ] || break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    printf '\n'
    for svc in $not_up; do
      case "$svc" in *"(no-container)") continue;; esac
      name="${svc%%(*}"
      printf '    --- last log lines from %s ---\n' "$name"
      compose logs --tail 15 "$name" 2>&1 | sed 's/^/    /'
    done
    die "these services are not running after ${SERVICES_UP_TIMEOUT}s:$not_up
    A service that will not start is a deploy that has not happened, however green /health is.
    The usual cause is a config file this script did not install into $DEPLOY_DIR — check step 2."
  fi
  sleep 3
done
for svc in $SERVICES; do
  cid="$(compose ps -q "$svc")"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo '?')"
  [ "$restarts" = "0" ] && continue
  note "NOTE: $svc is running but has restarted $restarts time(s) — worth a look at its log"
done
note "all $(printf '%s\n' $SERVICES | wc -l | tr -d ' ') declared services running: $(printf '%s ' $SERVICES)"

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
step "8/8 the edge gate: /api/health as JSON, and a screen path as HTML"
# ----------------------------------------------------------------------------------------------
# The hostname is read out of the Caddyfile rather than configured twice — one source of truth,
# and re-pointing the stack at another name stays a one-file change (GC1).
SITE_HOST="$(awk 'NF == 2 && $2 == "{" && $1 ~ /^[A-Za-z0-9][A-Za-z0-9.-]*$/ && $1 ~ /\./ { print $1; exit }' \
  "$DEPLOY_DIR/caddy/Caddyfile")"
[ -n "$SITE_HOST" ] || die "could not read the site hostname out of $DEPLOY_DIR/caddy/Caddyfile"
note "site hostname $SITE_HOST"

# PLAN 11g / DD1 — THE API MOVED TO /api/*, AND THIS GATE HAD TO MOVE WITH IT OR BECOME A LIE.
#
# `/health` is no longer proxied: it falls to the SPA handler and comes back as index.html with
# HTTP 200, which `curl -fsS` reports as success. A gate that cannot tell the API from the SPA is
# the exact defect this phase exists to close, so it now checks BOTH halves of the split and
# checks the BODY rather than only the status.
deadline=$(( $(date +%s) + EDGE_HEALTH_TIMEOUT ))
until body="$(curl -fsS --max-time 10 "https://$SITE_HOST/api/health" 2>/dev/null)"; do
  [ "$(date +%s)" -lt "$deadline" ] \
    || die "https://$SITE_HOST/api/health did not answer within ${EDGE_HEALTH_TIMEOUT}s.
    On a first deploy this is usually ACME: read the caddy container log and confirm the hostname
    resolves to this box unproxied."
  sleep 3
done
# The API half must be the API. A 200 whose body is a document is the SPA handler answering, which
# means the @api matcher or its strip_prefix is wrong — and it would otherwise report as healthy.
case "$body" in
  '{'*) : ;;
  *) die "https://$SITE_HOST/api/health answered 200 with a NON-JSON body — the edge is serving the
    SPA where the API should be. First 200 bytes: $(printf '%.200s' "$body")" ;;
esac
note "api through the edge: HTTP 200 $body"

# The APPLICATION half must be the application, and this is the leg that would have caught the
# 2026-08-24 smoke test's D1: fifteen screens answered the API's JSON to a browser for a whole
# plan cycle while every test and every deploy gate was green. `/admin/users` is chosen because it
# is the exact URL the owner opened when the outage was found.
screen="$(curl -fsS --max-time 10 -H 'Accept: text/html' "https://$SITE_HOST/admin/users" 2>/dev/null)" \
  || die "https://$SITE_HOST/admin/users did not answer at all"
case "$screen" in
  *'<!doctype html>'*|*'<!DOCTYPE html>'*) : ;;
  *) die "https://$SITE_HOST/admin/users did not serve the SPA — a browser asking for a SCREEN is
    being handed something else (smoke-test D1). First 200 bytes: $(printf '%.200s' "$screen")" ;;
esac
note "screen through the edge: /admin/users serves the SPA document"

printf '\n==> hmis-prod is up: https://%s\n' "$SITE_HOST"
# PLAN 11g / DD1 — SAY THIS EVERY TIME, because the one deploy where it mattered is the one where
# nobody was told. The API moved under /api/*; any browser still holding a pre-11g bundle requests
# the bare paths, gets the SPA's index.html where it expects JSON, and fails with an unrecognised
# parse error rather than a refusal any screen knows how to render. Nothing is lost and nothing is
# double-posted — the API never sees those requests — but a cashier mid-shift, or the waiting-room
# display board left on /opd/display overnight, will show unexplained failures until reloaded.
printf '==> AFTER A DEPLOY, HARD-RELOAD EVERY OPEN BROWSER TAB (Ctrl+Shift+R).\n'
printf '    A stale tab gets HTML where it expects JSON and fails opaquely.\n\n' 
