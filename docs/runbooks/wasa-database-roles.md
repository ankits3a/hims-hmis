# WASA M-07 / M-10 / L-08 — the database roles, the relay's grant, the device's agent

**Who runs this:** the owner (or whoever deploys production). No agent runs any of it against
production. **When:** after the deploy that carries migration `*_wasa_audit_append_only_agent_bindings`
(serial assigned at merge). §3 can be done any time after that deploy; §4 and §5 are checks the same
day.

| | done by the migration, no operator act | owed by an operator |
|---|---|---|
| **M-07** audit tables append-only | `events` and `phi_access_log` refuse UPDATE/DELETE (triggers `events_append_only`, `phi_access_log_append_only`) | move the API off the superuser role — **§3** |
| **M-10** print claim bound to the relay | `agents.print_destinations`; every agent that has claimed a job granted today's four destinations, every other agent none | check the grants, optionally narrow — **§4** |
| **L-08** heartbeat bound to the device | `interfaces.agent_id`; a heartbeat from anybody but the bound agent is 403 | bind any device that is heartbeating — **§5** |

Every command below is runnable as written on the production box. They use one shell variable, set
once per terminal:

```bash
C="docker compose -p hmis-prod -f /opt/hmis-prod/docker-compose.prod.yml --project-directory /opt/hmis-prod"
```

`psql` runs INSIDE the `db` container as the container's own `POSTGRES_USER` / `POSTGRES_DB`, so no
database name or role is typed by hand.

---

## 1 · Why (read once)

Production's `DATABASE_URL` connects as `POSTGRES_USER` (`hmis`), which the official `postgres`
image creates as a **superuser**. A superuser can `ALTER TABLE … DISABLE TRIGGER`, set
`session_replication_role = replica`, `TRUNCATE` or `DROP` anything — so every append-only trigger in
this schema (billing `0012`, orders `0044`, registers `0056`/`0135`, and now `events` and
`phi_access_log`) is one statement deep for the API, and a single future SQL injection would own the
whole cluster.

The fix splits the process that faces the internet from the processes that must own the schema:

| role | used by | may |
|---|---|---|
| `hmis` (existing, owner, superuser) | the **worker**, the **migrator** and every `compose run --rm api node dist/scripts/*.js` one-off in `deploy.sh` | everything — it creates and drops the monthly `events` partitions (only the owner of `events` may), runs DDL, and runs the PHI-log retention prune |
| `hmis_app` (new, **not** superuser, owns nothing) | the long-running **API** process only | `SELECT, INSERT, UPDATE, DELETE` on ordinary tables; on `events` and `phi_access_log` **`SELECT, INSERT` only**; no DDL, no `TRUNCATE`, cannot disable a trigger or set `session_replication_role` |

**How the API — and only the API — gets the new role, without touching `deploy.sh`:** the API
process reads `API_DATABASE_URL` when it is set and non-empty, and uses it instead of
`DATABASE_URL` (`apps/core/src/kernel/db/role-check.ts` `applyApiDatabaseUrl`, called first thing in
`main.ts`). Nothing else reads that key, so the worker, the migrator and the seeds keep the owner
role. Unset, nothing changes.

**How you know it is still owed:** the API logs one line at boot while it is a superuser:

```
db: the API is connected to Postgres as "hmis", a SUPERUSER. … docs/runbooks/wasa-database-roles.md (WASA M-07).
```

It **warns and never refuses** (the boot-check rule: a deployment state an operator can be halfway
through is a warning, not an outage).

**Why `hmis` itself is not demoted here:** it is the cluster's bootstrap role (created from
`POSTGRES_USER`), which Postgres requires to stay a superuser, and the worker needs ownership anyway.
Moving the worker to a separate non-superuser *owner* role is a later, larger change (every object's
owner moves); it is out of scope for this page.

---

## 2 · Measure first (read-only)

```bash
$C exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X' <<'SQL'
SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser;
SELECT rolname FROM pg_roles WHERE rolname = 'hmis_app';
SELECT tgname FROM pg_trigger WHERE tgname IN ('events_append_only', 'phi_access_log_append_only') AND NOT tgisinternal;
SQL
$C logs --since 24h api | grep -c 'a SUPERUSER' || true
```

Expected before §3: `superuser = t`; **no** `hmis_app` row (if there is one, §3a has already been
done — skip to §3b); both trigger names present (if not, the migration is not deployed — stop); the
log count is ≥ 1 (the warning, once per API boot).

---

## 3 · Move the API onto `hmis_app`

### 3a · Create the role (once)

The password is generated on the box, handed to `psql` as a variable, and written straight into the
mode-600 deploy `.env`. It is never typed, never echoed and never leaves the box.

