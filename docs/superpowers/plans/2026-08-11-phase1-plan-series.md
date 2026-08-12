# Phase 1 — Plan Series Roadmap (the cross-session continuity document)

**Purpose:** This file carries the inter-plan thinking so any fresh session can write Plan N at Plan-01 quality without the original conversation. Read order for a new session: spec v4.5 (`2026-08-10-hmis-architecture-design.md`) → S10 v1.3 → this file → the previous plan + its gate report. The specs are design law — never re-litigate them in a planning session; open questions go to the owner.

**Quality bar:** `2026-08-11-phase1-01-foundation-kernel.md` is the reference standard — bite-sized TDD tasks, exact code in every step, Interfaces blocks with exact signatures, no placeholders, self-review at the end.

**Operating rhythm (owner-approved):** one session = write plan N from this roadmap → owner approves in-conversation → compile into the routing pipeline (/execute; sonnet-tier tasks unless flagged, opus gate per task) → pipeline runs in background → **gate report committed to `docs/superpowers/plans/reports/plan-NN-gate-report.md`** (the next session's ground truth for interfaces actually shipped) → next session writes plan N+1. Never write plan N+1 before plan N's gate report exists.

**Global rules binding every plan (from spec — copy into each plan's Global Constraints):** TypeScript strict, no `any` in kernel · events append-only, `entity.verb_past`, full §10.5 envelope, occurred≠recorded, idempotency keys on edge submissions · module isolation lint-enforced, cross-module only via `index.ts` interfaces or events · no broker/Redis; Postgres + pg-boss only · multi-process-safe (no in-memory single-process state for anything load-bearing) · perf budgets: patient search <300 ms, interactive <100 ms (test-enforced from Plan 05 on) · keyboard-first counters, Hindi/English i18n scaffolding from first UI · print is a first-class surface; every printed doc gets a signed QR · billing append-only; corrections via credit notes / entered-in-error grammar · KPIs derive from events only.

---

## Standing execution rules (learned in Plan 01 — copy into every pipeline)

**Where the build lives.** The **server checkout `/opt/hmis` on `root@62.238.106.231` is canonical for code**; the Windows repo `C:\Users\ankit\hmis` is canonical for docs/plans. Both push to the same private GitHub repo, so **always `git pull` before writing** in either, and rebase the server (`git pull --rebase origin main`) if a docs commit landed while a pipeline was running.

**Two hard environment facts:**
- **The server's deploy key cannot push `.github/workflows/*`** — GitHub refuses it. Any plan touching CI must make that edit in the local repo and push from there (the owner's `gh` token carries the `workflow` scope).
- The server is **shared with an unrelated InsForge stack** (`/opt/InsForge`, `insforge-*` containers, ports 5430/5432/7130/7133). It is not part of this architecture and is off-limits to every agent.

**Brief boilerplate every task needs** (Plan 01's pipelines carry the exact wording): `/opt/hmis` is the only writable path on the server, *including no writes to `/tmp`* · no docker container may be created except the `hmis` compose project · never read, stat or reference `/opt/InsForge` — not even read-only · **the owner may be working on the same host from the same IP and key, so never infer from logs or timestamps who did what, and report only what you yourself did** · guard any `apt` with `NEEDRESTART_MODE=l` so it cannot bounce the shared docker daemon.

**Acceptance-criteria discipline (the expensive lesson).** Every criterion must be **attributable to the task itself**. A criterion asserting the state of anything the task does not control — a co-tenant stack's health, another actor's files — cannot be satisfied by correct work, and the retry ladder will burn three attempts and halt the chain. Plan 01's first pipeline died exactly this way.

**Verify-by-execution.** Three defects in Plan 01's "exact" code passed typecheck and failed only at runtime: a lint matcher that matched nothing, a SQL array parameter that didn't bind, a CI action input that hard-errored. **Hand-written matcher patterns, raw-SQL parameter binding, and third-party CI action inputs must be proven by running them** — and a CI task is not done until a run is observed green.

**Pipeline shape that worked:** ≤6 tasks per Workflow, strictly sequential waves when tasks share files, sonnet coders with an Opus gate per task, retry → escalate to heavy-coder. Expect ~700k–1M subagent tokens and 60–90 min per 5-task pipeline. Tell each brief which *existing deviations not to "fix"* — gates otherwise fail work for touching them, and coders otherwise revert them.

## Open architectural decisions (not yet resolved — resolve before go-live)

**Event-log partitioning (spec §11.18 sweep #10) — half resolved.** The idempotency half is **DONE**: the owner chose the side-table option on 2026-08-12, and `event_idempotency` now holds the global uniqueness (commit `3660ffa`, gate report §3). `events` therefore has **no unique constraint that a partition key would fight** — the blocker is gone, and it was executed while the table had zero rows.

**Still open: the partition key itself.** `events` is still a plain table. Before choosing, weigh the one real tension:
- **Partition by `recorded_at` (monthly)** — what retention and archival actually need (drop/archive by month, legal holds override). But the outbox dispatcher reads `where seq > cursor order by seq`, which **cannot prune on `recorded_at`**, so every cycle probes every partition; after a few years that is dozens of index probes per cycle, forever.
- **Partition by `seq` (ranges)** — prunes the dispatcher's query perfectly, but doesn't map to calendar months, so time-based retention needs a `seq`→time lookup.
- Hybrid worth costing: partition by `recorded_at`, and give the dispatcher a `recorded_at` floor derived from its cursor so partition pruning applies to it too.
Decide before go-live; cost still rises with row count. Suggested home: a short dedicated plan, or folded into Plan 11.

**Deployment topology (Plan 11).** `62.238.106.231` is currently build host, InsForge co-tenant, and prospective deploy target simultaneously. Spec §12 wants primary and standby in **different fire zones**. Needs a real decision, not a default.

**Config & secrets ownership (Plan 02).** Connection strings are currently hardcoded fallbacks in five places (`client.ts`, `drizzle.config.ts`, `migrate.ts`, the health e2e test, the test helper). Plan 02 is the first plan holding real secrets (TOTP seeds, session keys, password hashes) — it should introduce the config loader and retire those fallbacks, rather than letting the pattern spread further.

---

## Plan 02 — Auth, RBAC & Actor Fabric

- **Spec anchors:** §14 (permissions action+scope, 2FA, break-glass, confidential/VIP), §16 (agents as first-class actors), §11.19-C fix 6 + S10 §11 (no shared accounts, PIN/badge fast-switch, SoD pairs), §11.19-D-27 (signature-class 2FA), §11.19-E-4 (sealed-class treating-team carve-out — model the access rule now, sealed data arrives with clinical records).
- **Scope:** users, roles, permissions (`action` + `scope`: own-department/floor/hospital), role assignments per department/floor; login sessions + shared-terminal fast user-switching (PIN/badge switch = identity change, not shared session); TOTP second factor for signature-class and money-class permission checks; break-glass grant (instant, loud event, review-queue record); **SoD hard-pair enforcement** (`sod.violation_blocked`) as a kernel check consulted by the approvals engine and any two-person flow; agent actor type with own credentials + per-agent kill-switch flag; emergency role elevation (S10 mechanism 6).
- **Produces (later plans consume):** Nest guard `@RequirePermission("billing.refund.approve", "department")`; `CurrentActor` decorator returning contracts `Actor`; `assertNotSodPair(actorId, otherActorId, pairKey)`; tables `users`, `roles`, `permissions`, `role_assignments`, `break_glass_grants`; events `break_glass.used`, `sod.violation_blocked`, `emergency_elevation.used`, `temp_role.granted/.expired`.
- **Traps:** permission strings are module-manifest-declared (Plan 01 Task 7 `allPermissions()`) — auth consumes the registry, never its own list. Fast-switch must be <2 s or wards will share sessions anyway (perf-test it).

## Plan 03 — Workflow Engine

- **Spec anchors:** §10.2 (definitions as versioned data: states, transitions, allowed roles, SLA per state, escalation ladder), §10.3 (structure everywhere, alerts selective — per-state `alerting: active|record_only`), §10.4 + D-15 (change classes A/B/C; owner/MS two-key for Class A), D-11 (in-flight migrate/abort), E-5 (emergency-activation precedence over drafter/activator SoD), E-35 analog (publish-with-deviation pattern), §11.19-C fix 11 (escalation dead-end fallback: duty manager + owner SMS).
- **Scope:** definition CRUD (draft → approve per change class → activate; versioned, immutable once active); instance lifecycle bound to definition version; transition API enforcing allowed roles (via Plan 02 guard); SLA timers per state (pg-boss scheduled checks) emitting `sla.breached`; escalation ladder resolution to on-duty *roles* (roster substrate arrives Plan 11-adjacent — until then, resolve to static role holders and mark the seam); `instance.migrated`/`instance.aborted` remediation ops (approval-gated); `workflow.definition.updated` events.
- **Produces:** `defineWorkflow(defJson)` validation (every branch reaches terminal — the §18 no-dangling-paths test as a library check); `startInstance(tx, defKey, subject)`, `transition(tx, instanceId, to, actor)`; tables `workflow_definitions`, `workflow_instances`, `workflow_timers`.
- **Traps:** timers must survive process restart (DB-persisted, pg-boss re-scheduled) — no setTimeout. The engine is generic; OPD/billing flows are *data* authored in later plans.

## Plan 04 — Approvals Engine v1

- **Spec anchors:** §8 (request → approver role → approve/reject with note → event; in-app action, WhatsApp notify only), C-12 (anti-structuring: thresholds evaluate cumulative same-patient/same-payee/same-day), E-15 (urgency classes; interrupting channel; act-first-review-after), E-18 pattern (every request type names reviewer role + closure SLA).
- **Scope:** generic approval requests (type, subject refs, amount?, requester, approver-role, urgency class); approver worklist API; approve/reject with mandatory note; cumulative-aggregation helper for money thresholds; timeout escalation via Plan 03 ladders; notification emission (consumed by Plan 10's gateway; until then, events only). Day-one consumer wiring lands with billing (Plan 08).
- **Produces:** `requestApproval(tx, req): Promise<{approvalId}>`; `approval.requested/.granted/.rejected` events; table `approvals`; `cumulativeAmount(payeeOrPatientId, type, window)` helper.
- **Traps:** requester≠approver uses Plan 02 `assertNotSodPair`; the emergency-governance precedence (E-5) is *not* this engine — don't conflate.

## Plan 05 — Patient Master & Registration (first UI plan)

- **Spec anchors:** §6 (patient master, UHID, ABHA nullable), §11.1 entry lanes, §11.5 (merge/unmerge, allergies, language), D-30 (ABHA address/verification/link-token fields), D-31 (guardianship model + sensitive-context override), §14 (confidential/VIP flag, alias on public surfaces), C-18/S10-18 (duplicate false-attach check: photo prompt + demographic-mismatch sampling), E-23 (signed QR payloads — signing utility lands in kernel here), §15 (keyboard-first, i18n, print).
- **Scope:** `apps/web` React+Vite scaffold (Tailwind, shadcn/ui, TanStack Query, i18n framework, keyboard-first form kit — this scaffold is reused by every later UI); patients table (registration module owns it); UHID generator (config prefix + check digit); **phone-first search <300 ms perf-tested**; photo capture; allergies + language + guardian entity (authority scope, validity, age-18 transition job); ABHA field set; merge (side-by-side, approval-gated) + unmerge; registration desk UI + printed QR card (HMAC-signed payload; `qr.signature_failed` on bad scans); `patient.registered/.updated/.merged/.unmerged`, `guardian.linked/.authority_changed`, `allergy.recorded`.
- **Traps:** every later module references `patient_id` — never copies demographics (§6). The guardian sensitive-context override must be modeled now (POCSO flows depend on it at IPD phase). VIP flag affects privacy surfaces only, never priority (D-37).

## Plan 06 — Tariff, Adjustment & GST Engine + Golden Suite

- **Spec anchors:** §7 (tariff versioning, tariff-lock rule data model, adjustment rules, best-single-benefit), C-3 (min(tariff, MRP, NPPA ceiling) with hard block; batch-MRP at GRN comes in pharmacy phase — model the regulated-price attributes now), D-3 (GST exemption-boundary: healthcare exemption, ₹5k/day room-rent line, composite supply, ITC-reversal data), §11.11 (tariff revision workflow: draft → impact simulation → Class-A approval → effective date), D-17 (config-validation gate), §18 (golden suite).
- **Scope:** service master + tariff versions; adjustment-rule engine (rule sources: manual discount w/ category E-8, coupon, membership — membership rules arrive Plan 09 but the contest interface is fixed here); **`priceInvoiceLines(ctx, items): PricedLine[]`** — pure, deterministic, exhaustively golden-tested; GST computation with exemption logic; regulated-price attributes (MRP, ceiling, effective dates) under master-data change control; impact simulation (re-price yesterday's lines under draft); **golden suite harness**: fixture files with exact expected invoices, CI-gated, covering §18's enumerated cases.
- **Produces:** the pricing function above + `AdjustmentSource` plugin interface (Plan 08/09 register sources); tables `services`, `tariff_versions`, `adjustment_rules`, `regulated_prices`.
- **Traps:** pricing must be pure (no DB inside) so golden tests are hermetic. GST thresholds are CA-configured values, never literals (§19 gate).

## Plan 07 — OPD: Encounters, Appointments, Queues, Vitals

- **Spec anchors:** §6 (encounter spine — the most load-bearing table after events), §11.1 (queue discipline verbatim: appointment-priority, walk-in gap-fill, late keeps priority; visit-type auto-detect 7-day default + capped evented extensions §11.5-fix14), vitals mandatory + danger flags + pediatric weight context (§11.8), WebSocket live queues, token displays (tokens only §11.5), E-32 (bounded-interleave membership perk slot — define the queue hook, rules arrive Plan 09), doctor-leave cascade (§11.5), Fig-1 outcome branches (Rx print + referral + advice; admission-request stub records intent for IPD phase).
- **Scope:** encounters table (type, status, doctor, department, timestamps); appointment booking + slots; check-in → token; queue engine implementing the locked discipline as a *pure function* over queue state (property-tested); vitals capture UI with danger-range escalation events; consultation screen v1 (history timeline, vitals, diagnosis + printed e-Rx with signed QR; prescription.issued event); WebSocket gateway (multi-process-safe: fan-out reads events via dispatcher, not in-memory); display board page (tokens + audio call); `visit.opened`, `patient.checked_in`, `vitals.recorded/.danger_flagged`, `consultation.started/.completed`, `appointment.*`, `queue` projections.
- **Traps:** same-day test re-entry loop (priority flag) must exist even though lab is phase 3 — the queue supports priority re-entry class now. Encounter schema must anticipate IPD/ER types (enum open, fields nullable) without building them.

## Plan 08 — Billing Counter: Invoices, Tenders, Cashier Sessions, Refunds

- **Spec anchors:** §7 (immutable invoices, credit notes, tenders, cashier sessions, variance, UPI reconciliation, refund-to-payer), C-2 (269ST episode cash aggregation warn/block + PAN/Form-60; 40A(3) is procurement-phase), §11.11 (charge-from-events + daily orphan report; day book), E-24/25/26 (degraded-tender mode, tender lifecycle states, expected-net settlement), E-8-pass8 (entered-in-error grammar — lands here for money, pattern reusable), D-33 (deceased suppression hook), intended-payer tag (§6), discount categories (D-8), approvals wiring (refunds, discount overrides — Plan 04 consumers go live here).
- **Scope:** invoices (issue from priced lines via Plan 06; immutable; print w/ signed QR), charge-posting consumers (visit.opened → consult charge etc.) + **orphan report** (chargeable events without charges, daily); tender capture (mixed modes, UTR refs, lifecycle states); episode cash-aggregation service with warn/block + config thresholds; cashier session lifecycle (float → collections → denomination close → variance approval); refunds (credit note + approval-gated voucher; refund-to-payer ID rule; bank-transfer-above-threshold); counter UI (keyboard-first; the three-way OPD fee branch from visit-type); daily revenue close job + day book report; degraded-tender mode flag honored at the counter.
- **Traps:** invoice immutability is structural (no UPDATE grants on the table); every price change is a new invoice/credit-note pair. The cash-law thresholds are config with CA-gate flags. Cashier-session SoD: variance approver ≠ session cashier (Plan 02 pair).

## Plan 09 — Memberships, Coupons & the Accrual Ledger

- **Spec anchors:** §7 (plans-as-config, three benefit kinds, family coverage, card sale as invoice line; silent accrual ledger accrue-on-payment/reverse-on-refund), C-1 (**payee classes: external-RMP payouts structurally OFF** pending legal gate; `payout.class_blocked`), C-17 (attribution verification before accrual eligibility), E-32 (sale guardrails: no ER/bedside sales, cooling-off refund, disclosure, no counter sales-KPIs), bounded-interleave perk wired into Plan 07's queue hook, prepaid bundles as entitlement counters (§11.4 map 11 machinery, generic here).
- **Scope:** membership plans config + instances + covered members (patient links); entitlement counters (freebies, bundles) with consume/restore on refund; coupon definitions + redemption; both registered as Plan 06 `AdjustmentSource`s (best-single-benefit contest tested in golden suite); referrer master with payee classes + verification state; accrual consumer on `payment.received` / reversal on `payment.refunded`; `membership.sold/.benefit_consumed`, `coupon.redeemed`, `commission.accrued/.reversed`, `attribution.unverified_flagged`.
- **Traps:** Payout *execution* is the Payouts pack (Phase-2 fast-follow) — Phase 1 accrues only. External-RMP class must be un-payable at the schema level (no payout path), not by convention.

## Plan 10 — Notifications Gateway & Public Read Surface

- **Spec anchors:** §11.13 (matrices, quiet hours 9pm–8am, template registry versioned w/ approval status, DPDP transactional/promotional split + opt-in), §11.5 (fallback ladder WhatsApp→SMS→IVR→manual flag; language per patient), D-24 (spoof defenses, registered-VPA rule), E-22 (amended-report supersession), E-1 (**public read-only surface**: one-way outbound push to DMZ/cloud relay; signed short-lived tokens; queue position + document verification; no PHI beyond token; no inbound path), D-33 (deceased suppression enforced at gateway), provider selection deferred (§19) → provider-agnostic adapter + dev/console provider.
- **Scope:** outbound message queue (pg-boss) with template rendering (language-aware), per-channel adapters (WhatsApp/SMS interfaces + console impl), fallback ladder w/ `notification.sent/.delivered/.failed`, quiet-hours scheduler, opt-in registry; the relay service (`apps/relay` — tiny, separate deployable; receives signed pushes, serves token-scoped reads) + core-side pusher; document-verification view (latest version + amendment banner); supersession flow re-sending amended docs.
- **Traps:** the relay holds no secrets and no DB — it's a cache of pushed snippets keyed by token. Token TTLs short; tokens revocable (supersession). Owner digest (agents, Plan 12) uses this gateway — keep the send API generic.

## Plan 11 — Deployment, DR & Ops Hardening

- **Spec anchors:** §5 (Compose, Caddy, Grafana/Prometheus/Loki), §2-v4.3 (process split: api / ws hub / worker / renderer from one build), §12 (semi-sync + **replication state machine** E-13, fencing, floor degradation, pgBackRest + weekly restore drill, immutable offsite), E-2 (LUKS everywhere, repo encryption, key escrow), E-16 (out-of-band watchdog sends primary-down), §11.14 sweep (NTP/clock-drift monitoring, interface heartbeat framework), D-17 (config-validation gate wired to go-live), downtime kit printables (§11.4 map 1: numbered-form PDFs, runbooks), E-10 (commissioning/ramp mode flag), pg-boss scheduling of the Plan-01 dispatcher + all timers.
- **Scope:** production compose files + process-split entrypoints; Caddy config; replication setup scripts + state machine daemon + promotion runbook (printed); backup stack + automated weekly restore-drill job with sanity checks; monitoring dashboards + alert rules (selective list per §10.3); watchdog box config; encryption provisioning docs + key escrow procedure; heartbeat framework (`interface.down/.restored`) with printer/scanner registration; downtime kit generator (PDF, reserved serial ranges); operating-mode service (normal/ramp/downtime/degraded flags the whole app + agents read).
- **Traps:** this plan is infra-heavy — several tasks are scripts+runbooks verified by drills rather than unit tests; the gate criteria are drill transcripts. Mark tasks needing real hardware as environment-gated (CI-skipped, drill-verified).

## Plan 12 — Phase-1 Agent Fleet

- **Spec anchors:** §16 (roster: Digest Writer, SLA Chaser, Leakage Auditor, Fraud Sentinel, Recall OPD, Ops Copilot; guardrails: API-only, fail-open, kill switch, heartbeats C-29, mode-awareness C-27, backfill semantics C-28, watchdog-of-watchers), E-30-dyads (Fraud Sentinel pair modeling), D-36 (signer-side automation-bias metrics — instrumentation only in Phase 1), **AI inference locus per the §19 DPIA gate decision** (build provider-agnostic: `InferenceClient` interface with cloud + on-prem impls), D-42 (DPIA artifact before activation).
- **Scope:** agent runtime (identity from Plan 02, permission-scoped API client, per-agent config/kill-switch/heartbeat, mode gate, backfill gate); deterministic watchdog (non-AI) monitoring agent heartbeats; the six agents as subscription consumers + scheduled jobs (digest 8 a.m.; SLA chase on `sla.breached` active list; leakage triangle + orphan trends weekly; fraud watchlist incl. dyads; recall ladder on no-shows/abandoned visits; Copilot as permission-enforced query endpoint); every agent report lands as a task/notification with a named reviewer (E-18).
- **Traps:** clinical cap and tier table are *config assertions tested in CI* (an agent whose config exceeds its tier fails the build). No agent writes clinical or financial state in Phase 1 — reports, nudges, drafts only.

---

## Sequencing notes

- 01→02→03→04 are strictly ordered (each consumes the last). 05 and 06 can proceed in parallel after 04 (disjoint files). 07 needs 05+06. 08 needs 06+07. 09 needs 08. 10 needs 05 (patients/language) and is needed by 12. 11 can start any time after 01 but must complete before go-live. 12 last.
- **Go-live checklist = §19 pre-go-live gates** (legal, CA config, DPIA, register legality, internal auditor, transition boundary map, config-validation report) + all 12 gate reports green + owner's UAT at the real counters.
- Product name still undecided (owner's list item #5) — repo stays `hmis`; renaming is a config/branding concern, never a code blocker.
