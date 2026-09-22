# The catch-up deploy — production, September 2026

**Status: EXECUTED 2026-09-14. Production is live on `8fe7a78c`, migrations 78 → 85. See §11 for
what actually happened** — including the rehearsal that passed, the two near-misses worth knowing,
and the `deploy.sh` passphrase fix, which has since **landed** (§11 — do not reimplement it).

Written for `origin/main` @ `dc2bedc` on 2026-09-06 (Phase 11i T7); the run went out at a much later
tip. The owner runs this. No agent deploys production and none ever will: the classifier blocks it
and `CLAUDE.md` forbids it.

**IF YOU ARE HERE FOR A LATER DEPLOY: no number on this page is yours.** Re-read production's
watermark at §1 and the candidate's journal out of the image at §2a. This page once carried an
acceptance gate stated as an equality against a remembered count, and a `docker run` naming a
prebuilt image — an operator following it after the September train would have deployed a tip from
before fourteen merged PRs with every gate reading green. Both lines are gone; the habit that
produced them is what §1's **MEASURE, DO NOT ASSUME** is for.

---

## What this deploy is

Production last deployed on **2026-09-06 at `399f92c`** — the accidental deploy of 12:35 UTC, from
an unmerged commissioning branch. The 2 September `c11833d` deploy this runbook was originally
written against **is no longer what is running, and its images no longer exist on the daemon.**
Since then:

> **THIS RUN IS DONE — see §11. The table below is HISTORY, not instructions.** It was measured at
> `dc2bedc` on 2026-09-06, and the deploy actually executed on 2026-09-14 at `8fe7a78c`, taking
> production 78 → 85.
>
> **If you are here for a LATER deploy, every number on this page is a measurement with a date on
> it and none of them is yours.** Re-read production's watermark at §1 and the candidate's journal
> out of the image at §2a. That is not caution, it is the defect this page shipped with: it once
> carried an equality gate against a remembered count and a `docker run` naming a prebuilt image,
> and an operator following it would have deployed a tip from before fourteen merged PRs with every
> gate reading green.

| | measured at `dc2bedc`, 2026-09-06 — **superseded by §11, which records the run** |
|---|---|
| commits | **82** |
| migrations applied on production | **56** as of 2026-09-05 — **STALE, re-read it at §1**: the 12:35 deploy on 09-06 applied more |
| migrations in the candidate's journal | read it from the image — it was **85** at `8fe7a78c` on the day |
| pending | **whatever §1 reads, subtracted from the image's own journal length** — do not carry a number down from here |
| whole modules production has never had | **pharmacy**, **aerb** |
| SPA routes | **47 → 53**: six added, **none deleted** |
| environment keys added | **none** — `docker/prod/.env.prod.example` declares the same keys at the tip, at `399f92c` (what is running) and at `c11833d`; verified against both bases |

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
`:latest`, and what is *currently* running already carries its own SHA tag.
`HMIS_DEPLOY_ROLLBACK_TO=<sha> bash docker/prod/deploy.sh` retags and restarts **without
building and without migrating** — old code on the new schema, which additive migrations permit by
rule. Step 9 is that command written out even though you will probably never run it.
**`<sha>` is read off the daemon, never off this page** — §9's loop names the targets that are
actually resident, because a SHA written into a runbook outlives the image it names. This line
used to hardcode `399f92c`, and by 2026-09-22 there were zero images at it.

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

    diff <(git show 399f92c:docker/prod/.env.prod.example | grep -oE '^[A-Z_]+=' | sort) \
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

**MEASURE, DO NOT ASSUME.** This runbook's original `56` was read on 2026-09-05, *before* the
accidental deploy of 09-06 applied migrations of its own. Whatever this query answers is the
watermark; subtract it from **the candidate image's own journal length** to get what is pending.
**Do not carry a number down from this page.** On 2026-09-14 that arithmetic was 85 − 78 = 7.

    docker exec hmis-prod-db-1 psql -U hmis -d hmis -qAt \
      -c "select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1"

**MEASURE, DO NOT ASSUME.** The original `1788351286473` was the `when` of
`0055_drawer_session_indexes` and is stale for the same reason. Whatever this answers is the
**watermark**: drizzle applies only journal entries strictly greater than it. Record both answers
here before continuing — this whole runbook is written
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
    docker build --tag "hmis-candidate/server:$SHA" .   # the BUILD half only: no migrate, no restart

    HMIS_DRILL_SERVER_IMAGE="hmis-candidate/server:$SHA" HMIS_DRILL_REHEARSAL=1 \
      bash /opt/hmis-prod/drill/restore-drill.sh