```bash
( set -euo pipefail
  cd /opt/hmis-prod
  test "$(stat -c %a .env)" = 600
  if grep -q '^API_DATABASE_URL=' .env; then echo 'API_DATABASE_URL is already in .env — §3a was done; go to §3b'; exit 1; fi
  APP_PW="$(openssl rand -hex 32)"
  $C exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -v app_pw="$1"' _ "$APP_PW" <<'SQL'
CREATE ROLE hmis_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 60 PASSWORD :'app_pw';
SQL
  DB_NAME="$(grep '^POSTGRES_DB=' .env | cut -d= -f2-)"
  printf 'API_DATABASE_URL=postgres://hmis_app:%s@db:5432/%s\n' "$APP_PW" "$DB_NAME" >> .env
  test "$(stat -c %a .env)" = 600
  echo "role created; API_DATABASE_URL lines in .env: $(grep -c '^API_DATABASE_URL=' .env)" )
```

It must end `API_DATABASE_URL lines in .env: 1`. It runs in a subshell, so a failed check stops it
without closing your terminal, and the password dies with the subshell. The `.env` line is written
only after the role exists, so a failure part-way leaves the API exactly as it was. (Nothing reads
the new line until §3d recreates the API — do §3b first.)

### 3b · The grants (idempotent — safe to re-run after any deploy)

```bash
$C exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1' <<'SQL'
-- Reach the database and its schema.
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hmis_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO hmis_app;

-- Every table and sequence that exists now: ordinary DML, no TRUNCATE, no REFERENCES, no TRIGGER.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hmis_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO hmis_app;

-- Every table and sequence a FUTURE migration creates. The migrator runs as the owner
-- (current_user here), so its new objects are granted automatically and a deploy never
-- ships a table the API cannot read.
DO $$ BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hmis_app', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO hmis_app', current_user);
END $$;

-- THE AUDIT TABLES: read and append, nothing else. Privileges on a partitioned table are
-- checked on the PARENT, so the API inserts through `events` and needs nothing on a partition;
-- existing partitions are stripped so no month can be addressed directly. (A month the worker
-- creates later inherits the default grant above, and its cloned `events_append_only` trigger
-- still refuses every UPDATE and DELETE on it; TRUNCATE is never granted. Re-running this block
-- after a deploy strips those too.)
REVOKE UPDATE, DELETE, TRUNCATE ON events, phi_access_log FROM hmis_app;
DO $$
DECLARE p regclass;
BEGIN
  FOR p IN SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'public.events'::regclass LOOP
    EXECUTE format('REVOKE ALL ON %s FROM hmis_app', p);
  END LOOP;
END $$;
SQL
```

### 3c · Verify the grants (read-only)

```bash
$C exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X' <<'SQL'
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = 'hmis_app';
SELECT t AS "table",
       has_table_privilege('hmis_app', t, 'INSERT')   AS ins,
       has_table_privilege('hmis_app', t, 'UPDATE')   AS upd,
       has_table_privilege('hmis_app', t, 'DELETE')   AS del,
       has_table_privilege('hmis_app', t, 'TRUNCATE') AS trunc
  FROM unnest(ARRAY['events', 'phi_access_log', 'patients', 'invoices']) AS t;
SQL
```

Expected: `hmis_app | f | f | f | f`; `events` and `phi_access_log` → `t f f f`; `patients` and
`invoices` → `t t t f` (invoices are still append-only by their own trigger).

### 3d · Restart the API on the new role

`env_file` is read when a container is created, so the API is **recreated**, not restarted. Only the
API: the worker and the database are untouched.

```bash
$C up -d --no-deps --force-recreate api
sleep 20
$C ps api
curl -fsS https://hmis.crkmch.com/api/health; echo
$C logs --since 2m api | grep -c 'a SUPERUSER' || true
$C exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "SELECT usename, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1 ORDER BY 1"'
```

