#!/usr/bin/env bash
# PLAN 17-F · S — stand the Central Lab up on a NON-PRODUCTION database with synthetic data, then
# print `standup:check lab`. The rehearsal half of docs/runbooks/lab-go-live.md (G5-a), never G5.
#
#   tools/lab-synthetic.sh [dbname]        # default hmis_lab_synth, on the dev instance :5433
#
# Every value it writes is synthetic: the catalogue (golden 64 + apps/core/scripts/synthetic/lab/
# supplement), the reference ranges ("SYNTHETIC - …" in each band's source), the prices, the staff,
# the pathologist of record and the analysers. Production's copies of all of these belong to the
# owner, through the shipped screens. This script refuses anything but the dev instance.
#
# Credentials: generated once per database, written ONLY to ~/.hmis-synthetic/<db>.credentials
# (mode 600, outside git) and piped to seed:staff on stdin. Re-runs reuse them.
set -euo pipefail

DB="${1:-hmis_lab_synth}"
[[ "$DB" =~ ^[a-z0-9_]+$ ]] || { echo "refused: database name must be [a-z0-9_]+" >&2; exit 2; }
case "$DB" in hmis|hmis_prod*|*prod*) echo "refused: '$DB' looks like production" >&2; exit 2;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/apps/core"
DATA="$CORE/scripts/synthetic/lab"
export DATABASE_URL="postgres://hmis:hmis@localhost:5433/$DB"
export HMIS_SYNTHETIC_DATA_OK=1
unset NODE_ENV

step() { printf '\n── %s\n' "$*"; }

step "database $DB on the dev instance (:5433)"
if ! docker exec hmis-db-1 psql -U hmis -d postgres -qAt -c "select 1 from pg_database where datname='$DB'" | grep -q 1; then
  docker exec hmis-db-1 psql -U hmis -d postgres -qAt -c "create database $DB"
  echo "created"
else
  echo "present"
fi

step "contracts build (scripts import @hmis/contracts from dist)"
[ -f "$ROOT/packages/contracts/dist/index.js" ] || pnpm -s --filter @hmis/contracts build

cd "$CORE"
step "migrate, then the deploy's seed order"
pnpm -s db:migrate
pnpm -s exec tsx scripts/seed-cursors.ts
for s in ops opd patients billing tariff membership formulary materials ot pharmacy lab; do
  pnpm -s "seed:$s" >/dev/null && echo "seed:$s ok"
done
pnpm -s seed:roles >/dev/null || true   # exits 1 while roles lack holders; deploy ignores it too

step "synthetic staff (seed:staff, passwords on stdin only)"
CRED_DIR="$HOME/.hmis-synthetic"; CRED="$CRED_DIR/$DB.credentials"
mkdir -p "$CRED_DIR"; chmod 700 "$CRED_DIR"
if [ ! -f "$CRED" ]; then
  ( umask 077
    python3 - "$DATA/staff.json" > "$CRED" <<'PY'
import json, secrets, sys
print(f"admin\t{secrets.token_urlsafe(15)}")
for row in json.load(open(sys.argv[1])):
    print(f"{row['username']}\t{secrets.token_urlsafe(15)}")
PY
  )
fi
ADMIN_PASSWORD="$(awk -F'\t' '$1=="admin"{print $2}' "$CRED")" pnpm -s seed:admin | tail -1
python3 - "$DATA/staff.json" "$CRED" <<'PY' | pnpm -s seed:staff
import json, sys
creds = dict(line.rstrip("\n").split("\t") for line in open(sys.argv[2]))
roster = [{"username": r["username"], "fullName": r["fullName"], "password": creds[r["username"]], "roles": r["roles"]}
          for r in json.load(open(sys.argv[1]))]
print(json.dumps(roster))
PY

PATHOLOGIST_ID="$(docker exec hmis-db-1 psql -U hmis -d "$DB" -qAt -c "select id from users where username='dr.meera'")"

step "catalogue: the golden 64, then the synthetic supplement through the owner's own loader"
# Once per database: a re-run of seed:lab-catalogue resets each golden analyte's bands to the
# fixture's, which would wipe the supplement's bands for the fixture's text analytes.
ORDERABLES="$(docker exec hmis-db-1 psql -U hmis -d "$DB" -qAt -c "select count(*) from lab_orderables")"
if [ "$ORDERABLES" = "0" ]; then
  SEED_ACTOR_ID="$PATHOLOGIST_ID" pnpm -s seed:lab-catalogue | tail -1
else
  echo "golden catalogue already seeded ($ORDERABLES orderables)"
fi
# The loader refuses a second import of the same bytes (by design), and bands are not additive
# (range_overlap). So the supplement is imported once per database; changed data = a fresh database.
IMPORTED="$(docker exec hmis-db-1 psql -U hmis -d "$DB" -qAt -c \
  "select count(*) from lab_catalogue_imports where file_names = 'analytes.csv, orderables.csv, ranges.csv'")"
if [ "$IMPORTED" = "0" ]; then
  pnpm -s import:lab-catalogue --analytes "$DATA/analytes.csv" --orderables "$DATA/orderables.csv" \
    --ranges "$DATA/ranges.csv" --apply --actor "$PATHOLOGIST_ID" | tail -3
else
  echo "supplement already imported into $DB — to load changed synthetic data, drop the database and re-run"
fi

step "paperwork: LAB department, pathologist of record, opd_visit, GST placeholder, synthetic prices"
pnpm -s exec tsx scripts/dev-lab-standup.ts

step "the room: benches and analysers"
pnpm -s exec tsx scripts/seed-lab-synthetic.ts

step "standup:check lab"
pnpm -s standup:check lab || true
echo
echo "credentials for the synthetic staff: $CRED (mode 600, never commit)"