> **`hmis-candidate/`, not `hmis-prod/`.** Nothing enforces this — a candidate in the prod namespace
> is *not* rollback-targetable, because `HMIS_DEPLOY_ROLLBACK_TO` requires **all three** of
> `server`, `web` and `db` at that tag and this builds only `server`, so a rollback to it refuses by
> name. It is a naming discipline, not a guard: it keeps `hmis-prod/*` meaning "images that have
> actually served".
>
> **On `HMIS_DRILL_STANZA` / `HMIS_DRILL_REPO_PATH`:** the script's header says a rehearsal sets both
> at a scratch prefix, and that instruction is aimed at **a lane**, not at this runbook. Run here, by
> the operator, against production's own repository, the rehearsal restores the same backup the
> weekly drill does — which is the point. A lane rehearsing must not.

**Expected transcript, in order:**

- `5/7 the migrator's own consistency check` … `migrations applied`
- `5b/7 REHEARSAL — the deploy's seeds, its gate, and the census, against the restored copy`
  — twelve `rehearsing seed-*.js` lines, then `seed:roles`, then
  `config-present: ok=true problems=0`
- `standup:check all` printing its rows — **its RED lines are a preview of step 3's**
- `candidate image <tag> declares N migrations in its journal` — **N is whatever the image says.**
  This line used to name a number measured at a SHA, and a number in a runbook is a claim about a
  moment. Read it from the image you just built and compare it to nothing in this file.
- `rehearsal: all N of the candidate's migrations are applied on the restored copy` — an
  **equality**, not a `>=`: a half-applied journal must not pass a rehearsal. The equality is the
  gate; the number is not.
- `7/7 drop the scratch database` … `DRILL PASSED`
- `verdict: passed — appending backup.drill_rehearsed (a rehearsal is not a drill)`

**A rehearsal that fails stops this runbook here.** The failing migration is fixed on `main` by
the lane that owns it — **never by hand on production**. Nothing about production has changed at
this point: the drill restores into a scratch container and destroys it on every exit path.

> Do not run this inside **22:00–23:00 UTC on a Saturday**: that is the weekly drill's own hour and
> the two would compete for this box's memory and its docker daemon.

### (2b) The way back already exists — **DO NOT RUN THE OLD TAG COMMANDS**

> **THIS STEP USED TO SAY: `docker tag hmis-prod/server:latest hmis-prod/server:c11833d`, and two
> more like it. DO NOT. Those commands SUCCEED and print exactly the three rows the step told you to
> expect — while labelling the 2026-09-06 accidental build as the 2 September pre-incident base.**
> Step 9 would then "roll back" to a tag that is not what it says it is, on a hospital, with nothing
> anywhere reporting a substitution. **This is the failure mode a runbook cannot afford: a check that
> passes because the operator did what it asked.**
>
> Verified on this box, from `docker images` alone — no production access needed:
>
>     hmis-prod/server   latest = 399f92c = sha256:ede6226225f5
>     hmis-prod/web      latest = 399f92c = sha256:942cd826bfe8
>     hmis-prod/db       latest = 399f92c = sha256:f5344ea35a4f
>     docker images | grep -c c11833d   ->  0

**Nothing to do here. But CHECK THE TRIPLE BY NAME, NOT BY ROW COUNT:**

    docker image inspect hmis-prod/server:<sha> hmis-prod/web:<sha> hmis-prod/db:<sha> >/dev/null \
      && echo "COMPLETE — HMIS_DEPLOY_ROLLBACK_TO=<sha> will be accepted" \
      || echo "INCOMPLETE — deploy.sh will REFUSE this target by name"

**Expected:** `COMPLETE`. That is exactly what `HMIS_DEPLOY_ROLLBACK_TO` requires: `deploy.sh`'s
`IMAGE_REPOS` is `$IMAGE_NS/{server,web,db}` and step 1/8 `docker image inspect`s each one in turn,
refusing **by name** if any is missing — so the check has to ask the same question, per repository.

