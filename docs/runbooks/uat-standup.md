# Standing UAT up — what it costs, what you must decide, and what a pass looks like

**Audience: the owner.** This page exists so that `:8443` is a decision you can act on rather than
an ask you have to design. It answers four questions in order: what you give up, what only you can
decide, what to run, and what "it worked" looks like.

**Status: UAT HAS NEVER BEEN STOOD UP ON THIS BOX.** Everything below is derived from
`docker/prod/deploy.sh`, `docker/prod/uat-reset.sh` and the box as measured on **2026-09-13** —
not from a run. Where a number could drift, this page says how to measure it rather than quoting
it, for the reason the catch-up runbook now states on its own first page: a number written in a
runbook records a moment, not a state.

**It also depends on PR #177.** Before those five fixes, `deploy.sh --target uat` could not
complete — and its worst defect *succeeded*, bringing a stack up against production's currently
deployed image. Do not follow this page against a checkout that lacks #177.

---

## 0. What you give up, and for how long

**`:8443` is your live front-desk preview.** Measured just now: port 8443 is held by `caddy`
(pid 2145010) inside the container **`hmis-preview-caddy`**, which runs on the host network.
`deploy.sh` will refuse rather than fight it —

```
port 8443 is in use and it is not this project's caddy.
The retired preview stack used it: docker stop hmis-preview-caddy
```

— so standing UAT up means **stopping the preview**, and the preview does not come back until you
start it again (`/opt/hmis-preview/preview.sh`, which also opens and closes the firewall rule).

> **A wording snag, so it does not stop you.** That refusal calls the preview stack *"retired."*
> It is not — it is serving right now. The sentence was true when it was written. Treat it as the
> instruction it is (`docker stop hmis-preview-caddy`) and ignore the adjective.

**What replaces it.** UAT is a strictly better preview for everything except speed of iteration:
it serves the full stack — api, worker, database, edge — from the same image that will ship,
behind basic auth on the same port, with a visible environment banner. What it does *not* give you
is a lane's uncommitted work: the preview shows one lane's branch minutes after an edit, and UAT
shows the built candidate. **Keep the preview for "does this screen look right", and use UAT for
"can a person do a day's work".**

**The four other ports you are testing across do not move, and nothing below touches them:**

| port | what holds it | whose |
|---|---|---|
| **8443** | `hmis-preview-caddy` | **the one UAT takes** |
| 5180 | `vite`, on 127.0.0.1 | the front-desk lane's web preview (`/opt/hmis-lanes/front-desk`) |
| 3010 | `node dist/src/main.js` | the front-desk lane's API |
| 80 / 443 | `hmis-prod-caddy-1` | **production. Never in play here.** |
| 5434 | `hmis-prod-db-1`, on 127.0.0.1 | production's database |

UAT's own database publishes **127.0.0.1:5435**, which is free (measured). Production's edge, its
database and the monitoring ports (3001, 9090, 9093 — all loopback) are untouched: UAT runs in its
own compose project, with its own volumes and network, and `deploy-parity.test.ts` pins the
absence of any shared-volume escape hatch.

---

## 1. The one thing only you can decide, and the gap it fills

**Nothing in `deploy.sh` or `uat-reset.sh` creates a user.** This is deliberate and it is stated in
the script itself (`deploy.sh:739`): *"A deploy that created an administrator would be creating a
credential nobody asked it for."* `seed:admin` is absent from both seed lists — I checked both, not
one.

**The consequence is the thing most likely to be discovered at the login screen at the worst
moment: a completely green UAT deploy has nobody who can log in.**

`/opt/hmis-uat/.env` already exists (mode 600) and is otherwise complete. Its ten keys, measured:

```
DATABASE_URL            POSTGRES_DB        HMIS_UAT_SITE
SECRET_KEY              POSTGRES_USER      HMIS_UAT_BASIC_AUTH_HASH
PORT                    POSTGRES_PASSWORD  HMIS_SYNTHETIC_DATA_OK
HMIS_ENVIRONMENT_LABEL
```

**There is no `ADMIN_USERNAME`, no `ADMIN_FULL_NAME` and no `ADMIN_PASSWORD` — and they do not
belong in that file.** `seed:admin` reads them from the process environment, so they are passed on
the one command that needs them and are never written to disk:

```bash
cd /opt/hmis-uat
docker compose -p hmis-uat \
  -f docker-compose.prod.yml -f docker-compose.uat.yml --project-directory . \
  run --rm \
    -e ADMIN_USERNAME='<the username you will type at the login screen>' \
    -e ADMIN_FULL_NAME='<the name that appears on screens and in the audit log>' \
    -e ADMIN_PASSWORD='<at least 10 characters>' \
  api node dist/scripts/seed-admin.js
```

