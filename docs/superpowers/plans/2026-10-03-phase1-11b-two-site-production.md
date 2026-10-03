# Plan 11b — Two-site production: hospital server primary, cloud automatic failover

## Context

Production is one Hetzner box. An internet cut at the hospital stops every counter, and all
patient data sits outside the hospital. The owner wants the hospital's own server (Windows
Server 2022, i7 13th gen, 16 GB) to be the first production site, with `https://hmis.crkmch.com`
moving to the cloud automatically when the hospital server fails and moving back, with data
caught up, when it returns.

This is the "hybrid step" the architecture already names (design doc §2/§12, plan series
"Plan 11b": streaming replication, fencing, promotion). Nothing of it is built.

Owner rulings taken in this session (2026-10-03):

| Topic | Ruling |
|---|---|
| Standby location | Hetzner for now; move to an Indian server in about a month |
| Extra hardware | None. No second ISP line, no witness device; only the existing server |
| Switching | Automatic both ways; no manual step |
| Loss on sudden server death | A few seconds is acceptable (asynchronous replication) |
| GST serials after emergency failover | Every series skips 20 numbers, with an audit record |
| Outside users during an internet cut | Should still be able to write (queued, merged later) |

Findings that change the picture:

- No patient portal, online booking, online payment, email or voice channel exists in code.
  SMS/WhatsApp run on the `console` provider in production (they only log). Today the only
  outside user is the owner.
- Everything stateful except the documents volume and Caddy certificates is in Postgres
  (no Redis, no queue broker, no object store), so replicating Postgres carries queues,
  scheduler state, sessions and every serial counter except `uhid_seq` lag.
- The app cannot run on a read-only database: login, search and every PHI read insert rows.
- Production uses about 625 MiB; the hospital server has ample room.

## Design

### One writer at a time

Postgres 16 physical streaming replication, asynchronous, one replication slot, over a
WireGuard tunnel that the hospital node dials out (no static IP or port-forward needed).
Two-way "sync" is never two writers: the node that is not primary is a hot standby and runs
no `api` and no `worker`. Roles swap by promotion; the returning node is rewound
(`pg_rewind`, needs `wal_log_hints=on`) or re-seeded from pgBackRest and catches up.

### Hospital server layout (no new hardware)

- Windows host keeps the existing small software, and gains: Hyper-V role, DNS Server role,
  one small watchdog service.
- Ubuntu 24.04 VM under Hyper-V (10 GB RAM, 6 vCPU, auto-start, static LAN IP) runs the same
  compose stack as Hetzner.
- Router DHCP hands out DNS 1 = Windows host, DNS 2 = a public resolver. The host answers
  `hmis.crkmch.com` with the VM's LAN IP, so LAN PCs work with no internet. If the host is
  dead, PCs fall through to DNS 2 and reach the cloud by themselves.

### Routing

- Public DNS always points at the cloud node. While the hospital is primary, the cloud node
  forwards `/api` through the tunnel, so the owner outside reaches the hospital database.
- The Caddyfile stays identical on both nodes (`caddyfile-parity.test.ts` pins
  `reverse_proxy api:3000`). On a standby, the compose service that answers to the name
  `api` is a small forwarder to the peer instead of the real API (compose profiles
  `primary` / `standby`).
- TLS on the LAN: the cloud node keeps obtaining the certificate (HTTP-01) and pushes it to
  the hospital node over the tunnel on renewal.

### Who decides, with one ISP line and no witness device

A node agent runs on each node (small script under `docker/prod/ha/`). The hospital node
renews a lease with the cloud every 5 s, by tunnel and by public HTTPS.

| What happened | What the cloud sees | Result |
|---|---|---|
| Internet cut, server alive | Lease stops, no hospital PC reaches the cloud | No promotion. LAN keeps working on the hospital server |
| App or VM dead, Windows host alive | Host watchdog reports it and drops the DNS override | Cloud promotes |
| Whole server dead, internet fine | Lease stops and hospital PCs (via DNS 2, carrying the site cookie) start arriving at the cloud | Cloud promotes after 30 s |
| Hospital server returns | It asks the cloud for the current epoch before accepting writes | Rejoins as standby, catches up, switches back automatically once lag is zero for 10 minutes |

Target: counters working again within about 2 minutes of a server death.

On promotion the cloud node, in one transaction: raises the epoch, writes a `site_failovers`
audit row, advances every `document_series` by 20 (owner ruling) and applies the same skip
to `episode_series`, `opd_department_tokens`, `pcpndt_form_f_serials` and `uhid_seq`
(DECIDED: same rule for all counters). Then it starts `api` and `worker`.

Before a returning node is rewound, a "lost tail" report lists bills, receipts and other
rows that existed only on it, for re-entry by hand.

### What "no extra device" costs — stated plainly

Two double faults are not fully automatic, because nothing inside the LAN outlives the
server:

1. Server dies and restarts while the internet is also cut: it cannot ask the cloud whether
   the cloud took over. Rule: it waits 2 minutes for LAN browsers to report the newest epoch
   they have seen; if none is newer it resumes as primary.
2. If the owner wrote on the cloud in that same window, the higher epoch wins and the other
   side's rows land in the lost-tail report.

