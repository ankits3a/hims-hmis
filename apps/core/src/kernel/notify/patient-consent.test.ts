import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser } from "../../../test/helpers/opd";
import { events, notifications, patients, users } from "../db/schema";
import { withTx } from "../db/client";
import { alertsConsumer } from "../alerts/consumer";
import { consoleWhatsappAdapter } from "./adapters";
import { enqueueNotification } from "./enqueue";
import { MessagePreferenceError, messagePreferenceOf, recordMessagePreference } from "./preferences";
import { dltSmsAdapter } from "./providers";
import { runNotifyPump } from "./pump";
import { recordTemplateRegistration } from "./registrations";
import type { ChannelAdapter, SendMeta } from "./adapters";
import type { FetchLike } from "./providers";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * ═══ PHARMACY P6 (patient messages) — THE PATIENT'S WORD, KEPT BY THE KERNEL ═══
 *
 * DPDP Act 2023 and TRAI TCCCPR 2018, as the notify kernel carries them: a STOP silences every patient
 * message, a reminder needs an opt-in both at enqueue AND at send, the patient's language and channel are
 * obeyed, a live gateway is never undercut by a console sink, and a live SMS gateway refuses a template
 * the DLT portal has not registered. Every test drives `runNotifyPump` directly with recording adapters.
 */
const PATIENT = "01HP6MSGPATIENT0000000001";
const DESK = "01HP6MSGDESKUSER000000001";
const PHONE = "9876543210";
const NOON = new Date("2026-09-14T06:30:00.000Z"); // 12:00 IST
const NIGHT = new Date("2026-09-14T17:00:00.000Z"); // 22:30 IST
const desk: Actor = { type: "user", id: DESK };

type Sent = { channel: string; to: string; text: string; meta: SendMeta };
function recorder(channel: ChannelAdapter["channel"], sent: Sent[], sink = false): ChannelAdapter {
  return {
    channel, ...(sink ? { sink: true } : {}),
    async send(to, text, meta) { sent.push({ channel, to, text, meta }); return { providerMessageId: null }; },
  };
}

const BILL = { hospital: "Sanjeevani Hospital", billNo: "PB-000123", amountPaise: 123450, paidOn: "2026-08-14" };
const REFILL = { hospital: "Sanjeevani Hospital", since: "2026-08-17", runsOutOn: "2026-09-16", contactPhone: "0141-2345678" };

