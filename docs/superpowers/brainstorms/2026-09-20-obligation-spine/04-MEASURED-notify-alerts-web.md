> Measured 2026-09-20 on `main` @ 21fe8912 by a read-only subagent for the obligation-spine implementation plan. Line numbers are from that commit; re-measure any line a task cites before editing it.

# HMIS dossier — notify / alerts / web routing / push readiness
Repo: `/opt/hmis`, branch `main`, read-only. Nothing edited. All paths absolute. Line numbers are from the shipped files as of this read.

---

## 1. `apps/core/src/kernel/notify/`

Files present (`/opt/hmis/apps/core/src/kernel/notify/`): `adapters.ts`, `adapters.test.ts`, `consumer.ts`, `consumer.test.ts`, `enqueue.ts`, `enqueue.test.ts`, `events.ts`, `manifest.ts`, `pump.ts`, `pump.test.ts`, `templates.ts`, `templates.test.ts`.

### 1.1 `enqueue.ts` — input type and signature

`/opt/hmis/apps/core/src/kernel/notify/enqueue.ts:25-42` (verbatim):

```ts
export type EnqueueNotificationInput = {
  templateKey: string;
  /** Exactly the payload fields the template interpolates. A paramless template passes `{}` —
   *  `notifications.params` is `jsonb NOT NULL`, so `null`/`undefined` is a constraint error. */
  params: Record<string, unknown>;
  /** The at-least-once guard (GC15). Redelivery of the same event inserts nothing (N6). */
  dedupeKey: string;
  /** The EVENT's time, never the wall clock (D5/D13) — the expiry anchor, and what makes a
   *  replayed month-old booking expire instead of sending. */
  occurredAt: Date;
  patientId?: string | null;
  userId?: string | null;
  sourceEventId?: string | null;
  refType?: string | null;
  refId?: string | null;
  /** `null` = due immediately; the reminder sets `slotStart − 24 h` (D13). */
  scheduledFor?: Date | null;
};
```

`:45` — `const ENQUEUE_ACTOR: Actor = { type: "system", id: "notify-enqueue" };`

Signature, `:68-71`:

```ts
export async function enqueueNotification(
  tx: Tx,
  input: EnqueueNotificationInput,
): Promise<{ id: string } | null> {
```

Takes `Tx` (not `Db`) deliberately — `:14-17` — so an enqueue rides the caller's transaction.

Second export, `:144-149`:

```ts
export async function expireByRef(
  tx: Tx,
  refType: string,
  refId: string,
  now: Date,
): Promise<number> {
```

`expireByRef` updates only `status = 'queued'` rows matching `(refType, refId)` → `status: "expired"`, `RETURNING` id/templateKey/audience/patientId, and appends one `notificationExpired` per won row (`:150-185`). Never touches `sending` or `sent`.

### 1.2 The audiences

The audience is a property of the TEMPLATE, not of the enqueue call. `NotificationTemplate.audience: "patient" | "staff" | "owner"` (`templates.ts:14`). Event payload enum: `const audienceSchema = z.enum(["patient", "staff", "owner"]);` (`events.ts:14`). DB column `audience` is bare `text` (`schema/notifications.ts:32`), app-enforced.

### 1.3 Dedupe key rule

- Column: `dedupeKey: text("dedupe_key").notNull()` with `uniqueIndex("notifications_dedupe_key_ux")` (`schema/notifications.ts:37`, `:56`).
- Insert uses `.onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id })` and returns `inserted[0] ?? null` (`enqueue.ts:127-130`).
- The key FORMULA lives in the consumer, `consumer.ts:42-43` (verbatim):

```ts
const dedupeKeyFor = (eventId: string, templateKey: string, recipientId: string): string =>
  `n:${eventId}:${templateKey}:${recipientId}`;
```

### 1.4 The four refusals

`enqueue.ts` refuses in four places (five `throw`s, four classes):

1. **Unregistered template key** — `const template = templateByKey(input.templateKey);` at `:75`; `templateByKey` throws `` `no notification template registered for key "${key}"` `` (`templates.ts:217-223`).
2. **Promotional class** — `:77-83`:
```ts
  if (template.class === "promotional") {
    throw new Error(
      `enqueueNotification: template "${input.templateKey}" is class "promotional" and this ` +
        `gateway refuses promotional messages outright (Plan 10 D9 — DPDP; the CRM plan owns the ` +
        `opt-in check that replaces this refusal)`,
    );
  }
```
3. **Patient-audience recipient coherence** — `:87-93`:
```ts
  if (template.audience === "patient") {
    if (patientId === null) {
      throw new Error(`enqueueNotification: template "${input.templateKey}" is patient-audience but no patientId was given`);
    }
    if (userId !== null) {
      throw new Error(`enqueueNotification: template "${input.templateKey}" is patient-audience but a userId was given`);
    }
```
4. **Staff/owner recipient coherence** — `:94-101`:
```ts
  } else {
    if (userId === null) {
      throw new Error(`enqueueNotification: template "${input.templateKey}" is ${template.audience}-audience but no userId was given`);
    }
    if (patientId !== null) {
      throw new Error(`enqueueNotification: template "${input.templateKey}" is ${template.audience}-audience but a patientId was given`);
    }
  }
```

Expiry is computed at enqueue: `const expiresAt = template.expiresAt(input.params, input.occurredAt);` (`:106`).

Test names pinning these: `/opt/hmis/apps/core/src/kernel/notify/enqueue.test.ts:138` (`the promotional refusal (D9, N2 leg a)`), `:163`, `:179`, `:195` (`the validations that have no CHECK constraint behind them`), `:196`, `:211`, `:225`, `:93` (dedupe returns null), `:242` (`expireByRef (D13)`).

### 1.5 `pump.ts` — options, ladder, quiet hours, deceased, expiry

Options type, `/opt/hmis/apps/core/src/kernel/notify/pump.ts:39-49` (verbatim):

```ts
export type NotifyPumpOptions = {
  batchSize?: number;
  maxAttemptsPerRung?: number;
  stuckAfterMs?: number;
  now?: Date;
  /**
   * The adapter set to send through. Tests inject recording/failing fakes here and drive
   * `runNotifyPump` DIRECTLY, never through the Scheduler (Global Constraint 8).
   */
  adapters?: AdapterSet;
};
```

Local types `:34-37`: `type Channel = ChannelAdapter["channel"]; type AdapterSet = Record<Channel, ChannelAdapter>; type NotificationRow = typeof notifications.$inferSelect; type PatientRow = typeof patients.$inferSelect;`

Constants, `:51-82` (verbatim, comments trimmed only where noted — the DEFAULT_CHANNELS one is complete):

```ts
const DEFAULT_BATCH_SIZE = 50;
/** D6: `attempts` counts failures on the CURRENT rung; at this many the rung advances. */
const DEFAULT_MAX_ATTEMPTS_PER_RUNG = 3;
const DEFAULT_STUCK_AFTER_MS = 300_000;
/** The dispatcher's own curve (dispatcher.ts:37), one convention across the codebase. */
const MAX_BACKOFF_SECONDS = 60;
/** D6: the patient and staff/owner ladders share this default; a template may narrow it. */
const DEFAULT_CHANNELS: Channel[] = ["whatsapp", "sms"];
/** D4: `status='merged'` resolves through `merged_into_patient_id`, bounded. */
const MERGE_MAX_HOPS = 5;

const PUMP_ACTOR: Actor = { type: "system", id: "notify-pump" };
const STUCK_ERROR = "claimed for sending and never completed — flagged, never re-sent (D2)";
const PUMP_PROVIDER: NotifyProvider = "console";
```

Backoff, `:85`: `const backoffMs = (attempts: number): number => Math.min(2 ** attempts, MAX_BACKOFF_SECONDS) * 1000;`

**Main entry point**, `:527-567` (verbatim body):

```ts
export async function runNotifyPump(db: Db, opts: NotifyPumpOptions = {}): Promise<number> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttemptsPerRung = opts.maxAttemptsPerRung ?? DEFAULT_MAX_ATTEMPTS_PER_RUNG;
  const stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const now = opts.now ?? new Date();
  const adapters = opts.adapters ?? adaptersFor({ notifyProvider: PUMP_PROVIDER });

  await recoverStuckSending(db, now, stuckAfterMs);

  const claimed = await claimBatch(db, now, batchSize);
  let sent = 0;

  for (const row of claimed) {
    try {
      const plan = await withTx(db, (tx) => prepareRow(tx, row, now));
      if (plan.kind === "done") continue;

      let result: { providerMessageId: string | null };
      try {
        result = await adapters[plan.channel].send(plan.to, plan.text, { notificationId: row.id });
      } catch (err) {
        await withTx(db, (tx) => recordAttemptFailure(tx, row, plan.channels, err, now, maxAttemptsPerRung));
        continue;
      }

      const won = await withTx(db, (tx) =>
        completeSend(
          tx,
          row,
          { channel: plan.channel, providerMessageId: result.providerMessageId, templateVersion: plan.templateVersion },
          now,
        ),
      );
      if (won) sent += 1;
    } catch (err) {
      await noteRowError(db, row, err);
    }
  }

  return sent;
}
```

**How it picks a channel** — `prepareRow` step 5, `:369-374` (verbatim):

```ts
  const channels = template.channels ?? DEFAULT_CHANNELS;
  const channel = channels[row.rung];
  if (channel === undefined) {
    await markUndeliverable(tx, row, "ladder_exhausted", now, row.lastError ?? "ladder exhausted");
    return { kind: "done" };
  }
```

So the "ladder" is an index into the array: `rung` is an `integer` column on `notifications`, `channels[rung]` is the channel.

**"Climbs on failure" in code** — `recordAttemptFailure`, `:408-438` (verbatim):