Three things about this command are worth knowing before you run it:

- **Ten characters is enforced, not advised.** `seed:admin` is the sixth path guarded by the one
  password policy (11f D1), and it refuses *before the first write* — so a short password costs you
  nothing but a retry.
- **It is safe to re-run and it is the documented repair.** Every step runs on every invocation —
  the permission catalogue, the `admin` role, and the full grant reconcile. Only *user creation*
  is conditional, which is the one fact that must never be silently overwritten. If you later add a
  module, re-running this is what grants its new permissions to `admin`.
- **This is a training box, so use a training password.** It should not be your production
  administrator's, and it will be typed in front of whoever you are training.

**`/opt/hmis-uat/.uat-password` already exists** — that is the *basic-auth* password for the edge
(the outer gate the browser asks for), not a login. They are two different doors and you will be
asked for both: the browser's basic-auth prompt first, the application's login screen second.

---

## 2. Pre-flight — what is already staged

`deploy.sh` step 0 refuses unless all of these hold. All were measured as **already true** on
2026-09-13, so expect it to pass straight through; if it does not, the refusal names the file:

- `/opt/hmis-uat` exists ✓ and `/opt/hmis-uat/.env` is present and mode 600 ✓
- `.env` carries `HMIS_UAT_SITE` ✓ and `HMIS_UAT_BASIC_AUTH_HASH` ✓
- `docker`, `curl`, `ss` on PATH ✓
- **port 8443 free, or held by UAT's own caddy** ✗ — *this is the one you must act on*: see §0.

Note the asymmetry with production, and that it is deliberate: **UAT is refused if it declares a
backup credential, and production is refused if it declares `HMIS_SYNTHETIC_DATA_OK`.** Each target
refuses the other's config rather than ignoring it.

---

## 3. The invocation

```bash
docker stop hmis-preview-caddy                 # §0 — gives up the preview
cd /opt/hmis                                   # a CLEAN checkout at the commit you mean to rehearse
git log --oneline -1                           # write this SHA down; it is what you are testing
HMIS_TARGET=uat bash docker/prod/deploy.sh 2>&1 | tee /tmp/uat-standup-$(date +%Y%m%d-%H%M).log
```

`tee` is not decoration. This has never been run, so its first run is also the evidence that it
works, and a scrolled-away failure at step 5 of 8 is the difference between a fixable afternoon and
a guess.

---

## 4. What a pass looks like

**Derived from the script, not observed** — no one has run this. Verify each step marker appears;
treat a missing one as a failure even if the script keeps going.

| step | marker | on UAT |
|---|---|---|
| 0 | `0/8 pre-flight` | + `target uat: no pgBackRest credentials and no alert sink expected` |
| 1 | `1/8 building images from the checkout` | builds **`hmis-uat/{server,web,db}:latest`** |
| 2 | `2/8 copying configs into /opt/hmis-uat` | installs `Caddyfile.uat` |
| 3 | `3/8 database up` | waited to healthy on its own healthcheck |
| 4 | `4/8 pgBackRest stanza` | **SKIPPED — correct.** See §6 |
| 5 | `5/8 migrations, run from inside the image` | then cursor seeding, then twelve configuration seeds |
| — | `configuration gate` | **hard gate.** A failure here is real |
| 6 | `6/8 api, worker and caddy up` | then `6b/8 every declared service is up` — **four services, not nine** |
| 7 | `7/8 backup and restore-drill cron` | **SKIPPED — correct.** See §6 |
| 8 | `8/8 the edge gate` | `/api/health` as JSON **and** a screen path as HTML, over `:8443` |

**The image namespace at step 1 is worth one glance.** It must say `hmis-uat/`. If it says
`hmis-prod/`, you are on a checkout without #177 and you are about to rehearse production's
currently deployed build while everything reports success — the one defect in that set that fails
by succeeding.

**Two lines in the middle are expected and are not failures:**

- `seed:roles reported NOT READY` — a verdict about *who holds which role* in a hospital that has
  no staff yet. The grants it writes land either way; the verdict is for a human. It is deliberately
  not wired to the deploy's exit status.
- **`standup:check reported RED rows`** — see §5, which is the section most likely to stop somebody.

**After the deploy, mint the administrator (§1), then re-run the role census** — in that order,
because `seed:admin` installs six `auth.*` grants that `seed:roles` checks for:

```bash
cd /opt/hmis-uat && docker compose -p hmis-uat \
  -f docker-compose.prod.yml -f docker-compose.uat.yml --project-directory . \
  run --rm api node dist/scripts/seed-roles.js
```