A witness device or a 4G backup link would remove both. The design leaves room to add one
later without rework.

## Phases

Each phase is its own lane and PR; one additive migration in total (`site_failovers`).

1. **Prepare the cloud node (no behaviour change).** `wal_log_hints`, replication role,
   `pg_hba` entry, WireGuard, compose profiles, `deploy.sh` role-awareness (migrations and
   seeds only against the primary; standby gets images only). `/health` reports node role,
   epoch and replication lag (`apps/core/src/health/health.controller.ts`). Needs one short
   Postgres restart at a quiet hour.
2. **Hospital node as standby.** Hyper-V VM, seed from pgBackRest, streaming replication,
   documents-volume and certificate sync, image delivery from the cloud build. LAN still
   uses the cloud. Soak one week and read the lag numbers.
3. **Controller.** Node agents, lease, epoch, promotion transaction with the series skip
   (`apps/core/scripts/`, reusing `nextSeriesNo`'s table in
   `apps/core/src/modules/billing/series.ts`), Windows host watchdog and DNS role, lost-tail
   report, automatic switchback. Rehearsed on a two-stack pair on staging before the
   hospital sees it.
4. **Cutover.** Planned zero-loss switchover makes the hospital node primary; router DHCP
   change; pgBackRest archiving follows the primary.
5. **Outside access during a cut.** Separate spec. The cloud standby serves a read view and
   queues an enumerated list of owner actions (approvals first) for replay on reconnect; it
   needs a small writable side store for sessions and access logs. Until it ships, outside
   users see a "hospital link down since HH:MM" page during a cut.
6. **Move the standby to India.** Add the Indian server as a second standby, switch the
   cloud role to it, retire Hetzner as a data holder (it can keep staging and development).

Also to fix along the way: the notify pump marks a send stuck for 300 s as undeliverable and
never retries, which will drop messages during a cut once a live provider is switched on.

## Files

- `docker/prod/docker-compose.prod.yml`, new `docker/prod/docker-compose.site.yml`
  (profiles, forwarder, replication flags), `docker/prod/deploy.sh`, `tools/auto-deploy.sh`
- new `docker/prod/ha/` (node agent, promotion, switchback, lost-tail report, Windows
  watchdog), `docker/prod/pgbackrest/pgbackrest.conf`
- `apps/core/src/health/health.controller.ts`, one migration in `apps/core/drizzle/`,
  promotion script in `apps/core/scripts/`
- `docs/superpowers/plans/` phase doc for Plan 11b, `docs/runbooks/` failover runbook,
  README stage-1 section

Shared files touched (`kernel/db/schema/index.ts`, drizzle serial, Caddy/deploy parity
tests) are coordinated per CLAUDE.md; production containers are changed only through
`deploy.sh` via auto-deploy.

## Verification

- `pnpm typecheck && pnpm lint`; touched jest suites under the test lock; new tests fail
  first (health role, promotion skip of exactly 20 per series, deploy-parity for the site
  overlay).
- Rehearsal pair on staging, each drill run and timed:
  1. kill the primary's database: standby promotes, serials jump by 20, audit row present;
  2. block the tunnel only (simulated internet cut): no promotion, primary keeps writing;
  3. old primary returns: lost-tail report, rewind, catch-up, automatic switchback, zero
     rows lost in the planned direction;
  4. restart during a simulated cut: the 2-minute epoch rule behaves as written;
  5. deploy with a migration while roles are swapped.
- At the hospital after cutover: pull the internet cable (counters keep billing), then
  power off the VM (counters back on the cloud within about 2 minutes), then power it on
  (automatic return).

## Phase 1 task list — prepare the cloud node

Phase 1 changes nothing a user can see. Each row is one PR on its own lane.

| Task | What | State |
|---|---|---|
| P1-T1 | `/health` reports `site` (`primary` or `standby`) from `pg_is_in_recovery()`; an API pointed at a standby is `degraded` | this PR |
| P1-T2 | Postgres replication readiness: `wal_log_hints=on`, a `replicator` role, a `pg_hba` replication entry bound to the tunnel subnet, a physical replication slot. One short database restart at a quiet hour | open |
| P1-T3 | Compose site overlay (`docker-compose.site.yml`): profiles `primary` and `standby`; on a standby the service named `api` is a forwarder to the peer, so the Caddyfile stays byte-identical on both nodes | open |
| P1-T4 | `deploy.sh` reads the node's role: migrations, seeds and `stanza-create` run only against the primary; a standby receives images and configuration only | open |
| P1-T5 | WireGuard on the cloud node, listening for the hospital node; ufw admits the one UDP port | open |

DECIDED (not owner rulings; standard answers):

- The role is asked of Postgres on every `/health` call and is never configuration.
- The skip of 20 applies to every counter, not only the four GST series the owner ruled on.
- Switchback is automatic once replication lag has been zero for 10 minutes.
- The standby runs no `api` and no `worker`; the cloud's read view during a cut is phase 5.

Open for the owner:

- The Indian server for phase 6 (provider and size) — procurement.
- Whether a CA wants the skip-20 audit record in a particular form.
