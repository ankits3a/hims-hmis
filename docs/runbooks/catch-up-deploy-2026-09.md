# The catch-up deploy — production, September 2026

**Written for `origin/main` @ `dc2bedc` on 2026-09-06 (Phase 11i T7). Every number below was
measured, not remembered.** The owner runs this. No agent deploys production and none ever will:
the classifier blocks it and `CLAUDE.md` forbids it.

**Status: NOT YET RUN.** When it is run, date this line and fill in §11.

---

## What this deploy is

Production last deployed on **2 September** at `c11833d`. Since then:

| | measured at `dc2bedc`, 2026-09-06 |
|---|---|
| commits | **82** |
| migrations applied on production | **56** (`0000`–`0055`, watermark `0055_drawer_session_indexes`, `when = 1788351286473`) |
| migrations in the candidate's journal | **78** |
| pending | **22** — `0056_pharmacy_dispense` … `0077_radiology_outside_studies` |
| whole modules production has never had | **pharmacy**, **aerb** |
| SPA routes | **47 → 53**: six added, **none deleted** |
| environment keys added | **none** (`docker/prod/.env.prod.example` at the tip and at `c11833d` declare the same keys) |

The six new routes: `/appointment`, `/counter/figures`, `/lab/reports`, `/pharmacy/counter`,
`/pharmacy/items`, `/radiology/radiation-safety`.

**No route production serves today is deleted by this deploy** — measured, and it is only true
because 11i T9 put three forwarding addresses in the tip. `/counter/seat`,
`/counter/seat/figures` and `/opd/vitals/bay` were deleted on `main` and now redirect to
`/counter`, `/counter/figures` and `/opd/vitals`, carrying the query string, for one release.
**`/opd/vitals` is not a new path but it is a new screen**: Bay One replaced the old vitals form
behind the same URL.

## What can go wrong, and what you do about it

**There is now a way back.** Every image this deploy builds is tagged with its short SHA beside
`:latest`, and step 2b tags what is *currently* running as `c11833d` before anything is rebuilt.
`HMIS_DEPLOY_ROLLBACK_TO=c11833d bash docker/prod/deploy.sh` retags and restarts **without
building and without migrating** — old code on the new schema, which additive migrations permit by
rule. Step 9 is that command written out even though you will probably never run it.

**The one thing a backout cannot undo** is a row the new code wrote while it was serving. Step 4's
window names them.

---

## 0. Before you start

### (0) The tip

    git fetch origin && git log --oneline -1 origin/main

Write the SHA into §11. The tip must include **#108** (18a-iii T4, merged 2026-09-06 06:35 UTC as
migration `0077`). Until it merged, `recordAcquired` wrote an AERB dose row for an *outside* study
on an ionising type — a statutory register with a fabricated row in it. Any tip at or after
`f211075` satisfies this.

**The rule that generalises it.** A lane that finds a defect production must not be deployed
without puts the **`deploy-blocker`** label on the fixing PR. **No deploy takes a tip while one is
open.**

    gh pr list --label deploy-blocker --state open

**Expected: no rows.** If there are rows, stop and read them.

### (0b) The one open item that is *not* a deploy-blocker, and why

**17-E T7 — an analyser rerun auto-supersedes a verified result**, which D9 forbids
(`lab/ingest.ts` writes `entry_mode='interface'` into a path `results.ts` auto-supersedes). It is
**not** labelled `deploy-blocker` because it is not reachable by any actor at this tip: it needs a
configured analyser interface, and production has no analyser. Under the classification rule it is
a **census row**, not a blocker. It becomes a blocker the day the first analyser is configured —
which is the laboratory's stand-up, not this deploy.

### (0c) The environment diff

    diff <(git show c11833d:docker/prod/.env.prod.example | grep -oE '^[A-Z_]+=' | sort) \
         <(git show origin/main:docker/prod/.env.prod.example | grep -oE '^[A-Z_]+=' | sort)

**Expected: no output.** Measured 2026-09-06: no key difference. This step exists so the first tip
that *does* add a key is not the first deploy that forgets it. If it prints anything, add the key
to `/opt/hmis-prod/.env` **before** step 3.

### (0d) The label

    gh label list --limit 200 | grep deploy-blocker

**Expected:** one row, `deploy-blocker  A fix production must not be deployed without…  #B60205`.
Created 2026-09-06 by 11i T7; if it is missing, `gh label create deploy-blocker --color B60205`.

---

## 1. What production is actually at

    docker exec hmis-prod-db-1 psql -U hmis -d hmis -qAt \
      -c "select count(*) from drizzle.__drizzle_migrations"

**Expected: `56`.**

    docker exec hmis-prod-db-1 psql -U hmis -d hmis -qAt \
      -c "select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1"