```ts
async function recordAttemptFailure(
  tx: Tx,
  row: NotificationRow,
  channels: Channel[],
  err: unknown,
  now: Date,
  maxAttemptsPerRung: number,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const attempted = row.attempts + 1;
  const advance = attempted >= maxAttemptsPerRung;
  const nextRung = advance ? row.rung + 1 : row.rung;

  if (nextRung >= channels.length) {
    await markUndeliverable(tx, row, "ladder_exhausted", now, message);
    return;
  }

  await settle(
    tx,
    row,
    {
      status: "queued",
      rung: nextRung,
      attempts: advance ? 0 : attempted,
      lastError: message,
      nextAttemptAt: new Date(now.getTime() + backoffMs(attempted)),
    },
    now,
  );
}
```

The climb is triggered ONLY by an adapter `send()` throwing. There is no "no-read" or "no-ack" signal anywhere in the pump — the only inputs are adapter exceptions, `attempts`, and `maxAttemptsPerRung`.

**Quiet hours** — the one pure function, `:91-132` (verbatim):

```ts
/** IST is UTC+5:30 and has no DST — the offset is arithmetic, never a timezone database read. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Design law (D7), not a deployment knob: quiet hours are 21:00–08:00 IST, wrapping midnight. */
const QUIET_START_HOUR_IST = 21;
const QUIET_END_HOUR_IST = 8;

export function quietHoursDeferral(
  template: Pick<NotificationTemplate, "urgency">,
  audience: string,
  now: Date,
): Date | null {
  if (audience !== "patient") return null;
  if (template.urgency !== "routine") return null;

  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const hourIst = istNow.getUTCHours();
  const afterEvening = hourIst >= QUIET_START_HOUR_IST;
  const beforeMorning = hourIst < QUIET_END_HOUR_IST;
  if (!afterEvening && !beforeMorning) return null;

  const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  const resumeIst = istMidnight + QUIET_END_HOUR_IST * HOUR_MS + (afterEvening ? DAY_MS : 0);
  return new Date(resumeIst - IST_OFFSET_MS);
}
```

Applied at `:353-357`: on a non-null deferral the row goes back to `queued` with `nextAttemptAt: resumeAt` and **no attempt counted**.

**Deceased suppression** — `:339-342` (verbatim):

```ts
  if (chain.some((p) => p.deceasedAt !== null)) {
    await markSuppressed(tx, row, "deceased", now);
    return { kind: "done" };
  }
```
It is asked of the WHOLE merge chain (`resolvePatientChain`, `:271-293`, bounded by `MERGE_MAX_HOPS = 5`, returns `null` on cycle/unresolved → `markSuppressed(..., "merge_unresolvable", ...)`).

**Expiry** — first check in the gauntlet, `:319-322`:
```ts
  if (row.expiresAt.getTime() <= now.getTime()) {
    await markExpired(tx, row, now);
    return { kind: "done" };
  }
```

Full gauntlet order in `prepareRow` (`:315-393`): 1 expiry → contact truth load → 2 deceased → 3 promotional belt → 4 quiet hours → 5 channel resolution (`to` from `patient.phone` or `userPhone`, empty/null → `markUndeliverable(..., "no_phone", ...)`) → 6 render.

**Render/language selection**, `:378-390` (verbatim):
```ts
  const language: "hi" | "en" =
    row.audience !== "patient" ? "en" : patient?.language === "en" ? "en" : "hi";
  let text: string;
  try {
    text = template.render[language](row.params);
  } catch (err) {
    await markUndeliverable(tx, row, "render_error", now, err instanceof Error ? err.message : String(err));
    return { kind: "done" };
  }
```

Other exported function: `completeSend`, `:218-223`:
```ts
export async function completeSend(
  tx: Tx,
  row: NotificationRow,
  sent: { channel: Channel; providerMessageId: string | null; templateVersion: number },
  now: Date,
): Promise<boolean> {
```

Claim SQL (`claimBatch`, `:470-494`) is a single `update … where id in (select id … where status='queued' and (next_attempt_at is null or next_attempt_at <= …) and (scheduled_for is null or scheduled_for <= …) order by created_at asc, id asc limit … for update skip locked) returning id`.

Terminal-state helpers (all guarded on `status='sending'` via `settle`, `:141-148`): `markExpired`, `markSuppressed(reason: "deceased" | "promotional_blocked" | "merge_unresolvable")` `:163-167`, `markUndeliverable(reason: "ladder_exhausted" | "no_phone" | "render_error" | "stuck_sending")` `:183-189`.

Scheduling: `/opt/hmis/apps/core/src/kernel/worker/jobs.ts:282-285` —
```ts
    name: "runNotifyPump",
    every: intervals.workerNotifyIntervalMs,
      await runNotifyPump(db, { now, stuckAfterMs: intervals.notifyStuckAfterMs });
```

### 1.6 `ChannelAdapter` / `adaptersFor` / provider selection

`/opt/hmis/apps/core/src/kernel/notify/adapters.ts:10-17` (verbatim):

```ts
export type ChannelAdapter = {
  channel: "whatsapp" | "sms";
  send(
    to: string,
    text: string,
    meta: { notificationId: string },
  ): Promise<{ providerMessageId: string | null }>;
};
```

`:19` `const LOG_BODY_CHARS = 80;` · `:33-39` `consoleWhatsappAdapter` · `:41-47` `consoleSmsAdapter` — both log one JSON line `{channel, to, notificationId, text: text.slice(0,80)}` and return `{ providerMessageId: null }`.

`:55-66` (verbatim):
```ts
export function adaptersFor(
  cfg: Pick<AppConfig, "notifyProvider">,
): Record<ChannelAdapter["channel"], ChannelAdapter> {
  switch (cfg.notifyProvider) {
    case "console":
      return { whatsapp: consoleWhatsappAdapter, sms: consoleSmsAdapter };
    default: {
      const exhaustive: never = cfg.notifyProvider;
      throw new Error(`adaptersFor: unmapped NOTIFY_PROVIDER ${String(exhaustive)}`);
    }
  }
}
```

**Env var: `NOTIFY_PROVIDER`. Allowed values: exactly `"console"`.** `/opt/hmis/apps/core/src/kernel/config.ts:31-32`, `:73`:
```ts
const notifyProviderSchema = z.enum(["console"]);
export type NotifyProvider = z.infer<typeof notifyProviderSchema>;
…
  NOTIFY_PROVIDER: notifyProviderSchema.default("console"),
```
Related keys: `WORKER_NOTIFY_INTERVAL_MS` (default 5000, `config.ts:72`), `NOTIFY_STUCK_AFTER_MS` (default 300000, `:207`), `NOTIFY_RETAIN_DAYS` (default 180, `:225`). Exposed as `cfg.notifyProvider` `:343/:409`, `cfg.notifyStuckAfterMs` `:354/:436`, `cfg.notifyRetainDays` `:360/:439`.

Note the seam at `pump.ts:73-82`: the pump hardcodes `PUMP_PROVIDER: NotifyProvider = "console"` because `registerAllJobs` reads no environment; a real provider is threaded in via `opts.adapters`.

**Adding a Web Push adapter touches `ChannelAdapter["channel"]`** — that union `"whatsapp" | "sms"` is duplicated in four shipped places: `adapters.ts:11`, `templates.ts:16` (`channels?: ("whatsapp" | "sms")[]`), `events.ts:24` (`channel: z.enum(["whatsapp","sms"])`), `schema/notifications.ts:50` comment on `sent_channel`.

### 1.7 `templates.ts` registry shape

`/opt/hmis/apps/core/src/kernel/notify/templates.ts:10-20` (verbatim):

```ts
export type NotificationTemplate = {
  key: string; // grammar: snake_case, audience-prefixed
  version: number; // bumped on any render change
  class: "transactional" | "promotional";
  audience: "patient" | "staff" | "owner";
  urgency: "routine" | "urgent";
  channels?: ("whatsapp" | "sms")[]; // default ["whatsapp", "sms"]
  waApprovalStatus: "not_submitted" | "pending" | "approved" | "rejected"; // data for §19, later
  expiresAt(params: Record<string, unknown>, occurredAt: Date): Date; // D5 — anchored on MEANING, never elapsed time
  render: Record<"hi" | "en", (params: Record<string, unknown>) => string>; // both, or no compile
};
```

- **Render signature**: `render: Record<"hi" | "en", (params: Record<string, unknown>) => string>`. **Languages that exist: exactly `hi` and `en`**, both mandatory by the type.
- **Params typing**: `Record<string, unknown>` — untyped at the boundary; templates read fields via the defensive helper `paramStr` (`:28-31`):
```ts
function paramStr(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : String(value);
}
```
- Registry itself, `:48`: `export const notificationTemplates: Record<string, NotificationTemplate> = { … };` — a **closed object literal with no registration function** (stated at `:145-150`: a module cannot register a template; appends land in this file).
- Lookup, `:217-223`:
```ts
export function templateByKey(key: string): NotificationTemplate {
  const template = notificationTemplates[key];
  if (!template) {
    throw new Error(`no notification template registered for key "${key}"`);
  }
  return template;
}
```
- The seven shipped keys, pinned whole-array in `/opt/hmis/apps/core/src/kernel/notify/templates.test.ts:19-32`: `appointment_confirmed`, `appointment_reminder`, `imaging_report_ready`, `owner_escalation_sms`, `patient_lab_report_ready`, `patient_welcome`, `staff_escalation`.
- Helper date formatters: `formatServiceDate` `:35-38` (`Intl.DateTimeFormat("en-IN", {day:"2-digit",month:"short",year:"numeric",timeZone:"Asia/Kolkata"})`), `formatSlotTime` `:41-44`, `expiresAtSlotStart` `:46`.

### 1.8 Notify events — payload schemas verbatim