Expected: `api` healthy; `/api/health` answers `"db":"ok"`; the SUPERUSER count is **`0`**; the
activity list shows `hmis_app` (the API's pool) beside `hmis` (the worker).

Then walk one desk: log in, open a patient, register a walk-in or print a token slip. Any
`permission denied for …` in `$C logs --since 10m api` is a grant §3b missed — **roll back (§6)
first, then report the table name**; do not widen grants by hand on the live box.

**Measured before this page shipped** (dev cluster, a throwaway role and database, dropped after):
the §3b grants applied; as the app role an event INSERT and a PHI-log INSERT succeeded, UPDATE /
DELETE / TRUNCATE on both were `permission denied`, `CREATE TABLE`, `ALTER TABLE … DISABLE TRIGGER`
and `SET session_replication_role` were refused; the owner still created and dropped a monthly
partition; and the compiled API booted on the app role, served `/health` `db: ok`, wrote
`auth.login_failed` to `events`, and printed no SUPERUSER warning (the same build on the owner role
printed it). The shell and SQL blocks of §2, §3a–§3c, §4, §5 and §6 were then run as written against
a scratch database (role renamed, `docker exec` for `$C exec -T db`): every one succeeded with the
expected output, and §5's block refused with its two variables unset.

### After later deploys

Nothing is required: the migrator is the owner, so default privileges grant the API every new table
and sequence. Re-running §3b is harmless and also strips the months the worker created since.

---

## 4 · The print relay's grant (M-10)

The migration granted `front_desk_a4, front_desk_thermal, pharmacy_thermal, vitals_thermal` (plus
any older destination in its history) to **every agent that has claimed a print job still on record**
(printed jobs keep their claimer for the 90-day print-job window), and **nothing** to every other
agent. See the migration's header for why that is the least surprising default.

```bash
$C exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X' <<'SQL'
SELECT name, print_destinations, kill_switch, created_at FROM agents ORDER BY name;
SQL
```

Expected: the site's relay (one per site, owner ruling 2026-09-04) with the four destinations; every
other agent `{}`. **If the relay shows `{}`** (it had printed nothing in 90 days), its next poll is
refused `403 print_relay_not_registered` — grant it now.

**Narrowing (recommended, not required).** A relay should hold only the destinations its own
`/etc/hmis-print-relay.json` `queues` map to a printer. The command below grants the four declared
ones to the single agent that currently holds a grant, and refuses unless exactly one does; **delete
from `AGENT_PRINT_DESTINATIONS` every destination the relay's `queues` do not list** before running
it. The list REPLACES the grant; an empty list revokes it.

```bash
RELAY="$($C exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "SELECT name FROM agents WHERE cardinality(print_destinations) > 0"')"
test "$(printf '%s\n' "$RELAY" | grep -c .)" = 1
$C run --rm -e AGENT_NAME="$RELAY" -e AGENT_PRINT_DESTINATIONS=front_desk_a4,front_desk_thermal,pharmacy_thermal,vitals_thermal \
  api node dist/scripts/set-agent-print-destinations.js
```

The relay logs a claim that is partly outside its grant: the response carries
`refusedDestinations`, and only the granted part is claimed. A claim entirely outside it is
`403 print_destination_not_granted`.

**A new relay** is created with its grant in one step: `AGENT_PRINT_DESTINATIONS=…` beside
`AGENT_NAME=…` on `scripts/create-agent.js` (`docs/superpowers/2026-09-06-RUNBOOK-print-relay-go-live.md` §3).

---

## 5 · Device heartbeats (L-08)

`POST /ops/interfaces/:id/heartbeat` now accepts a beat only from the agent bound to that device
(`interfaces.agent_id`). A person gets `403 heartbeat_agent_only`, another agent `403
heartbeat_agent_mismatch`, and a device with no agent bound `403 interface_agent_unbound`. A device
that never beats stays `unknown`, which the sweep never downs — so nothing is falsely alarmed.

```bash
$C exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X' <<'SQL'
SELECT id, name, kind, agent_id, status, last_seen_at, active FROM interfaces ORDER BY seq;
SQL
```

Expected at stage 1: every row `agent_id` empty and `last_seen_at` empty (no device has ever
heartbeated — the print relay does not). **Nothing to do.**

If a row HAS a recent `last_seen_at`, a device agent was heartbeating it and is now refused. Bind it
to that agent (both values from the two listings above; the block refuses if either is not found):

```bash
$C exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -v iface_id="$1" -v agent_name="$2"' _ "$IFACE_ID" "$AGENT_NAME" <<'SQL'
SELECT set_config('bind.iface', :'iface_id', false), set_config('bind.agent', :'agent_name', false);
DO $$
DECLARE a text; n int;
BEGIN
  SELECT id INTO a FROM agents WHERE name = current_setting('bind.agent');
  IF a IS NULL THEN RAISE EXCEPTION 'no agent named %', current_setting('bind.agent'); END IF;
  UPDATE interfaces SET agent_id = a WHERE id = current_setting('bind.iface');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'no interface %', current_setting('bind.iface'); END IF;
END $$;
SQL
```

(`IFACE_ID` and `AGENT_NAME` are set in the shell first; unset, the block refuses.) A NEW device is
registered already bound: `POST /ops/interfaces` with `agentId` in the body.

---

## 6 · Rollback

§3 only: remove the key and recreate the API — it is back on the owner role at once.

```bash
cd /opt/hmis-prod && sed -i '/^API_DATABASE_URL=/d' .env && test "$(stat -c %a .env)" = 600
$C up -d --no-deps --force-recreate api
```

The role and grants may stay; they are inert without the key. The migration's triggers and columns
are **not** rolled back (migrations are additive and forward-only); the old image runs on the new
schema, with the append-only triggers still in force.

---

## 7 · What this does not cover

- **The owner role is still a superuser.** The worker, the migrator and operator one-offs keep full
  power; a compromise of the worker or of the box is out of scope for M-07's API half.
- **TRUNCATE and DROP of the audit tables** are stopped for the API by §3 (it holds neither), not by
  the triggers — row triggers do not fire on TRUNCATE or DDL, and the retention sweep's partition
  DROP depends on that.
- **The PHI-log floor is 1094 days by the database clock.** Shortening `PHI_ACCESS_RETAIN_DAYS`
  (1095) is refused by the trigger; it needs a migration.
- **UAT** (`-p hmis-uat`, both compose files) takes the same steps if it should match production.