**Expected: `1788351286473`** — the `when` of `0055_drawer_session_indexes`. That number is the
**watermark**: drizzle applies only journal entries strictly greater than it. If either answer
differs from these, **stop** and say so before anything else — this whole runbook is written
against 56.

---

## 2. Prove the backups restore, before touching anything

    tail -20 /opt/hmis-prod/log/restore-drill.log

**Expected:** a `DRILL PASSED` block, dated within the last seven days.

Last read 2026-09-06: **PASSED 2026-09-05 22:00 UTC** — backup 33 s, restore 3 s, 498 events
restored and read back out of a scratch cluster, `backup.drill_passed` appended.

> **This is the one step this runbook refuses to skip.** A deploy onto a database whose backups
> have not been proven to restore is a deploy with no floor under it. If the newest PASSED block is
> older than a week, run the drill first:
> `bash /opt/hmis-prod/drill/restore-drill.sh` — it takes about a minute and it restores for real.

### (2a) The migration rehearsal — the drill, pointed at the candidate

Build the candidate images **without deploying them**, then run the drill against last night's
copy of production with the candidate's migrator:

    cd /opt/hmis
    git fetch origin && git pull --ff-only        # deploy.sh refuses any HEAD but origin/main
    SHA=$(git rev-parse --short HEAD)
    docker build --tag "hmis-prod/server:$SHA" .  # the BUILD half only: no migrate, no restart

    HMIS_DRILL_SERVER_IMAGE="hmis-prod/server:$SHA" HMIS_DRILL_REHEARSAL=1 \
      bash /opt/hmis-prod/drill/restore-drill.sh

**Expected transcript, in order:**

- `5/7 the migrator's own consistency check` … `migrations applied`
- `5b/7 REHEARSAL — the deploy's seeds, its gate, and the census, against the restored copy`
  — twelve `rehearsing seed-*.js` lines, then `seed:roles`, then
  `config-present: ok=true problems=0`
- `standup:check all` printing its rows — **its RED lines are a preview of step 3's**
- `candidate image hmis-prod/server:<sha> declares 78 migrations in its journal`
- `rehearsal: all 78 of the candidate's migrations are applied on the restored copy` — an
  **equality**, not a `>=`: a half-applied journal must not pass a rehearsal
- `7/7 drop the scratch database` … `DRILL PASSED`
- `verdict: passed — appending backup.drill_rehearsed (a rehearsal is not a drill)`

**A rehearsal that fails stops this runbook here.** The failing migration is fixed on `main` by
the lane that owns it — **never by hand on production**. Nothing about production has changed at
this point: the drill restores into a scratch container and destroys it on every exit path.

> Do not run this inside **22:00–23:00 UTC on a Saturday**: that is the weekly drill's own hour and
> the two would compete for this box's memory and its docker daemon.

### (2b) Tag what is running now, so there is somewhere to go back to

**Before anything is rebuilt:**

    docker tag hmis-prod/server:latest hmis-prod/server:c11833d
    docker tag hmis-prod/web:latest    hmis-prod/web:c11833d
    docker tag hmis-prod/db:latest     hmis-prod/db:c11833d
    docker images | grep c11833d

**Expected:** three rows. From here on, `HMIS_DEPLOY_ROLLBACK_TO=c11833d` is the way back and
step 9 is the command. Every deploy after this one tags its own SHA automatically (11i T8), so
this hand step is needed exactly once.

### (2c) Rehearse 18c's licence gate on the bench that already exists

The AERB demo stack at `/opt/hmis-aerb-demo` exists for exactly this: API on `:3020`, database
`hmis_aerb_demo`, credentials in `/opt/hmis-aerb-demo/demo.env`, and `file-demo.sh` beside it.
Ionising acquisition refuses `device_not_licensed` from the moment `0060`–`0065` land, and that is
**the one behaviour-changing step in this batch**. Rehearsing it here costs nothing; meeting it for
the first time on production during the window costs the radiology department its morning.

**1. The gaps list, before anything is filed.**

    curl -s http://127.0.0.1:3020/aerb/licences/gaps -H "Authorization: Bearer $TOKEN"

