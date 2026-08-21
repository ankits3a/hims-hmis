# Phase 1 / Plan 10 — The Notifications Gateway: outbox, pump, templates, ladder, and the consumer that speaks to people · Implementation Plan

> **For agentic workers:** this plan is design law for the pipeline that executes it (EXECUTE-METHOD
> v2). Every agent reads [`AGENT-RULES.md`](../AGENT-RULES.md) and this document, nothing else.
> Written 2026-08-21 at `2de3c2e`, from the brainstorm the same day; prompt:
> `reports/PLAN-10-PROMPT-2026-08-21.md`. **No pipeline is compiled and nothing is executed by the
> session that wrote this** — that separation is deliberate and has paid twice.

> **STATUS: SHIPPED 2026-08-22.** Six tasks, `48f118e`..`b6d5647`, all gate-passed on the first
> rung. Compiled and executed by a fresh session per `reports/PLAN-10-EXECUTE-PROMPT-2026-08-21.md`;
> pipeline `../pipelines/plan-10-notifications.js`. **The gate report is the ground truth for what
> shipped, and it is not an unqualified pass:** [`reports/plan-10-gate-report.md`](reports/plan-10-gate-report.md)
> books two MAJOR gaps in protection (the suppression gauntlet's ORDER is unpinned; `NOTIFY_STUCK_AFTER_MS`
> is a dead key) and one UNDISCHARGED CI criterion (T2's commit has no CI run at all). Read it before
> building on this surface. Amendment 7 below was landed by the compiling session, not the author.

> **AMENDMENT 7 — 2026-08-21, by the COMPILING session, before any brief was written
> (EXECUTE-METHOD §3 sweep items 1–2; §2.46 crossed with §2.54 and §2.47).**
> **The contradiction:** T4 registers a seventh `Scheduler` job and widens `JobIntervals`. Three
> shipped artefacts break the instant it does, and NEITHER file that holds them was in T4's Files
> list — so under §2.25 the generated frozen block would have told T4 the correct action was the
> forbidden action, exactly as it told 08.5's T4, and T4's own `pnpm verify` could not have been
> green:
> · `apps/core/src/kernel/worker/scheduler.test.ts` — in **no** task's Files list, therefore frozen
>   to all six. It holds `THE_SIX` (:104), `spyOnTheSix` (:74) and — the one nothing but a
>   typechecker finds — `const CENSUS_INTERVALS: JobIntervals = { …three keys }` (:184), an object
>   LITERAL that stops compiling the moment the `Pick` widens.
> · `apps/core/test/worker-runtime.e2e.test.ts` — its own `THE_SIX` (:89) and
>   `expect(scheduler.jobs()).toEqual(THE_SIX)` (:326). That file was **T5's**, one wave later.
> **And the plan named the wrong file for the work:** T4 step 3 said *"the census in `jobs.test.ts`
> grows to seven names"*. `jobs.test.ts` holds no job-name census at all — it tests only
> `buildSubscriptionBus`. Write-from-memory, §2.46's exact class, in a document whose own §7.1 sweep
> had already caught one of these.
> **The resolution — no task added, no design touched, D1–D14 untouched:** T4's Files list gains
> both files; T4 step 3 names the real censuses; `test/worker-runtime.e2e.test.ts` becomes a
> deliberate TWO-OWNER file across the SEQUENTIAL waves 3 → 4 (T4 grows the job census, then T5
> grows the pairs census), carried forward explicitly in both briefs per §3.2; self-review item 7's
> "none" is corrected in place rather than left standing. T5 step 5 additionally now names the two
> `registerAllJobs(...)` call sites that installing `notifyManifest` turns into boot errors.
> The pipeline script's `files` arrays are updated in this same commit (§2.54).

## Owner rulings reached in the brainstorm (2026-08-21, in conversation) — the plan encodes them

1. **SPLIT (prompt §6.1 option a).** Plan 10 is the **notifications gateway only**. The public read
   surface (`apps/relay`, signed tokens, queue-position and document-verification pages) is **out**,
   by explicit owner ruling — not editorial scoping. It moves to where the topology decision lives
   (Plan 10.5 or joins Plan 11 — owner decision listed below). E-1 (DMZ vs cloud relay, spec line
   793) remains an OPEN pre-go-live gate; nothing in this plan forecloses either answer. Patients
   still get WhatsApp/SMS confirmations at go-live (§17 step 1); the live queue-position *link* and
   document-verification page arrive with the relay's plan, still before go-live since Plan 11
   precedes it.
2. **Promotional opt-in: FIELD NOW, SENDING STRUCTURALLY OFF (prompt §6.4).** Migration `0015` adds
   `patients.promotional_opt_in` (default **false** — not opted in), captured at registration and
   editable on the patient record (that is the DPDP revocation path). The gateway **refuses
   promotional-class messages entirely** — mutant-enforced, the external-RMP-payout shape. Every
   patient registered from go-live day one has a recorded consent answer; the send path switches on
   only when the CRM phase builds it, and THAT plan owns replacing the refusal with the opt-in check.
3. **NO SPIKE.** The prompt's strongest candidate (the relay's process topology, the `tsx` trap)
   left with the relay. What remains reuses shipped, measured patterns end to end: the pump is
   `runDueTimers`' conditional-claim shape on 08.5's own `Scheduler`; the consumer is
   `alertsConsumer`'s idempotency shape; config is D9's zod defaults; the wiring is amendment 6's
   seam. No new dependency, no new process, no new entrypoint, no fork that a measurement would
   resolve — so no assertion in this plan is one nobody has executed. Stated here so the departure
   from the prompt's "probably yes" is auditable.
4. **Replay defense in depth (prompt §5.3), ruled explicitly:** a structural staleness guard in the
   gateway (D5, mutant-enforced) **plus** the Plan 11 deployment step (cursor seeded at `max(seq)`
   when a consumer is first wired — Plan 11's existing note gains `kernel.notify` beside
   `kernel.alerts`). Dispatcher cursor semantics are untouched (prompt trap 6).
5. **Claim-before-send** (D2) and **desk flag via the alerts consumer** (D6) were stress-tested and
   approved in the brainstorm review.

**What ships when this ships:** the system speaks to someone outside the building for the first
time — through a console sink. The machinery is real end to end: registration enqueues a welcome,
a booking enqueues a confirmation and a reminder, an exhausted escalation reaches for the owner's
phone, quiet hours hold the routine and pass the urgent, a deceased patient's family is structurally
unreachable, and a phoneless patient becomes a human task at the desk instead of a silent failure.
When a provider is selected (§19, procurement — see Decisions), one adapter file changes and
nothing else does.

---

## Design (the decisions this plan makes — read before the tasks)

### D1. One half of the roadmap entry, by owner ruling — and what the gateway is

The gateway is four cooperating pieces, all in `apps/core`, all riding 08.5's worker:

- an **outbox** (`notifications` table) that every would-be message becomes a row in first;
- a **pump** — the seventh job on the shipped `Scheduler` — that claims due rows, applies the
  suppression gauntlet, renders, and hands to a channel adapter;
- a **template registry** (code, versioned, typed) that owns per-message class, audience, urgency,
  staleness and both languages;
- a **consumer** (`kernel.notify`) on the shipped dispatcher that turns events into outbox rows and
  nothing else.

No human flow ever blocks on any of it (Global Constraint 1): modules and consumers only ever
INSERT a row; sending happens on the worker's clock. The relay, IVR, `notification.delivered`,
promotional sending, the digest producer (12a), and provider selection are all explicitly NOT here
(D14).

### D2. The outbox claims BEFORE the adapter call — deliberately the OPPOSITE of the dispatcher, and the mirror of billing

