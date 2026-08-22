#!/usr/bin/env bash
#
# Plan 11a / D8 + Global Constraint 7 — THE WEEKLY RESTORE DRILL, AND IT RESTORES FOR REAL.
#
# A backup nobody has restored is a belief, not a backup. Stage 1 runs on one box with no standby,
# no promotion and no fencing, so the backup repository is not one layer of defence — it is the
# only one. That is why this is not a `--dry-run`: a dry run discharges nothing.
#
# What it does, in order:
#
#   1. reads a census off the LIVE cluster — the event count, the newest event id, the number of
#      applied migrations;
#   2. takes an incremental backup, which finishes by pushing the WAL segment containing that
#      census and waiting for it to land, so the restore below provably contains it;
#   3. restores the repository into a SCRATCH CONTAINER's own directory — never anywhere near
#      production's PGDATA, and never into a running cluster;
#   4. boots a SECOND POSTMASTER on the restored directory, on a private port inside that
#      container, and waits for it to leave recovery;
#   5. runs the migrator against the restored cluster — the application's own consistency check;
#   6. asserts the census back OUT of the restored data: the row count and the known event id.
#      The verdict is read out of the restored database, never out of pgbackrest's exit code;
#   7. drops the restored database and destroys the scratch container.
#
# IT EMITS AN EXIT CODE, A TRANSCRIPT, AND — since Plan 11a T5 wired the seam below — ONE EVENT:
# `backup.drill_passed` or `backup.drill_failed`, defined in
# apps/core/src/kernel/retention/events.ts and appended through the application's own
# `appendEvent`. THE EXIT CODE REMAINS THE AUTHORITATIVE VERDICT — the event is what a dashboard
# and an alert rule can see, and an append that fails is noted without changing it. There is
# exactly one insertion point for that wire and it is marked `T5 SEAM` below.
#
# SCHEDULING: a host cron entry installed by deploy.sh (weekly, IST off-hours), deliberately NOT a
# Scheduler job — the worker must hold no restore privilege and must never block for minutes on a
# restore.
#
# Production runs the copy in the deploy directory (/opt/hmis-prod/drill/restore-drill.sh), which
# deploy.sh installs from this file, never this checkout.

set -euo pipefail

# ------------------------------------------------------------------------------------------------
# Configuration. The defaults ARE production; every override exists so the drill can be rehearsed
# end to end — R2 included — without touching the production repository or the production cluster.
# Same idiom as deploy.sh's HMIS_DEPLOY_DIR.
# ------------------------------------------------------------------------------------------------
DEPLOY_DIR="${HMIS_DEPLOY_DIR:-/opt/hmis-prod}"
STANZA="${HMIS_DRILL_STANZA:-hmis}"
DB_CONTAINER="${HMIS_DRILL_DB_CONTAINER:-hmis-prod-db-1}"
DB_IMAGE="${HMIS_DRILL_DB_IMAGE:-hmis-prod/db:latest}"
SERVER_IMAGE="${HMIS_DRILL_SERVER_IMAGE:-hmis-prod/server:latest}"
# Empty means "whatever pgbackrest.conf says", i.e. the production repository. A rehearsal points
# this at a scratch prefix in the same bucket and exercises the identical code path.
REPO_PATH="${HMIS_DRILL_REPO_PATH:-}"
# Rule 7: the scratch container is the only container this script creates, it is labelled into a
# clearly-temporary compose project, and it is removed on every exit path including failure.
SCRATCH_PROJECT="${HMIS_DRILL_PROJECT:-hmis-drill}"
SCRATCH_PORT="${HMIS_DRILL_PORT:-5601}"
RECOVERY_TIMEOUT="${HMIS_DRILL_RECOVERY_TIMEOUT:-900}"

ENV_FILE="$DEPLOY_DIR/.env"
PGBR_ENV="$DEPLOY_DIR/.env.pgbackrest"
CONF_DIR="$DEPLOY_DIR/pgbackrest"
RESTORE_DIR=/restore

SCRATCH_NAME="${SCRATCH_PROJECT}-restore-$(date -u +%Y%m%d%H%M%S)-$$"