`/opt/hmis/apps/core/src/kernel/notify/events.ts:12-61` (verbatim, all four; `notification.delivered` is deliberately absent per `:8-11`):

```ts
const MODULE = "notify";

const audienceSchema = z.enum(["patient", "staff", "owner"]);

export const notificationSent = defineEvent(
  "notification.sent",
  MODULE,
  z.object({
    notificationId: z.string().min(1),
    templateKey: z.string().min(1),
    templateVersion: z.number().int(),
    audience: audienceSchema,
    channel: z.enum(["whatsapp", "sms"]),
    providerMessageId: z.string().nullable(), // console adapter always returns null (D11)
  }),
);

export const notificationFailed = defineEvent(
  "notification.failed",
  MODULE,
  z.object({
    notificationId: z.string().min(1),
    templateKey: z.string().min(1),
    audience: audienceSchema,
    reason: z.enum(["ladder_exhausted", "no_phone", "render_error", "stuck_sending"]),
    refType: z.string().nullable(), // the outbox row's ref_type/ref_id — not every notification has one
    refId: z.string().nullable(),
  }),
);

export const notificationSuppressed = defineEvent(
  "notification.suppressed",
  MODULE,
  z.object({
    notificationId: z.string().min(1),
    templateKey: z.string().min(1),
    audience: audienceSchema,
    reason: z.enum(["deceased", "promotional_blocked", "merge_unresolvable"]),
  }),
);

export const notificationExpired = defineEvent(
  "notification.expired",
  MODULE,
  z.object({
    notificationId: z.string().min(1),
    templateKey: z.string().min(1),
    audience: audienceSchema,
  }),
);
```

`notify/manifest.ts:24-36` — `permissions: []`, `menu: []`, five subscriptions (listed below).

### 1.9 `consumer.ts` — subscribed events and the two escalation templates

Exports: `NOTIFY_CONSUMER = "kernel.notify"` (`:11`), `OWNER_ROLE = "owner"` (`:18`), `notifyConsumer(db: Db): Handler` (`:67`).

**Subscribed events** (switch in `notifyConsumer`, `:70-90`; manifest `notify/manifest.ts:29-35`; whole-array pinned at `consumer.test.ts:166-175`):
1. `patient.registered` → `handlePatientRegistered`
2. `appointment.booked` → `handleAppointmentBooked`
3. `appointment.rescheduled` → `handleAppointmentRescheduled`
4. `appointment.cancelled` → `handleAppointmentCancelled`
5. `escalation.triggered` → `handleEscalationTriggered`
`default:` throws — `` `notify consumer: no branch for event "${e.name}" — notifyManifest declares a subscription this handler does not serve` ``.

Constants `:21-33`: `APPOINTMENT_REF_TYPE = "appointment"`, `REMINDER_LEAD_MS = 24h`, `MIN_REMINDER_NOTICE_MS = 1h`, `PATIENT_WELCOME`, `APPOINTMENT_CONFIRMED`, `APPOINTMENT_REMINDER`, `STAFF_ESCALATION = "staff_escalation"`, `OWNER_ESCALATION_SMS = "owner_escalation_sms"`.

`handleEscalationTriggered` (`:204-240`): params are exactly `{ defKey, state, rung, role }`; loops `payload.resolvedUserIds` enqueuing `staff_escalation`; if `payload.fallbackExhausted`, loops `await usersHoldingRole(tx, OWNER_ROLE)` enqueuing `owner_escalation_sms`.

**`staff_escalation` template and bodies**, `/opt/hmis/apps/core/src/kernel/notify/templates.ts:105-119` (verbatim):

```ts
  staff_escalation: {
    key: "staff_escalation",
    version: 1,
    class: "transactional",
    audience: "staff",
    urgency: "urgent",
    waApprovalStatus: "not_submitted",
    expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 4 * HOUR_MS),
    render: {
      en: (params) =>
        `Escalation: "${paramStr(params, "defKey")}" is at state "${paramStr(params, "state")}" (rung ${paramStr(params, "rung")}, role ${paramStr(params, "role")}). Please review.`,
      hi: (params) =>
        `एस्केलेशन: "${paramStr(params, "defKey")}" "${paramStr(params, "state")}" स्थिति में है (चरण ${paramStr(params, "rung")}, भूमिका ${paramStr(params, "role")})। कृपया समीक्षा करें।`,
    },
  },
```

**`owner_escalation_sms`**, `templates.ts:125-140` (verbatim) — note `channels: ["sms"]`, the only template narrowing its own ladder:

```ts
  owner_escalation_sms: {
    key: "owner_escalation_sms",
    version: 1,
    class: "transactional",
    audience: "owner",
    urgency: "urgent",
    channels: ["sms"],
    waApprovalStatus: "not_submitted",
    expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 4 * HOUR_MS),
    render: {
      en: (params) =>
        `URGENT: "${paramStr(params, "defKey")}" escalation exhausted at rung ${paramStr(params, "rung")} (state "${paramStr(params, "state")}", role ${paramStr(params, "role")}). Please act.`,
      hi: (params) =>
        `अत्यावश्यक: "${paramStr(params, "defKey")}" एस्केलेशन चरण ${paramStr(params, "rung")} पर समाप्त (स्थिति "${paramStr(params, "state")}", भूमिका ${paramStr(params, "role")})। कृपया कार्रवाई करें।`,
    },
  },
```

---

## 2. Schema

### 2.1 `notifications` — every column verbatim

`/opt/hmis/apps/core/src/kernel/db/schema/notifications.ts:28-67` (verbatim, including the inline comments which carry the semantics):

```ts
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(), // ULID via newId() — entity ids share the event-id grammar
    audience: text("audience").notNull(), // 'patient' | 'staff' | 'owner' (D8; app-enforced against the columns below)
    patientId: text("patient_id").references(() => patients.id), // nullable: set iff audience='patient'
    userId: text("user_id").references(() => users.id), // nullable: set iff audience is 'staff' | 'owner'
    templateKey: text("template_key").notNull(), // key into the code registry (D8); rendering happens at send
    params: jsonb("params").$type<Record<string, unknown>>().notNull(), // ONLY event-payload fields (D8/N10) — no name lookups
    dedupeKey: text("dedupe_key").notNull(), // UNIQUE below — at-least-once redelivery inserts nothing (GC15)
    sourceEventId: text("source_event_id"), // nullable: producers that are not dispatcher consumers have none
    refType: text("ref_type"), // nullable; with ref_id, the expire-by-ref handle (D13) and E-22's future seam
    refId: text("ref_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(), // the EVENT's time, never the wall clock (D5/D13)
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // computed at enqueue by the template (D5)
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }), // nullable: null = due immediately (reminders set it)
    status: text("status").notNull().default("queued"), // 'queued'|'sending'|'sent'|'suppressed'|'expired'|'undeliverable'
    rung: integer("rung").notNull().default(0), // ladder position (D6): 0 = first channel; audience decides the ladder
    attempts: integer("attempts").notNull().default(0), // attempts AT THE CURRENT RUNG; quiet-hours deferral counts none (D4)
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }), // nullable; the claim predicate's other half
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentChannel: text("sent_channel"), // 'whatsapp' | 'sms' — which adapter accepted it (D11)
    sentTemplateVersion: integer("sent_template_version"), // the template version that actually rendered (D8)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_key_ux").on(t.dedupeKey),
    index("notifications_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
    index("notifications_ref_idx").on(t.refType, t.refId),
    index("notifications_status_updated_at_idx").on(t.status, t.updatedAt),
  ],
);
```