The dispatcher records its delivery claim **after** the handler succeeds (dispatcher.ts:102-115)
because its nightmare is **losing an event**. This surface's nightmare is the mirror image: a
WhatsApp message cannot be un-sent, so the gateway's nightmare is **sending twice**. The pump
therefore claims first — `UPDATE … SET status='sending' WHERE id IN (SELECT … FROM notifications
WHERE status='queued' AND due … FOR UPDATE SKIP LOCKED) RETURNING …` — then calls the adapter, then
flips the row to `sent` (guarded `WHERE status='sending' … RETURNING`; only a won flip appends
`notification.sent`, so a crash-retry of completion appends once). All three claim placements in
the codebase now exist with stated reasoning: billing before (a second receipt is a real document),
dispatcher after (silent loss is the defect it exists to remove), gateway before (a second message
is a real message). The contrast is the decision; Assertion Book N4 is its mutant.

**A crash between adapter-accept and the `sent` flip leaves the row `sending`.** Recovery policy,
ruled: a `sending` row older than `NOTIFY_STUCK_AFTER_MS` (default 300 000) is flipped to
`undeliverable` with `notification.failed(reason: "stuck_sending")` and, for patient audience, the
D6 desk flag — **it is never automatically re-sent**, because the message may already be with the
patient and only a human can find out (N14). Exactly-once at a provider boundary is not achievable
without provider-side idempotency keys; this is the honest local optimum, and the plan says so.

### D3. The pump is a Scheduler job; correctness NEVER rests on the advisory lock (08.5 D3 inherited)