die() { printf 'restore-drill: FATAL: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# ------------------------------------------------------------------------------------------------
# ================================== T5 SEAM — THE EVENTED VERDICT ===============================
#
# This is the ONE place the evented verdict goes, and nothing else in this script had to change
# when it did.
#
# T4 left this seam because `backup.drill_passed` / `backup.drill_failed` did not exist yet. They
# do now: apps/core/src/kernel/retention/events.ts (Plan 11a T5) defines both, and the wire below
# appends one of them THROUGH THE APPLICATION'S OWN `appendEvent` — the same envelope, the same
# zod payload validation and the same `events` table every other fact in this hospital's record
# goes through. A hand-written INSERT would have produced a row that looked like an event and was
# not one.
#
# The emitter is invoked from the EXIT trap on BOTH paths — success and every failure, including a
# `die` before the restore ever starts — with
#   $1                 "passed" | "failed"
#   $CENSUS_EVENTS     events counted in the LIVE cluster before the backup ("" if not reached)
#   $RESTORED_EVENTS   events counted in the RESTORED cluster        ("" if not reached)
#   $CENSUS_EVENT_ID   the known event id that was asserted          ("" if the table was empty)
#   $BACKUP_SECONDS / $RESTORE_SECONDS
# All of them are pre-declared empty immediately below, so the trap is safe under `set -u` even
# when the drill dies on its first line, and every one of them is NULLABLE in the payload schema
# for exactly that case.
#
# THE APPEND CAN FAIL AND THAT MUST NOT CHANGE THE VERDICT. Every prerequisite is checked rather
# than assumed (the trap fires on paths where none of them hold), and a failure to append is
# NOTED, never fatal: the exit code and this transcript remain the record. Each guard's last
# command succeeds, so the trap still ends 0 and the shell still exits with the drill's own
# status — the property the whole script's verdict rests on.
# ------------------------------------------------------------------------------------------------
CENSUS_EVENTS=""
CENSUS_EVENT_ID=""
CENSUS_MIGRATIONS=""
RESTORED_EVENTS=""
RESTORED_MIGRATIONS=""
BACKUP_SECONDS=""
RESTORE_SECONDS=""

emit_drill_event() {
  local verdict="$1"
  [ -f "$ENV_FILE" ] || { note "no $ENV_FILE — no database to append the verdict to"; return 1; }
  command -v docker >/dev/null 2>&1 || { note "docker is not installed — verdict not appended"; return 1; }
  docker image inspect "$SERVER_IMAGE" >/dev/null 2>&1 \
    || { note "image $SERVER_IMAGE is not on this host — verdict not appended"; return 1; }
  [ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null)" = "true" ] \
    || { note "container $DB_CONTAINER is not running — verdict not appended"; return 1; }

  local prod_url; prod_url="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | head -n 1)"
  [ -n "$prod_url" ] || { note "$ENV_FILE carries no DATABASE_URL — verdict not appended"; return 1; }

  # The same host:port rewrite step 5/7 does, for the same reason: the deploy .env's own URL with
  # only the endpoint swapped, so the password is never re-encoded and never built by hand. The
  # container joins the LIVE db container's network namespace, where the cluster is on loopback.
  # Exported and passed BY NAME so the credential never appears in the process table.
  local prefix="${prod_url%@*}" suffix="${prod_url##*@}"
  export DATABASE_URL="$prefix@127.0.0.1:5432/${suffix#*/}"
  export HMIS_DRILL_VERDICT="$verdict"
  export HMIS_DRILL_EVENT_STANZA="$STANZA"
  export HMIS_DRILL_EVENT_CENSUS="$CENSUS_EVENTS"
  export HMIS_DRILL_EVENT_RESTORED="$RESTORED_EVENTS"
  export HMIS_DRILL_EVENT_ID="$CENSUS_EVENT_ID"
  export HMIS_DRILL_EVENT_BACKUP_SECONDS="$BACKUP_SECONDS"
  export HMIS_DRILL_EVENT_RESTORE_SECONDS="$RESTORE_SECONDS"

  local rc=0
  docker run --rm --network "container:$DB_CONTAINER" \
    --env DATABASE_URL \
    --env HMIS_DRILL_VERDICT \
    --env HMIS_DRILL_EVENT_STANZA \
    --env HMIS_DRILL_EVENT_CENSUS \
    --env HMIS_DRILL_EVENT_RESTORED \
    --env HMIS_DRILL_EVENT_ID \
    --env HMIS_DRILL_EVENT_BACKUP_SECONDS \
    --env HMIS_DRILL_EVENT_RESTORE_SECONDS \
    "$SERVER_IMAGE" node -e '
const { createDb, withTx } = require("./dist/src/kernel/db/client.js");
const { appendEvent } = require("./dist/src/kernel/events/append.js");
const catalog = require("./dist/src/kernel/retention/events.js");
const num = (v) => (v === undefined || v === "" ? null : Number(v));
const str = (v) => (v === undefined || v === "" ? null : v);
const passed = process.env.HMIS_DRILL_VERDICT === "passed";
const def = passed ? catalog.backupDrillPassed : catalog.backupDrillFailed;
const { db, pool } = createDb(process.env.DATABASE_URL);
withTx(db, (tx) => appendEvent(tx, def.make({
  actor: { type: "system", id: "restore-drill" },
  payload: {
    stanza: process.env.HMIS_DRILL_EVENT_STANZA,
    censusEvents: num(process.env.HMIS_DRILL_EVENT_CENSUS),
    restoredEvents: num(process.env.HMIS_DRILL_EVENT_RESTORED),
    assertedEventId: str(process.env.HMIS_DRILL_EVENT_ID),
    backupSeconds: num(process.env.HMIS_DRILL_EVENT_BACKUP_SECONDS),
    restoreSeconds: num(process.env.HMIS_DRILL_EVENT_RESTORE_SECONDS),
  },
})))
  .then(() => pool.end())
  .then(() => { console.log("appended " + def.name); })
  .catch((err) => { console.error(String(err)); process.exit(1); });
' || rc=$?
  unset DATABASE_URL
  [ "$rc" -eq 0 ] || { note "the verdict event could NOT be appended (exit $rc)"; return 1; }
  return 0
}

emit_verdict() {
  local verdict="$1"
  note "verdict: $verdict — appending backup.drill_$verdict to the events log"
  emit_drill_event "$verdict" \
    || note "verdict NOT evented; the exit code and this transcript remain the record"
}
# ================================ END T5 SEAM ===================================================

CONTAINER_CREATED=""
cleanup() {
  local rc=$?
  if [ -n "$CONTAINER_CREATED" ]; then
    step "cleanup — destroying the scratch container $SCRATCH_NAME"
    # -v takes its anonymous volumes with it. The restored cluster lives only in the container's
    # own writable layer, so this is what "drops the scratch database" ultimately means; the
    # explicit dropdb above it is the part that proves the restored cluster accepted DDL.
    docker rm -f -v "$SCRATCH_NAME" >/dev/null 2>&1 || note "could not remove $SCRATCH_NAME — REMOVE IT BY NAME"
  fi
  if [ "$rc" -eq 0 ]; then
    step "DRILL PASSED"
    emit_verdict passed
  else
    step "DRILL FAILED (exit $rc)"
    emit_verdict failed
  fi
}
trap cleanup EXIT

# ------------------------------------------------------------------------------------------------
step "0/7 pre-flight"
# ------------------------------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed"
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing — has deploy.sh ever run on this box?"
[ -f "$PGBR_ENV" ] || die "$PGBR_ENV is missing — deploy.sh derives it from $DEPLOY_DIR/.env.r2"
[ -d "$CONF_DIR" ] || die "$CONF_DIR is missing — deploy.sh installs pgbackrest.conf there"
docker image inspect "$DB_IMAGE" >/dev/null 2>&1 || die "image $DB_IMAGE is not on this host"
docker image inspect "$SERVER_IMAGE" >/dev/null 2>&1 || die "image $SERVER_IMAGE is not on this host"
[ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null)" = "true" ] \
  || die "container $DB_CONTAINER is not running — the drill reads its census off the live cluster"

# Read from the deploy .env rather than re-deriving: one source of truth, and the credential never
# passes through a command line where `ps` could see it.
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
POSTGRES_USER="$(env_get POSTGRES_USER)"
POSTGRES_DB="$(env_get POSTGRES_DB)"
DATABASE_URL="$(env_get DATABASE_URL)"
[ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_DB" ] && [ -n "$DATABASE_URL" ] \
  || die "$ENV_FILE is missing POSTGRES_USER, POSTGRES_DB or DATABASE_URL"

# The repo-path override, if any, has to reach every pgbackrest invocation: the ones in the live
# container and the ones in the scratch container. Kept as an array so the empty case is empty.
BR_ENV=()
if [ -n "$REPO_PATH" ]; then
  BR_ENV=(--env "PGBACKREST_REPO1_PATH=$REPO_PATH")
  note "repo path OVERRIDDEN to $REPO_PATH — this is a rehearsal, not the production repository"
fi

note "stanza $STANZA · live container $DB_CONTAINER · scratch $SCRATCH_NAME"

live_psql() {
  docker exec --user postgres "$DB_CONTAINER" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -qtAX -c "$1"
}
live_pgbackrest() {
  docker exec --user postgres "${BR_ENV[@]}" "$DB_CONTAINER" pgbackrest --stanza="$STANZA" "$@"
}
scratch_psql() {
  docker exec --user postgres "$SCRATCH_NAME" \
    psql -p "$SCRATCH_PORT" -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -qtAX -c "$2"
}

# ------------------------------------------------------------------------------------------------
step "1/7 census of the live cluster"
# ------------------------------------------------------------------------------------------------
CENSUS_EVENTS="$(live_psql 'select count(*) from events')"
CENSUS_EVENT_ID="$(live_psql 'select event_id from events order by seq desc limit 1')"
CENSUS_MIGRATIONS="$(live_psql 'select count(*) from drizzle.__drizzle_migrations')"
note "events=$CENSUS_EVENTS  migrations=$CENSUS_MIGRATIONS  newest event id=${CENSUS_EVENT_ID:-<none: the table is empty>}"

# ------------------------------------------------------------------------------------------------
step "2/7 incremental backup, so the census above is inside the repository"
# ------------------------------------------------------------------------------------------------
# The first ever run has no full to build on; pgBackRest promotes the incr to a full by itself and
# says so. The backup ends by switching WAL and waiting for the segment to be archived, which is
# what makes step 6's assertions deterministic rather than a race with archive_timeout.
backup_start=$SECONDS
live_pgbackrest --type=incr backup
BACKUP_SECONDS=$(( SECONDS - backup_start ))
note "backup took ${BACKUP_SECONDS}s"

step "repository state (sizes here are the repo's own accounting, i.e. compressed and encrypted)"
live_pgbackrest info

# ------------------------------------------------------------------------------------------------
step "3/7 scratch container"
# ------------------------------------------------------------------------------------------------
# Rule 7: labelled into the temporary `hmis-drill` project, named after this run, and removed by
# the EXIT trap on every path. It is the same image production runs, reading the same
# pgbackrest.conf and the same credentials — a restore proved with different tooling proves
# nothing about the tooling that will be used at 3am.
docker run -d \
  --name "$SCRATCH_NAME" \
  --label "com.docker.compose.project=$SCRATCH_PROJECT" \
  --env-file "$PGBR_ENV" \
  "${BR_ENV[@]}" \
  -v "$CONF_DIR:/etc/pgbackrest:ro" \
  --entrypoint bash \
  "$DB_IMAGE" -c 'sleep infinity' >/dev/null
CONTAINER_CREATED=yes
docker exec "$SCRATCH_NAME" install -d -o postgres -g postgres -m 0700 "$RESTORE_DIR"
note "scratch container up from $DB_IMAGE"

# ------------------------------------------------------------------------------------------------
step "4/7 RESTORE — the real thing, out of the repository, into $RESTORE_DIR"
# ------------------------------------------------------------------------------------------------
restore_start=$SECONDS
docker exec --user postgres "$SCRATCH_NAME" \
  pgbackrest --stanza="$STANZA" --pg1-path="$RESTORE_DIR" restore
RESTORE_SECONDS=$(( SECONDS - restore_start ))
note "restore took ${RESTORE_SECONDS}s"
docker exec "$SCRATCH_NAME" du -sh "$RESTORE_DIR"

# archive_mode is off on the restored copy so it cannot push its replayed WAL back into the
# repository and corrupt production's timeline. It is off anyway — production sets archive_mode on
# the COMMAND LINE, so it was never in the backed-up postgresql.conf — and it is stated here
# because relying on that would be relying on the shape of a different file.
docker exec --user postgres "$SCRATCH_NAME" \
  pg_ctl -D "$RESTORE_DIR" -l "$RESTORE_DIR/startup.log" -w -t 300 \
  -o "-p $SCRATCH_PORT -c archive_mode=off -c listen_addresses=127.0.0.1" start

# `restore_command` (pgbackrest again, in this same container) replays the archive; the cluster
# leaves recovery when it runs out of WAL and promotes itself.
deadline=$(( $(date +%s) + RECOVERY_TIMEOUT ))
until [ "$(scratch_psql postgres 'select pg_is_in_recovery()' 2>/dev/null || echo t)" = "f" ]; do
  [ "$(date +%s)" -lt "$deadline" ] || {
    docker exec "$SCRATCH_NAME" tail -40 "$RESTORE_DIR/startup.log" || true
    die "the restored cluster was still in recovery after ${RECOVERY_TIMEOUT}s"
  }
  sleep 2
done
note "restored cluster is out of recovery and accepting writes on port $SCRATCH_PORT"
docker exec "$SCRATCH_NAME" tail -15 "$RESTORE_DIR/startup.log"

# ------------------------------------------------------------------------------------------------
step "5/7 the migrator's own consistency check, against the restored cluster"
# ------------------------------------------------------------------------------------------------
# The application's migrator, not a hand-rolled schema comparison: it validates the journal against
# apps/core/drizzle and applies anything missing. On a faithful restore of a deployed cluster there
# is nothing to apply and it prints `migrations applied`.
#
# The URL is the deploy .env's own DATABASE_URL with only the host:port swapped, so the password is
# never re-encoded and never built by hand. It is exported and passed by NAME, so it does not
# appear in the process table.
DRILL_PREFIX="${DATABASE_URL%@*}"
DRILL_SUFFIX="${DATABASE_URL##*@}"
export DATABASE_URL="$DRILL_PREFIX@127.0.0.1:$SCRATCH_PORT/${DRILL_SUFFIX#*/}"
docker run --rm --network "container:$SCRATCH_NAME" --env DATABASE_URL "$SERVER_IMAGE" \
  node dist/scripts/migrate.js
unset DATABASE_URL

# ------------------------------------------------------------------------------------------------
step "6/7 assertions — read back OUT of the restored data"
# ------------------------------------------------------------------------------------------------
RESTORED_EVENTS="$(scratch_psql "$POSTGRES_DB" 'select count(*) from events')"
RESTORED_MIGRATIONS="$(scratch_psql "$POSTGRES_DB" 'select count(*) from drizzle.__drizzle_migrations')"
note "restored events=$RESTORED_EVENTS (census $CENSUS_EVENTS) · migrations=$RESTORED_MIGRATIONS (census $CENSUS_MIGRATIONS)"

[ "$RESTORED_EVENTS" -ge "$CENSUS_EVENTS" ] \
  || die "row count REGRESSED: the restored cluster has $RESTORED_EVENTS events, the live one had $CENSUS_EVENTS"
[ "$RESTORED_MIGRATIONS" -ge "$CENSUS_MIGRATIONS" ] \
  || die "migration count REGRESSED: restored $RESTORED_MIGRATIONS, live $CENSUS_MIGRATIONS"

if [ -n "$CENSUS_EVENT_ID" ]; then
  found="$(scratch_psql "$POSTGRES_DB" "select count(*) from events where event_id = '$CENSUS_EVENT_ID'")"
  [ "$found" = "1" ] \
    || die "the known event id $CENSUS_EVENT_ID is NOT in the restored cluster (found $found rows)"
  note "known event id $CENSUS_EVENT_ID found in the restored cluster"
else
  # Said out loud rather than passed over: on a cluster that has not yet recorded an event there is
  # no id to look for, and a drill that quietly skipped the check would read as one that ran it.
  note "NO EVENT ID ASSERTED: the live events table was empty at census time. The row count and the"
  note "migration journal were still checked, and both matched."
fi

# ------------------------------------------------------------------------------------------------
step "7/7 drop the scratch database"
# ------------------------------------------------------------------------------------------------
# A real DDL statement against the restored cluster, which is a stronger statement than deleting a
# directory: it says the restored cluster is a working, writable Postgres and not just bytes that
# happened to survive. The container, and with it everything else that was restored, goes in the
# EXIT trap immediately below.
docker exec --user postgres "$SCRATCH_NAME" dropdb -p "$SCRATCH_PORT" -U "$POSTGRES_USER" "$POSTGRES_DB"
docker exec --user postgres "$SCRATCH_NAME" pg_ctl -D "$RESTORE_DIR" -m immediate -w -t 60 stop
note "scratch database dropped and the second postmaster stopped"

step "SUMMARY  backup ${BACKUP_SECONDS}s · restore ${RESTORE_SECONDS}s · events ${CENSUS_EVENTS} -> ${RESTORED_EVENTS}"