**There is no delivery-attempts table.** The attempt state is three columns on the row itself (`rung`, `attempts`, `lastError`) plus `next_attempt_at`. No `notification_attempts` / `delivery_attempts` table exists anywhere in `apps/core/src/kernel/db/schema/` (directory listing in this dossier's §2.3 shows the full file set; no such file, and the only notifications-related table is this one).

Migration: 0015 (per the test's describe: *"migration 0015 — the notifications outbox and the three columns beside it"*), with the prune index riding migration 0016.

### 2.2 `alerts` — every column verbatim

`/opt/hmis/apps/core/src/kernel/db/schema/alerts.ts:13-31` (verbatim, whole file body):

```ts
export const alerts = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    sourceEventId: text("source_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("alerts_source_event_user_ux").on(t.sourceEventId, t.userId),
    index("alerts_user_read_idx").on(t.userId, t.readAt),
  ],
);
```

**There is no `acknowledged_at` on `alerts`.** `read_at` is the only lifecycle timestamp beyond `created_at`.

### 2.3 Which test pins each

There is **no global schema census test**. Each table is pinned by a co-located per-table test:

- `notifications` → `/opt/hmis/apps/core/src/kernel/db/schema/notifications.test.ts`. Describe block at `:27`: `describe("migration 0015 — the notifications outbox and the three columns beside it", …)`. Its first test (`:41`, *"round-trips a queued patient row with every default applied"*) asserts every column individually: `status==="queued"`, `rung===0`, `attempts===0`, `typeof rung/attempts === "number"`, `audience`, `patientId`, `userId===null`, `templateKey`, `params` deep-equal, `sourceEventId`, `occurredAt`, `expiresAt`, and then `scheduledFor/nextAttemptAt/lastError/sentAt/sentChannel/sentTemplateVersion/refType/refId` all null, `createdAt`/`updatedAt` `instanceof Date`. Later tests pin the staff-row shape, the ref/scheduled_for pair, and the UNIQUE dedupe key.
- `alerts` → `/opt/hmis/apps/core/src/kernel/db/schema/alerts.test.ts`, `describe("alerts table")` at `:14`, four tests: `:27` optional columns empty (`body/refType/refId/readAt` null, `createdAt instanceof Date`), `:38` `(source_event_id, user_id)` pair UNIQUE, `:45` one event fans to a second recipient, `:54` `user_id` FK.
- Repo-wide there is also `/opt/hmis/apps/core/test/drizzle-snapshot-chain.test.ts` (migration chain) — not a column census. `information_schema.columns` is read only by `schema/formulary.test.ts`, `schema/materials.test.ts`, `schema/resources.test.ts`, `schema/ot.test.ts` — not by notifications or alerts.

---

## 3. `apps/core/src/kernel/alerts/`

Files: `alerts.controller.ts`, `alerts.module.ts`, `alerts.ts`, `consumer.ts`, `consumer.test.ts`, `events.ts`, `manifest.ts`, `realtime.ts`.

### 3.1 `alerts.controller.ts` — routes verbatim

`/opt/hmis/apps/core/src/kernel/alerts/alerts.controller.ts:35-57` (verbatim, the entire controller class):

```ts
@Controller("alerts")
export class AlertsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<{ items: AlertRow[]; unreadCount: number }> {
    const userId = requireUserActor(actor);
    return listAlerts(this.db, userId);
  }

  @Post(":id/read")
  async markRead(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
  ): Promise<{ alertId: string; readAt: Date; alreadyRead: boolean }> {
    requireUserActor(actor);
    try {
      return await markAlertRead(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }
}
```

Helpers, `:10-25`:
```ts
function toHttp(e: unknown): never {
  if (e instanceof AlertsError && e.code === "unknown_alert") throw new NotFoundException(e.message);
  throw e;
}

function requireUserActor(actor: Actor): string {
  if (actor.type !== "user") throw new ForbiddenException("user_actor_required");
  return actor.id;
}
```

**Auth model** (docstring `:27-34`, verbatim): *"NEITHER @Public NOR @RequirePermission, deliberately (D6): a route that declares no requirement is authenticated-only, so these are gated by AuthGuard alone and then scoped BY IDENTITY inside. Your alerts are yours because they are addressed to you, not because you hold a role … The shipped precedents for a permissionless authenticated route are `GET /auth/me` and `POST /auth/logout`."* The `requireUserActor` call is the only thing stopping an agent key (`:15-21`).

**The 50 cap**: `/opt/hmis/apps/core/src/kernel/alerts/alerts.ts:14` — `export const ALERTS_PAGE_LIMIT = 50;` applied at `:66` `.limit(ALERTS_PAGE_LIMIT)`. `unreadCount` is a separate uncapped `count(*)::int` (`:68-72`).

Two routes only. There is **no** `POST /alerts/:id/ack`, no bulk mark-read, no deep-link route.

### 3.2 `alerts.ts` — exported functions

- `:14` `export const ALERTS_PAGE_LIMIT = 50;`
- `:16` `export type AlertsErrorCode = "unknown_alert";`
- `:18-26` `export class AlertsError extends Error { constructor(readonly code: AlertsErrorCode, message?: string) … this.name = "AlertsError"; }`
- `:28-37`:
```ts
export type AlertRow = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: Date;
  readAt: Date | null;
};
```
- `:47-50`:
```ts
export async function listAlerts(
  db: Db,
  userId: string,
): Promise<{ items: AlertRow[]; unreadCount: number }> {
```
  Order clause `:65`: ``.orderBy(sql`${alerts.readAt} is not null`, desc(alerts.createdAt))`` — unread first, then newest.
- `:86-91`:
```ts
export async function markAlertRead(
  db: Db,
  actor: Actor,
  alertId: string,
  now: Date = new Date(),
): Promise<{ alertId: string; readAt: Date; alreadyRead: boolean }> {
```
  Conditional `UPDATE … WHERE id AND user_id AND read_at IS NULL RETURNING`; on won, appends `alertRead` in the same tx; on miss, an owned re-read distinguishes `alreadyRead: true` from `AlertsError("unknown_alert")` (404, deliberately not 403 — existence leak, `:81-84`).

### 3.3 `realtime.ts` — verbatim, whole file body

`/opt/hmis/apps/core/src/kernel/alerts/realtime.ts:4-27`:

```ts
export const ALERTS_TOPIC_PREFIX = "alerts";

export const alertsTopicSpace: TopicSpace = {
  prefix: ALERTS_TOPIC_PREFIX,
  authorize: (userId, topic) => topic === `${ALERTS_TOPIC_PREFIX}:${userId}`,
};

export const ALERTS_REALTIME_NAMES = ["alert.raised"];

export function alertsTopicsFor(e: Pick<TailedEvent, "name" | "payload">): string[] {
  const p = (e.payload ?? {}) as { userId?: string };
  return p.userId === undefined ? [] : [`${ALERTS_TOPIC_PREFIX}:${p.userId}`];
}

export const alertsTopicRouter: TopicRouter = {
  names: ALERTS_REALTIME_NAMES,
  topicsFor: alertsTopicsFor,
};
```

- **Topic naming**: `alerts:<userId>`, one topic per user.
- **What it fans**: exactly `alert.raised`. `alert.read` is NOT fanned (confirmed by `ALERTS_REALTIME_NAMES` containing one name; also stated in `alerts-bell.tsx:22`).
- **Identity- not permission-scoped**: it declares `authorize` and not `permission`. The gateway validates exactly-one-of at `registerTopicSpace` — `/opt/hmis/apps/core/src/kernel/realtime/gateway.ts:80-82`:
```ts
    const declared = (s.permission === undefined ? 0 : 1) + (s.authorize === undefined ? 0 : 1);
      throw new Error(`topic space "${s.prefix}" must declare exactly one of permission | authorize`);
```
  Types, `gateway.ts:14`, `:21-24`:
```ts
export type TopicRouter = { names: string[]; topicsFor: (e: TailedEvent) => string[] };
export type TopicSpace = {
  prefix: …;
  permission?: string;
  authorize?: (userId: string, topic: string) => boolean;
```
  Subscribe branch `gateway.ts:194-199`.
- **How the tail subscribes**: registration is at module init, `/opt/hmis/apps/core/src/kernel/alerts/alerts.module.ts:12-20` (verbatim):
```ts
@Injectable()
class AlertsRealtimeRegistrar implements OnModuleInit {
  constructor(private readonly gateway: RealtimeGateway) {}

  onModuleInit(): void {
    this.gateway.registerTopicSpace(alertsTopicSpace);
    this.gateway.registerRouter(alertsTopicRouter);
  }
}
```
  The tail is a **polling cursor over the shared `events` table**, not LISTEN/NOTIFY — `/opt/hmis/apps/core/src/kernel/realtime/tail.ts:4` `export type TailedEvent = { seq, eventId, name, occurredAt, patientId, encounterId, payload }`, class `EventTail` at `:26`, `poll()` at `:72`, floor = `max(seq)` at start (history never replayed), lookback window, `unref()`'d timer. `tail.ts:24` states: *"Deliveries are hints: subscribing screens also poll their read models every 15 s."* Fan-out at `gateway.ts:212`: `const topics = new Set(this.routers.filter((r) => r.names.includes(e.name)).flatMap((r) => r.topicsFor(e)));`

### 3.4 Manifest permissions — EMPTY

`/opt/hmis/apps/core/src/kernel/alerts/manifest.ts:14-59` (verbatim header of the object):
```ts
export const alertsManifest: ModuleManifest = {
  key: "alerts",
  title: "Alerts",
  menu: [], // the bell lives in the Shell header, not the menu (T5)
  permissions: [],
  subscriptions: [
    { event: "escalation.triggered", consumer: "kernel.alerts" },
    { event: "notification.failed", consumer: "kernel.alerts" },
    { event: "ops.mode_changed", consumer: "kernel.alerts" },
    { event: "imaging.critical_overdue", consumer: "kernel.alerts" },
    { event: "imaging.report_unread", consumer: "kernel.alerts" },
    { event: "approval.requested", consumer: "kernel.alerts" },
  ],
};
```
Docstring `:10-13`: *"`permissions` is deliberately EMPTY (D6). Alerts are yours BY IDENTITY, not by role… The routes carry neither @Public nor @RequirePermission and are authenticated-only."*

### 3.5 `alerts/consumer.ts` — six branches, one output

Exports: `ALERTS_CONSUMER = "kernel.alerts"` (`:17`), `OWNER_ROLE = "owner"` (`:24`), `DUTY_MANAGER_ROLE = "duty_manager"` (`:31`), `alertsConsumer(db: Db): Handler` (`:104`).

Kinds/ref types (`:33-77`): `escalation`/`workflow_instance`, `manual_notify`/`patient`, `operating_mode`/`operating_mode`, `approval_requested`/`approval`, `imaging_chase`/`imaging_study`; `ALERTING_MODES = new Set(["downtime","degraded"])`; `ALERTS_ACTOR: Actor = { type: "system", id: "kernel-alerts" }`.

Routing, `:105-127`: explicit `if` per subscription, `default` fallthrough is the escalation parser.

`raiseAlerts` (`:142-189`) is the sole insert path: per-recipient `withTx`, `.onConflictDoNothing({ target: [alerts.sourceEventId, alerts.userId] })`, and **only a won insert appends `alertRaised`** with payload `{ alertId, userId, kind, refType, refId, sourceEventId }` plus `causationId: e.eventId`.

`handleApprovalRequested` (`:372-404`) is the relevant one for the deep link: `refType: "approval"`, `refId: payload.approvalId`, title `` `Approval requested: ${payload.typeKey} (${payload.urgencyClass})` ``. Recipients = holders of `payload.approverRole` minus the requester, falling back to `duty_manager` then `owner`, and the fallback is named in the body.

`alerts/events.ts:12-32` (verbatim):
```ts
export const alertRaised = defineEvent(
  "alert.raised",
  "alerts",
  z.object({
    alertId: z.string(),
    userId: z.string(), // the topic key: realtime.ts routes on this field
    kind: z.string(),
    refType: z.string(),
    refId: z.string(),
    sourceEventId: z.string(),
  }),
);

export const alertRead = defineEvent(
  "alert.read",
  "alerts",
  z.object({
    alertId: z.string(),
    userId: z.string(),
  }),
);
```
No `alert.acknowledged` event exists.

---

## 4. Web

### 4.1 `apps/web/src/components/alerts-bell.tsx` — IN FULL

`/opt/hmis/apps/web/src/components/alerts-bell.tsx`, 111 lines, verbatim:

```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { listAlerts, markAlertRead } from "../lib/alerts-api";
import { useAuth } from "../lib/auth";
import { useRealtime } from "../lib/realtime";
import { SubmitButton } from "./submit-button";
import { Badge } from "@/components/ui/badge";

/**
 * THE FIRST HUMAN-FACING SURFACE OF THE RUNTIME LOOP (Plan 08.5 T5 / D6). An escalation the
 * scheduler raises now has somewhere to land: this bell polls `GET /alerts`, shows the unread
 * count, and lets the signed-in user mark one read.
 *
 * THE REALTIME FRAME IS AN INVALIDATE HINT, NEVER A RENDER SOURCE (D6/the opd-appointments
 * precedent). T4's gate measured the wire frame over WS: `{alertId, userId, kind, refType, refId,
 * sourceEventId}` — no `title`, no patient identity — so there is nothing in the frame this
 * component could render even if it wanted to. A frame on `alerts:<actor.id>` only triggers a
 * re-fetch of the poll below; a missed frame costs the next 15 s tick, never correctness.
 *
 * `alert.read` does not fan out over WS (findings inbox, T4 gate item 6) — a second tab's badge
 * clears on its own next poll, not immediately. By design; not this task's surface to change.
 */
const POLL_MS = 15_000;

function relativeLabel(iso: string, t: TFunction, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return t("alerts.justNow");
  if (minutes < 60) return t("alerts.minutesAgo", { n: minutes });
  return t("alerts.hoursAgo", { n: Math.floor(minutes / 60) });
}

export function AlertsBell(): React.ReactElement | null {
  const { t } = useTranslation();
  const { actor } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: listAlerts,
    enabled: actor !== null,
    refetchInterval: POLL_MS,
  });

  useRealtime(actor === null ? [] : [`alerts:${actor.id}`], () => {
    void qc.invalidateQueries({ queryKey: ["alerts"] });
  });

  // Nothing to show before the actor resolves (no identity, no topic, no route to call).
  if (actor === null) return null;

  const items = alerts.data?.items ?? [];
  const unreadCount = alerts.data?.unreadCount ?? 0;

  const markRead = async (id: string, key: string): Promise<void> => {
    await markAlertRead(id, key);
    await qc.invalidateQueries({ queryKey: ["alerts"] });
  };

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="alerts-bell-toggle"
        aria-label={t("alerts.title")}
        onClick={() => setOpen((o) => !o)}
        className="relative"
      >
        {t("alerts.bellIcon")}
        {unreadCount > 0 && (
          <Badge data-testid="alerts-unread-badge" variant="destructive" className="absolute -top-2 -right-2 px-1">
            {unreadCount > 9 ? "9+" : unreadCount}
          </Badge>
        )}
      </button>
      {open && (
        <div
          data-testid="alerts-panel"
          className="absolute right-0 top-full z-50 mt-2 w-80 rounded border bg-background text-sm shadow-lg"
        >
          {items.length === 0 ? (
            <p className="p-3 text-neutral-500">{t("alerts.empty")}</p>
          ) : (
            <ul>
              {items.map((a) => (
                <li key={a.id} data-testid={`alert-row-${a.id}`} className="flex items-start justify-between gap-2 border-b p-2 last:border-b-0">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{a.title}</p>
                    <p className="text-xs text-neutral-500">{relativeLabel(a.createdAt, t)}</p>
                  </div>
                  {a.readAt === null && (
                    <SubmitButton
                      data-testid={`alerts-mark-read-${a.id}`}
                      variant="ghost"
                      size="sm"
                      onClick={(key) => markRead(a.id, key)}
                    >
                      {t("alerts.markRead")}
                    </SubmitButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
```

Note for the deep-link work: the panel renders `a.title` and `relativeLabel(a.createdAt)` and **nothing else** — `a.refType` / `a.refId` are fetched and unused. There is **no `<Link>` and no router import** in this file.

Mounted at `/opt/hmis/apps/web/src/router.tsx:14` (`import { AlertsBell } from "./components/alerts-bell";`) and rendered once at `:398` inside `ShellChrome`'s header.

### 4.2 `alerts-bell.test.tsx` — the harness

`/opt/hmis/apps/web/src/components/alerts-bell.test.tsx`, 171 lines.

- **How it mounts**: `renderWithProviders(<AlertsBell />)` — `:110`, `:133`, `:162`. That helper is `/opt/hmis/apps/web/src/test-utils.tsx:7-19` (verbatim):
```tsx
export function renderWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider><PatientInHandProvider>{ui}</PatientInHandProvider></AuthProvider>
    </QueryClientProvider>,
  );
}
```
  **So: `QueryClientProvider` YES, `AuthProvider` YES, `PatientInHandProvider` YES, ROUTER — NO.** There is no `RouterProvider` / `createMemoryHistory` anywhere in `test-utils.tsx`. Adding a `<Link to="/approvals">` to the bell will break this harness unless a router is added or the link is stubbed.
- **Fetch mock**: a local `mockRoutes` (NOT the shared `stubFetch`), `:39-58`:
```ts
type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply);

/** `stubFetch` always answers 200; a POST here must answer 201 (D6), so a direct stub is used. */
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler() : handler;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}
```
  Routes stubbed: `"GET /api/auth/me"`, `"GET /api/alerts"`, `"POST /api/alerts/al-1/read"` (`:101-107`).
- **WebSocket**: a local `class FakeWebSocket` (`:13-33`) installed via `vi.stubGlobal("WebSocket", FakeWebSocket)`; `resetRealtimeClientForTests()` in `beforeEach` (`:84`).
- Time pinned: `const NOW_ISO = "2026-08-21T09:40:00.000Z";` (`:37`), `vi.setSystemTime` `:85`.
- Fixture `alertRow()` `:71-77`: `{ id: "al-1", kind: "escalation", title: "OPD wait escalated — reception queue", body: null, refType: "workflow_instance", refId: "wf-1", createdAt: NOW_ISO, readAt: null }`.
- Three tests: `:95` badge + panel + mark-read clears badge + exactly one POST carrying an `Idempotency-Key`; `:132` nothing renders before the actor resolves; `:146` `refetchInterval: 15_000` presence-only.

### 4.3 `apps/web/src/lib/realtime.ts` — exported hooks, and the `alert.raised` refetch

Exports (`/opt/hmis/apps/web/src/lib/realtime.ts`):
- `:4` `export type EventFrame = { type: "event"; topic: string; name: string; seq: number; occurredAt: string; payload: unknown };`
- `:9` `export class RealtimeClient` — one socket per tab; ctor `(private readonly url: string, private readonly token: () => string | null)`; methods `onStatus(l): () => void` `:18`, `get connected(): boolean` `:19`, `subscribe(topics: string[], h: Handler): () => void` `:21`; reconnect with capped exponential backoff (1 s → 30 s, `:63-64`).
- `:71-79` `export function realtimeClient(): RealtimeClient` — singleton at `` `${proto}://${location.host}${API_BASE}/ws` ``.
- `:81` `export function resetRealtimeClientForTests(): void`
- `:84-96` (verbatim):
```ts
export function useRealtime(topics: string[], onEvent: (f: EventFrame) => void): { connected: boolean } {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const key = topics.join("|");
  const [connected, setConnected] = useState(realtimeClient().connected);
  useEffect(() => {
    const client = realtimeClient();
    const off = client.subscribe(key === "" ? [] : key.split("|"), (f) => cb.current(f));
    const offStatus = client.onStatus(setConnected);
    return () => { off(); offStatus(); };
  }, [key]);
  return { connected };
}
```

**How `alert.raised` refetches**: `useRealtime` does not filter by event name at all — the client dispatches on TOPIC (`realtime.ts:56`: `for (const h of this.handlers.get(f.topic) ?? []) h(f);`). The bell subscribes to the single topic `alerts:${actor.id}` and its callback body is unconditionally `void qc.invalidateQueries({ queryKey: ["alerts"] });` (`alerts-bell.tsx:47-49`). Since `alertsTopicRouter.names === ["alert.raised"]`, that topic can only carry `alert.raised` today, so any frame on it = a refetch of `GET /alerts`.

### 4.4 `apps/web/src/lib/alerts-api.ts` — IN FULL

`/opt/hmis/apps/web/src/lib/alerts-api.ts`, 37 lines, verbatim:

```ts
import { api } from "./api";

/**
 * The alerts wire contract (Plan 08.5 D6/D9), transcribed from the route contract T4's gate
 * measured over HTTP (plan-08.5-findings-inbox.md, "T4 coder … for T5"): `GET /alerts` returns
 * `{ items, unreadCount }` with `items` capped at 50 server-side and `unreadCount` a SEPARATE,
 * uncapped count — this file describes the shape, it does not re-derive it. `AlertRow` carries
 * no `userId` on the wire (identity-scoped by the auth token, D6) and no patient identity (L8).
 */
export type WireAlert = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: string;
  readAt: string | null;
};

export type WireAlertsList = { items: WireAlert[]; unreadCount: number };

/** `POST /alerts/:id/read`'s body. A repeat is a no-op that still reports `alreadyRead: true`. */
export type WireMarkReadResult = { alertId: string; readAt: string; alreadyRead: boolean };

export function listAlerts(): Promise<WireAlertsList> {
  return api("GET", "/alerts");
}

/**
 * `idempotencyKey` is `SubmitButton`'s minted attempt key. The server ignores it on this route —
 * the conditional `UPDATE … WHERE read_at IS NULL` is already idempotent (D6) — carried anyway
 * because `SubmitButton` is a write-lane convention, not a per-route judgement call (D11).
 */
export function markAlertRead(id: string, idempotencyKey: string): Promise<WireMarkReadResult> {
  return api("POST", `/alerts/${id}/read`, undefined, idempotencyKey);
}
```

### 4.5 Service worker / PWA / Web Push in `apps/web` — **ABSENT**

Grep run (from `/opt/hmis/apps/web`), verbatim command and result:

```
$ grep -rniE "serviceWorker|service-worker|workbox|vite-plugin-pwa|VitePWA|webmanifest|requestPermission|PushManager|pushSubscription|web-push|vapid|Notification\(" src index.html package.json vite.config.ts
EXIT=1          # zero matches
```

A broader, whole-app grep (`--include` ts/tsx/json/html/js/mjs/cjs, excluding node_modules) returned exactly one file: `apps/web/dist/assets/index-Bp5RlAvU.js`, and inspecting it shows the match is React's own preload-link vendor code (`case "audioworklet": case "paintworklet": case "serviceworker": case "sharedworker": case "worker": case "script":`) — a built artefact, not source.

Directory facts: `/opt/hmis/apps/web/public/` contains exactly one entry, `fonts/` — no `manifest.webmanifest`, no `sw.js`. `/opt/hmis/apps/web/` root: `components.json`, `dist/`, `index.html`, `node_modules/`, `package.json`, `public/`, `src/`, `tsconfig.json`, `vite.config.ts` — no PWA plugin config file.

Conclusion: **no service worker, no `vite-plugin-pwa`, no `manifest.webmanifest`, no `Notification.requestPermission`, no `PushManager`, no VAPID, no `web-push` dependency anywhere in `apps/web` source.** A Web Push adapter starts from zero on the client side.

Server side likewise: `grep -rn "web-push\|vapid\|PushSubscription"` over `apps/core/src` returns nothing (no push subscription table exists in `apps/core/src/kernel/db/schema/`).

### 4.6 Web settings page — **ABSENT**

Grep run:
```
$ grep -rniE "\bsettings\b|\bpreferences\b|\bmy account\b|userPref" apps/web/src --include="*.tsx" --include="*.ts" --include="*.json"
```
Hits are all unrelated: `apps/web/src/lib/aerb-api.ts:387` (`POST /aerb/settings/investigation-level` — a radiation-safety admin knob), `apps/web/src/screens/radiation-safety.test.tsx:584`, `apps/web/src/locales/en.json:400-406` ("Radiology settings" / "OT settings" — formulary change-control labels), and three "my account has no access" prose strings (`router.tsx:450`, `desk.tsx:405`, `shell-nav.test.tsx:223`). `grep -rni "settings\|preferences" apps/web/src/router.tsx` → zero hits.

The only route that is "a user's own" is `/change-password` — `/opt/hmis/apps/web/src/router.tsx:524-531`, a **sibling of `/login`, NOT a child of the shell** (docstring `:516-523`), with its own `beforeLoad` token check and `component: ChangePassword` (`/opt/hmis/apps/web/src/screens/change-password.tsx`). Plus `/my-day` (`router.tsx:566-570`), which is the person's own day's report, not preferences.

**There is nowhere today for per-person channel/notification preferences to live in the UI.**

i18n keys the bell uses (`/opt/hmis/apps/web/src/locales/en.json`, `alerts` block):
```json
"alerts": {
  "title": "Alerts", "bellIcon": "🔔", "empty": "Nothing yet", "markRead": "Mark read",
  "justNow": "Just now", "minutesAgo": "{{n}}m ago", "hoursAgo": "{{n}}h ago"
}
```
`hi.json` mirror: `"title": "सूचनाएं", "bellIcon": "🔔", "empty": "अभी कुछ नहीं", "markRead": "पढ़ा हुआ चिह्नित करें", "justNow": "अभी", "minutesAgo": "{{n}} मिनट पहले", "hoursAgo": "{{n}} घंटे पहले"`. No `alerts.ack*` key exists in either file.

---

## 5. Routing pattern (for transcription) + i18n

### (a) A `createRoute` for an authenticated screen — complete example

`/opt/hmis/apps/web/src/router.tsx:808-812` (the approvals route itself — the simplest complete example):
```tsx
const approvalsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/approvals",
  component: ApprovalsInbox,
});
```

The parent that supplies the auth gate, `:533-540`:
```tsx
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: () => {
    if (getToken() === null) throw redirect({ to: "/login" });
  },
  component: Shell,
});
```
Root, `:511`: `const rootRoute = createRootRoute({ component: () => <Outlet /> });`

A route with search-param validation (if the deep link needs `?alertId=`), `:588-601`:
```tsx
const opdDayReportRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/reports/opd-day",
  validateSearch: (search: Record<string, unknown>): { date?: string; period?: "day" | "week" | "month" } => ({
    date: typeof search.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.date) ? search.date : undefined,
    period: search.period === "week" || search.period === "month" || search.period === "day" ? search.period : undefined,
  }),
  component: function OpdDayReportRoute() {
    const { date, period } = opdDayReportRoute.useSearch();
    return <OpdReportScreen initial={date === undefined ? undefined : { period: period ?? "day", date }} />;
  },
});
```
A redirect-only route (no component), `:1255-1258`:
```tsx
const legacySeatRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/counter/seat",
  beforeLoad: ({ search }) => { throw redirect({ to: "/counter", search }); },
});
```

### (b) The nav entry array item shape

Declaration, `/opt/hmis/apps/web/src/router.tsx:104-106`:
```tsx
type NavGroup = "desk" | "patients" | "opd" | "billing" | "stores" | "admin";
/** Reading order is the order a desk WORKS in — the counter first, administration last. */
const NAV_GROUPS: readonly NavGroup[] = ["desk", "patients", "opd", "billing", "stores", "admin"];
const NAV: readonly { to: string; label: string; permission: string; group: NavGroup }[] = [
```
The approvals row, `:162` (verbatim, one complete item):
```tsx
  { to: "/approvals", label: "nav.approvals", permission: "approvals.requests.read", group: "admin" },
```

How the nav is rendered, `:427-444`:
```tsx
        {NAV_GROUPS.map((group) => {
          const entries = NAV.filter((e) => e.group === group && can(e.permission));
          if (entries.length === 0) return null;
          return (
            <span key={group} className="grp">
              <span className="tag">{t(`nav.group.${group}`)}</span>
              {entries.map((entry) => (
                <Link
                  key={entry.to}
                  to={entry.to}
                  className={pathname === entry.to ? "here" : undefined}
                >
                  {t(entry.label)}
                </Link>
              ))}
            </span>
          );
        })}
```
Empty-nav sentence at `:445-454` (`t("nav.noneAvailable")`).

**Pinned by** `/opt/hmis/apps/core/test/nav-parity.test.ts` — parses the `const NAV:` array out of `router.tsx` as TEXT (function `navEntries`, `:52+`, which THROWS if `const NAV:` is missing) and compares `{to, permission}` against `ALL_MANIFESTS`' `menu` entries. Assertions: `:99` non-vacuous census (`nav.length > 15`, `menu.size > 15`, `shared.length > 15`), `:108` every path in BOTH lists carries the SAME permission (`expect({ drift }).toEqual({ drift: [] })`), `:128` the three materials entries. A NAV entry whose path is in no manifest is legitimate and not compared.

### (c) How routes are collected into the tree

`/opt/hmis/apps/web/src/router.tsx:1271-1310` (the whole `createRouter` call, comments elided here but present in-file; the structural shape is exact):
```tsx
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    changePasswordRoute,
    authedRoute.addChildren([
      indexRoute, myDayRoute, staffReportsRoute, opdDayReportRoute, counterDeskRoute, patientRoute, mergeRoute, approvalsRoute, opdAdminRoute, opdAppointmentsRoute,
      opdDeskRoute, opdConsultRoute, opdScribeRoute, opdDisplayRoute, billingRoute, billingDuesRoute,
      billingSessionRoute, billingOfficeRoute, opsModeRoute, opsDowntimeKitRoute, adminUsersRoute,
      counterInstrumentsRoute, instrumentReconcileRoute, partnerReceivablesRoute, partnerPnlRoute,
      counterFiguresRoute,
      registrationRoute,
      appointmentRoute,
      slipCaptureRoute,
      vitalsBayRoute,
      formularyAdminRoute,
      materialsItemsRoute, materialsVendorsRoute, materialsGrnRoute,
      otListRoute, otBookRoute, otCockpitRoute, otRecoveryRoute,
      labDeskRoute, labCollectionRoute, labBenchRoute, labVerifyRoute,
      labReportsRoute,
      radiologyReceptionRoute, radiologyWorklistRoute, radiologyStudyRoute, radiologyReportRoute,
      pcpndtFormFRoute, radiationSafetyRoute,
      pharmacyCounterRoute, pharmacyDeskRoute, pharmacyDeskTicketRoute, pharmacyAuthoriseRoute, pharmacyItemsRoute, pharmacyPharmacistsRoute, pharmacyReorderRoute, pharmacyH1RegisterRoute, materialsCountsRoute, materialsTransfersRoute, pharmacyLeakageRoute,
      pharmacyRetailRoute, pharmacyRetailLicenceRoute, pharmacyDowntimeRoute,
      legacySeatRoute, legacySeatFiguresRoute, legacyVitalsBayRoute,
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

**Transcription recipe for a new authenticated route**: (1) import the screen at the top of `router.tsx`; (2) add a `createRoute({ getParentRoute: () => authedRoute, path: "/x", component: X })`; (3) add the const into the `authedRoute.addChildren([…])` array; (4) if it should appear in the nav, add a `{ to, label, permission, group }` row to `NAV` **and** the matching `menu` entry in the server manifest (nav-parity compares them); (5) add the label key to BOTH `en.json` and `hi.json`; (6) bump the count in `caddyfile-parity.test.ts` (see §6).

### i18n pattern

- Bundles: `/opt/hmis/apps/web/src/locales/en.json`, `/opt/hmis/apps/web/src/locales/hi.json`.
- Consumed in `/opt/hmis/apps/web/src/lib/i18n.ts:8-13`:
```ts
void i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi } },
  lng: localStorage.getItem(LANG_KEY) ?? "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React escapes
});
```
  plus `stampDocumentLanguage` (`:28-30`) and `export function switchLanguage(lng: "en" | "hi"): void` (`:34-38`). Storage key `const LANG_KEY = "hmis.lang";` (`:6`) — **this is where a UI language preference lives today: `localStorage`, per browser, not per user on the server.**
- Screens consume via `const { t } = useTranslation();` then `t("ns.key")` / `t("ns.key", { n })`.

**The key-parity test** — `/opt/hmis/apps/web/src/lib/i18n.test.ts`, 13 lines, complete:
```ts
import en from "../locales/en.json";
import hi from "../locales/hi.json";

function keyPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix === "" ? k : `${prefix}.${k}`),
  );
}

it("hi.json mirrors en.json key-for-key — a missing key would silently fall back to English", () => {
  expect(keyPaths(hi).sort()).toEqual(keyPaths(en).sort());
});
```

**A second, stricter test**: `/opt/hmis/apps/web/src/lib/i18n-keys.test.ts` (399 lines), which walks all non-test `.ts/.tsx` under `apps/web/src` and enforces four rules:
- `:295` every literal `t("ns.key")` resolves to a STRING in `en.json` (regex `T_CALL` at `:55`; comments stripped first by `stripComments` `:85-97`; plural suffixes `_one/_other/_zero/_two/_few/_many` accepted at `:108`).
- `:339` a `t("k")` with NO second argument against a string containing `{{…}}` is a failure.
- `:383` a key that exists ONLY as a plural pair must be called with a `count` option.
- `:250`/`:261`/`:266` no hand-spelled plural (`patient(s)`, `box(es)`, `patient/s`) in `en.json`, `hi.json`, or any hardcoded string literal in the web source.
- Non-vacuity guard at `:289`: `files.length > 50` and total `t()` calls `> 500`.

---

## 6. `apps/core/test/caddyfile-parity.test.ts`

File: `/opt/hmis/apps/core/test/caddyfile-parity.test.ts`, 506 lines.

Paths it reads (`:64-69`):
```ts
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const VITE_CONFIG = resolve(REPO_ROOT, "apps", "web", "vite.config.ts");
const CADDYFILE = resolve(REPO_ROOT, "docker", "prod", "Caddyfile");
const WEB_SRC = resolve(REPO_ROOT, "apps", "web", "src");
const ROUTER_TSX = resolve(WEB_SRC, "router.tsx");
```
**The Caddyfile it reads is `/opt/hmis/docker/prod/Caddyfile`.**

What it pins — five `it`s in `describe("Caddyfile / vite dev-proxy parity (Plan 11a D14)")`:
1. `:230` vite proxy census: `expect(vite).toHaveLength(1); expect(vite).toEqual(["/api"]);`
2. `:239` `expect(caddyProxyPrefixes(caddySource)).toEqual(viteProxyPrefixes(viteSource));`
3. `:243` `expect(caddySource).toMatch(/handle\s+@api\s*\{[^}]*\breverse_proxy\s+api:3000\b/);`
4. `:247` the `uri strip_prefix /api` leg.
5. `:253` the one-door leg: `expect(called.length).toBeGreaterThanOrEqual(9)`, `expect(called).toContain("/admin"|"/ops"|"/tariff")`, **`expect(fetchCallingModules()).toEqual(["lib/api.ts"])`**, and `API_BASE` ∈ both proxy lists.
6. `:292` **the SPA route census** — `it("PLAN 11g — no SPA route falls inside a Caddy-proxied prefix (smoke-test D1)")`.

**The route count today**: `/opt/hmis/apps/core/test/caddyfile-parity.test.ts:415` (verbatim):
```ts
    expect(routes).toHaveLength(68); // MERGE 2026-09-15: main's grants + the lane's, measured from the failing run
