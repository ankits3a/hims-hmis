# Plan 11h — Global search and the command palette

**Written 2026-08-25 (owner brainstorm, in-conversation). Not yet approved for execution.**
Slot: **after 11g, before 09** — ruled by the owner in the brainstorm that produced this document.
The plan-series roadmap line ([`2026-08-11-phase1-plan-series.md`](2026-08-11-phase1-plan-series.md)
§ Sequencing notes) is **not amended by this document**: Plan 11g is in flight and owns that file's
neighbourhood this week. The one-line amendment lands at 11g's close, by the session that closes it.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Eight tasks, no full-module build, one new kernel surface plus four modules registering
into it. The main session codes task by task under [`AGENT-RULES.md`](../AGENT-RULES.md), builds the
mutants for the inline CRITICAL rows, watches CI with
[`pipelines/ci-watch-host.sh`](../pipelines/ci-watch-host.sh), and closes with one independent
reviewer. **The NL lane is not in this phase** (§4 DD10) — that is what keeps the count at eight.

**Stop-loss (v3 §6):** 1.5× Plan 11g's actual, read from 11g's CLOSE. If 11g has not closed when
this phase starts, the stop-loss is **2.5M tokens** — the first LIGHT-lane phase has no comparable
actual, and a HEAVY-lane number (2.49M–3.34M) would be a ceiling, not a tripwire.

**Frozen paths — 11g is running in parallel and owns these; this phase touches none of them:**
`apps/web/src/screens/registration-desk.tsx` · `apps/web/src/screens/patient-detail.tsx` ·
`apps/web/src/lib/confidential-capture.ts` · `apps/web/src/lib/api.ts` · `docker/prod/Caddyfile` ·
`docker/prod/deploy.sh` · `apps/core/scripts/seed-tariff.ts` · `apps/core/src/kernel/auth/throttle.ts`.
`apps/web/src/router.tsx` is **shared risk** — 11g rewrote its nav to `<Link>`; this phase adds one
mount line and a permission filter to the same JSX. T6/T8 rebase onto 11g's merged state; they do
not start before it.

---

## 1. Why this phase

The owner asked to extend "the search that `/` opens" into a global, beautiful, permission-aware
finder with an `@entity` filter grammar, voice, and a natural-language lane. Ground truth (§2) is
that there is almost nothing to extend: `/` focuses whatever element carries `data-search-input`,
that element exists on **six of sixteen** authed screens, and behind it sits a patients-only,
prefix-only query. On the other ten screens the hotkey does nothing at all. What was described as an
extension is a new kernel surface, and it is worth building as one.

It is worth building **now**, before Plan 09, for a reason that has nothing to do with search. The
2026-08-24 synthetic smoke test found screens that were dark because the client had no idea what the
signed-in person may do — `GET /auth/me` returns `{ actor }` and the shell renders sixteen nav links
to everybody, cashier and consultant alike. A command palette cannot be built without an effective-
permissions endpoint, and once that endpoint exists the nav bar stops lying. The palette is the UX
win; the permission projection is the operability repair that rides along, and it is a prerequisite
for every screen-poor role in the stage-2 Track B cohort.

The third reason is sequencing economics. Four modules ship search-shaped queries today, each
privately: patients has its own controller route, OPD has doctor and department pickers, billing
re-mounts the patient picker twice. Every stage-2 module (procurement, mini-OT, pharmacy, LIMS,
radiology) will want the same thing. Declaring search on the §4 manifest seam **now** means those
five plans add one array entry each instead of a screen each, and the middle-tail worklists of
deferred note 3's Lane 2 get their entry point for free. Retrofitting a registry after five more
modules have each grown a bespoke search box is the expensive order.

---

## 2. Ground truth — measured 2026-08-25 on the build host

**The hotkey.** [`apps/web/src/lib/keyboard.tsx:23`](../../../apps/web/src/lib/keyboard.tsx) —
`if (e.key === "/" && !isTypingTarget(e.target))` → `document.querySelector("[data-search-input]").focus()`.
Ten references to that attribute exist in `apps/web/src`; it is carried by exactly two elements —
`registration-desk.tsx:328` and `patient-picker.tsx:89`. `PatientPicker` is mounted by `opd-desk`,
`opd-appointments`, `billing-counter`, `billing-dues` and `merge-review`. **Six screens of sixteen
have any search at all; on the other ten `/` is a no-op.**