Then open `https://<the address in HMIS_UAT_SITE>:8443`, answer the basic-auth prompt, and log in
with the credentials from §1. The certificate is self-signed (`tls internal`), so your browser will
warn — that is expected on a box answering on an IP, and it is why no HSTS header is sent. You
should see an **environment banner**: `HMIS_ENVIRONMENT_LABEL` is set on UAT and unset on
production, so the banner renders here and renders nothing there. **If you do not see the banner,
check which stack you are looking at before you do anything else.**

---

## 5. The first census will print a wall of red, and the red is correct

`standup:check` prints a readiness row per commissioning fact. **On a freshly built box most rows
are red, and that is the design, not a fault.** The census's grammar is that *every row is RED
until an act makes it green* — which is exactly why scanning it for red gives you a to-do list
rather than a fault list.

Measured on today's `main`: **49 rows — 34 of them G3 (master data) or G4 (people).** With PR #178
merged it becomes **52 rows, 37 of them G3/G4.** Only the G2 rows — the fourteen the deploy itself
establishes — are expected green on a box that has just been deployed and has no staff and no
catalogue. **Count the red rows; do not read them as breakage.**

**And know what it is not:** `standup:check` is **not** a hard gate on UAT. All three of its call
sites are non-fatal and none branches on the target, whatever ROADMAP §3 and the comment near
`deploy.sh:830` imply. The deploy's actual hard gate is `check-config-present` (the configuration
gate at step 5). That discrepancy is recorded as an open design question, not patched here — but
if you are relying on the census to stop a bad UAT deploy, **it will not.**

---

## 6. What UAT deliberately does not do

Each of these is skipped rather than faked, and the reasons are in `deploy.sh`'s own header:

- **No pgBackRest stanza (step 4).** UAT has no backup repository and must not have one — its
  whole point is that it holds nothing worth restoring.
- **No backup or drill cron (step 7).** Same reason, plus: two crons writing one log file is how a
  drill's verdict gets attributed to the wrong cluster.
- **No real-hostname edge gate (step 8's other half).** No public hostname, no ACME certificate;
  UAT answers on this box's IP over `tls internal`, behind basic auth.
- **No alert sink.** An alert path pointing at your mailbox from a training box is how a real page
  gets ignored.

**And the one that is a rule rather than an omission: UAT NEVER RESTORES A PRODUCTION BACKUP.**
Nothing in `deploy.sh`'s uat target or in `uat-reset.sh` can do it, and nothing should be added
that can. A training box holding a real patient is a DPDP incident wearing a training label — and
UAT is seen by trainees, by vendors, and on a phone.

---

## 7. Between training days

A day of training leaves half-finished visits, cancelled invoices and a patient somebody typed in
by mistake. The honest answer is to throw the database away, not to tidy it:

```bash
bash /opt/hmis/docker/prod/uat-reset.sh
```

It refuses on **every name production could answer to** rather than checking one, requires
`HMIS_SYNTHETIC_DATA_OK=1` in `/opt/hmis-uat/.env` (already set), and then drops the database,
re-migrates, re-seeds, loads the synthetic lab catalogue and a demo day, and prints the census.
**It is not a deploy** — it builds nothing and touches no image, so it will not pick up new code.

**It does not re-create the administrator.** `seed-admin` is not in its list either, so after every
reset you run §1's command again. Keep that command somewhere you can paste it from.

---

## 8. Giving the port back

```bash
cd /opt/hmis-uat && docker compose -p hmis-uat \
  -f docker-compose.prod.yml -f docker-compose.uat.yml --project-directory . down
bash /opt/hmis-preview/preview.sh start      # the front-desk preview returns to :8443
```

UAT's data survives in its own volume, so bringing it back up later does not mean re-commissioning
it. Production is unaffected by every command on this page.

---

## 9. What this page has NOT verified

Stated plainly, because a runbook that hides its untested half is worse than no runbook:

1. **No step here has been executed.** The step table in §4 is read out of the script.
2. **The edge gate over `:8443` is the least certain step** — it is the one the five fixes in #177
   most directly touch, and the only one that exercises `Caddyfile.uat`'s site address, the basic
   auth split and the port map together.
3. **The census counts in §5 are static counts of declared rows**, not a census run against a
   deployed UAT.
4. **Whether the synthetic seeds populate a usable training day** is unknown; `uat-reset.sh` runs
   them, the first deploy does not.

If the first run disagrees with anything above, **the run is right and this page is wrong** — fix
the page in the same hour, while you still remember which line lied.