describe("the patient's word, at enqueue and at send (PHARMACY P6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let sent: Sent[];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    sent = [];
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000009-1", name: "Kamla Devi", sex: "female", administrativeGender: "female", phone: PHONE,
      createdBy: "u1", updatedBy: "u1",
    });
    await db.insert(users).values({ id: DESK, username: "ph.desk", fullName: "Desk Pharmacist", staffCode: "EMP-0901", passwordHash: "x" });
  });

  const say = (change: Parameters<typeof recordMessagePreference>[3]) =>
    withTx(db, (tx) => recordMessagePreference(tx, desk, PATIENT, change, "pharmacy_desk", NOON));
  const enqueue = (templateKey: string, params: Record<string, unknown>, key: string) =>
    withTx(db, (tx) => enqueueNotification(tx, { templateKey, params, dedupeKey: key, occurredAt: NOON, patientId: PATIENT }));
  const rowOf = async (id: string) => (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!;
  const suppressedReasons = async () =>
    (await db.select({ payload: events.payload }).from(events).where(eq(events.name, "notification.suppressed"))).map((e) => (e.payload as { reason: string }).reason);
  const both = (sms: ChannelAdapter, whatsapp: ChannelAdapter) => ({ sms, whatsapp, web_push: recorder("web_push", sent) });

  it("a STOP silences a transactional message too — suppressed at send, no adapter called", async () => {
    const q = await enqueue("pharmacy_bill_ready", BILL, "t:bill:1");
    await say({ kind: "stop" });
    await runNotifyPump(db, { now: NOON, adapters: both(recorder("sms", sent), recorder("whatsapp", sent)) });
    expect(sent).toEqual([]);
    expect(await rowOf(q!.id)).toMatchObject({ status: "suppressed", lastError: "opted_out" });
    expect(await suppressedReasons()).toEqual(["opted_out"]);
  });

  it("a reminder needs the opt-in to be QUEUED — refused without it, taken with it", async () => {
    await expect(enqueue("pharmacy_refill_due", REFILL, "t:refill:1")).rejects.toThrow(/opt-in to "refill_reminders"/);
    await say({ kind: "reminders", on: true });
    expect(await enqueue("pharmacy_refill_due", REFILL, "t:refill:1")).not.toBeNull();
  });

  it("…and to be SENT: an opt-in withdrawn after it was queued suppresses it (no_consent)", async () => {
    await say({ kind: "reminders", on: true });
    const q = await enqueue("pharmacy_refill_due", REFILL, "t:refill:2");
    await say({ kind: "reminders", on: false });
    await runNotifyPump(db, { now: NOON, adapters: both(recorder("sms", sent), recorder("whatsapp", sent)) });
    expect(sent).toEqual([]);
    expect(await rowOf(q!.id)).toMatchObject({ status: "suppressed", lastError: "no_consent" });
  });

  it("a reminder respects quiet hours: at 22:30 IST it is held for 08:00, not sent and not failed", async () => {
    await say({ kind: "reminders", on: true });
    const q = await enqueue("pharmacy_refill_due", REFILL, "t:refill:3");
    await runNotifyPump(db, { now: NIGHT, adapters: both(recorder("sms", sent), recorder("whatsapp", sent)) });
    expect(sent).toEqual([]);
    const row = await rowOf(q!.id);
    expect(row).toMatchObject({ status: "queued", attempts: 0 });
    expect(row.nextAttemptAt!.toISOString()).toBe("2026-09-15T02:30:00.000Z"); // 08:00 IST
  });

  it("the consent record: who, when, where — and a STOP takes the opt-in with it, a RESUME does not bring it back", async () => {
    await say({ kind: "reminders", on: true });
    expect(await messagePreferenceOf(db, PATIENT)).toMatchObject({
      refillReminders: true, remindersConsent: { at: NOON, by: DESK, via: "pharmacy_desk" }, optedOut: null,
    });
    await say({ kind: "stop" });
    await expect(say({ kind: "reminders", on: true })).rejects.toThrow(MessagePreferenceError);
    await say({ kind: "resume" });
    expect(await messagePreferenceOf(db, PATIENT)).toMatchObject({ refillReminders: false, optedOut: null });
    const recorded = await db.select({ payload: events.payload, actorId: events.actorId, patientId: events.patientId })
      .from(events).where(eq(events.name, "message_preference.recorded"));
    expect(recorded.map((e) => (e.payload as { change: string }).change)).toEqual(["reminders_on", "stopped", "resumed"]);
    expect(recorded.every((e) => e.actorId === DESK && e.patientId === PATIENT)).toBe(true);
  });

  it("a consent is a person's record: the system cannot give one", async () => {
    await expect(withTx(db, (tx) => recordMessagePreference(tx, { type: "system", id: "job" }, PATIENT, { kind: "reminders", on: true }, "pharmacy_desk", NOON)))
      .rejects.toThrow(expect.objectContaining({ code: "not_a_person" }));
  });

  it("the patient's language and channel are obeyed — WhatsApp first, in English", async () => {
    await say({ kind: "channel", channel: "whatsapp" });
    await say({ kind: "language", language: "en" }); // registered language is the default "hi"
    await enqueue("pharmacy_bill_ready", BILL, "t:bill:2");
    await runNotifyPump(db, { now: NOON, adapters: both(recorder("sms", sent), recorder("whatsapp", sent)) });
    expect(sent.map((s) => s.channel)).toEqual(["whatsapp"]);
    expect(sent[0]!.text).toBe("Sanjeevani Hospital pharmacy: bill PB-000123 for Rs 1,234.50 is paid (14 Aug 2026). Keep this message; the counter gives a printed copy on request.");
    expect(sent[0]!.meta).toMatchObject({ templateKey: "pharmacy_bill_ready", language: "en", variables: ["Sanjeevani Hospital", "PB-000123", "1,234.50", "14 Aug 2026"] });
  });

  it("a live SMS gateway is never undercut by a WhatsApp still on the console sink", async () => {
    await say({ kind: "channel", channel: "whatsapp" }); // even asked for first
    const q = await enqueue("pharmacy_bill_ready", BILL, "t:bill:3");
    await runNotifyPump(db, { now: NOON, adapters: both(recorder("sms", sent), recorder("whatsapp", sent, true)) });
    expect(sent.map((s) => s.channel)).toEqual(["sms"]);
    expect(await rowOf(q!.id)).toMatchObject({ status: "sent", sentChannel: "sms" });
  });

  it("the live SMS adapter REFUSES a template with no DLT id — once, not three times — and raises no call-the-patient task", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ id: "gw-1" }) }; };
    const sms = dltSmsAdapter({ gatewayUrl: "https://sms.example.test", entityId: "1101", senderId: "HOSPTL", apiKey: "k" }, fetchImpl);
    const q = await enqueue("pharmacy_bill_ready", BILL, "t:bill:4");
    await runNotifyPump(db, { now: NOON, adapters: both(sms, consoleWhatsappAdapter) });
    expect(calls).toEqual([]);
    const row = await rowOf(q!.id);
    // SMS is the only real rung (the sink dropped out), and a refusal advances at once: undeliverable after ONE try.
    expect(row.status).toBe("undeliverable");
    expect(row.lastError).toMatch(/no DLT template id recorded/);
    const failed = await db.select().from(events).where(eq(events.name, "notification.failed"));
    expect(failed).toHaveLength(1);
    // A bill the patient holds on paper is not a phone call for the duty manager — who IS on duty here,
    // so a lab report's identical failure raises the task (the control leg) and the bill's does not.
    await mkUser(db, "dm.night", ["duty_manager"]);
    const deliver = async (f: typeof failed[number]) => alertsConsumer(db)({
      eventId: f.eventId, name: f.name, payload: f.payload, occurredAt: f.occurredAt, patientId: f.patientId, correlationId: null, seq: 1,
    });
    await deliver(failed[0]!);
    expect(await db.select().from(events).where(eq(events.name, "alert.raised"))).toEqual([]);
    await deliver({ ...failed[0]!, eventId: "01HP6MSGCONTROLEVENT00001", payload: { ...(failed[0]!.payload as object), templateKey: "patient_lab_report_ready" } });
    expect(await db.select().from(events).where(eq(events.name, "alert.raised"))).toHaveLength(1);
  });

  it("…and sends once the office has recorded the id: the gateway is told which registration it is", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: FetchLike = async (_url, init) => { bodies.push(JSON.parse(init.body) as Record<string, unknown>); return { ok: true, status: 200, json: async () => ({ id: "gw-2" }) }; };
    const sms = dltSmsAdapter({ gatewayUrl: "https://sms.example.test", entityId: "1101", senderId: "HOSPTL", apiKey: "k" }, fetchImpl);
    await withTx(db, (tx) => recordTemplateRegistration(tx, desk, "pharmacy_bill_ready", { dltTemplateId: "1107161234567890123", whatsappTemplateName: null }, NOON));
    const q = await enqueue("pharmacy_bill_ready", BILL, "t:bill:5");
    await runNotifyPump(db, { now: NOON, adapters: both(sms, consoleWhatsappAdapter) });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ to: "919876543210", template_id: "1107161234567890123", sender: "HOSPTL" });
    expect(await rowOf(q!.id)).toMatchObject({ status: "sent", sentChannel: "sms" });
  });

  it("the console default sends nothing out of the building, and its line carries four digits of the phone", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      await enqueue("pharmacy_bill_ready", BILL, "t:bill:6");
      expect(await runNotifyPump(db, { now: NOON })).toBe(1); // the pump's own default set — the console sinks
      expect(fetchSpy).not.toHaveBeenCalled();
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.join("\n")).not.toContain(PHONE);
      expect(lines.some((l) => l.includes("******3210"))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      log.mockRestore();
    }
  });
});