**What the search is.** `GET /patients/search` (`patients.controller.ts:164` →
`modules/patients/search.ts`): user actors only, `q.trim().length >= 2`, cap 50, three exclusive
branches — `^\d{3,14}$` searches `phone`/`altPhone` by prefix, a UHID *shape* matches exactly, all
else is a `lower(name) like 'x%'` prefix. LIKE metacharacters are escaped to literals. Confidential
rows are excluded **in the WHERE clause** unless the actor holds `patients.confidential.read`, and
ordering never touches the flag (D-37). A CI perf test pins it under 300 ms.

**The permission projection does not exist.** `GET /auth/me` returns `{ actor }`. 61 references
across 15 files consume it. `router.tsx` renders all sixteen nav links unconditionally.

**The confidential class is currently inert.** `CONFIDENTIAL_CAPTURE_ENABLED = false` (11g DD5)
because no production role holds `patients.confidential.read`. The sealed class this plan builds is
therefore correct-but-unexercised in production until the owner rules that grant.

**Database.** `hmis-prod-db-1` is PostgreSQL 16.14. Read-only query, 2026-08-25:
`pg_trgm` 1.6, `unaccent` 1.1, `fuzzystrmatch` 1.2 and `btree_gin` 1.3 are all **available and none
installed**. Live row counts: patients 20 · opd_doctors 3 · opd_departments 12 · invoices 5 ·
users 29 — pilot volumes, which is why §3 Q5 re-baselines perf against seeded data, not production.

**Config discipline.** `kernel/config.ts` parses the whole environment through one zod schema for
every caller of `loadConfig()`. The B1 scar stands: **anything this plan adds must carry a default**,
or CI and every existing `.env` break at once.

---

## 3. Spike — questions written before, answers measured in place (v3 §1.2)

**Q1 — The owner supplied a self-hosted OpenAI-compatible router for LLM work. Does it reach, what
does it route to, and how fast is it?**

**MEASURED 2026-08-25, and the answer changes a design decision.** `GET /v1/models` answers 200 with
**1,459 model ids** across ~60 provider prefixes. `POST /v1/chat/completions` works and returns
well-formed JSON for an intent-parse prompt. But:

| probe | routed to | outcome |
|---|---|---|
| `auto/fast` (streamed) | `meta/llama-3.2-3b-instruct` @ **nvidia** | ok · router-reported 8,033 ms · 21.9 s wall |
| `auto/fast` (non-stream) | same | ok, valid JSON intent · **33.3 s wall** |
| `auto/cheap` (1st) | `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` | ok · router-reported 762 ms · 10.1 s wall |
| `auto/cheap` (2nd) | — | **hard timeout at 60 s** |
| `pu/claude-haiku-4-5` | — | `model_cooldown`, retry in 93 s |
| `groq/*` | — | 404, no access on this key |
| `cerebras/*` | — | 402 payment required |

Three facts follow, and all three are load-bearing. **(a) "Self-hosted" describes the router, not the
inference** — the destination is a third-party provider chosen *per request* (nvidia, observed), so
the data processor cannot be named in advance, which is exactly what a DPIA must name. **(b) Latency
is 0.8–60 s with hard failures** — this is not an interactive path under any circumstance, and it
settles DD10. **(c) The reachable model set is a variable subset** of the advertised 1,459.

**Q2 — Does widening `GET /auth/me` break its 61 consumers?** The field is additive and no consumer
asserts an exact object shape on inspection. **To confirm at kickoff** by running `auth.e2e`,
`user-admin.e2e`, `credential-lifecycle.e2e` and the five web suites that stub the route, before
T6 writes a line.

**Q3 — Is fuzzy matching available without a new image?** **MEASURED: yes** — `pg_trgm` and
`unaccent` are available in the running production image and need only `CREATE EXTENSION` in a
migration. No Dockerfile change, no Elasticsearch, no second datastore.