> **THIS STEP USED TO SAY `docker images | grep <sha>` AND READ THE ROW COUNT. DO NOT.** It is the
> same false-pass shape as the retag commands above: a check that passes because the operator did
> what it asked. `grep` matches on the whole line, so the **candidate** namespace counts towards the
> total, and a repository that is missing the tag altogether can still be made up for by one that
> has it twice. Measured on this box **2026-09-22**: `docker images | grep b9485337` prints
> **three** rows — but they are `hmis-candidate/server`, `hmis-prod/server` and `hmis-prod/web`.
> There is **no `hmis-prod/db:b9485337`**, so `HMIS_DEPLOY_ROLLBACK_TO=b9485337` dies at 1/8 with
> `no image hmis-prod/db:b9485337 on this host` — the three-row pass was a lie about the only thing
> the step exists to establish. A count answers "how many things are named this"; the rollback asks
> "is each of these three repositories tagged", and only `docker image inspect` asks that.

**`399f92c` ITSELF IS GONE — read the live target off the daemon, §9 has the loop.** Verified
2026-09-22: zero images at that SHA, pruned by `HMIS_SHA_TAGS_KEPT`. The paragraph below is the
September record of what the backout meant *on the day*, not a live instruction.

**AND BE CLEAR WHAT IT ROLLED BACK TO, ON 2026-09-06.** `399f92c` was **that day's production —
the accidental build**. It was a real, working backout for *that* deploy: it returned the box to
the state it was already in. **It was never a way back to pre-incident code.** The `c11833d`
images were overwritten at 12:35 on 2026-09-06 and there were no dangling images; rebuilding that
tip from source and deploying it is a different and much larger act than a retag, against a
database that has had migrations applied since.
**If someone asks for "a rollback to before the accident", the honest answer is that this path does
not offer one.**

Every deploy from 11i T8 onward tags its own SHA automatically, so no hand step is needed — this one
was written before that shipped and is now actively harmful.

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

**Three things that must be unchanged.** A seed must never touch a CA-signed row — and the check
below is the SECOND version of this step, because the first one was wrong in a way that produced a
false alarm on the very first deploy it met.

    docker exec hmis-prod-db-1 psql -U hmis -d hmis -qAt \
      -c "select category, exempt, updated_at from gst_config order by updated_at, category"

**Expected:** every category that existed before the deploy carries **the same `updated_at` it had
in step 1**. New rows with the deploy's own timestamp are correct and expected — a deploy that
brings a module brings its GST categories with it. Take the same reading in step 1 and compare
ROW BY ROW.

> **Why not `count(*), max(updated_at)`, which is what this step used to say.** That pair cannot
> answer the question. `max()` over a table that gained a row moves by construction, so a correct
> deploy fails the check — and a reader who has no *before* count reads "the count is 8 and the
> timestamp moved" as *something rewrote the slabs*. That is exactly what happened on 2026-09-06:
> five pre-existing categories were untouched at `2026-08-24 17:47:03`, three new ones
> (`pharmacy_exempt`, `pharmacy_5`, `pharmacy_18`) were created at `12:35:23`, and the aggregate
> reported an alarm about a table nothing had violated. `seed-tariff` skips a category that already
> exists (`if (haveCategories.has(cfg.category)) continue`) and its guard held perfectly.
>
> **An aggregate cannot tell you which row moved.** Read the rows.

    docker exec hmis-prod-db-1 psql -U hmis -d hmis -qAt \
      -c "select series_key, fy, next_no from document_series order by series_key, fy"

**Expected:** the same rows, with the same `next_no`, as before the deploy. The series rolls on the
IST financial year and a deploy is not a financial year. (An empty result is also correct and means
no invoice has ever been issued — take the same reading in step 1 so you are comparing something.)

And the migration count:

    docker exec hmis-prod-db-1 psql -U hmis -d hmis -qAt \
      -c "select count(*) from drizzle.__drizzle_migrations"

**Expected: equal to the candidate image's own journal length** — the same equality step 2a
rehearsed, and **read from the image, never from this page**:

    docker run --rm --entrypoint node "$CANDIDATE_IMAGE" \
      -e 'console.log(require("/app/apps/core/drizzle/meta/_journal.json").entries.length)'