**Expected:** a non-empty list — every ionising device with no active licence covering today. (Get
`$TOKEN` the way `file-demo.sh` does, from `POST /auth/login`; the demo's own credentials are in
`demo.env` and are not production's.)

**2. Start a CT acquisition on the demo.** **Expected:** refused, and the refusal reads
`device_not_licensed`. **This is the behaviour production gains.**

**3. File the four demo certificates.**

    bash /opt/hmis-aerb-demo/file-demo.sh

**Expected:** each `POST /aerb/persons` and `POST /aerb/licences` answers. Every number it writes
carries `DEMO`, and it writes only to `hmis_aerb_demo` — never to production.

**4. The gaps list again.**

    curl -s http://127.0.0.1:3020/aerb/licences/gaps -H "Authorization: Bearer $TOKEN"

**Expected: empty.** That is 18c §0's own check, and watching it go from non-empty to empty is what
tells you the licence gate can be satisfied at all.

Record what you saw in §11. Do not narrate it from this page.

---

## 3. The census, before

    cd /opt/hmis-prod
    docker compose -p hmis-prod -f docker-compose.prod.yml --project-directory . \
      run --rm api node dist/scripts/standup-check.js all

Read-only; it writes nothing. **Its RED rows are the to-do list, not blockers.** They will name the
LAB department that does not exist, the four lab role keys nobody holds, the catalogue that has not
been loaded, the pharmacy stock that has not been received, and the AERB licences you may not yet
hold. Keep the output; step 6 compares against it.

You will also see `NOT MODELLED` rows. Those are facts the schema does not hold at all — the phone
number the bench rings at 02:00, the report-ready SMS, the printer registry. Each names the runbook
section a human performs instead. **They are not failures and they never go green.**

---

## 4. The deploy, in a declared window

**Declare the window first.** From `/ops/mode`, set **`degraded`** with a note naming radiology and
the expected duration. The window's record is the mode ledger's own row.

    cd /opt/hmis && bash docker/prod/deploy.sh

It builds three images, tags them `:latest` **and** `<sha>`, snapshots the outgoing configs into
`/opt/hmis-prod/previous/`, migrates, seeds, gates, prints the census, brings the stack up and runs
the edge gate. **Expected: `8/8` and a green edge gate.**

**Then, inside the window, radiology:** every ionising machine's licence filed from the real
certificates at `/radiology/radiation-safety`, until

    GET /aerb/licences/gaps

is **empty**. Then set the mode back to **`normal`**. Target: under an hour.

**If you do not yet hold the certificates,** the ionising devices stay refused after the window.
That is recorded as a RED census row and **it is not a blocker** — radiology is not open. Say so in
§11 rather than leaving it to be discovered.

**What the new code can write inside the window** — the rows a rollback cannot undo:
`aerb_licences` (the licences you file in this step), `print_jobs`, and any `pharmacy_*` row. None
of them exists until a human acts, and in this window only the first is likely.

---

## 5. Tell the people who use it

- **Three bookmarks still work and now forward:** `/counter/seat` → `/counter`,
  `/counter/seat/figures` → `/counter/figures`, `/opd/vitals/bay` → `/opd/vitals`. Tell the desk to
  **hard-refresh** (Ctrl-Shift-R) and then follow their bookmark. **Expected:** it lands on the new
  screen with whatever was in the URL intact. Tell them to re-save the bookmark where it lands —
  these forwards are removed one release after the laboratory opens.
- **`/opd/vitals` is the same address and a different screen.** Bay One replaced the old vitals
  form. Nobody has to change a link; everybody sees a new layout.
- **The UHID series moves.** Migration `0057` moves the UHID sequence to `11001` behind a guard on
  the sequence's current value, so the first patient registered after this deploy may carry a
  number from a different series. Step 2a's rehearsal showed which branch runs on production's own
  data — say which, and tell the desk before they see it.

---

## 6. The census, after

    docker compose -p hmis-prod -f docker-compose.prod.yml --project-directory . \
      run --rm api node dist/scripts/standup-check.js all

**Expected, compared with step 3:** the **G2** rows have gone green *by the deploy alone* — the
lab's two definitions and its approval type, the pharmacy's `PHARM-OPD` store and its dispense
definition, `patient_merge`, the billing and GST configuration. The G3 and G4 rows are still RED
and that is correct: no deploy hires a pathologist or types in a catalogue.

**One G2 row will still be RED and it is a known finding, not a failure:**
`radiology.radiology_study_types_active`. `seed-radiology.js` exists in the tree and `deploy.sh`
does not run it, so radiology's Class-C definition is established by no deploy — the same defect
11i T1 closed for the lab. It is the radiology lane's to fix.

**Three things that must be unchanged.** A seed must never touch a CA-signed row:

    docker exec hmis-prod-db-1 psql -U hmis -d hmis -qAt \
      -c "select count(*), max(updated_at) from gst_config"

**Expected:** the same count and the same `updated_at` as before the deploy. Take that reading in
step 1 as well as here.

    docker exec hmis-prod-db-1 psql -U hmis -d hmis -qAt \
      -c "select series_key, fy, next_no from document_series order by series_key, fy"

**Expected:** the same rows, with the same `next_no`, as before the deploy. The series rolls on the
IST financial year and a deploy is not a financial year. (An empty result is also correct and means
no invoice has ever been issued — take the same reading in step 1 so you are comparing something.)

And the migration count:

    docker exec hmis-prod-db-1 psql -U hmis -d hmis -qAt \
      -c "select count(*) from drizzle.__drizzle_migrations"

**Expected: `78`** — equal to the candidate's journal, the same equality step 2a rehearsed.

---

## 7. Close PR #73

    gh pr close 73 --comment "Superseded by the catch-up deploy of <date>: production is at <sha>."

#73 is a hotfix branch that exists only because a rebuild from the deployed base was refused by
`deploy.sh` itself. That refusal is now scoped to the build path and the backout is
`HMIS_DEPLOY_ROLLBACK_TO`, so the branch has nothing left to do.

---

## 8. The edge gate

`deploy.sh` step 8/8 runs it: `/api/health` as JSON **through Caddy over HTTPS on the real
hostname**, and a screen path served as HTML. **Expected: both green.** If it fails, the stack is
up and the edge is not — that is a Caddy or certificate problem, not a migration problem, and
step 9 will not help.

---

## 9. The backout — written as a command even though you will probably never run it

    HMIS_DEPLOY_ROLLBACK_TO=c11833d bash /opt/hmis/docker/prod/deploy.sh

**Expected:**

- `1/8 ROLLBACK — retagging :latest from c11833d. Nothing is built and nothing is migrated`
- three `hmis-prod/*:latest now points at c11833d` lines
- `restored the previous compose file, caddy/ and prometheus/ from /opt/hmis-prod/previous`
- `5/8 ROLLBACK — NO MIGRATION, NO SEED, NO GATE (D13)`
- the stack restarts and the step-8 edge gate runs again

If it refuses with `no image hmis-prod/server:c11833d on this host`, **step 2b was not done.** The
images are gone and there is no way back through this path; say so immediately rather than
improvising.

**What a rollback cannot undo:** the rows in §4's list, written by the new code while it was
serving. The schema stays at 78 migrations — that is the design, and it is why the backout is
*old code on the new schema* rather than a downgrade.

---

## 10. What this runbook deliberately does not do

- **Open a department.** The census names what each one still needs; the laboratory's own runbook
  (`lab-go-live.md`) is the ordered list, and 11i T6 executes it on UAT first.
- **Create a user, assign a role, or load a catalogue.** Those are the owner's and the department
  head's acts, at `/admin/users` and through `POST /lab/catalogue/*`.
- **Touch `validate:config`, the CA signature or the tariff.** Leaving `commissioning` is a
  separate, hospital-wide act (O6).
- **Automate anything.** Production is deployed weekly, by a hand, from this page.

---

## 11. Executed on — **NOT YET RUN**

Fill this in as you go. A step performed and not recorded is a step nobody can check.

| step | what you saw | when |
|---|---|---|
| (0) tip SHA | | |
| (0) `deploy-blocker` open PRs | | |
| (0c) env diff | | |
| (1) applied count / watermark | | |
| (2) drill log date | | |
| (2a) rehearsal: restored = candidate journal | | |
| (2b) `c11833d` tags | | |
| (2c) 18c bench: refusal, then gaps empty | | |
| (3) census before — RED rows | | |
| (4) window declared / deploy 8/8 / gaps empty / mode normal | | |
| (5) desk told: bookmarks, `/opd/vitals`, UHID series | | |
| (6) census after / `gst_config` unchanged / next invoice no. / migrations = 78 | | |
| (7) #73 closed | | |
| (8) edge gate | | |
| (9) rollback needed? | | |

---

## 12. After the deploy: the two demo stacks retire — and not before

**Added by 11i T3. Do this only once step 2c has been performed**, because step 2c is what the AERB
bench exists for. Retiring it first would destroy the instrument this runbook sends you to.

This box has 15 GB and now carries three stacks beside production. UAT replaces both ad-hoc ones:

    docker stop hmis-preview-caddy      # the front-desk preview on :8443 — UAT takes that port
    docker stop hmis-aerb-demo-caddy    # the 18c bench, AFTER step 2c has used it

**Expected:** `:8443` free, so `HMIS_TARGET=uat bash docker/prod/deploy.sh` can take it.

**The directories stay.** `/opt/hmis-preview` and `/opt/hmis-aerb-demo` hold the demo passwords and
a `demo.env`; they are yours to delete when you are sure you want to, and no script here removes
them. `preview.sh` is not in this repository — it lives in `/opt/hmis-preview` — so nothing in the
tree needs deleting either.

**What UAT gives you that they did not:** the production image, the production deploy path, a
database that is reset to a clean training day with one command (`/opt/hmis-uat/uat-reset.sh`), and
a banner on every screen saying which box you are looking at.