**Q4 — What is the blast radius of changing what `/` means?** Ten references; the only test that
pins the current contract is `patient-picker.test.tsx` (3 assertions, self-documented as "the `/`
hotkey's only contract"). T8 rewrites those three to pin the new contract. Nothing else reads the
attribute at runtime.

**Q5 — What is the honest perf baseline?** `test/perf-patient-search.test.ts` exists and seeds its
own data; production has 20 patients, so production timing proves nothing. T7 re-baselines the
seeded test after the trigram indexes land, and T1 adds the same instrument for the federated route.

---

## 4. Design decisions

### DD1 — Search is declared on the §4 manifest seam, never imported across modules (RULED)

`ModuleManifest` gains `search?: SearchProviderSpec[]`. A provider is
`{ key, entity, permission, run(db, actor, parsed, limit, signal) }`. `kernel/search/registry.ts`
collects them at boot the way `syncPermissions` already walks `registry.all()`, and one route —
`GET /api/search` — fans out to **only** those providers whose declared permission the actor holds.

This is the seam that already exists for permissions and menus, and using it keeps three properties
the codebase paid for: the cross-module isolation lint stays satisfied (modules register, they never
import each other), a provider naming a permission no manifest declares fails at registry build the
way `grantPermissionToRole` already refuses one, and a stage-2 module adds search by adding an array
entry. **A provider that does its own permission check instead of declaring one is a defect** — the
declaration is what makes the fan-out decidable before any query runs.

### DD2 — The grammar is deterministic, lives in `packages/contracts`, and is parsed twice (RULED)

`@doctor`, `@patient`, `@dept`, `@bill`, `@appt`, `@staff`, `@room`, `@service`, `@approval` (plus
short aliases `@p`, `@dr`). Typing `@doctor Meh` filters doctors; Tab or Enter **resolves the text
into a chip carrying a real entity id**, and the trailing free text then searches inside that scope.
Chips AND together. Date words (`today`, `yesterday`, `this week`, and their Hindi forms) parse to a
range deterministically — that is the large majority of what reads as "natural language", and it
needs no model.

The parser lives in `packages/contracts` because **both sides parse**: the client parses to render
chips, the server re-parses the raw string to execute. The server never trusts the client's parse.
A digit string is not disambiguated by guessing — it is classified and *grouped* ("3 patients by
phone · 1 invoice · 1 token"), which is also the honest answer when the same digits mean two things.

**Context is an implicit chip:** opening the palette on a screen that owns a patient pre-fills
`[@patient <that patient>]`, so "last 3 bills" resolves without retyping a name.

### DD3 — Two invisibility classes: SEALED and RESTRICTED (RULED)

- **Sealed** — confidential/VIP patients for an actor without `patients.confidential.read`. Zero
  results, **zero count, no hint of any kind.** A "1 restricted match" row would leak the existence
  of the record, which is the entire purpose of the flag. Enforced in the WHERE clause, never as a
  post-filter, and ordering must be identical to the same query against a database without the row
  (the D-37 property, extended to every provider).
- **Restricted** — an ordinary record outside the actor's scope. A stub with the reason and a
  **break-glass** action; `useBreakGlass` already exists and already events, so this is a call, not
  a build.

The distinction is the whole privacy design: sealed protects the *patient* from the staff, restricted
protects the *record* from the wrong desk while leaving a lawful route in.

### DD4 — Search audit is a table with retention, not the event spine (RULED)

Every call to `GET /api/search` writes one row to `search_audit`: actor, timestamp, raw query text,
query hash, result counts by entity, and — on a follow-up call — which result was opened. **Zero-hit
queries are logged too**, because fishing is exactly what the log exists to catch.

It is deliberately **not** an event. The spine is append-only, replayed by the dispatcher, and sized
for ~330 semantic event types; a debounced palette would write to it on a rhythm no consumer wants
and no retention policy can prune. Three cases *do* append events, because they are semantic:
a restricted record surfacing, break-glass being used from the palette, and a sealed record being
returned to an authorised holder. Retention default **90 days**, wired to the existing retention
kernel, with the legal-hold path unchanged.

### DD5 — `GET /auth/me` gains scope-aware effective permissions (RULED)

`{ actor, permissions: string[], scopes: {...} }`, computed from `role_assignments` ⨝
`role_permissions` including live `temp_role_grants` — the same read `hasPermission` performs, not a
second implementation of the rule. Additive only. The palette uses it to render commands; `router.tsx`
uses it to stop rendering sixteen links to everyone. **The client-side list is presentation, never
enforcement** — every route keeps its `RequirePermission` guard exactly as today.

### DD6 — A barcode wedge anywhere in the app opens the patient (RULED)

The palette detects wedge-speed input (the 500 ms idle-buffer discipline already proven in
`patient-picker.tsx`) and routes the payload to `POST /patients/qr/verify` instead of the text search.
Scan a card on any screen, the patient opens. This is the single highest-value desk affordance in the
plan and it costs one branch, because both halves already exist.

### DD7 — `/` means the palette, everywhere, and the old contract is retired in the open (RULED)

One key, one meaning. `Ctrl+K` and `Alt+/` are aliases (both interceptable; `preventDefault` already
handles Firefox quick-find). The screen-level pickers keep their own autofocus and click/Tab
behaviour — they simply stop being the hotkey's target. `patient-picker.test.tsx`'s three assertions
are **rewritten, not deleted**: they pin the new contract, and the comment records that the old one
was intentional and superseded.

### DD8 — Latency is a contract, not an aspiration (RULED)

Per-provider budget **250 ms** via `AbortSignal`, fan-out with `Promise.allSettled`, first group
rendered under the §15 **300 ms** budget. A provider that times out marks its group `timedOut` and
the palette shows the rest — **one slow provider must never hold the palette**. Caps: 5 rows per
entity before "show all", minimum 2 characters, per-actor rate limit, no bare-wildcard query. The
palette must not become a patient-list exporter.

### DD9 — Fuzzy matching lands with the module, not after it (RULED)

`CREATE EXTENSION pg_trgm, unaccent` plus GIN trigram indexes, and a normalization pass (case,
diacritics, whitespace, Devanagari→Latin transliteration) applied identically at write and query
time. Asha / Aasha / Aashaa / आशा must find one person. This is in scope rather than deferred because
retrofitting it means a second migration, a second index build and a second perf baseline over the
same tables — and because a search that only matches exact prefixes of Indian names will be worked
around at the desk within a week.

Prefix matching stays the **first** branch (it is exact and cheap); trigram similarity is the
fallback that fills an otherwise-empty result set, ranked below exact hits and visibly labelled.

### DD10 — The natural-language lane is SPECIFIED HERE AND BUILT LATER (RULED)

The design is settled; the build is not in this phase. What is ruled:

1. **Shape.** NL → *structured intent*, never NL → *answer*. A deterministic local pass extracts
   entities first and replaces them with tokens, so only a skeleton leaves the building —
   `"unpaid bills for <PATIENT_1> since <DATE_1>"`. The model returns
   `{intent, entities, filters}`, the local resolver substitutes real ids, and **a DD1 provider
   executes it under the caller's RBAC**. The model sees no record, no name, and never composes an
   answer. This is the only shape compatible with the standing design law — *identified PHI never
   enters an inference request, any stage, any locus, ever* (plan-series § inference locus, ruled
   2026-08-23) — and Q1's measurement is why that law is load-bearing rather than ceremonial: the
   router's destination provider is chosen per request.
2. **It never blocks.** Deterministic results render immediately; the interpretation appends when it
   arrives, and is **abandoned at 3 s**. Q1 measured 0.8–60 s with a hard timeout and a cooldown
   refusal, so the fast path cannot depend on it and the feature must be correct when it never
   answers at all.
3. **propose→confirm.** The palette renders the structured action it intends; the human's Enter *is*
   the API call. Plan 04's approval ladders can never be bypassed by an interpretation.
4. **Where the code lives.** The `InferenceClient` interface belongs to Plan 12a. This phase does not
   write a second one. When the NL lane is built it consumes 12a's client with an
   OpenAI-compatible implementation configured by `INFERENCE_BASE_URL` / `INFERENCE_API_KEY` /
   `INFERENCE_MODEL`, all three **defaulted to empty** per the B1 scar, with the lane inert unless all
   three are set. **The owner's endpoint URL and key are deliberately NOT recorded in this repository
   — it is public.** They live in `/opt/hmis-prod/.env` (gitignored) and were supplied out-of-band.
5. **What must be true before it activates:** the DPIA amended to describe a router whose
   sub-processor varies per request, a model pinned rather than `auto/*` (Q1: `auto/*` chose a
   different provider on consecutive calls), and a measured p95 under 3 s.

**NL → answer synthesis over retrieved records is refused, not deferred.** It requires PHI in the
prompt; Class 2 is not an inference input under the current law. Revisiting it is a DPIA question,
not a UI question.

### DD11 — Voice is deferred, and the reason is asymmetric (RULED)

Text can be tokenized before it leaves; **audio cannot**. Any ASR path — the browser's Web Speech
API (which streams to Google in Chrome) or the router's own `groq/whisper-large-v3-turbo`, which
Q1 confirms is on the menu — sends the raw utterance, patient name included, to a third party. That
is a straight breach of the same design law DD10 is built to satisfy, and no amount of downstream
redaction repairs it.

The recommendation stands: **on-prem ASR** (whisper.cpp, small multilingual model, English + Hindi)
on the existing box before any microphone appears in this product, with "voice off at open counters"
as the shipped default because dictating a name across a crowded desk is its own confidentiality
failure. **No mic icon ships in 11h.**

---

## 5. Tasks

Eight, sequential. T1 gates everything; T6 and T8 wait for 11g to merge (§ THE LANE, frozen paths).
CRITICAL tasks carry their Assertion Book rows inline — assertion · mutant · discriminating input.
ROUTINE tasks carry none.

### T1 — CRITICAL — the search registry, the manifest seam, and one federated route

**Files:** `apps/core/src/kernel/modules/manifest.ts` · `apps/core/src/kernel/search/types.ts` ·
`apps/core/src/kernel/search/registry.ts` · `apps/core/src/kernel/search/registry.test.ts` ·
`apps/core/src/kernel/search/search.controller.ts` · `apps/core/src/kernel/search/search.module.ts` ·
`apps/core/src/kernel/search/manifest.ts` · `apps/core/src/app.module.ts` ·
`packages/contracts/src/search.ts` · `apps/core/test/search.e2e.test.ts`

**Acceptance.** `GET /api/search?q=&types=&limit=` returns `{ groups: [{entity, hits, total,
timedOut, restricted}], took }`. Fan-out runs only providers whose declared permission the actor
holds. Per-provider `AbortSignal` at 250 ms. Zero registered providers is a valid empty answer, not
a 500. A provider declaring a permission absent from `registry.allPermissions()` fails registry
construction with the same class of error `grantPermissionToRole` already throws.

| assertion | mutant | discriminating input |
|---|---|---|
| A provider whose permission the actor lacks is **never invoked** — not filtered afterwards | run every provider, then drop unauthorised groups from the response | a cashier (no `patients.read`) searching `asha`: a counting spy on the patients provider must read **0 invocations**; the mutant reads 1 while returning the same JSON |
| One slow provider does not delay the response past its budget | `Promise.all` instead of `allSettled` + timeout | a provider that sleeps 2,000 ms alongside two fast ones — the response must arrive < 400 ms with that group `timedOut: true`; the mutant takes > 2 s |

**Commit:** `feat(core): search is declared on the module manifest and served by one federated route (11h T1)`

### T2 — CRITICAL — the patients provider, with the sealed class enforced in SQL

**Files:** `apps/core/src/modules/patients/search-provider.ts` ·
`apps/core/src/modules/patients/search-provider.test.ts` ·
`apps/core/src/modules/patients/manifest.ts` · `apps/core/src/modules/patients/index.ts`

**Acceptance.** Wraps the existing `searchPatients` branch logic rather than reimplementing it —
phone/UHID/name, escaped LIKE, `user_actor_required`. Adds the DD3 classes: sealed rows absent from
hits *and* totals; restricted rows returned as stubs carrying a reason and a break-glass affordance.
`GET /patients/search` keeps working unchanged for the six screens that use it — this task adds a
caller, it does not migrate one.

| assertion | mutant | discriminating input |
|---|---|---|
| A sealed row changes neither the result set nor the count nor the ordering | filter confidential rows in JS after the query and decrement the count | one confidential + one ordinary row both matching `syn`: `total` must equal 1 and the ordering must be byte-identical to the same query run against a table where the confidential row does not exist |
| LIKE metacharacters stay literal | drop `escapeLike` | `a%` must match nobody; the mutant returns every patient whose name starts with `a` |

**Commit:** `feat(core): the patients search provider, with sealed and restricted result classes (11h T2)`

### T3 — ROUTINE — OPD providers: doctors, departments, appointments

**Files:** `apps/core/src/modules/opd/search-providers.ts` ·
`apps/core/src/modules/opd/search-providers.test.ts` · `apps/core/src/modules/opd/manifest.ts` ·
`apps/core/src/modules/opd/index.ts`

**Acceptance.** Three providers on `opd.masters.read`, `opd.masters.read` and
`opd.appointments.read`. Doctor and department hits resolve `@dr` / `@dept` chips to ids. Appointment
hits respect an already-resolved patient or doctor chip as a scope, and default to a ±7-day window
when no date chip is present.

**Commit:** `feat(core): OPD search providers — doctors, departments and appointments (11h T3)`

### T4 — ROUTINE — billing and tariff providers

**Files:** `apps/core/src/modules/billing/search-provider.ts` ·
`apps/core/src/modules/billing/search-provider.test.ts` ·
`apps/core/src/modules/billing/manifest.ts` · `apps/core/src/modules/tariff/search-provider.ts` ·
`apps/core/src/modules/tariff/manifest.ts`

**Acceptance.** Invoices and receipts by document number and by resolved patient chip, on
`billing.invoice.read`; services by name/code on `tariff.read`. Amounts render through the existing
money formatting — the palette never does its own arithmetic on paise.

**Commit:** `feat(core): billing and tariff search providers (11h T4)`

### T5 — CRITICAL — the search audit table, its writer, and the three evented cases

**Files:** `apps/core/src/kernel/db/schema/search.ts` · `apps/core/src/kernel/db/schema/index.ts` ·
`apps/core/drizzle/<generated>.sql` · `apps/core/src/kernel/search/audit.ts` ·
`apps/core/src/kernel/search/audit.test.ts` · `apps/core/src/kernel/retention/*` (registration only) ·
`apps/core/src/kernel/search/events.ts`

**Acceptance.** One row per search call, including zero-hit calls; an `opened` follow-up records
which hit was taken. 90-day retention registered with the existing sweep, legal holds honoured.
Events appended **only** for: a restricted stub surfacing, break-glass from the palette, and a
sealed row returned to an authorised holder.

| assertion | mutant | discriminating input |
|---|---|---|
| Every search writes exactly one audit row, whatever the outcome | write the row only when `hits.length > 0` | a query matching nothing — the row must exist, because zero-hit fishing is the pattern the log exists to catch |
| Ordinary searches append no event | append on every search | 10 ordinary searches then 1 restricted-surfacing search: the events table must gain exactly 1 row |

**Commit:** `feat(core): search is audited to its own table, with three cases that also earn an event (11h T5)`

### T6 — CRITICAL — `/auth/me` returns scope-aware effective permissions

**Files:** `apps/core/src/kernel/auth/auth.controller.ts` ·
`apps/core/src/kernel/auth/permissions.ts` · `apps/core/src/kernel/auth/permissions.test.ts` ·
`apps/core/test/auth.e2e.test.ts` · `apps/web/src/lib/auth.tsx` · `apps/web/src/router.tsx`

**Acceptance.** Additive field; the 61 existing consumers keep working (Q2 confirmed at kickoff
before a line is written). Computed from the same read `hasPermission` performs, temp grants
included. The shell filters its nav to permitted entries. Guards on every route are untouched.

| assertion | mutant | discriminating input |
|---|---|---|
| The list is **scope-aware**, not a flat role→permission join | return every permission from `role_permissions` for the user's roles, ignoring `role_assignments` scope | a user holding a department-scoped role only: a hospital-scoped permission of that role must be **absent** from the list, and `hasPermission(..., "hospital")` must agree with the list for every declared permission |

**Commit:** `feat(core,web): /auth/me carries effective permissions, and the nav stops lying (11h T6)`

### T7 — ROUTINE — normalization, trigram indexes, and an honest perf baseline

**Files:** `apps/core/drizzle/<generated>.sql` · `apps/core/src/kernel/search/normalize.ts` ·
`apps/core/src/kernel/search/normalize.test.ts` · `apps/core/src/modules/patients/search.ts` ·
`apps/core/test/perf-search.test.ts`

**Acceptance.** `CREATE EXTENSION IF NOT EXISTS pg_trgm, unaccent` (Q3: both available in the running
image). GIN trigram indexes on the name columns the providers search. Exact-prefix stays the first
branch; similarity is the labelled fallback when the prefix branch is empty. `Asha` / `Aasha` /
`आशा` find one person, proven by test. p95 < 300 ms for the federated route against seeded volume,
in the shape of the existing `perf-patient-search` instrument.

**Commit:** `feat(core): trigram fallback and name normalization, so spelling variance stops hiding patients (11h T7)`

### T8 — CRITICAL — the palette itself

**Files:** `apps/web/src/components/command-palette.tsx` ·
`apps/web/src/components/command-palette.test.tsx` · `apps/web/src/lib/search-api.ts` ·
`apps/web/src/lib/keyboard.tsx` · `apps/web/src/router.tsx` ·
`packages/contracts/src/search-grammar.ts` · `packages/contracts/src/search-grammar.test.ts` ·
`apps/web/src/locales/en.json` · `apps/web/src/locales/hi.json` ·
`apps/web/src/components/patient-picker.test.tsx` (contract rewrite, DD7)

**Acceptance.** `/`, `Ctrl+K`, `Alt+/` open it from any authed screen; `Esc`, blur and the session
idle timer close it. `@` grammar with resolved chips (DD2), implicit context chip, grouped results
with per-entity caps, arrow/Enter keyboard model, per-row action lists gated by T6's permissions,
commands and navigation as first-class results. Phone masked to last 4 in rows, full value only on
open. Recents in session memory only — **never `localStorage`**, these are shared counter machines.
Backdrop blur with a solid-scrim fallback under `prefers-reduced-motion`. Focus trap, `aria-live`
result counts, both locales. In `degraded`/`downtime` operating mode the palette opens, says so, and
offers the downtime kit instead of spinning on a dead API.

| assertion | mutant | discriminating input |
|---|---|---|
| `/` opens the palette on screens with no search input, and never fires while typing | drop the `isTypingTarget` guard | typing `/` inside the consultation note: the note must receive the character and the palette must stay closed; the mutant swallows it |
| Wedge-speed input goes to QR verify; human-speed input does not | route every input to `POST /patients/qr/verify` | the same 24-character payload delivered in 100 ms vs. typed over 3 s — verify must be called exactly once, for the first |

**Commit:** `feat(web): the command palette — one key, every entity the signed-in person may see (11h T8)`

---

## 6. Routed to the owner — NOT this phase's, named so they are not lost

1. **`patients.confidential.read` — who holds it.** Still open from 11g DD5. Until a role holds it,
   the sealed class is correct and unexercised, and confidential capture stays off at the desk.
2. **Search-audit retention.** 90 days is this plan's default (DD4). NABH review may want twelve
   months; changing it later is a config edit, not a migration, so the default ships either way.
3. **The DPIA amendment that gates the NL lane.** Q1 measured that the supplied router selects a
   third-party provider *per request*. A DPIA that must name processors cannot name that one. Before
   any NL activation: pin one model, name its provider, and record the redaction gate as the control.
4. **Voice.** DD11 defers it. Reversing that needs an explicit owner ruling that raw audio may leave
   the building, because unlike text it cannot be redacted first. Recommended alternative on the
   table: on-prem whisper, no new hardware.
5. **The roadmap line.** `plan-series.md` § Sequencing notes gains 11h between 11g and 09 — deferred
   to 11g's close to avoid editing a file a running phase owns.

---

## 7. CLOSE — appended as the phase runs (v3 §1.5)

*(empty until execution is authorised)*