*(On 2026-09-14 that was 85 and production went 78 → 85. Recorded in §11, not to be reused: the
next operator's answer is whatever their image says.)*

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

**READ THE TARGET OFF THE DAEMON. DO NOT TAKE A SHA FROM THIS PAGE.** This step used to carry
`HMIS_DEPLOY_ROLLBACK_TO=399f92c` written out as a runnable command, and on 2026-09-22 there were
**zero** images at that SHA — the command in the backout step was dead in the file, which is the one
place it cannot be. A SHA on this page rots; the daemon does not. The target is the newest
**COMPLETE** triple that `:latest` is not already pointing at:

    LIVE="$(docker image inspect --format '{{.Id}}' hmis-prod/server:latest)"
    for sha in $(docker images --format '{{.Tag}}' hmis-prod/server | grep -v '^latest$'); do
      if docker image inspect "hmis-prod/server:$sha" "hmis-prod/web:$sha" "hmis-prod/db:$sha" >/dev/null; then
        if [ "$(docker image inspect --format '{{.Id}}' "hmis-prod/server:$sha")" = "$LIVE" ]; then
          echo "COMPLETE   $sha  <- ALREADY LIVE. Rolling back here changes no code."
        else
          echo "COMPLETE   $sha"
        fi
      else
        echo "INCOMPLETE $sha  <- deploy.sh refuses"
      fi
    done

**The `ALREADY LIVE` marker is the whole point of the loop and it is why the inspect's stderr is
left on.** An earlier version of this step printed the live image's Id on a line of its own, below a
list that carried only tags — nothing in the output mapped one to the other, so an operator reading
it during an incident picks the FIRST `COMPLETE` row, which on 2026-09-22 was `:latest` itself. That
rollback prints all eight steps and every Expected bullet below in green while backing nothing out.
A check that passes because the operator did as it asked is the same false pass §2b exists to
remove; do not reintroduce it by "tidying" this loop back into a one-liner. For the same reason the
inspect is NOT redirected with `2>&1`: a daemon-level failure must read as `No such image: ...` on
your terminal, not be laundered into `INCOMPLETE` for every tag — which would march you straight
into "no COMPLETE row at all" below and out the wrong door.

`hmis-prod/server` is only the *enumerator* — the tags to try. Completeness is decided by the
inspect, because the three repositories are pruned independently and `server` having a tag says
nothing about `db` having it.

**A reading with a date on it, not your target — measured 2026-09-22:** `47b02dfb` COMPLETE but
**identical to `:latest`**; `61906e51` COMPLETE — the one real step back; `b9485337` **INCOMPLETE**
(server and web, no `db`) and refused by name. Your loop will print something else.

**Rolling back to the live SHA is not a no-op, and calling it one is how it gets chosen.** No code
changes, but `deploy.sh` still restores the previous compose file, `caddy/` and `prometheus/` from
`/opt/hmis-prod/previous` and restarts every service — so an incident ends with the stack bounced,
the config reverted to whatever preceded the CURRENT deploy, and the faulty code still serving.

    HMIS_DEPLOY_ROLLBACK_TO=<the newest COMPLETE sha that is not :latest> \
      bash /opt/hmis/docker/prod/deploy.sh

**Expected:**

- `1/8 ROLLBACK — retagging :latest from <sha>. Nothing is built and nothing is migrated`
- three `hmis-prod/*:latest now points at <sha>` lines
- `restored the previous compose file, caddy/ and prometheus/ from /opt/hmis-prod/previous`
- `5/8 ROLLBACK — NO MIGRATION, NO SEED, NO GATE (D13)`
- the stack restarts and the step-8 edge gate runs again

If it refuses with `no image hmis-prod/<repo>:<sha> on this host`, **stop — to re-read, not to
despair.** `deploy.sh` keeps `HMIS_SHA_TAGS_KEPT` (default three) SHA tags **per repository** and
prunes them independently, so by far the likelier cause is a target whose triple is incomplete, not
a daemon with nothing on it. The refusal even names the repository that is missing: take it and go
back to the loop above.

**The old text here said "there is then no way back through this path." Do not repeat it.** It was
false when checked on 2026-09-22 — two complete triples were resident while the SHA this step named
had none. Only if the loop prints **no COMPLETE row at all** is there genuinely no way back, and
then say so immediately rather than improvising a tag from `:latest`, which is how this step was
wrong in the first place.

**What a rollback cannot undo:** the rows in §4's list, written by the new code while it was
serving. The schema stays where the deploy left it — 85 after this run — because these migrations
are additive. That is the design, and it is why the backout is *old code on the new schema* rather
than a downgrade.

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

## 11. Executed — 2026-09-14

**This deploy ran and production is live on `8fe7a78c`.** Everything below is what happened, not
what was expected. The section above it is preserved as the procedure; this is the record.

### Provenance, because a runbook that does not say where its numbers came from is how this page
### acquired a stale one in the first place

| source | which figures |
|---|---|
| **verified in this repository** by the lane that wrote this page | the pinned tip, the journal length at that tip, which migrations are new |
| **recorded from the deploy transcript** run by the operating session | production's applied count, the edge gate, service count, image tags, backup label, census counts |

Nothing in the second row was re-measured by the author of this page, who held no production
access. If you need to re-confirm any of it, §1, §6 and §8 are the live queries.

### What ran

| step | what was seen |
|---|---|
| (0) tip | **`8fe7a78c`**, CI green on that exact commit. Fourteen PRs landed ahead of it |
| (2a) **rehearsal** | **PASSED** — `85 == 85` against the restored copy, `backup.drill_rehearsed` appended. **The first migration rehearsal this project has ever run** |
| (2b) way back | `399f92c` server/web/db — all three still on the daemon, none tagged by hand |
| recovery point | full backup **`20260914-083547F`**, taken **08:35:54**, minutes before the deploy |
| (4) deploy | 8/8, all **9** services up, `hmis-prod/server:8fe7a78c` == `:latest` |
| (1)/(6) migrations | **78 → 85**, watermark **`1789367343208`** |
| schema after | **7/7** `opd_queue_entries` parked/skip columns · **3/3** formulary release-tier tables |
| (8) edge gate | HTTP **200** `{"status":"ok","db":"ok","worker":"ok"}` through Caddy on the real host |
| (3)/(6) census | **55 rows, 29 red, 6 not modelled** — see below |
| (9) rollback | not needed |

### The census printed 29 red rows and that is correct

`standup:check`'s grammar is **every row is RED until an act makes it green**. 29 red on the day
after a deploy is a commissioning to-do list, not a fault list — the deploy establishes the G2 rows
and nothing else, and G3 (master data) and G4 (people) are hospital acts. **Do not read the red as
a failed deploy**, and do not let anyone roll back a healthy build over it.

### The two things that nearly went wrong, recorded because they will recur

1. **`HMIS_DRILL_REHEARSAL`, not `HMIS_DRILL_REHEARSAL_MODE`.** The plan wrote the longer name. The
   wrong name does **not** error — it runs an ordinary drill, which asserts `>=` and appends
   `drill_passed`. That would have produced a green transcript proving nothing, because `>=` also
   passes a half-applied journal. §2a has the correct name; do not "fix" it.
2. **The scratch-prefix instruction in `restore-drill.sh`'s own header is aimed at a LANE, not at
   this operator.** Line 301 takes an *incremental* backup, which needs a prior full in the same
   repository; a scratch prefix has none and fails. Run here, against production's own repository,
   the rehearsal restores the same backup the weekly drill does — which is the point.

### The mitigation that was applied, and the code fix it became — **LANDED, do not reimplement**

**What was found on 2026-09-13, in `deploy.sh` as it then stood — read this as the finding, not as
the current code:** `/opt/hmis-prod/.env.pgbackrest.pre-deploy-20260913` was taken before the
run. The then-`deploy.sh:542` derived that file with `cat > "$PGBR_ENV" <<EOF` — **truncate in
place** — and `PGBACKREST_REPO1_CIPHER_PASS` was the **last line written**, while the code
re-minted a passphrase whenever it read that key back empty. A kill inside that window left the
file without the passphrase, the next deploy minted a new one, and at that point **every backup
already in the object store would have been unreadable ciphertext, including by us.** The
script's own comment called it "the worst failure shape available here" and truncated in place
anyway.

The copy fully mitigated it for this run, and depended on somebody remembering to take it.

**THE CODE FIX HAS LANDED. Do not reimplement it.** Verified 2026-09-22 by content, not by SHA:
`/opt/hmis/docker/prod/deploy.sh` is byte-identical to the `origin/main` @ `47b02dfb` checkout
(both `sha256:647a9a50…`), and the block now reads the passphrase back, **dies** if the file
exists and carries an empty one, writes `$PGBR_ENV.tmp` under a `trap 'rm -f …' EXIT` so a live
credential cannot outlive a failure, `chmod 600`s it, and `mv -f`s it into place — one directory,
so a rename, so no window. **It landed larger than this section asked for:** refusing to mint over
a damaged file is the load-bearing half, and `.tmp` + `mv` only removes the window that makes that
case likely. The paragraphs above are kept as the record of how it was found — the `deploy.sh:542`
line number in them is from before the fix and points at nothing now.

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
