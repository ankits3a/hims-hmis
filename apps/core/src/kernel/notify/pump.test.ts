import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { notifications, patients, users, events } from "../db/schema";
import { withTx } from "../db/client";
import { enqueueNotification } from "./enqueue";
import { completeSend, quietHoursDeferral, runNotifyPump } from "./pump";
import * as templatesMod from "./templates";
import type { NotificationTemplate } from "./templates";
import type { ChannelAdapter } from "./adapters";
import type { Db } from "../db/client";

// GLOBAL CONSTRAINT 8: every test here drives `runNotifyPump` DIRECTLY with an injected `now`
// and fake adapters. Nothing in this file goes through the Scheduler — the seventh job's
// REGISTRATION is asserted in `worker/scheduler.test.ts` and `test/worker-runtime.e2e.test.ts`,
// and those two files stub the pump body out for exactly this reason.
//
// GLOBAL CONSTRAINT 9/10: no assertion below gates on a wall-clock mean or median. Time is a
// PARAMETER here, so "three attempts then the next rung" is arithmetic, not a wait.

const PATIENT_A = "01HT4PUMPPATIENTA00000001";
const PATIENT_LOSER = "01HT4PUMPPATIENTLOSER0001";
const PATIENT_SURVIVOR = "01HT4PUMPPATIENTSURVIV001";
const USER_OWNER = "01HT4PUMPUSEROWNER0000001";
const EVENT_ID = "01HT4PUMPSOURCEEVENT00001";

const PHONE_A = "9876500001";
const PHONE_LOSER = "9876511111";
const PHONE_SURVIVOR = "9876522222";
const PHONE_OWNER = "9876533333";

/** 2026-08-21 11:30 IST — the middle of the day, so no test depends on D7 by accident. */
const NOON = new Date("2026-08-21T06:00:00.000Z");
const WELCOME_PARAMS = { uhid: "HMS-00000001-5" };
const ESCALATION_PARAMS = { defKey: "opd_wait", state: "waiting", rung: 2, role: "duty_manager" };

type Channel = ChannelAdapter["channel"];
type Call = { channel: Channel; to: string; text: string; notificationId: string };

function fakeAdapter(
  channel: Channel,
  calls: Call[],
  opts: { throws?: string; onSend?: (call: Call) => Promise<void> } = {},
): ChannelAdapter {
  return {
    channel,
    async send(to, text, meta) {
      const call: Call = { channel, to, text, notificationId: meta.notificationId };
      calls.push(call);
      if (opts.onSend) await opts.onSend(call);
      if (opts.throws !== undefined) throw new Error(opts.throws);
      return { providerMessageId: null };
    },
  };
}

const at = (seconds: number): Date => new Date(NOON.getTime() + seconds * 1000);