```
followed by ~45 `expect(routes).toContain("/…")` named-route assertions (`:416-499`) and the shadow check `:501-504`:
```ts
    const proxied = caddyProxyPrefixes(caddySource);
    const shadowed = routes.filter((route) => proxied.some((p) => route === p || route.startsWith(p)));
    expect(shadowed).toEqual([]);
```

The parser it uses (`spaRoutePaths`, `:210-220`, verbatim):
```ts
function spaRoutePaths(source: string): string[] {
  const paths: string[] = [];
  for (const match of source.matchAll(/\bpath:\s*"(\/[^"]*)"/g)) {
    const path = match[1];
    if (path !== undefined) paths.push(path);
  }
  if (paths.length === 0) {
    throw new Error('router.tsx: no `path: "/…"` route declaration found — this parser is stale');
  }
  return [...new Set(paths)].sort();
}
```
i.e. it reads `path: "/…"` literals out of `router.tsx`, deduped. `redirect({ to: "/…" })` is deliberately NOT matched (`:205-207`).

**What edit a new web route needs there**: exactly one line — raise `expect(routes).toHaveLength(68)` at `:415` to 69 (or +N), and per the file's own convention add a dated comment above it recording the move (the convention is "MEASURED from the failing run, never predicted"; see the comment stack `:295-414`). Optionally add an `expect(routes).toContain("/your/path")`. **No Caddyfile edit is needed** — since Plan 11g / DD1 there is exactly one proxied prefix (`/api`), and the docstring at `:24-27` says the count "stays as a non-vacuity pin, not as friction". The only hard constraint on the new path is that it must NOT start with `/api` (the `shadowed` leg at `:504`).

The Caddyfile itself (`/opt/hmis/docker/prod/Caddyfile`, 86 lines) declares `@api path /api*` at `:64`, `handle @api { uri strip_prefix /api; reverse_proxy api:3000 }` at `:70-77`, and the SPA fallback `handle { root * /srv; try_files {path} /index.html; file_server }` at `:81-85`.

---

## 7. `users` — every column verbatim, and `users.phone`

`/opt/hmis/apps/core/src/kernel/db/schema/auth.ts:5-56` (verbatim; the long FD-29 docstring on `staffCode` is elided at the marked point, everything else is complete):

```ts
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    fullName: text("full_name").notNull(),
    /**
     * ═══ FD-29 — THE STAFF ID (owner, 2026-09-06: *"We should have staff-ID in the schema"*) ═══
     * … [20-line docstring: `EMP-` + four digits, unique, minted at createUser, overridable;
     *     distinct from `opd_doctors.code`] …
     */
    staffCode: text("staff_code").notNull(),
    // Staff/owner external messaging (Plan 10). Normalized 10-digit Indian mobile — the SAME
    // convention as patients.phone (schema/patients.ts) — and NULLABLE: a phoneless owner simply
    // degrades to the in-app alert that already ships. No collection flow exists in this phase;
    // numbers are deployment data, seeded per hospital.
    phone: text("phone"),
    passwordHash: text("password_hash").notNull(),
    pinHash: text("pin_hash"),
    badgeVersion: integer("badge_version").notNull().default(0),
    active: boolean("active").notNull().default(true),
    // PLAN 11e D1 — the forced-credential-change flag …
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_username_ux").on(t.username), uniqueIndex("users_staff_code_ux").on(t.staffCode)],
);
```

**`users.phone`**: `phone: text("phone")` at `:36` — nullable, 10-digit normalized Indian mobile. Read by the pump at `/opt/hmis/apps/core/src/kernel/notify/pump.ts:395-401`:
```ts
async function userPhone(tx: Tx, userId: string | null): Promise<string | null> {
  if (userId === null) {
    throw new Error("notify pump: a staff/owner row carries no user_id");
  }
  const found = await tx.select({ phone: users.phone }).from(users).where(eq(users.id, userId));
  return found[0]?.phone ?? null;
}
```

**User preference / language column: ABSENT.** `grep -rn "language" apps/core/src/kernel/db/schema/*.ts` returns hits only on `patients.ts:95` (`language: text("language").notNull().default("hi"), // 'hi' | 'en' — outbound-message language (§6), NOT the UI language`), `lab.ts:61`, `opd.ts:543`, and comments in `notifications.ts`/`notifications.test.ts`. **There is no `users.language`, no `users.locale`, no `user_preferences` table, no `notification_preferences` table.** Staff/owner messages render `en` unconditionally (`pump.ts:378-379`: `row.audience !== "patient" ? "en" : …`).

Other tables in `auth.ts`: `roles` `:58`, `permissions` `:65`, `rolePermissions` `:71`, `roleAssignments` `:80`, `authSessions` `:93`, `agents` `:112`, `userTotp` `:124`, `sodPairs` `:130`, `tempRoleGrants` `:135`, `breakGlassGrants` `:179`, `authThrottle` `:218`.

---

## 8. The desk rail on `/` that shows approvals

**Route**: `/opt/hmis/apps/web/src/router.tsx:555-559`:
```tsx
const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  component: Desk,
});
```

**File**: `/opt/hmis/apps/web/src/screens/desk.tsx` (482 lines), `export function Desk(): React.ReactElement` at `:300`.

**What API it calls**: `GET /me/desk` — `desk.tsx:305`:
```tsx
  const desk = useQuery({ queryKey: ["me", "desk", actor?.id ?? "", date], queryFn: () => fetchDesk(date), enabled: actor !== null });
```
(`fetchDesk` at `/opt/hmis/apps/web/src/lib/desk-api.ts:66`, wire types `WireDeskCard` `:41`, `WireDesk = { date, cards }` `:51`, `WireDeskStat` `:20`.) Plus `GET` current cash session — `desk.tsx:308-312`, `fetchCurrentSession` from `lib/billing-api`.

**The approvals element is a LINK, not a rail of approval rows.** `desk.tsx:228-241`, verbatim:
```tsx
function AwaitingApprovalPanel(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="box drawer" data-testid="drawer-awaiting">
      <div className="say">
        <div className="ttl">{t("desk.drawer.awaitingTitle")}</div>
        <p className="body">{t("desk.drawer.awaitingBody")}</p>
      </div>
      <div className="form">
        <Link to="/billing/session" className="pri" data-testid="drawer-goto-session">{t("desk.drawer.seeCount")}</Link>
        <Link to="/approvals" className="sec">{t("desk.drawer.seeApproval")}</Link>
      </div>
    </div>
  );
}
```
Gated at `desk.tsx:368` (`const awaitingApproval = holdsDrawer && drawerStatus === "closing";`) and rendered at `:395-396`. So it appears **only** for a `billing.session.own` holder whose drawer is in `closing`.

**There is no approvals desk-card provider on the server.** `find apps/core/src -name "desk-provider*.ts"` → billing, membership, opd, partners, patients, pharmacy only. `grep -rn "deskCard\|DeskCard" apps/core/src/kernel/approvals/` → zero hits. So `GET /me/desk` never returns a pending-approvals count today.

**The approvals screen itself**: `/opt/hmis/apps/web/src/screens/approvals-inbox.tsx` (531 lines), `ApprovalItem` type `:42-62`, `ApprovalList = { items, total }` `:64`. Queries at `:412-427`:
```tsx
  const pending = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => fetchList("/approvals"),
…
  const decided = useQuery({
    queryKey: ["approvals", "decided"],
…
        fetchList(`/approvals?status=granted&limit=${String(DECIDED_PAGE)}`),
        fetchList(`/approvals?status=rejected&limit=${String(DECIDED_PAGE)}`),
```
Decide: `:294` `await api("POST", `/approvals/${item.id}/${verdict}`, { note: note.trim() });` then `invalidateQueries({ queryKey: ["approvals"] })`.
Server routes (`/opt/hmis/apps/core/src/kernel/approvals/approvals.controller.ts`): `@Controller("approvals")` `:67`; `POST types` (`approvals.types.manage`) `:72-74`; `POST /` (`approvals.requests.create`) `:87-89`; `GET /` (`approvals.requests.read`) `:102-104` → `{ items: ApprovalListItem[]; total: number }`; `GET /:id` (`approvals.requests.read`) `:121-123`; `POST /:id/approve` and `POST /:id/reject` (`approvals.requests.decide`) `:129-131`, `:145-147`.
The inbox screen takes **no search params today** — `approvalsRoute` has no `validateSearch`, so a deep link `/approvals?alert=<id>` would need one added.

---

## 9. Existing "acknowledge" / "ack" concept in `apps/core/src`

`grep -rniE "acknowledg" apps/core/src --include="*.ts"` → **241 matching lines across 40 files**, but **ALL of the real (non-comment) concept lives in radiology, and there is NOTHING on alerts or notifications.**

**The only acknowledgement STATE in the schema** — `/opt/hmis/apps/core/src/kernel/db/schema/radiology.ts`, table `imagingCriticalFindings`:
- `:500` `acknowledgedBy: text("acknowledged_by"),`
- `:501` `/** F76 — who entered the acknowledgement. Separate from who gave it, deliberately. */` (an `acknowledged_via`-style sibling column follows in the same block)
- `:503` `acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),`
- `:525-527` `/** The chaser's own query: everything unacknowledged and unchased, oldest first. */` … `.on(t.acknowledgedAt, t.chasedAt, t.createdAt)`
- `:529-532` the half-acknowledgement CHECK, verbatim: `/** An acknowledgement is a person and an instant; half of one is not an acknowledgement. */` … ``sql`(${t.acknowledgedBy} is null) = (${t.acknowledgedAt} is null)` ``

**Write path** — `/opt/hmis/apps/core/src/modules/radiology/reports.ts`:
- `:973` `): Promise<{ criticalId: string; acknowledgedAt: Date }> {`
- `:978` `if (critical.acknowledgedAt !== null) { …` (already-acknowledged guard)
- `:1039` `const acknowledgedAt = input.now ?? new Date();`
- `:1044` `acknowledgedAt,` (the update)
- `:1055` `return { criticalId: input.criticalId, acknowledgedAt };`

**Read path / chaser** — `/opt/hmis/apps/core/src/modules/radiology/chasers.ts`:
- `:43` comment: *"`acknowledged_at` remains the only answer to 'was this closed'"*
- `:109` `isNull(imagingCriticalFindings.acknowledgedAt),`
- `:135` `isNull(imagingCriticalFindings.acknowledgedAt),`

**In the kernel**, `acknowledg` appears only as PROSE, never as a column or a function:
- `/opt/hmis/apps/core/src/kernel/worker/jobs.ts:433` — comment "the ladder chasing an unacknowledged critical at 02:00"
- `/opt/hmis/apps/core/src/kernel/alerts/manifest.ts:39` — comment "a critical finding nobody acknowledged past its own tier's window"
- `/opt/hmis/apps/core/src/kernel/alerts/consumer.ts:304`, `:313`, `:322`, `:325` — the `imaging_chase` alert title/body text ("Critical imaging finding unacknowledged (…)", "with no acknowledgement recorded")

**`read_at` / `readAt`** in `apps/core/src` (non-test):
- `/opt/hmis/apps/core/src/kernel/db/schema/alerts.ts:25` `readAt: timestamp("read_at", { withTimezone: true }),` and `:29` `index("alerts_user_read_idx").on(t.userId, t.readAt)`
- `/opt/hmis/apps/core/src/kernel/alerts/alerts.ts:36, 60, 64, 65, 71, 78, 91, 95, 96, 97, 102, 107, 118` — the whole read lifecycle
- `/opt/hmis/apps/core/src/kernel/alerts/alerts.controller.ts:49`
- Unrelated `read_at` in other domains: `/opt/hmis/apps/core/src/kernel/db/schema/radiology.ts:900` `firstReadAt: timestamp("first_read_at", …)` (report first opened by a non-signer; used by `modules/radiology/read.ts:410` and `chasers.ts:169`); `/opt/hmis/apps/core/src/kernel/db/schema/lab.ts:1085` `readAt` on `labPlateMaps` (an ELISA plate read instant — a different sense of "read"), consumed in `modules/lab/inbox.ts:100,109,113` and written at `modules/lab/plate-maps.ts:347`.

**Conclusion for (a)**: the alerts table has `read_at` and nothing else. There is **no `acknowledged_at`, no ack event, no ack route, no ack UI** on alerts anywhere. The `imagingCriticalFindings` pair (`acknowledged_by` + `acknowledged_at` with the "half of one is not an acknowledgement" CHECK, `schema/radiology.ts:529-532`) is the shipped precedent to copy for an ack state, and `radiology/reports.ts:973-1055` is the shipped write-path precedent (idempotent: already-acknowledged is refused at `:978`).

---

## Cross-cutting notes relevant to your four features

- **(a) ack states on in-app alerts**: touches `schema/alerts.ts` (new migration; today it is exactly 10 columns, no ack), `alerts/alerts.ts` (`AlertRow` type + `listAlerts` select + a new `markAlertAcked` twin of `markAlertRead`), `alerts/alerts.controller.ts` (a third route — note both existing ones are permissionless-but-`requireUserActor`), `alerts/events.ts` (a new `alert.acknowledged` definition; `defineEvent` enforces `entity.verb_past`), `alerts/realtime.ts` (`ALERTS_REALTIME_NAMES` currently `["alert.raised"]` only), `lib/alerts-api.ts`, `alerts-bell.tsx`, both locale files, and `schema/alerts.test.ts`.
- **(b) per-person channel ladder climbing on no-read then no-ack**: no such signal exists. `notifications` has no linkage to `alerts` (`refType/refId` is a free pair; the notify consumer never writes an alert ref). `recordAttemptFailure` (`pump.ts:408`) is driven ONLY by adapter exceptions. There is no per-person ladder store — `template.channels ?? DEFAULT_CHANNELS` is the entire ladder, global per template. A per-person ladder needs a new table (there is no `user_preferences`/`notification_preferences` today) plus a new trigger source (a sweep reading `alerts.read_at` / the new ack column), since nothing currently re-queues a `sent` row.
- **(c) Web Push adapter**: server side needs `ChannelAdapter["channel"]` widened in four synchronized places (§1.6) and `NOTIFY_PROVIDER`'s zod enum widened (`config.ts:31`) — note `adaptersFor`'s `never` assignment makes that a compile error until a case is added, which is the designed forcing function. `PUMP_PROVIDER` at `pump.ts:82` is a hardcoded seam; the plan's own note says a real provider is threaded via `opts.adapters`. Client side is a greenfield: no SW, no manifest, no `requestPermission`, no VAPID, no subscription table (§4.5).
- **(d) deep link bell → approvals inbox**: the data is already on the wire (`WireAlert.refType === "approval"`, `refId === approvalId`, set at `alerts/consumer.ts:401-402`) and already unused in the bell's render. The blockers are: the bell imports no router (§4.1), and its test harness has no `RouterProvider` (§4.2); `approvalsRoute` has no `validateSearch` (§5a shows the shipped pattern on `opdDayReportRoute`). No new route is needed if you link to the existing `/approvals`, so `caddyfile-parity.test.ts`'s count at `:415` stays at 68.