`runNotifyPump(db, opts?: { batchSize?, maxAttemptsPerRung?, stuckAfterMs?, now? })` registers in
`registerAllJobs` as `every: workerNotifyIntervalMs` (default 5000). The advisory lock keeps two
workers from burning the same cycles; the per-row `FOR UPDATE SKIP LOCKED` claim carries the
correctness, exactly as the six sweeps carry their own. No test observes the lock (§3.21's class).
Every row processes inside its own try/catch — one poison row never stalls the batch — and a
**render error is not a channel failure**: it goes straight to `undeliverable` +
`notification.failed(reason: "render_error")`, never through the ladder (retrying render cannot fix
params).

### D4. Contact truth is read at SEND time, never snapshotted at enqueue

The outbox stores `patient_id` / `user_id` + template + params. Phone, language, deceased state and
merge state are resolved by the pump at send: a number corrected at the desk after enqueue is used;
a phone added while a message waits un-strands the patient; a patient marked deceased after enqueue
is still suppressed. A `status='merged'` patient resolves through `merged_into_patient_id`
(bounded, ≤5 hops; an unresolved or cyclic chain suppresses with reason `merge_unresolvable` —
defensive, should not exist). The **suppression gauntlet**, in order, at claim time:

1. `expires_at <= now` → `expired` + `notification.expired` (D5 — checked first: a stale message is
   dead no matter what else is true);
2. patient `deceased_at IS NOT NULL` → `suppressed` + `notification.suppressed(reason:"deceased")`
   — **the D-33 hard stop; beats urgency, beats everything; CRITICAL mutant N1**;
3. template class `promotional` → `suppressed(reason:"promotional_blocked")` — belt to D9's
   enqueue-time refusal;
4. quiet-hours deferral (D7) — not a suppression: row returns to `queued`,
   `next_attempt_at` = next 08:00 IST, no attempt counted;
5. channel resolution (D6) — phoneless patient jumps to the desk-flag rung.

The suppression events are the audit trail that proves the stops fired — `notification.suppressed`
is how a later reviewer sees the deceased check working, not just believes it.

### D5. Staleness: every template computes its own expiry from the event's time — and `DispatchedEvent` gains `occurredAt`

`expires_at` is computed **at enqueue** by the template — `expiresAt(params, occurredAt): Date` —
anchored on the message's *meaning*, never on elapsed-time-since-enqueue: a confirmation and a
reminder both die when the appointment's `slotStart` passes; a welcome dies 24 h after
registration; escalation messages die 4 h after the event. This is why quiet hours compose (a
confirmation booked at 21:05 for tomorrow holds overnight and sends at 08:00, still valid) and why
replay is safe (a replayed last-month booking expires instead of sending). A replayed event for a
**still-future** appointment enqueues and sends — a late confirmation is correct behaviour, and its
volume is bounded by the future-appointments count; noted, accepted.

The anchor requires the event's time, and `DispatchedEvent` does not carry it
(subscriptions.ts:1-8). **This plan widens the envelope**: `occurredAt: Date`, from
`events.occurred_at` (schema/events.ts:10, NOT NULL). In `dispatcher.ts` that is one added select
column (`e.occurred_at as "occurredAt"` at the :140-151 query), one `WindowRow` field, one line in
the `DispatchedEvent` construction (:173-180). **This is NOT prompt-trap-6 territory and the plan
is explicit about why:** the window predicate, the claim placement, the cursor arithmetic and the
backoff (:146, :206-214, :221-226, :37) are untouched — byte-identical — and the one-WHERE-chain
shape (Global Constraint 7 of 08.5) is preserved. The alternative (each consumer re-reading the
events row by id) buys a per-event query to avoid completing a projection the §10.5 envelope
already promises. Existing consumers ignore the new field (structural typing); N11 pins it.

### D6. The ladder is AUDIENCE-DEPENDENT, and its last patient rung is a human at a desk

- **Patient:** WhatsApp → SMS → **manual-notify desk flag**. IVR has no adapter until the CRM phase
  and the ladder **skips it, stated here** rather than silently. A patient with `phone IS NULL`
  (D-34, the designed path) enters at the desk-flag rung directly — zero adapter calls, N9.
- **Staff / owner:** WhatsApp → SMS → **evented stop.** No desk flag — 08.5's D6 already guarantees
  the in-app alert exists for every escalation, so the external channel is additive by design; a
  phoneless owner degrades to exactly what ships today. A template may narrow its ladder
  (`channels: ["sms"]` for `owner_escalation_sms` — fix 11 names SMS).

Rung mechanics: `attempts` counts failures on the current rung; at `maxAttemptsPerRung` (3) the
rung advances and attempts reset; adapter-failure backoff is `min(2^attempts, 60) s` via
`next_attempt_at` (the dispatcher's own curve, one convention). Ladder exhausted (or no phone) →
`undeliverable` + `notification.failed`.

**The desk flag reuses D6-08.5's machinery instead of duplicating it.** The pump only appends
`notification.failed` (payload: notificationId, templateKey, audience, reason, refType, refId; the
envelope carries patientId as events already do). `alertsManifest` gains a second subscription —
`{ event: "notification.failed", consumer: "kernel.alerts" }` — and `alertsConsumer` gains a branch
on `e.name`: for `audience === "patient"` it fans to `usersHoldingRole(tx, "duty_manager")` (no
front-desk role is seeded today — measured; the constant is one line to change when one is), kind
`manual_notify`, title built **from `templateKey` only**, `refType: "patient"`, `refId: patientId`
— an id, not an identity; the desk reaches the patient through permission-checked routes, the same
rule and the same mutant-class as 08.5's L8/M-A2. Alert uniqueness keys on the **`notification.failed`
event's id**, so it cannot collide with escalation alerts on the same source event. Staff/owner
failures raise no desk flag (`audience !== "patient"` returns).

### D7. Quiet hours: 21:00–08:00 IST, one pure function, patient-routine only

`quietHoursDeferral(template, audience, now: Date): Date | null` in the pump — the ONLY place the
rule exists (prompt §6.5: one place, not three). Applies iff `audience === "patient"` AND
`template.urgency === "routine"`. Urgent templates ignore it by design (§11.13); staff messages in
Phase 1 are escalation-driven and therefore interrupt-class (the anti-alarm-fatigue boundary:
digests are 12a producers, not this plan); the owner matrix is real-time always. Bounds are code
constants (design law, not knobs). IST is UTC+5:30, no DST; the window wraps midnight; the boundary
instants are Assertion Book N5 and are **marked as §7.4 predictions** — 08.5's L14 is exactly the
lesson that a `>=` boundary input is a claim until a mutant dies on it.

### D8. Templates: a versioned code registry; both languages enforced by the type system

```ts
type NotificationTemplate = {
  key: string;                                   // grammar: snake_case, audience-prefixed
  version: number;                               // bumped on any render change
  class: "transactional" | "promotional";
  audience: "patient" | "staff" | "owner";
  urgency: "routine" | "urgent";
  channels?: ("whatsapp" | "sms")[];             // default ["whatsapp", "sms"]
  waApprovalStatus: "not_submitted" | "pending" | "approved" | "rejected"; // data for §19, later
  expiresAt(params: Record<string, unknown>, occurredAt: Date): Date;      // D5
  render: Record<"hi" | "en", (params: Record<string, unknown>) => string>; // both, or no compile
};
```

`Record<"hi" | "en", …>` is the enforcement — a template missing a language does not typecheck.
Patient language is read from `patients.language` at send (`'hi' | 'en'`, default `'hi'`,
patients.ts:52 — the outbound-message language by its own comment); staff/owner render `en`.
The **starter catalog is only templates with live producers** (five):

| key | audience | urgency | expiry anchor | params (exactly the event payload's fields) |
|---|---|---|---|---|
| `patient_welcome` | patient | routine | occurredAt + 24 h | uhid |
| `appointment_confirmed` | patient | routine | slotStart | serviceDate, slotStart |
| `appointment_reminder` | patient | routine | slotStart | serviceDate, slotStart |
| `staff_escalation` | staff | urgent | occurredAt + 4 h | defKey, state, rung, role |
| `owner_escalation_sms` | owner | urgent | occurredAt + 4 h | defKey, state, rung, role |

Params carry **only payload fields** — no doctor-name or patient-name lookups: the consumer is
kernel code and imports no module's tables (Global Constraint 12), and staff/owner bodies carry no
patient identity anyway (N10, the L8 rule extended to outbound text). Message copy is short,
factual, and bilingual; the exact strings are the template task's to write and the registry test
pins that `hi` renders contain Devanagari (flag ④). Versioned WhatsApp approval tracking is a
**field**, not a workflow — the workflow arrives with the provider.

### D9. DPDP: the promotional refusal is structural, and its assertion has a leg that can fail

`enqueueNotification` **throws** on `class === "promotional"` (N2's mutant). The shipped catalog
contains zero promotional templates, so per §2.49 that check alone would be vacuous — the test
therefore has the amendment-6 two-leg shape: **(a)** the discriminating leg registers a SYNTHETIC
promotional template in a test-local registry and asserts the refusal fires; **(b)** the honest pin
asserts the real catalog contains none. `patients.promotional_opt_in boolean NOT NULL DEFAULT
false` is captured at registration (checkbox, default unchecked — opt-IN means the patient acted)
and editable via the existing `PATCH /patients/:id` (patients.controller.ts:247) — revocable, per
§11.13. No opt-in check exists in the send path yet **by design**: there is nothing it could
correctly gate (no promotional message can exist), and a check nothing exercises is §2.49's class.
The CRM plan replaces refusal-with-mutant by check-with-mutant; this sentence is its pointer.

### D10. D-33 deceased: the column, the hard stop, and how the flag gets set before IPD exists

`patients.deceased_at timestamptz NULL` (migration 0015). The gauntlet checks it at send (D4, N1 —
CRITICAL). **Nothing in the schema records death today — measured, not assumed** (zero matches for
deceased/died across `apps/core/src`); Phase 1 has no death-recording flow, so the flag is settable
on the existing patient-master edit surface: `PATCH /patients/:id` gains `deceasedAt: string |
null` (ISO), the shipped update path diffs it into `patient.updated`'s `changes` array
(patients/events.ts:30-42) so marking and UN-marking are both audited, and `patient-detail.tsx`
surfaces it behind the route's existing permission (no new permission is minted). IPD's death
cascade will WRITE this column later; the gateway's check is live from the first message.

### D11. Adapters: two interfaces, console implementations, and honest `sent` semantics

```ts
type ChannelAdapter = {
  channel: "whatsapp" | "sms";
  send(to: string, text: string, meta: { notificationId: string }): Promise<{ providerMessageId: string | null }>;
};
```

`consoleWhatsappAdapter` / `consoleSmsAdapter` log a structured line and return `{
providerMessageId: null }`. Selection: `NOTIFY_PROVIDER` zod-enum `["console"]` default
`"console"` — no `.env` change anywhere (D9-08.5 pattern); the enum widens when a provider lands,
and that provider's credential keys enter the schema **required-only-when-selected** (zod
refinement), so nothing secret exists in a repo that is public today. **`notification.sent` means
"the selected adapter accepted the message" — with the console sink that is a statement about the
gateway, not about delivery, and this plan says so out loud** (prompt §6.2): the golden path
asserts `sent` against the console implementation, `notification.delivered` is deliberately NOT
defined (an event with zero possible producers is §2.49's class), and it arrives with the provider
integration alongside the delivery-callback route.

### D12. Events: four names, all with producers — `notification.sent` / `.failed` / `.suppressed` / `.expired`

`kernel/notify/events.ts`, module `notify`, `entity.verb_past`, full envelope via `defineEvent`.
Payloads: `sent` {notificationId, templateKey, templateVersion, audience, channel, providerMessageId};
`failed` {notificationId, templateKey, audience, reason, refType, refId} (reasons:
`ladder_exhausted` | `no_phone` | `render_error` | `stuck_sending`); `suppressed` {notificationId,
templateKey, audience, reason: `deceased` | `promotional_blocked` | `merge_unresolvable`};
`expired` {notificationId, templateKey, audience}. Catalog additions, no version bumps, no
per-tick events. The envelope's own `patientId` column carries patient linkage where it exists —
payloads do not duplicate it.

### D13. The consumer: `kernel.notify` enqueues and does nothing else

`notifyConsumer(db): Handler`, `NOTIFY_CONSUMER = "kernel.notify"`, subscriptions (manifest +
handler, both halves, one task — amendment 6 binds it):

| event | action | dedupe key |
|---|---|---|
| `patient.registered` | enqueue `patient_welcome` | `n:{eventId}:patient_welcome:{patientId}` |
| `appointment.booked` | enqueue `appointment_confirmed`; enqueue `appointment_reminder` with `scheduledFor = slotStart − 24 h` when that instant is still ≥ 1 h ahead of `occurredAt` | `n:{eventId}:{templateKey}:{patientId}` |
| `appointment.rescheduled` | expire queued rows with ref (`appointment`, fromAppointmentId); enqueue both for the new slot | as booked, on the new event |
| `appointment.cancelled` | expire queued rows with ref (`appointment`, appointmentId) | — |
| `escalation.triggered` | enqueue `staff_escalation` per id in `resolvedUserIds`; when `fallbackExhausted` — **the owner-SMS half of fix 11, landing here as consumer.ts:18 promises** — enqueue `owner_escalation_sms` per holder of role `owner` (`usersHoldingRole`) | `n:{eventId}:{templateKey}:{userId}` |

Every enqueue is `ON CONFLICT (dedupe_key) DO NOTHING` — redelivery (D4-08.5's at-least-once)
inserts nothing (N6). Expire-by-ref is a conditional `UPDATE … WHERE ref_type/ref_id … AND status =
'queued' RETURNING`, appending `notification.expired` per won row — idempotent, and it never
touches `sending`/`sent` rows. The handler holds no other logic: rendering, suppression and
channels are the pump's, so a handler throw (which blocks this consumer's queue ~30 s then parks —
08.5's measured behaviour) has almost no surface to happen in. Scheduling decisions read
`e.occurredAt`, never the wall clock, so replays compute the same answer.

### D14. What this plan deliberately does NOT build (stated, like 08.5's D12)

No `apps/relay`, no signed tokens, no queue-position or document-verification pages (split out —
owner ruling 1). No IVR adapter (CRM phase; the ladder skips the rung, D6). No
`notification.delivered`, no delivery callbacks, no real provider, no credentials (D11; §19
procurement). No promotional send path and no opt-in check in the pump (D9 — the refusal is the
Phase-1 mechanism). No digest producer (12a sends THROUGH `enqueueNotification`; the API stays
generic — audience `owner`, any template, caller-supplied dedupe key). No notification-center UI
and no per-notification screens (the bell and alerts list ship as-is). No E-22 supersession flow —
no document producer exists in Phase-1 scope to supersede; the outbox's `ref_type`/`ref_id` +
expire-by-ref is the seam it will use, and the lab/relay plans own it. No change to
`event_cursors` semantics (prompt trap 6). No second process, scheduler, broker or Redis (08.5
GC4). No `users.phone` collection flow — the column ships nullable; numbers are deployment data
(Decisions, item 4).

---

## Consumed shipped surfaces (transcribed from source at `2de3c2e`, 2026-08-21, this session)

- `Scheduler` — `apps/core/src/kernel/worker/scheduler.ts`: `register(spec: JobSpec)`
  (`EverySpec | DailyIstSpec`), `start()`, `stop()` (awaits in-flight AND latches `stopped`),
  `jobs()`; `JobRun = (now: Date) => Promise<void>`. **Not modified.**
- `registerAllJobs(scheduler, db, registry, consumers: Record<string, Handler>, intervals: JobIntervals)`
  — `kernel/worker/jobs.ts:92-131`; six registrations; **reads no environment** (its :84-90
  docstring is the B1 scar; keep it that way). `JobIntervals = Pick<AppConfig, …>` at jobs.ts:66.
  `buildSubscriptionBus(registry, consumers)` at jobs.ts:36 — **a declared subscription with no
  matching handler is a BOOT ERROR** (amendment 6). T4 adds the pump registration; T5 adds the
  consumer entry.
- `worker.ts` — `registerAllJobs(scheduler, db, registry, { [ALERTS_CONSUMER]: alertsConsumer(db) }, cfg)`
  at worker.ts:36, inside `bootstrap()`, which runs at import (`void bootstrap()`) — **why its half
  of the wire is unguarded** (gate report ADDENDUM, booked item 1). T5 extracts `workerConsumers(db)`
  into `worker.module.ts` and closes it.
- `WorkerModule` — `kernel/worker/worker.module.ts:39-88`: providers-only, all injection **by
  token** (tsx emits no `design:paramtypes` — :31-37); registry installs seven manifests +
  `alertsManifest` (:54-68). `shutdownWorker` :111-124 (never rejects). T5 modifies the registry
  block and adds the extraction; the shutdown path is untouched.
- `runDispatchCycle(db, bus, opts?: { batchSize?, lookback?, maxAttempts?, now? })` —
  `kernel/events/dispatcher.ts:117`; window query :140-151 (ONE where chain — Global Constraint 7
  of 08.5); claim-on-success :206-214 with its reasoning at :102-115; parking :58-96; backoff
  `min(2^attempts, 60) s` :37. **T5 adds one select column + one type field; every other line
  byte-identical (D5).**
- `DispatchedEvent { seq, eventId, name, payload, patientId, correlationId }` / `Handler` /
  `SubscriptionBus` — `kernel/events/subscriptions.ts:1-29`. **T5 widens the type with
  `occurredAt: Date` (D5).**
- `alertsConsumer(db): Handler` — `kernel/alerts/consumer.ts:43-104`: parses
  `escalationTriggered.payloadSchema` (:45), per-recipient own-tx insert with
  `onConflictDoNothing({ target: [alerts.sourceEventId, alerts.userId] })` (:73), **only a won
  insert appends `alert.raised`** (:76-100). `ALERTS_CONSUMER = "kernel.alerts"` :13,
  `OWNER_ROLE = "owner"` :20; :18's comment books the owner-SMS half for this plan. **This is the
  template for `notifyConsumer` AND T5 adds the `notification.failed` branch to it (D6).**
- `alertsManifest` — `kernel/alerts/manifest.ts:19`:
  `subscriptions: [{ event: "escalation.triggered", consumer: "kernel.alerts" }]`; `permissions`
  deliberately empty. T5 appends the second subscription.
- `alerts` table — `kernel/db/schema/alerts.ts:13-31`; UNIQUE `(source_event_id, user_id)` :28; no
  patient identity in any column (its header comment is the rule).
- Events consumed: `patient.registered` {patientId, uhid, name, phone|null, language} —
  `modules/patients/events.ts:18-28` · `patient.updated` field-diff `changes` :30-42 ·
  `appointment.booked` {appointmentId, patientId, doctorId, departmentId, serviceDate, slotStart,
  source} — `modules/opd/events.ts:32-35` · `appointment.rescheduled` {fromAppointmentId,
  toAppointmentId, …} :37-40 · `appointment.cancelled` {appointmentId, patientId, doctorId,
  serviceDate, slotStart, reason} :42-44 · `escalation.triggered` {instanceId, defKey, state, rung,
  role, resolvedUserIds, fallback, fallbackExhausted} — `kernel/workflow/events.ts:34-47`.
- `usersHoldingRole(tx, role)` — `kernel/workflow/roles.ts` (kernel; reused for `owner` and
  `duty_manager` fan-outs). Seeded role keys measured: `duty_manager` and `owner` exist;
  **no registration/front-desk role does** (D6's constant).
- `patients` — `kernel/db/schema/patients.ts`: `phone` NULLABLE :43 (D-34 comment verbatim),
  `language` :52 (`'hi' | 'en'`, default `'hi'`, "outbound-message language (§6), NOT the UI
  language"), `status 'active'|'merged'` :63, `mergedIntoPatientId` :64. **No deceased or opt-in
  columns exist** (measured). T1 adds both.
- `users` — `kernel/db/schema/auth.ts:5-19`: **no phone column** (measured). T1 adds
  `phone text NULL` (normalized 10-digit, same convention as patients.ts:43).
- `patients.controller.ts` — `@Post()` registration :226, `@Patch(":id")` :247; both zod-bodied.
  T6 adds the two fields to both schemas; `modules/patients/registration.ts` persists them and the
  shipped update-diff path events them.
- Config — `kernel/config.ts:42-51` (zod-defaulted `WORKER_*` keys), camel accessors :80-84. T3
  adds `WORKER_NOTIFY_INTERVAL_MS` (5000), `NOTIFY_PROVIDER` (enum `["console"]`, default
  `"console"`), `NOTIFY_STUCK_AFTER_MS` (300000) — all defaulted, **no `.env` change anywhere**.
- `appendEvent(tx, input)` — `kernel/events/append.ts`; `events.occurredAt` NOT NULL —
  `kernel/db/schema/events.ts:10`.
- Truncate helper — `test/helpers/db.ts:51-79`; §3.35/§3.12 quoted verbatim at :67-73; precedent
  that one table may appear in TWO statements: `approvals` at :62 and :64. `notifications` FKs
  into BOTH `patients` and `users`, so T1 adds it to **both** the patients-group and users-group
  statements.
- Migrations — `apps/core/drizzle/`, latest `0014_true_dark_beast.sql`; **next is `0015`** (measured).
- Web — `screens/registration-desk.tsx`, `screens/patient-detail.tsx` (+ their tests),
  `locales/en.json` / `hi.json`, `components/submit-button.tsx` (D11-08.5: every new write surface
  mounts it), `lib/api.ts`.
- Baseline (prompt §2, measured 2026-08-21 on the build host, exit VALUE 0 from a file):
  `apps/core 126 suites / 811 tests · apps/web 31 files / 147 tests · packages/contracts 3 / 7`.
  CI GREEN at `c5316f9`. **Re-measure at compile; measurement beats this document (§2.9/§2.21).**

## Global Constraints (spec v4.6 + 08.5 inheritance + this plan)

1. **The gateway is never load-bearing for a human flow.** Modules and consumers only INSERT
   outbox rows; sending happens on the worker's clock; when the worker is down, rows accumulate
   and drain safely (staleness + quiet hours make the drain safe by construction).
2. **Messages are irreversible → the pump claims BEFORE the adapter call** (D2), and a stuck
   `sending` row is never auto-resent (N14). Double-send is this surface's nightmare; the
   dispatcher's opposite placement stays untouched and both reasonings stay written down.
3. **No promotional message can be enqueued or sent** (D9, N2). The CRM plan owns the flip.
4. **Deceased suppression is a send-time hard stop that beats urgency** (D10, N1 — CRITICAL).
5. **No patient identity in staff/owner outbound bodies or in any alert column** (N10; 08.5 GC6;
   L8's mutant class). Patient linkage travels as ids in refs and envelopes only.
6. **Quiet hours live in ONE pump function** (D7); in-app alerts remain exempt (08.5 D12); urgent
   ignores by design.
7. The pump is a job on 08.5's Scheduler — **no second process, no second scheduler, no broker**
   (08.5 GC4); correctness never rests on the advisory lock (08.5 D3).
8. **jest drives `runNotifyPump` and `notifyConsumer` directly, never through the Scheduler**
   (08.5 GC3).
9. Every clock-reading function takes `now: Date = new Date()`; **no timing assertion gates on a
   wall-clock mean or median** (08.5 GC9/10); this plan authors no perf budget.
10. **The dispatcher edit is envelope-only** (D5): window, claim, cursor and backoff lines
    byte-identical; one WHERE chain preserved; `event_cursors` semantics untouched (trap 6).
11. Events: append-only, `entity.verb_past`, full §10.5 envelope, no per-tick events (D12).
12. TypeScript strict, no `any` in kernel; `kernel/notify` imports **no module's tables** — it MAY
    import module event *definitions* (zod schemas are contracts, not state; the lint checks
    tables) and the module-isolation lint must stay green.
13. Migration `0015` ONLY; rollback stated in T1 before the generator runs (§6); full generator
    output committed (§3.16); truncate-group rule per §3.35/§3.12 with `notifications` in both
    FK-target groups.
14. Workspace test totals never decrease; no test deleted; runner summaries quoted by exact path
    (AGENT-RULES §4). No per-task test-count targets exist in this plan.
15. **At-least-once is inherited by `kernel.notify`** (dispatcher contract): every enqueue is
    dedupe-keyed `ON CONFLICT DO NOTHING`; every expire-by-ref is conditional; redelivery changes
    nothing (N6).

## File Structure (locked; the frozen-path list is GENERATED from the Files lists — §2.25)

```
apps/core/
  drizzle/0015_<generated-name>.sql                          T1 (generated; full output committed)
  drizzle/meta/*                                             T1 (generator-owned)
  src/kernel/db/schema/notifications.ts                      T1 create (+ notifications.test.ts)
  src/kernel/db/schema/notifications.test.ts                 T1 create
  src/kernel/db/schema/patients.ts                           T1 (promotionalOptIn, deceasedAt)
  src/kernel/db/schema/auth.ts                               T1 (users.phone)
  src/kernel/db/schema/index.ts                              T1 (export notifications)
  test/helpers/db.ts                                         T1 (truncate groups — BOTH statements)
  src/kernel/notify/templates.ts                             T2 create (type + registry + catalog)
  src/kernel/notify/templates.test.ts                        T2 create
  src/kernel/notify/events.ts                                T2 create (the four events)
  src/kernel/notify/adapters.ts                              T3 create (interface + console impls + selection)
  src/kernel/notify/adapters.test.ts                         T3 create
  src/kernel/config.ts                                       T3 (three defaulted keys)
  src/kernel/config.test.ts                                  T3 (defaults asserted)
  src/kernel/notify/enqueue.ts                               T4 create (generic API, dedupe, refusal, expiry)
  src/kernel/notify/enqueue.test.ts                          T4 create
  src/kernel/notify/pump.ts                                  T4 create (claim, gauntlet, quiet hours, ladder)
  src/kernel/notify/pump.test.ts                             T4 create
  src/kernel/worker/jobs.ts                                  T4 (JobIntervals + runNotifyPump registration)
  src/kernel/worker/jobs.test.ts                             T4 (the amendment-6 seam tests; see amendment 7)
  src/kernel/worker/scheduler.test.ts                        T4 (amendment 7 — the L14 censuses + CENSUS_INTERVALS)
  test/worker-runtime.e2e.test.ts                            T4 (amendment 7 — its own THE_SIX census) AND T5, sequential
  src/kernel/notify/consumer.ts                              T5 create (kernel.notify handler)
  src/kernel/notify/consumer.test.ts                         T5 create
  src/kernel/notify/manifest.ts                              T5 create (subscriptions declaration)
  src/kernel/alerts/manifest.ts                              T5 (+ notification.failed subscription)
  src/kernel/alerts/consumer.ts                              T5 (the manual_notify branch)
  src/kernel/alerts/consumer.test.ts                         T5 (branch + idempotency asserted)
  src/kernel/events/subscriptions.ts                         T5 (DispatchedEvent.occurredAt)
  src/kernel/events/dispatcher.ts                            T5 (one select column + WindowRow + construction)
  src/kernel/events/dispatcher.test.ts                       T5 (N11 regression pin)
  src/kernel/worker/worker.module.ts                         T5 (install notifyManifest; workerConsumers())
  src/worker.ts                                              T5 (uses workerConsumers(db))
  test/worker-runtime.e2e.test.ts                            T5 (pairs assertion grows, whole-equality)
  src/modules/patients/patients.controller.ts                T6 (POST + PATCH schemas gain two fields)
  src/modules/patients/registration.ts                       T6 (persist both; update path diffs them)
  src/modules/patients/registration.test.ts                  T6
apps/web/src/
  screens/registration-desk.tsx                              T6 (opt-in checkbox)
  screens/registration-desk.test.tsx                         T6
  screens/patient-detail.tsx                                 T6 (opt-in toggle + deceased marking)
  screens/patient-detail.test.tsx                            T6
  locales/en.json                                            T6
  locales/hi.json                                            T6
```

Forward-reference audit (§7.2/§2.47), run on the finished lists: T4's pump imports T2's
`templates.ts` and T3's `adapters.ts` (waves behind it); T4's `jobs.ts` edit registers T4's own
`pump.ts`; T5's consumer imports T4's `enqueue.ts` and T2's templates (behind it); T6 imports
nothing from T2–T5 (its API surface is T1's columns). **No task imports an export from a later
wave.** The one two-owner file risk — `jobs.ts` (T4) vs `worker.ts`/`worker.module.ts` (T5) — is
resolved by the amendment-6 seam itself: T4 registers the pump job (no consumer needed);
T5 supplies the consumer through the `consumers` map parameter, touching `jobs.ts` not at all.

## Tasks

### Task 1: Migration 0015 — the outbox and the three columns  *(ROUTINE tier, opus coder — the plan's only migration; §6 discipline is the risk, and the truncate-group edit is §3.12's exact class)*

1. `schema/notifications.ts` per D2/D4/D5: id (ULID) · audience (`'patient'|'staff'|'owner'`) ·
   patientId (nullable, FK patients.id) · userId (nullable, FK users.id) · templateKey ·
   params jsonb · dedupeKey (NOT NULL, **UNIQUE**) · sourceEventId (nullable) · refType/refId
   (nullable) · occurredAt (NOT NULL) · expiresAt (NOT NULL) · scheduledFor (nullable) ·
   status (`'queued'|'sending'|'sent'|'suppressed'|'expired'|'undeliverable'`, default `'queued'`) ·
   rung int default 0 · attempts int default 0 · lastError (nullable) · nextAttemptAt (nullable) ·
   sentAt/sentChannel/sentTemplateVersion (nullable) · createdAt/updatedAt. Indexes: unique
   `dedupe_key`; `(status, next_attempt_at)`; `(ref_type, ref_id)`. Audience/recipient coherence is
   app-enforced (comment states it) — no CHECK constraints beyond NOT NULLs.
2. `patients.ts` gains `promotionalOptIn boolean NOT NULL DEFAULT false` (D9) and
   `deceasedAt timestamptz NULL` (D10), each with a comment carrying its D-number.
   `auth.ts` `users` gains `phone text NULL` (same normalization comment as patients.ts:43).
3. Generate migration 0015; commit the FULL generator output (§3.16).
   **Rollback, stated now (§6):** `ALTER TABLE patients DROP COLUMN promotional_opt_in, DROP
   COLUMN deceased_at; ALTER TABLE users DROP COLUMN phone; DROP TABLE notifications;` — all three
   are additive, no data exists at rollback time, no index or FK outlives its table.
4. `test/helpers/db.ts`: `notifications` joins **BOTH** the opd/billing/patients statement AND the
   users statement (§3.35: constraint existence, never row counts; §3.12: the group's own statement
   must gain the name; precedent: `approvals` sits in two statements at :62/:64).
5. Schema test: columns, defaults, uniques; insert + dedupe-conflict; FK behaviour.

**Files:** as the File Structure's T1 rows. **Produces:** the `notifications` drizzle table object
(consumed by T4/T5), the three columns (consumed by T4/T6).

### Task 2: The template registry — versioned, classed, both languages by type  *(ROUTINE, sonnet coder; carries mutant N2 — a deliberate tier override, §3.14's class: the refusal it guards is otherwise absence-asserted)*

1. `templates.ts`: the `NotificationTemplate` type (D8 verbatim), `notificationTemplates` record,
   `templateByKey(key)` throwing accessor, the five catalog entries with real bilingual copy
   (short, factual; params interpolated; no names beyond the hospital's).
2. `events.ts`: the four `defineEvent`s (D12 payloads exactly).
3. Tests: registry keys match record keys; every version ≥ 1; **the honest pin — zero
   `promotional` entries in the shipped catalog** (labelled as D9's leg b); `hi` renders match
   `/[ऀ-ॿ]/` (flag ④); `expiresAt` anchors per the D8 table (confirmation/reminder die
   at `slotStart`; welcome at +24 h; escalations at +4 h).

**Produces:** `NotificationTemplate`, `notificationTemplates`, `templateByKey`, the four event
objects (consumed by T4/T5).

### Task 3: Channel adapters and config  *(ROUTINE, sonnet coder)*

1. `adapters.ts`: `ChannelAdapter` (D11 verbatim); `consoleWhatsappAdapter` / `consoleSmsAdapter`
   (structured log line: channel, to, notificationId, first 80 chars); `adaptersFor(cfg)` returning
   the channel→adapter map for `NOTIFY_PROVIDER` (`"console"` today; exhaustive switch so a new
   enum member fails compilation until mapped).
2. `config.ts`: `WORKER_NOTIFY_INTERVAL_MS` default 5000 · `NOTIFY_PROVIDER`
   `z.enum(["console"]).default("console")` · `NOTIFY_STUCK_AFTER_MS` default 300000; camel
   accessors; `config.test.ts` asserts the defaults resolve with an empty environment (the B1 scar:
   nothing here may require a value).

**Produces:** `ChannelAdapter`, `adaptersFor` (consumed by T4); the three config keys (consumed by
T4 via `JobIntervals` and by `worker.ts` untouched — `cfg` already satisfies the widened Pick
structurally).

### Task 4: The pump — claim-before-send, the gauntlet, quiet hours, the ladder  *(CRITICAL, opus coder + opus gate — the send path; D-33 lives here; messages are irreversible)*

1. `enqueue.ts`: `enqueueNotification(tx, input)` per D13's needs and D14's genericity — validates
   template exists, **throws on promotional class (N2)**, computes `expiresAt =
   template.expiresAt(params, occurredAt)`, inserts `ON CONFLICT (dedupe_key) DO NOTHING
   RETURNING id`, returns `{id} | null`. Also `expireByRef(tx, refType, refId, now)` — the
   conditional UPDATE + per-won-row `notification.expired` (D13).
2. `pump.ts`: `runNotifyPump(db, opts?: { batchSize?, maxAttemptsPerRung?, stuckAfterMs?, now? })`:
   claim batch (`FOR UPDATE SKIP LOCKED`, D2) → per row, own try/catch: gauntlet in D4's exact
   order (expiry → deceased → promotional-belt → quiet-hours deferral → channel resolution with
   merge-chain and phone reads at send) → render via `templateByKey(...).render[language]` (render
   throw → `undeliverable` + `failed(render_error)`, D3) → adapter send → guarded flip to `sent` +
   `notification.sent` (only a won flip appends). Failure: backoff `min(2^attempts, 60) s`; rung
   advance at `maxAttemptsPerRung`; exhaustion/no-phone → `undeliverable` + `notification.failed`.
   Stuck-`sending` recovery per D2 (N14). Quiet-hours function per D7 with the IST constants.
3. `jobs.ts`: `JobIntervals` Pick gains `workerNotifyIntervalMs`; register
   `{ name: "runNotifyPump", every: intervals.workerNotifyIntervalMs, run: async (now) =>
   { await runNotifyPump(db, { now }); } }`. **AMENDMENT 7 — the job-name census does NOT live in
   `jobs.test.ts`** (that file tests only `buildSubscriptionBus`). It lives in TWO places and both
   are T4's to grow, or T4's own `pnpm verify` cannot be green:
   · `src/kernel/worker/scheduler.test.ts` — `THE_SIX` (:104) → seven, `spyOnTheSix` (:74) → a
     seventh spy on `runNotifyPump` so no real pump body runs inside jest (GC8), and
     `CENSUS_INTERVALS` (:184), a `JobIntervals` object LITERAL that stops typechecking the moment
     the Pick widens.
   · `test/worker-runtime.e2e.test.ts` — its own `THE_SIX` (:89) and
     `expect(scheduler.jobs()).toEqual(THE_SIX)` (:326).
   Keyed the B3 way (the day-index-against-seeded-heartbeat lesson does not apply to an `every`
   job, but the census set does).
4. Tests drive `runNotifyPump` directly with injected `now` and recording/failing fake adapters
   (GC8): the gauntlet order, every N-row this task owns (Book), the ladder, quiet-hours
   boundaries, phoneless entry, merge resolution, claim-before-send call order, stuck recovery,
   double-completion appending once.

**Consumes:** T1 table, T2 registry/events, T3 adapters/config. **Produces:**
`enqueueNotification`, `expireByRef` (consumed by T5); `runNotifyPump` (registered here).

### Task 5: The consumer, both halves of the wire, and the residual it closes  *(CRITICAL, opus coder + opus gate — a new dispatcher consumer to a system with history; per-user fan-out)*

1. `consumer.ts` + `manifest.ts` per D13 — the five subscriptions declared AND handled (amendment
   6: a declaration without a handler is a boot error, and this task owns **both** files plus the
   worker wiring, so neither half can ship alone).
2. `subscriptions.ts` + `dispatcher.ts` + `dispatcher.test.ts`: the `occurredAt` widening per D5 —
   one select column, one `WindowRow` field, one construction line; **N11 pins that a handler
   receives the inserted row's `occurred_at`; a diff beyond those lines in `dispatcher.ts` is a
   task failure** (GC10).
3. `alerts/manifest.ts` + `alerts/consumer.ts`: the `notification.failed` subscription and the
   `manual_notify` branch per D6 (patient audience only; `duty_manager` holders; title from
   `templateKey` only; refType `patient`; keyed on the failed event's id). `consumer.test.ts`
   asserts the branch, its idempotency under redelivery, and that the escalation path is
   byte-unchanged in behaviour.
4. `worker.module.ts`: install `notifyManifest`; **extract `workerConsumers(db):
   Record<string, Handler>`** returning both entries — the one importable place the production
   consumers map exists (closes gate-report booked item 1). `worker.ts:36` becomes
   `registerAllJobs(scheduler, db, registry, workerConsumers(db), cfg)`.
5. `worker-runtime.e2e.test.ts`: **installing `notifyManifest` makes the two shipped
   `registerAllJobs(...)` call sites in this file (:316 and :363, both passing only
   `{ [ALERTS_CONSUMER]: alertsConsumer(workerDb) }` against the CONTEXT'S OWN registry) throw the
   amendment-6 boot error** — five declared `kernel.notify` subscriptions with no handler. Both
   become `workerConsumers(workerDb)`; that is the same edit N12 demands and shipping half of it is
   a task failure. T4 has already grown this file's `THE_SIX` census to seven (amendment 7) — read
   the file as T4 left it, do not restore six. Then: pairs asserted WHOLE against the REAL registry and
   `workerConsumers` —
   `[["kernel.alerts", ["escalation.triggered", "notification.failed"]], ["kernel.notify",
   ["appointment.booked", "appointment.cancelled", "appointment.rescheduled",
   "escalation.triggered", "patient.registered"]]]` (sorted) — plus the boot-error leg for a
   declaration with no handler. Deleting either consumers-map entry now fails this file (N12).

**Consumes:** T4's `enqueueNotification`/`expireByRef`; T2's templates/events; shipped
`usersHoldingRole`, `alertsConsumer` shape. **Produces:** `notifyConsumer`, `NOTIFY_CONSUMER`,
`workerConsumers` (consumed by nothing later — T6 is web/patient-master scope).

### Task 6: The patient-master surface — opt-in at registration, deceased on the record, the strings  *(ROUTINE, sonnet coder)*

1. `patients.controller.ts`: POST body gains `promotionalOptIn: z.boolean().default(false)`; PATCH
   body gains `promotionalOptIn: z.boolean()` and `deceasedAt: z.string().datetime().nullable()`
   (both optional in PATCH). `registration.ts` persists on create; the shipped update path diffs
   both into `patient.updated.changes` (marking AND clearing deceased are audited — D10). No new
   permission (the routes' existing guards stand).
2. `registration-desk.tsx`: one unchecked-by-default checkbox ("Promotional messages: opted in"),
   posted with registration; `patient-detail.tsx`: the opt-in toggle and a deceased
   mark/clear control (date + confirm; `SubmitButton` mounts on both writes — D11-08.5 convention).
3. `locales/en.json` + `hi.json`: the new keys, both languages.
4. Screen tests: checkbox default-off and posted value; deceased set/clear round-trip; PATCH
   payloads exact.

**Consumes:** T1's columns. **Produces:** nothing later tasks need.

## Commit messages — one per task, exact (AGENT-RULES §5 step 1 resolves here)

| task | subject |
|---|---|
| T1 | `feat(core): migration 0015 — the notifications outbox, opt-in and deceased columns, staff phone` |
| T2 | `feat(core): the template registry — five templates, two languages by type, four notify events` |
| T3 | `feat(core): channel adapters — console WhatsApp/SMS, provider selection, three defaulted keys` |
| T4 | `feat(core): the notification pump — claim-before-send, the suppression gauntlet, quiet hours, the ladder` |
| T5 | `feat(core): the notify consumer — five subscriptions, the owner-SMS dead-end, one importable consumers map` |
| T6 | `feat(web): opt-in at registration, deceased on the patient record, the notify strings` |

## Assertion Book — predictions until executed; the verdict column is filled by the shipping task

Per §7.4: an "exact discriminating input" is a PREDICTION. Rows marked **P** carry inputs the task
must confirm by building the mutant and watching it die, adjusting the input if both survive.

| # | task | assertion | killing mutant | discriminating input | P? |
|---|---|---|---|---|---|
| N1 | T4 | **Deceased patient is never sent to** (D10, CRITICAL) | delete the `deceased_at` check | patient marked deceased AFTER enqueue; pump cycle with recording adapter → shipped: `suppressed` row + `notification.suppressed(deceased)` + **zero adapter calls**; mutant: adapter called | |
| N2 | T2/T4 | Promotional class cannot enqueue (D9) | delete the class refusal in `enqueueNotification` | synthetic promotional template in a test-local registry → shipped throws; mutant inserts. Leg b: shipped catalog has zero promotional entries (honest pin) | |
| N3 | T4 | Stale rows expire instead of sending (D5 — the replay defense) | delete the `expires_at` gate | `patient_welcome` row with `occurredAt` 72 h back → shipped: `expired`, zero adapter calls; mutant: sends | |
| N4 | T4 | The claim precedes the adapter call (D2) | move the `sending` flip after `adapter.send` | fake adapter reads the row's status from the DB when invoked → shipped observes `sending`; mutant observes `queued` | |
| N5 | T4 | Quiet-hours window is exactly 21:00–08:00 IST, patient-routine only (D7) | flip a boundary comparison / drop the IST offset | routine patient row at 20:59:59.999, 21:00:00.000, 07:59:59.999, 08:00:00.000 IST; urgent row at 23:00 | **P** |
| N6 | T5 | Redelivery enqueues nothing (GC15) | drop `ON CONFLICT DO NOTHING` / vary the dedupe key | same `DispatchedEvent` handled twice → one row; mutant: two (or throws) | |
| N7 | T4 | Rung advances at `maxAttemptsPerRung`, WhatsApp→SMS | delete the rung-advance arm | WhatsApp fake throws ×3 → shipped: SMS adapter attempted; mutant: WhatsApp forever | |
| N8 | T4+T5 | Patient ladder exhaustion becomes a duty-manager alert (D6) | delete the `notification.failed` branch in `alertsConsumer` | both fakes always-throw → `undeliverable` + `failed` event; dispatch it → shipped: `manual_notify` alert row for each duty_manager; mutant: none | |
| N9 | T4 | Phoneless patient takes the desk rung with zero adapter calls (D-34) | delete the phone-null check | patient `phone NULL`, routine template → shipped: `failed(no_phone)` + desk path, adapters uncalled; mutant: adapter called with null/crash | |
| N10 | T5 | Staff/owner enqueue params are EXACTLY the four structural fields (GC5, L8's class) | consumer copies `e.patientId` into params | patientful `escalation.triggered` → `toEqual({defKey, state, rung, role})` — whole-object, the pair asserted WHOLE | |
| N11 | T5 | `DispatchedEvent.occurredAt` equals the row's `occurred_at` (D5) | select `now()` instead / drop the column | insert event with `occurredAt` = fixed past instant; handler records what it received | |
| N12 | T5 | Both halves of the wire, from production objects | delete either `workerConsumers` entry or either manifest install | the worker-runtime pairs whole-equality + boot-error leg (T5 step 5) | |
| N13 | T4 | Crash-retry of completion appends `notification.sent` once | append outside the won-flip guard | run the completion step twice against one `sending` row → one event | |
| N14 | T4 | Stuck `sending` is flagged, never re-sent (D2) | recovery arm re-queues instead | row `sending`, `updated_at` 10 min back, `now` injected → shipped: `undeliverable(stuck_sending)`, adapter NOT called; mutant: adapter called again | |
| N15 | T4 | Merged patient resolves to the survivor at send (D4) | skip chain resolution | loser phone A / survivor phone B, row on loser → adapter receives B; mutant: A | |

## Verify-by-execution flags (each names its owning task and discharging assertion; the list may be incomplete, §3.20)

- **①** (T1) Migration 0015 applies clean on a truncated dev database; the full generator output is
  in the diff; the rollback statements in T1 step 3 were reviewed against the generated SQL.
- **②** (T2, discharges the flag in D8) `hi` catalog renders contain Devanagari, asserted
  `/[ऀ-ॿ]/` against every patient template.
- **③** (T5, discharges N12) `worker-runtime.e2e.test.ts` green — boot, real registry, whole pairs.
- **④** (T4→gate, GC9/10 discipline) A real-scheduler DEMONSTRATION, not a test: dev compose, seed
  three rows (one fresh, one expired, one deceased patient), `start:worker`, transcript shows one
  console send, one `expired`, one `suppressed` within two pump intervals. Recorded in the gate
  report like 08.5's five-minute transcript.
- **⑤** (T6) Registration POST with the checkbox on persists `promotional_opt_in = true`; PATCH
  marking deceased lands in `patient.updated.changes` — asserted in `registration.test.ts`.

## Self-review — what this plan's own passes caught before commit

1. **Path resolution (§7.1/§2.46), run with `test -e` over every File Structure row:** all 25
   modify-targets exist, all create-targets absent. **One defect caught by the sweep and fixed:**
   the draft placed `worker-runtime.e2e.test.ts` at `src/kernel/worker/` from memory of the gate
   report; it actually lives at `apps/core/test/worker-runtime.e2e.test.ts` beside the other e2e
   suites — precisely the write-from-memory class §2.46 exists for. A second draft-phase fix:
   `kernel/notify/quiet-hours.ts` was named as a create-target no task's steps populate (the
   function lives in `pump.ts`, D7); the orphan was removed from the structure.
2. **Forward references (§7.2/§2.47):** the audit paragraph under File Structure. The draft
   originally had T3 owning `enqueue.ts` while T4 owned the pump that co-evolves with it and T5
   consumed it — moved to T4, restoring strict backward-only imports and keeping `jobs.ts`
   single-owner (T4) via the consumers-map parameter.
3. **Vacuous assertions (§7.3/§2.49):** two candidates found. The promotional refusal (no
   promotional template exists) — given the synthetic-template leg, N2. `notification.delivered` —
   removed from the event catalog entirely rather than defined producer-less (D11/D12).
4. **§7.4 sweep of the Book:** N5 marked P (boundary-equality inputs are exactly L14's failure
   class). Every other row's input is a deterministic fixture, not an instant.
5. **Type consistency:** `enqueueNotification` / `expireByRef` / `runNotifyPump` /
   `workerConsumers` / `NOTIFY_CONSUMER` / `templateByKey` names and signatures identical at every
   mention (D8, D13, T2–T5, Book). `JobIntervals` widening named once (T4) and consumed by
   `worker.ts` with **zero edits to the call site's shape** — `cfg` already satisfies the wider
   Pick structurally (worker.ts:36's own comment).
6. **Spec coverage against §11.13/§11.5:** channels (in-app ✅ 08.5 · WhatsApp/SMS ✅ adapters ·
   IVR — explicitly skipped rung, CRM · print/PBX — out of scope, unchanged) · ladder ✅ D6 ·
   language ✅ D8 · template registry + approval status ✅ D8 · DPDP split ✅ D9 · quiet hours ✅
   D7 · anti-alarm-fatigue boundary ✅ D7 · owner matrix real-time ✅ D7/D13 · fix 11 owner-SMS ✅
   D13 · D-33 ✅ D10 · D-34 ✅ D6/N9 · E-22 ✅ booked with its seam, D14 · D-24 spoof defenses —
   provider-boundary scope, arrives with the provider (noted in D11's deferral) · E-1 ✅ split by
   ruling 1.
7. **Two-owner files: ONE, and this claim was wrong when written — see amendment 7.**
   `test/worker-runtime.e2e.test.ts` is T4's (its job census) and then T5's (its pairs census), in
   that order, across SEQUENTIAL waves 3 → 4 with no parallelism, and both briefs name it as a
   carried-forward file with the rationale (§3.2). `kernel/config.ts` (T3), `jobs.ts` (T4), all other worker/alerts/dispatcher
   files (T5), patient-master files (T6) — each appears in exactly one task's Files list.

## Pipeline Notes (for /execute compilation — do not compile before owner approval of this plan)

- **One pipeline, five waves:** W1 [T1] → W2 [T2, T3] → W3 [T4] → W4 [T5] → W5 [T6].
- **Models:** T4, T5 opus coder + per-task opus gate (CRITICAL). T1 opus coder, no gate (migration
  discipline; 08.5's T1 precedent). T2, T3, T6 sonnet, mechanical check only — except T2's N2
  mutant work, which is fixture-discrimination and stays in the brief with the §3.14 override
  stated.
- Briefs POINT at AGENT-RULES.md and this plan (never paste — §2.40); restricted tool set (no MCP
  roster — §132k lesson); baseline re-measured at compile start, detached, exit value from a file.
- The compile-time sweep (EXECUTE-METHOD §3) runs before any brief is written; its path sweep
  re-runs the §7.1 check independently of self-review item 1.
- CI: `bash docs/superpowers/pipelines/ci-watch.sh &` during the run; a 3-second `failure` is a
  billing block, not code (§2.59) — the repo is public today and the owner intends to flip it back.
- Target ≤ 1.2M subagent tokens (smaller than 08.5: no spike, no fork resolution).

## Decisions for the owner (not designed around — listed with what stalls without each)

1. **E-1 + deployment topology + second server** (spec :793; roadmap "decide now"). Stalls: the
   relay (wherever it lands) and Plan 11. Unchanged by this plan; restated because ruling 1 makes
   the relay's plan the direct casualty.
2. **Where the relay lands: Plan 10.5, or joins Plan 11.** Recommended: **joins 11** — it is a
   deployable with a topology, and Plan 11 owns topology; a 10.5 exists only if 11 stays blocked on
   item 1 long enough to strand go-live's queue-link message. Stalls: nothing today; the §11.13
   patient matrix's "live queue link" line until decided.
3. **Provider procurement starts NOW (§19):** WhatsApp Business (BSP onboarding + per-template
   approval) and SMS (Indian DLT registration: entity, headers, per-template) are **weeks of lead
   time each** and no pipeline can produce them. Stalls: real delivery at go-live — the gateway
   ships either way and swaps one adapter file when credentials exist.
4. **Staff and owner phone numbers** are deployment data for `users.phone` (Plan 11 seed/runbook).
   Stalls: staff/owner external messages silently reduce to their in-app alerts (evented
   `no_phone` failures make the gap visible, not silent).
5. **`duty_manager` receives manual-notify desk flags** until a front-desk role is seeded (none
   exists — measured). Stalls: nothing; one constant to change.
6. **Roadmap amendments riding this plan's commit:** the Plan 10 entry re-scoped per ruling 1
   (relay lines move to the Plan 11/10.5 note); Plan 11's cursor-seeding deployment note gains
   `kernel.notify`. Both are records of rulings already made in the brainstorm, not new decisions.

## Carried forward / residuals this plan touches

- **Closes** gate-report booked item 1 (the unguarded `worker.ts` half) via `workerConsumers` (T5).
- **Inherits and defends** the §5.3 replay hazard (D5 + Plan 11 seeding note — ruling 4).
- **Does not touch** `start()`-clears-latch (gate booked 2), `shutdownWorker`'s logger `.catch`
  (booked 3), `TS151002` noise (booked 4), the OPD `SubmitButton` retrofit, or `POLL_MS` — all
  stay booked where 08.5 left them.