describe("runNotifyPump — the send path (Plan 10 T4: D2/D3/D4/D6/D7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let calls: Call[];

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
    calls = [];
    await db.insert(patients).values([
      { id: PATIENT_A, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female", phone: PHONE_A, createdBy: "u1", updatedBy: "u1" },
      { id: PATIENT_SURVIVOR, uhid: "HMS-00000002-3", name: "Bina Devi", sex: "female", phone: PHONE_SURVIVOR, createdBy: "u1", updatedBy: "u1" },
      {
        id: PATIENT_LOSER, uhid: "HMS-00000003-1", name: "Bina D", sex: "female", phone: PHONE_LOSER,
        status: "merged", mergedIntoPatientId: PATIENT_SURVIVOR, createdBy: "u1", updatedBy: "u1",
      },
    ]);
    await db.insert(users).values({
      id: USER_OWNER, username: "t4owner", fullName: "T4 Owner", passwordHash: "x", phone: PHONE_OWNER,
    });
  });

  /** The shipped pair, both recording; `opts` lets one leg throw or observe. */
  function adapterSet(
    whatsapp: ChannelAdapter = fakeAdapter("whatsapp", calls),
    sms: ChannelAdapter = fakeAdapter("sms", calls),
  ): Record<Channel, ChannelAdapter> {
    return { whatsapp, sms };
  }

  async function enqueueWelcome(
    over: { patientId?: string; occurredAt?: Date; scheduledFor?: Date } = {},
  ): Promise<string> {
    const result = await withTx(db, (tx) =>
      enqueueNotification(tx, {
        templateKey: "patient_welcome",
        params: WELCOME_PARAMS,
        dedupeKey: `n:${EVENT_ID}:patient_welcome:${over.patientId ?? PATIENT_A}`,
        occurredAt: over.occurredAt ?? NOON,
        patientId: over.patientId ?? PATIENT_A,
        sourceEventId: EVENT_ID,
        scheduledFor: over.scheduledFor ?? null,
      }),
    );
    return result!.id;
  }

  const rowById = async (id: string): Promise<typeof notifications.$inferSelect> =>
    (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!;

  const eventsNamed = async (name: string): Promise<{ payload: unknown; patientId: string | null }[]> =>
    await db.select({ payload: events.payload, patientId: events.patientId }).from(events).where(eq(events.name, name));

  // -------------------------------------------------------------------------------------------
  // The golden path, and the claim that makes it safe.
  // -------------------------------------------------------------------------------------------

  it("sends a queued patient row on WhatsApp, flips it to sent, and appends notification.sent", async () => {
    const id = await enqueueWelcome();

    const sent = await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(sent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe("whatsapp");
    expect(calls[0]!.to).toBe(PHONE_A);
    expect(calls[0]!.notificationId).toBe(id);
    expect(calls[0]!.text).toContain("HMS-00000001-5");
    expect(calls[0]!.text).toMatch(/[ऀ-ॿ]/); // patients.language defaults to 'hi' (D8)

    const row = await rowById(id);
    expect(row.status).toBe("sent");
    expect(row.sentChannel).toBe("whatsapp");
    expect(row.sentTemplateVersion).toBe(1);
    expect(row.sentAt).toEqual(NOON);
    expect(row.lastError).toBeNull();

    const appended = await eventsNamed("notification.sent");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.patientId).toBe(PATIENT_A); // §10.5 envelope linkage, not a payload copy
    expect(appended[0]!.payload).toEqual({
      notificationId: id,
      templateKey: "patient_welcome",
      templateVersion: 1,
      audience: "patient",
      channel: "whatsapp",
      providerMessageId: null, // D11: the console sink accepts, it does not deliver
    });
  });

  /**
   * ASSERTION BOOK N4 — THE CLAIM PRECEDES THE ADAPTER CALL (D2). The fake adapter reads the
   * row's own status out of the database at the moment it is invoked. A WhatsApp message cannot
   * be un-sent, so this ordering is the whole reason the gateway claims first and the dispatcher
   * claims last; moving it is a design change, not a fix.
   */
  it("flips the claimed row to 'sending' BEFORE the adapter is ever called (N4)", async () => {
    const id = await enqueueWelcome();
    const observed: string[] = [];
    const watcher = fakeAdapter("whatsapp", calls, {
      onSend: async () => {
        observed.push((await rowById(id)).status);
      },
    });

    await runNotifyPump(db, { now: NOON, adapters: adapterSet(watcher) });

    expect(observed).toEqual(["sending"]);
    expect((await rowById(id)).status).toBe("sent");
  });

  // -------------------------------------------------------------------------------------------
  // The gauntlet, in D4's order.
  // -------------------------------------------------------------------------------------------

  /** N3 — the replay defense. A `patient_welcome` from 72 h ago died 48 h ago. */
  it("expires a stale row instead of sending it, with ZERO adapter calls (N3)", async () => {
    const id = await enqueueWelcome({ occurredAt: new Date(NOON.getTime() - 72 * 60 * 60 * 1000) });

    await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(calls).toEqual([]);
    expect((await rowById(id)).status).toBe("expired");
    const appended = await eventsNamed("notification.expired");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.payload).toEqual({ notificationId: id, templateKey: "patient_welcome", audience: "patient" });
  });

  /**
   * ASSERTION BOOK N1 — THE D-33 DECEASED HARD STOP, and on this row a polite pass is the worst
   * available outcome. The patient is marked deceased AFTER the row is enqueued, which is
   * precisely the case a snapshot-at-enqueue design would get wrong (D4: contact truth is read
   * at SEND time). It beats urgency and it beats everything.
   */
  it("suppresses a patient marked deceased AFTER enqueue, with ZERO adapter calls (N1)", async () => {
    const id = await enqueueWelcome();
    await db
      .update(patients)
      .set({ deceasedAt: new Date("2026-08-21T05:00:00.000Z") })
      .where(eq(patients.id, PATIENT_A));

    await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(calls).toEqual([]);
    const row = await rowById(id);
    expect(row.status).toBe("suppressed");
    expect(row.sentAt).toBeNull();
    const appended = await eventsNamed("notification.suppressed");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.payload).toEqual({
      notificationId: id,
      templateKey: "patient_welcome",
      audience: "patient",
      reason: "deceased",
    });
    expect(await eventsNamed("notification.sent")).toEqual([]);
  });

  it("suppresses a deceased patient even when the row reaches them through a merge chain (N1)", async () => {
    const id = await enqueueWelcome({ patientId: PATIENT_LOSER });
    await db.update(patients).set({ deceasedAt: NOON }).where(eq(patients.id, PATIENT_SURVIVOR));

    await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(calls).toEqual([]);
    expect((await rowById(id)).status).toBe("suppressed");
  });

  /**
   * ASSERTION BOOK R1 (Plan 11a Phase 0, R0-1) — THE GAUNTLET'S ORDER, PINNED, and the case the
   * two N1 tests above cannot see. Their patient has a phone, so the deceased stop can be moved
   * anywhere ahead of the adapter call and they still pass: the plan-10 gate report relocated it
   * past channel resolution and the whole shipped suite stayed green (§7.1).
   *
   * A patient who is BOTH deceased and phoneless is where the two rungs disagree. Position 2 says
   * `suppressed(deceased)` — silence, and an audit row proving the stop fired. The `no_phone` rung
   * at step 5 says `undeliverable` + `notification.failed`, which `alertsConsumer` turns into a
   * `manual_notify` desk task telling a duty manager to phone the family of a dead patient. Both
   * make zero adapter calls, so counting adapter calls does NOT discriminate; the count of
   * `notification.failed` is the row that does, and it is why it is asserted as a COUNT.
   */
  it("suppresses a patient who is BOTH deceased and phoneless, with NO notification.failed (R1)", async () => {
    const id = await enqueueWelcome();
    // Both truths land AFTER enqueue: contact truth is read at SEND time (D4), and the phone is
    // NULL precisely so that the `no_phone` rung WOULD fire if the deceased stop were relocated
    // past channel resolution. This fixture cannot pass the assertion below vacuously.
    await db
      .update(patients)
      .set({ deceasedAt: new Date("2026-08-21T05:00:00.000Z"), phone: null })
      .where(eq(patients.id, PATIENT_A));

    await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(calls).toEqual([]);
    const row = await rowById(id);
    expect(row.status).toBe("suppressed");
    expect(row.sentAt).toBeNull();

    const suppressed = await eventsNamed("notification.suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.payload).toEqual({
      notificationId: id,
      templateKey: "patient_welcome",
      audience: "patient",
      reason: "deceased",
    });

    // THE LOAD-BEARING ROW. Not `toEqual([])` on a filtered list but the COUNT of the event that
    // becomes a human being's phone task: the deceased stop must run BEFORE channel resolution.
    expect(await eventsNamed("notification.failed")).toHaveLength(0);
    expect(await eventsNamed("notification.sent")).toEqual([]);
  });

  it("suppresses a promotional-class row at send time — the belt to D9's enqueue refusal", async () => {
    const real = templatesMod.templateByKey;
    const promotional: NotificationTemplate = { ...real("patient_welcome"), class: "promotional" };
    const spy = jest
      .spyOn(templatesMod, "templateByKey")
      .mockImplementation((key: string) => (key === "patient_welcome" ? promotional : real(key)));
    try {
      // Enqueued through a registry that still says transactional, so the row exists at all —
      // the belt is about a row that reaches the pump, however it got there.
      const id = "01HT4PUMPPROMOROW00000001";
      await db.insert(notifications).values({
        id, audience: "patient", patientId: PATIENT_A,
        templateKey: "patient_welcome", params: WELCOME_PARAMS, dedupeKey: "n:promo:1",
        occurredAt: NOON, expiresAt: new Date(NOON.getTime() + 3600_000),
      });

      await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

      expect(calls).toEqual([]);
      expect((await rowById(id)).status).toBe("suppressed");
      const appended = await eventsNamed("notification.suppressed");
      expect((appended[0]!.payload as { reason: string }).reason).toBe("promotional_blocked");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * ASSERTION BOOK N5 — the quiet-hours window, asserted on the pure function that IS the rule
   * (D7: one place, not three). The Book marks these instants a PREDICTION (§7.4); the verdict
   * is in the task report, from a mutant, not from this comment.
   */
  describe("quiet hours are exactly 21:00–08:00 IST, patient-routine only (N5)", () => {
    const routine = { urgency: "routine" } as const;
    const urgent = { urgency: "urgent" } as const;

    it("20:59:59.999 IST is NOT quiet — the message goes now", () => {
      expect(quietHoursDeferral(routine, "patient", new Date("2026-08-21T15:29:59.999Z"))).toBeNull();
    });

    it("21:00:00.000 IST IS quiet — deferred to the NEXT morning's 08:00 IST", () => {
      expect(quietHoursDeferral(routine, "patient", new Date("2026-08-21T15:30:00.000Z"))).toEqual(
        new Date("2026-08-22T02:30:00.000Z"),
      );
    });

    it("07:59:59.999 IST IS quiet — deferred to THIS morning's 08:00 IST", () => {
      expect(quietHoursDeferral(routine, "patient", new Date("2026-08-21T02:29:59.999Z"))).toEqual(
        new Date("2026-08-21T02:30:00.000Z"),
      );
    });

    it("08:00:00.000 IST is NOT quiet — the window has closed", () => {
      expect(quietHoursDeferral(routine, "patient", new Date("2026-08-21T02:30:00.000Z"))).toBeNull();
    });

    it("an URGENT patient template ignores the window at 23:00 IST, by design (§11.13)", () => {
      expect(quietHoursDeferral(urgent, "patient", new Date("2026-08-21T17:30:00.000Z"))).toBeNull();
    });

    it("staff and owner messages ignore the window — Phase 1 staff traffic is escalation-driven", () => {
      expect(quietHoursDeferral(routine, "staff", new Date("2026-08-21T17:30:00.000Z"))).toBeNull();
      expect(quietHoursDeferral(routine, "owner", new Date("2026-08-21T17:30:00.000Z"))).toBeNull();
    });
  });

  it("defers a routine patient message inside quiet hours back to 'queued' at the next 08:00 IST, counting NO attempt", async () => {
    const night = new Date("2026-08-21T15:30:00.000Z"); // 21:00 IST
    const id = await enqueueWelcome({ occurredAt: night });

    await runNotifyPump(db, { now: night, adapters: adapterSet() });

    expect(calls).toEqual([]);
    const row = await rowById(id);
    expect(row.status).toBe("queued");
    expect(row.nextAttemptAt).toEqual(new Date("2026-08-22T02:30:00.000Z"));
    expect(row.attempts).toBe(0); // a deferral is not a failure — it must not burn a rung by morning
    expect(row.rung).toBe(0);
    expect(await eventsNamed("notification.suppressed")).toEqual([]);

    // And it goes out when the window closes — the same row, no re-enqueue.
    await runNotifyPump(db, { now: new Date("2026-08-22T02:30:00.000Z"), adapters: adapterSet() });
    expect(calls).toHaveLength(1);
    expect((await rowById(id)).status).toBe("sent");
  });

  /** N9 — D-34's designed path: phoneless is a DESK task, not a silent failure. */
  it("sends a phoneless patient straight to undeliverable + failed(no_phone), ZERO adapter calls (N9)", async () => {
    await db.update(patients).set({ phone: null }).where(eq(patients.id, PATIENT_A));
    const id = await enqueueWelcome();

    await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(calls).toEqual([]);
    const row = await rowById(id);
    expect(row.status).toBe("undeliverable");
    expect(row.rung).toBe(0); // it never entered the ladder
    const appended = await eventsNamed("notification.failed");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.payload).toEqual({
      notificationId: id,
      templateKey: "patient_welcome",
      audience: "patient",
      reason: "no_phone",
      refType: null,
      refId: null,
    });
  });

  it("reads the phone at SEND time — a number added while the message waited is the one used (D4)", async () => {
    await db.update(patients).set({ phone: null }).where(eq(patients.id, PATIENT_A));
    const id = await enqueueWelcome({ scheduledFor: at(60) });

    await runNotifyPump(db, { now: NOON, adapters: adapterSet() }); // not due yet
    expect(calls).toEqual([]);
    expect((await rowById(id)).status).toBe("queued");

    await db.update(patients).set({ phone: "9876599999" }).where(eq(patients.id, PATIENT_A));
    await runNotifyPump(db, { now: at(60), adapters: adapterSet() });

    expect(calls.map((c) => c.to)).toEqual(["9876599999"]);
    expect((await rowById(id)).status).toBe("sent");
  });

  /** N15 — the merge chain, resolved at send. */
  it("sends a merged patient's message to the SURVIVOR's phone (N15)", async () => {
    const id = await enqueueWelcome({ patientId: PATIENT_LOSER });

    await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(PHONE_SURVIVOR);
    expect(calls[0]!.to).not.toBe(PHONE_LOSER);
    expect((await rowById(id)).status).toBe("sent");
  });

  it("suppresses a merge chain that leads nowhere with reason merge_unresolvable", async () => {
    await db
      .update(patients)
      .set({ status: "merged", mergedIntoPatientId: null })
      .where(eq(patients.id, PATIENT_A));
    const id = await enqueueWelcome();

    await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(calls).toEqual([]);
    expect((await rowById(id)).status).toBe("suppressed");
    const appended = await eventsNamed("notification.suppressed");
    expect((appended[0]!.payload as { reason: string }).reason).toBe("merge_unresolvable");
  });

  // -------------------------------------------------------------------------------------------
  // The ladder (D6).
  // -------------------------------------------------------------------------------------------

  /**
   * ASSERTION BOOK N7 — `attempts` counts failures on the CURRENT rung; at `maxAttemptsPerRung`
   * the rung advances, WhatsApp → SMS. The cycle instants below are the backoff curve
   * (`min(2^attempts, 60) s`) read forward, not a wait: time is a parameter here (GC9/10).
   */
  it("advances the ladder WhatsApp → SMS at maxAttemptsPerRung, then sends on SMS (N7)", async () => {
    const id = await enqueueWelcome();
    const adapters = adapterSet(fakeAdapter("whatsapp", calls, { throws: "whatsapp is down" }));

    await runNotifyPump(db, { now: at(0), adapters });
    expect((await rowById(id)).attempts).toBe(1);
    await runNotifyPump(db, { now: at(2), adapters });
    expect((await rowById(id)).attempts).toBe(2);
    await runNotifyPump(db, { now: at(6), adapters });

    const advanced = await rowById(id);
    expect(advanced.rung).toBe(1); // the SMS rung
    expect(advanced.attempts).toBe(0); // attempts are PER RUNG and reset with it
    expect(advanced.status).toBe("queued");
    expect(calls.map((c) => c.channel)).toEqual(["whatsapp", "whatsapp", "whatsapp"]);

    await runNotifyPump(db, { now: at(14), adapters });

    expect(calls.map((c) => c.channel)).toEqual(["whatsapp", "whatsapp", "whatsapp", "sms"]);
    expect((await rowById(id)).status).toBe("sent");
    expect((await rowById(id)).sentChannel).toBe("sms");
  });

  it("exhausting both rungs is undeliverable + failed(ladder_exhausted) — the patient desk rung (D6)", async () => {
    const id = await enqueueWelcome();
    const adapters = adapterSet(
      fakeAdapter("whatsapp", calls, { throws: "whatsapp is down" }),
      fakeAdapter("sms", calls, { throws: "sms is down" }),
    );

    for (const seconds of [0, 2, 6, 14, 16, 20]) {
      await runNotifyPump(db, { now: at(seconds), adapters });
    }

    expect(calls.map((c) => c.channel)).toEqual(["whatsapp", "whatsapp", "whatsapp", "sms", "sms", "sms"]);
    const row = await rowById(id);
    expect(row.status).toBe("undeliverable");
    expect(row.lastError).toBe("sms is down");
    const appended = await eventsNamed("notification.failed");
    expect(appended).toHaveLength(1);
    expect((appended[0]!.payload as { reason: string }).reason).toBe("ladder_exhausted");
  });

  it("an owner_escalation_sms row narrows its own ladder to SMS and renders English (D6/D8)", async () => {
    const id = (await withTx(db, (tx) =>
      enqueueNotification(tx, {
        templateKey: "owner_escalation_sms",
        params: ESCALATION_PARAMS,
        dedupeKey: `n:${EVENT_ID}:owner_escalation_sms:${USER_OWNER}`,
        occurredAt: NOON,
        userId: USER_OWNER,
      }),
    ))!.id;

    await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe("sms"); // never WhatsApp: the template names its own ladder
    expect(calls[0]!.to).toBe(PHONE_OWNER);
    expect(calls[0]!.text).toContain("URGENT"); // staff/owner render `en` (D8)
    expect(calls[0]!.text).not.toMatch(/[ऀ-ॿ]/);
    const row = await rowById(id);
    expect(row.status).toBe("sent");
    expect(row.patientId).toBeNull(); // GC5: no patient linkage on a staff/owner row at all
  });

  // -------------------------------------------------------------------------------------------
  // Render errors, poison rows, completion, and stuck recovery.
  // -------------------------------------------------------------------------------------------

  it("a render THROW goes straight to undeliverable + failed(render_error) and never enters the ladder", async () => {
    const id = await enqueueWelcome();
    const real = templatesMod.templateByKey;
    const broken: NotificationTemplate = {
      ...real("patient_welcome"),
      render: {
        hi: () => { throw new Error("params.uhid is not a string"); },
        en: () => { throw new Error("params.uhid is not a string"); },
      },
    };
    const spy = jest
      .spyOn(templatesMod, "templateByKey")
      .mockImplementation((key: string) => (key === "patient_welcome" ? broken : real(key)));
    try {
      await runNotifyPump(db, { now: NOON, adapters: adapterSet() });
    } finally {
      spy.mockRestore();
    }

    expect(calls).toEqual([]);
    const row = await rowById(id);
    expect(row.status).toBe("undeliverable");
    expect(row.attempts).toBe(0); // retrying a render cannot fix params — no rung is spent on it
    expect(row.rung).toBe(0);
    expect(row.lastError).toBe("params.uhid is not a string");
    const appended = await eventsNamed("notification.failed");
    expect((appended[0]!.payload as { reason: string }).reason).toBe("render_error");
  });

  it("one poison row does not stall the batch — the row behind it still sends (D3)", async () => {
    // An audience='patient' row with NO patient_id. `enqueueNotification` refuses to make one and
    // migration 0015 carries no CHECK that would (schema/notifications.ts:22-27), so this is
    // exactly the shape that reaches the pump when something else writes the table.
    await db.insert(notifications).values({
      id: "01HT4PUMPPOISONROW0000001", audience: "patient", patientId: null,
      templateKey: "patient_welcome", params: WELCOME_PARAMS, dedupeKey: "n:poison:1",
      occurredAt: NOON, expiresAt: new Date(NOON.getTime() + 3600_000),
      createdAt: new Date(NOON.getTime() - 60_000), // claimed FIRST
    });
    const goodId = await enqueueWelcome();

    const sent = await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(sent).toBe(1);
    expect(calls.map((c) => c.notificationId)).toEqual([goodId]);
    expect((await rowById(goodId)).status).toBe("sent");
    const poison = await rowById("01HT4PUMPPOISONROW0000001");
    // Left `sending` on purpose: the pump does not know whether an adapter was reached, and D2
    // forbids guessing. `recoverStuckSending` resolves it, and never by re-sending.
    expect(poison.status).toBe("sending");
    expect(poison.lastError).toContain("no patient_id");
  });

  /**
   * ASSERTION BOOK N13 — a crash-retry of the completion step appends `notification.sent` ONCE.
   * The guard is `WHERE status = 'sending'` inside the flip: the second run wins no row, so it
   * appends nothing. Appending outside that guard lies to every consumer of the event log.
   */
  it("completeSend appends notification.sent exactly ONCE when run twice against one sending row (N13)", async () => {
    const id = "01HT4PUMPCOMPLETION000001";
    await db.insert(notifications).values({
      id, audience: "patient", patientId: PATIENT_A, templateKey: "patient_welcome",
      params: WELCOME_PARAMS, dedupeKey: "n:complete:1", occurredAt: NOON,
      expiresAt: new Date(NOON.getTime() + 3600_000), status: "sending",
    });
    const row = await rowById(id);
    const sent = { channel: "whatsapp" as const, providerMessageId: null, templateVersion: 1 };

    const first = await withTx(db, (tx) => completeSend(tx, row, sent, NOON));
    const second = await withTx(db, (tx) => completeSend(tx, row, sent, NOON));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await eventsNamed("notification.sent")).toHaveLength(1);
    expect((await rowById(id)).status).toBe("sent");
  });

  /**
   * ASSERTION BOOK N14 — a `sending` row older than `stuckAfterMs` is FLAGGED, never re-sent.
   * The message may already be with the patient and only a human can find out; exactly-once at a
   * provider boundary is not achievable without provider-side idempotency keys (D2, stated).
   */
  it("flags a stuck 'sending' row as undeliverable(stuck_sending) and NEVER re-sends it (N14)", async () => {
    const id = "01HT4PUMPSTUCKROW00000001";
    await db.insert(notifications).values({
      id, audience: "patient", patientId: PATIENT_A, templateKey: "patient_welcome",
      params: WELCOME_PARAMS, dedupeKey: "n:stuck:1", occurredAt: NOON,
      expiresAt: new Date(NOON.getTime() + 24 * 3600_000), status: "sending",
      updatedAt: new Date(NOON.getTime() - 10 * 60_000), // claimed ten minutes ago
    });

    await runNotifyPump(db, { now: NOON, adapters: adapterSet() });

    expect(calls).toEqual([]);
    const row = await rowById(id);
    expect(row.status).toBe("undeliverable");
    expect(row.sentAt).toBeNull();
    const appended = await eventsNamed("notification.failed");
    expect(appended).toHaveLength(1);
    expect((appended[0]!.payload as { reason: string }).reason).toBe("stuck_sending");
  });

  it("leaves a freshly claimed 'sending' row alone — the stuck window is a window, not a rule", async () => {
    const id = await enqueueWelcome();
    // A cycle that claims and sends must not be eaten by its own stuck sweep.
    await runNotifyPump(db, { now: NOON, adapters: adapterSet(), stuckAfterMs: 1 });
    expect((await rowById(id)).status).toBe("sent");
    expect(await eventsNamed("notification.failed")).toEqual([]);
  });

  it("claims nothing that is not yet due — next_attempt_at and scheduled_for both gate the batch", async () => {
    const id = await enqueueWelcome({ scheduledFor: at(300) });
    await runNotifyPump(db, { now: NOON, adapters: adapterSet() });
    expect(calls).toEqual([]);
    expect((await rowById(id)).status).toBe("queued");
  });
});
