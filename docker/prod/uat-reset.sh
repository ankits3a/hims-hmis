#!/usr/bin/env bash
#
# PHASE 11i T3 (§2b row 23) — DROP UAT AND BUILD IT AGAIN, SO EVERY TRAINING DAY STARTS CLEAN.
#
# UAT is seen by trainees, by vendors and on the owner's phone, and it must never hold a real
# person (D1). Two things follow. The first is that it never restores a production backup — that
# is a DPDP question, not a convenience one, and nothing in this file or in `deploy.sh`'s uat
# target can do it. The second is this script: a day of training leaves a database full of
# half-finished visits, cancelled invoices and a patient somebody typed in by mistake, and the
# honest answer to all of that is to throw the database away rather than to tidy it.
#
# What it does:
#   1. refuses if it is not pointed at UAT (see the guard below — it is the whole safety of this
#      file and it is deliberately paranoid);
#   2. stops api and worker, so nothing is writing while the database goes;
#   3. drops and recreates the database inside UAT's own db container;
#   4. runs the MIGRATE + SEED half of a deploy from the same image, exactly as deploy.sh does;
#   5. runs the two synthetic seeds behind the synthetic-data door (11i T5);
#   6. brings api and worker back and prints the readiness census.
#
# It is NOT a deploy: it builds nothing, copies no config and touches no image. Run `deploy.sh`
# with HMIS_TARGET=uat for that.

set -euo pipefail

TARGET="${HMIS_TARGET:-uat}"
PROJECT="${HMIS_UAT_PROJECT:-hmis-uat}"
DEPLOY_DIR="${HMIS_DEPLOY_DIR:-/opt/hmis-uat}"

die() { printf 'uat-reset: FATAL: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# ════════════════════════════════════════════════════════════════════════════════════════════════
# THE GUARD. This script drops a database; the only thing standing between it and production is
# these lines, so they refuse on every name production could possibly answer to rather than
# checking one.
# ════════════════════════════════════════════════════════════════════════════════════════════════
case "$PROJECT" in
  hmis-prod|hmis-prod-*) die "PROJECT is '$PROJECT'. This script DROPS A DATABASE and will not run
    against production, ever. If you meant to reset UAT, unset HMIS_UAT_PROJECT." ;;
esac
[ "$TARGET" = "uat" ] || die "HMIS_TARGET is '$TARGET'; this script only runs against uat."
case "$DEPLOY_DIR" in
  /opt/hmis-prod|/opt/hmis-prod/*) die "DEPLOY_DIR is '$DEPLOY_DIR' — that is production's." ;;
esac
[ -f "$DEPLOY_DIR/.env" ] || die "$DEPLOY_DIR/.env is missing — has deploy.sh run for this target?"

# The synthetic-data door (11i T5 / D5). The seeds refuse without it; this script refuses too,
# rather than running the first half and failing at the second.
grep -q '^HMIS_SYNTHETIC_DATA_OK=1' "$DEPLOY_DIR/.env" \
  || die "$DEPLOY_DIR/.env does not set HMIS_SYNTHETIC_DATA_OK=1. The two synthetic seeds refuse
    without it (D5), and a reset that stopped halfway would leave UAT emptier than it started."

compose() {
  docker compose -p "$PROJECT" \
    -f "$DEPLOY_DIR/docker-compose.prod.yml" \
    -f "$DEPLOY_DIR/docker-compose.uat.yml" \
    --project-directory "$DEPLOY_DIR" "$@"
}

POSTGRES_USER="$(sed -n 's/^POSTGRES_USER=//p' "$DEPLOY_DIR/.env" | head -n 1)"
POSTGRES_DB="$(sed -n 's/^POSTGRES_DB=//p' "$DEPLOY_DIR/.env" | head -n 1)"
[ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_DB" ] || die "$DEPLOY_DIR/.env carries no POSTGRES_USER/POSTGRES_DB"

step "1/5 stopping api and worker so nothing writes while the database goes"
compose stop api worker >/dev/null
note "api and worker stopped"

step "2/5 dropping and recreating $POSTGRES_DB"
# `WITH (FORCE)` terminates whatever is still attached — a psql somebody left open is the usual
# reason a drop hangs, and hanging here is worse than disconnecting them.
compose exec -T db psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "drop database if exists \"$POSTGRES_DB\" with (force)"
compose exec -T db psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "create database \"$POSTGRES_DB\" owner \"$POSTGRES_USER\""
note "$POSTGRES_DB recreated, empty"

step "3/5 migrations and the configuration seeds, from inside the image"
# THE SAME LIST `deploy.sh` RUNS, in the same order. `deploy-parity.test.ts` asserts these agree:
# a second hand-maintained copy of a seed census is the shape that goes stale in silence.
compose run --rm api node dist/scripts/migrate.js
for seed in seed-cursors.js seed-ops.js seed-opd.js seed-patients.js seed-billing.js \
            seed-tariff.js seed-membership.js seed-formulary-interactions.js seed-materials.js \
            seed-ot.js seed-pharmacy.js seed-lab.js; do
  compose run --rm api node "dist/scripts/$seed" >/dev/null || die "$seed failed"
  note "ran $seed"
done
compose run --rm api node dist/scripts/seed-roles.js || note "seed:roles reported NOT READY (expected on a fresh box)"
compose run --rm api node dist/scripts/check-config-present.js

step "4/5 the synthetic data, behind the door (11i T5 / D5)"
compose run --rm api node dist/scripts/seed-lab-catalogue.js
compose run --rm api node dist/scripts/seed-lab-demo.js
note "the golden catalogue and a lab day are loaded"

step "5/5 api and worker back up, and the census"
compose up -d api worker
compose run --rm api node dist/scripts/standup-check.js all || note "standup:check reported RED rows — the to-do list"

printf '\n==> UAT is reset. Every training day starts here.\n'
