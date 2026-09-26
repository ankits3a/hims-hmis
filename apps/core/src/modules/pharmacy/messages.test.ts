import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { events, notifications, pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { recordMessagePreference } from "../../kernel/notify/preferences";
import { recordTemplateRegistration } from "../../kernel/notify/registrations";
import { runNotifyPump } from "../../kernel/notify/pump";
import { templateByKey } from "../../kernel/notify/templates";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { verifyDispense } from "./verify";
import {
  handlePharmacyMessageEvent, messagesOffice, namableDrugs, patientMessagesFor, pharmacyDltTemplateIdsRecorded, recordContactPhone,
  refillDue, runRefillReminders, supplyDays,
} from "./messages";
import type { RefillLine } from "./messages";
import type { ChannelAdapter } from "../../kernel/notify/adapters";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { RxLine } from "../opd";

/**
 * ═══ PHARMACY P6 (patient messages) — THE BILL ONCE PER INVOICE, THE REMINDER ONLY WITH A YES ═══
 *
 * A real ticket goes through the counter (claim → verify → pick → bill → hand over) so the bill message
 * is enqueued from the `dispense.handed_over` event the hand-over really appended, not a fabricated one.
 * Crocin 60 tablets at "1 tab 1-0-1" is 30 days: handed over 17 Aug, it runs out 16 Sep, and the
 * reminder is due from 13 Sep.
 */
const at = (m: number): Date => new Date(MON2.getTime() + m * 60_000);
const SEP14_10IST = new Date("2026-09-14T04:30:00.000Z");
const DRUG_WORDS = /crocin|azee|paracetamol|azithro|alprax/i;

describe("pharmacy patient messages (P6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", mrpPaise: 12_000, qtyBase: 200 });
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", mrpPaise: 15_000, qtyBase: 100 });
  });
  afterEach(() => { fx.unregister(); });

  /** One ticket through the whole counter; returns the dispense and its invoice. */
  async function handOver(lines: RxLine[], qty: number[]): Promise<{ dispenseId: string; invoiceId: string }> {
    const { issued } = await issueRx(db, fx, lines);
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("expected a dispense");
    const id = found.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, at(1));
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: qty.map((q, i) => ({ lineIdx: i, qtyBase: q })) }, at(2));
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, at(3));
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, at(4));
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }], changeGivenPaise: 0 }, at(4));
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "phone_last4", value: "3210" } }, at(5));
    const d = (await db.select({ invoiceId: pharmacyDispenses.invoiceId }).from(pharmacyDispenses).where(eq(pharmacyDispenses.id, id)))[0]!;
    return { dispenseId: id, invoiceId: d.invoiceId! };
  }
  const chronicCrocin = (): RxLine => line({ drug: "Crocin 500", medicineId: fx.med.crocin, dose: "1 tab", frequency: "1-0-1", durationDays: 30 });

  /** The `dispense.handed_over` event the hand-over appended, as the dispatcher would hand it over. */
  async function handedOverEvent(dispenseId: string) {
    const rows = await db.select().from(events).where(eq(events.name, "dispense.handed_over"));
    const e = rows.find((r) => (r.payload as { dispenseId: string }).dispenseId === dispenseId)!;
    return { eventId: e.eventId, name: e.name, payload: e.payload, occurredAt: e.occurredAt };
  }
  const billRows = async () => db.select().from(notifications).where(eq(notifications.templateKey, "pharmacy_bill_ready"));
  const refillRows = async () => db.select().from(notifications).where(eq(notifications.templateKey, "pharmacy_refill_due"));
  const say = (change: Parameters<typeof recordMessagePreference>[3]) =>
    withTx(db, (tx) => recordMessagePreference(tx, fx.pharmacist.actor, fx.patient.id, change, "pharmacy_desk", at(6)));

  // ── THE BILL ──────────────────────────────────────────────────────────────────────────────

  it("the bill is queued ONCE per invoice — a redelivery, or the other counter's event for the same bill, adds nothing", async () => {
    const { dispenseId, invoiceId } = await handOver([line({ drug: "Crocin 500", medicineId: fx.med.crocin, frequency: "1-0-1", durationDays: 5 })], [10]);
    const e = await handedOverEvent(dispenseId);
    const first = await withTx(db, (tx) => handlePharmacyMessageEvent(tx, e));
    const again = await withTx(db, (tx) => handlePharmacyMessageEvent(tx, e));
    const retail = await withTx(db, (tx) => handlePharmacyMessageEvent(tx, {
      eventId: "01HP6RETAILSAMEINVOICE001", name: "retail.sold", occurredAt: at(7),
      payload: {
        saleId: "s1", patientId: fx.patient.id, invoiceId, storeResourceId: fx.storeId, licenceId: "l1", registeredHere: false, scheduled: false,
        h1RegisterRows: 0, lines: [{ lineIdx: 0, medicineId: fx.med.crocin, itemId: fx.item.crocin, batchId: "b", qtyBase: 1, scheduleFlag: null, ledgerEntryId: "le", fefoOverride: false }],
        netPaise: 100, pharmacistRegNo: null, channel: "walk_in",
      },
    }));
    expect(first.id).not.toBeNull();
    expect(again).toEqual({ id: null, skipped: null });
    expect(retail).toEqual({ id: null, skipped: null });
    const rows = await billRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ patientId: fx.patient.id, refType: "invoice", refId: invoiceId, dedupeKey: `pharmacy_bill_ready:${invoiceId}` });
    // What it says: the hospital, the bill number, the amount, the day — and no medicine, in either language.
    const params = rows[0]!.params;
    expect(Object.keys(params).sort()).toEqual(["amountPaise", "billNo", "hospital", "paidOn"]);
    for (const lang of ["en", "hi"] as const) expect(templateByKey("pharmacy_bill_ready").render[lang](params)).not.toMatch(DRUG_WORDS);
  });

  it("the bill is NOT queued for a patient who stopped messages — and the desk sees why", async () => {
    await say({ kind: "stop" });
    const { dispenseId } = await handOver([line({ drug: "Crocin 500", medicineId: fx.med.crocin, frequency: "1-0-1", durationDays: 5 })], [10]);
    expect(await withTx(db, async (tx) => handlePharmacyMessageEvent(tx, await handedOverEvent(dispenseId)))).toEqual({ id: null, skipped: "stopped" });
    expect(await billRows()).toEqual([]);
    const view = await patientMessagesFor(db, dispenseId, { sms: false, whatsapp: false }, at(8));
    expect(view.bill.state).toBe("stopped");
    expect(view.stopped).toMatchObject({ byName: "ph.mehta", via: "pharmacy_desk" });
  });

  it("a paper dispense typed in after an outage sends no bill: the patient left days ago", async () => {
    const r = await withTx(db, (tx) => handlePharmacyMessageEvent(tx, {
      eventId: "01HP6DOWNTIMESALE00000001", name: "retail.sold", occurredAt: at(7),
      payload: {
        saleId: "s2", patientId: fx.patient.id, invoiceId: "inv-x", storeResourceId: fx.storeId, licenceId: null, registeredHere: false, scheduled: false,
        h1RegisterRows: 0, lines: [{ lineIdx: 0, medicineId: fx.med.crocin, itemId: fx.item.crocin, batchId: "b", qtyBase: 1, scheduleFlag: null, ledgerEntryId: "le", fefoOverride: false }],
        netPaise: 100, pharmacistRegNo: null, channel: "downtime", soldAt: at(0).toISOString(), soldBy: fx.pharmacist.id,
        sheet: { kitId: "k", serial: 1, desk: "OPD" },
      },
    }));
    expect(r).toEqual({ id: null, skipped: "downtime" });
  });

  it("the hand-over shows where the bill's message is: queued, then logged only while no provider is live", async () => {
    const { dispenseId } = await handOver([line({ drug: "Crocin 500", medicineId: fx.med.crocin, frequency: "1-0-1", durationDays: 5 })], [10]);
    expect((await patientMessagesFor(db, dispenseId, { sms: false, whatsapp: false }, at(6))).bill.state).toBe("pending");
    await withTx(db, async (tx) => handlePharmacyMessageEvent(tx, await handedOverEvent(dispenseId)));
    expect((await patientMessagesFor(db, dispenseId, { sms: false, whatsapp: false }, at(6))).bill.state).toBe("queued");
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      // 17 Aug 09:55 IST — inside the message hours; the pump's own default is the console sink.
      await runNotifyPump(db, { now: at(6) });
    } finally {
      log.mockRestore();
    }
    const view = await patientMessagesFor(db, dispenseId, { sms: false, whatsapp: false }, at(7));
    expect(view.bill).toMatchObject({ state: "logged_only", channel: "sms" });
    expect(view).toMatchObject({ hasPhone: true, phoneLast4: "3210", refillReminders: false });
  });

  // ── THE REMINDER ─────────────────────────────────────────────────────────────────────────

  it("no reminder without the patient's yes — and none held back silently: no pharmacy phone says so", async () => {
    await handOver([chronicCrocin()], [60]);
    expect(await runRefillReminders(db, SEP14_10IST)).toEqual({ held: "no_contact_phone", enqueued: [] });
    await withTx(db, (tx) => recordContactPhone(tx, fx.incharge.id, "0141-2345678", at(6)));
    expect(await runRefillReminders(db, SEP14_10IST)).toEqual({ held: null, enqueued: [] });
    expect(await refillRows()).toEqual([]);
  });

  it("with the yes: ONE reminder per dispense, in the window only, naming no medicine", async () => {
    const { dispenseId } = await handOver([chronicCrocin()], [60]);
    await withTx(db, (tx) => recordContactPhone(tx, fx.incharge.id, "0141-2345678", at(6)));
    await say({ kind: "reminders", on: true });

    expect((await runRefillReminders(db, new Date("2026-09-11T04:30:00.000Z"))).enqueued).toEqual([]); // too early
    expect((await runRefillReminders(db, SEP14_10IST)).enqueued).toEqual([{ dispenseId, patientId: fx.patient.id }]);
    expect((await runRefillReminders(db, new Date("2026-09-15T04:30:00.000Z"))).enqueued).toEqual([]); // not twice
    const rows = await refillRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refType: "pharmacy_dispense", refId: dispenseId, dedupeKey: `pharmacy_refill_due:${dispenseId}` });
    // The owner's name switch is OFF: the params carry no `drugs` key at all.
    expect(rows[0]!.params).toEqual({ hospital: expect.any(String), since: "2026-08-17", runsOutOn: "2026-09-16", contactPhone: "0141-2345678" });
    expect(rows[0]!.expiresAt.toISOString()).toBe("2026-09-16T18:30:00.000Z"); // the end of the day it runs out, IST
    for (const lang of ["en", "hi"] as const) expect(templateByKey("pharmacy_refill_due").render[lang](rows[0]!.params)).not.toMatch(DRUG_WORDS);
    expect(templateByKey("pharmacy_refill_due").render.en(rows[0]!.params)).toBe(
      `${String(rows[0]!.params.hospital)}: your medicines from 17 Aug 2026 may be running low. Please visit the hospital pharmacy or call 0141-2345678. To stop these reminders, tell the pharmacy.`,
    );
  });

  it("a stopped patient gets no reminder, and a short course is not chronic", async () => {
    await handOver([line({ drug: "Crocin 500", medicineId: fx.med.crocin, dose: "1 tab", frequency: "1-0-1", durationDays: 5 })], [10]); // 5 days
    await withTx(db, (tx) => recordContactPhone(tx, fx.incharge.id, "0141-2345678", at(6)));
    await say({ kind: "reminders", on: true });
    expect((await runRefillReminders(db, new Date("2026-08-20T04:30:00.000Z"))).enqueued).toEqual([]);
    await handOver([chronicCrocin()], [60]);
    await say({ kind: "stop" });
    expect((await runRefillReminders(db, SEP14_10IST)).enqueued).toEqual([]);
  });

  it("the reminder waits for 08:00 when the pump meets it at night (quiet hours)", async () => {
    await handOver([chronicCrocin()], [60]);
    await withTx(db, (tx) => recordContactPhone(tx, fx.incharge.id, "0141-2345678", at(6)));
    await say({ kind: "reminders", on: true });
    await runRefillReminders(db, SEP14_10IST);
    const calls: string[] = [];
    const rec = (channel: ChannelAdapter["channel"]): ChannelAdapter => ({ channel, async send() { calls.push(channel); return { providerMessageId: null }; } });
    await runNotifyPump(db, { now: new Date("2026-09-14T16:00:00.000Z"), adapters: { sms: rec("sms"), whatsapp: rec("whatsapp"), web_push: rec("web_push") } }); // 21:30 IST
    expect(calls).toEqual([]);
    expect((await refillRows())[0]).toMatchObject({ status: "queued", attempts: 0 });
    await runNotifyPump(db, { now: new Date("2026-09-15T02:31:00.000Z"), adapters: { sms: rec("sms"), whatsapp: rec("whatsapp"), web_push: rec("web_push") } }); // 08:01 IST
    expect(calls).toEqual(["sms"]);
  });

  // ── THE OFFICE ───────────────────────────────────────────────────────────────────────────

  it("the office sees the provider off, the ids to fill with the exact DLT text, and the census stays RED until both ids are in", async () => {
    const office = await messagesOffice(db, { sms: false, whatsapp: false }, at(6));
    expect(office.needs).toEqual(["provider", "dlt_ids", "contact_phone"]);
    expect(office.templates.map((t) => [t.key, t.dltTemplateId, t.variables])).toEqual([["pharmacy_bill_ready", null, 4], ["pharmacy_refill_due", null, 3]]);
    expect(office.templates[0]!.text.en).toBe("{#var#} pharmacy: bill {#var#} for Rs {#var#} is paid ({#var#}). Keep this message; the counter gives a printed copy on request.");
    expect(office.templates[1]!.text.en).toBe("{#var#}: your medicines from {#var#} may be running low. Please visit the hospital pharmacy or call {#var#}. To stop these reminders, tell the pharmacy.");
    expect(await pharmacyDltTemplateIdsRecorded(db)).toBe(false);
    await withTx(db, (tx) => recordTemplateRegistration(tx, fx.incharge.actor, "pharmacy_bill_ready", { dltTemplateId: "1107161234567890123", whatsappTemplateName: null }, at(6)));
    expect(await pharmacyDltTemplateIdsRecorded(db)).toBe(false); // one of two is not the act
    await withTx(db, (tx) => recordTemplateRegistration(tx, fx.incharge.actor, "pharmacy_refill_due", { dltTemplateId: "1107161234567890124", whatsappTemplateName: null }, at(6)));
    expect(await pharmacyDltTemplateIdsRecorded(db)).toBe(true);
  });

  it("the pharmacy's phone is a mobile or a landline with its STD code", async () => {
    await expect(withTx(db, (tx) => recordContactPhone(tx, fx.incharge.id, "12345", at(6)))).rejects.toThrow(expect.objectContaining({ code: "invalid_message_setting" }));
    expect(await withTx(db, (tx) => recordContactPhone(tx, fx.incharge.id, " 0141 234 5678 ", at(6)))).toBe("0141 234 5678");
  });
});

describe("the reminder's arithmetic (pure)", () => {
  const rx = (over: Partial<RxLine>): RxLine => ({ drug: "Metformin 500", dose: "1 tab", route: "oral", frequency: "BD", durationDays: 30, instructions: null, noSubstitution: false, ...over });
  const L = (over: Partial<Omit<RefillLine, "rxLine">> & { rxLine?: Partial<RxLine> }): RefillLine => ({
    itemId: "i1", qtyBase: 60, scheduleFlag: "H", ndpsClass: null, ...over, rxLine: rx(over.rxLine ?? {}),
  });
  const OPTS = { leadDays: 3, minSupplyDays: 20 };

  it("days of supply = quantity ÷ (dose × doses a day), or nothing when the words do not parse", () => {
    expect(supplyDays(rx({ frequency: "BD" }), 60)).toBe(30);
    expect(supplyDays(rx({ dose: "2 tab", frequency: "1-0-1" }), 60)).toBe(15);
    expect(supplyDays(rx({ frequency: "SOS" }), 60)).toBeNull();
    expect(supplyDays(rx({ dose: "as directed" }), 60)).toBeNull();
  });

  it("due from lead days before the first chronic line runs out, until that day", () => {
    const lines = [L({}), L({ itemId: "i2", qtyBase: 90, rxLine: { drug: "Amlodipine 5", frequency: "OD" } })]; // 30 and 90 days
    expect(refillDue("2026-08-17", lines, "2026-09-12", OPTS)).toBeNull();
    expect(refillDue("2026-08-17", lines, "2026-09-13", OPTS)).toMatchObject({ runsOutOn: "2026-09-16" });
    expect(refillDue("2026-08-17", lines, "2026-09-16", OPTS)).toMatchObject({ runsOutOn: "2026-09-16" });
    expect(refillDue("2026-08-17", lines, "2026-09-17", OPTS)).toBeNull();
    expect(refillDue("2026-08-17", [L({ qtyBase: 10 })], "2026-08-20", OPTS)).toBeNull(); // 5 days: not chronic
  });

  it("a Schedule X or NDPS line never prompts a reminder", () => {
    expect(refillDue("2026-08-17", [L({ scheduleFlag: "X" })], "2026-09-14", OPTS)).toBeNull();
    expect(refillDue("2026-08-17", [L({ scheduleFlag: "H", ndpsClass: "narcotic" })], "2026-09-14", OPTS)).toBeNull();
    expect(refillDue("2026-08-17", [L({ scheduleFlag: "H1" })], "2026-09-14", OPTS)).not.toBeNull(); // a TB course may be reminded — never named
  });

  it("even with names switched ON, no Schedule X, NDPS or H1 name can enter a message", () => {
    const names = namableDrugs([
      L({ rxLine: { drug: "Metformin 500" }, scheduleFlag: "H" }),
      L({ rxLine: { drug: "Alprax 0.5" }, scheduleFlag: "X" }),
      L({ rxLine: { drug: "Tramadol 50" }, scheduleFlag: "H1", ndpsClass: null }),
      L({ rxLine: { drug: "Morphine 10" }, scheduleFlag: null, ndpsClass: "narcotic" }),
      L({ rxLine: { drug: "Clonazepam 0.5" }, scheduleFlag: "H", ndpsClass: "psychotropic" }),
      L({ rxLine: { drug: "Rifampicin 450" }, scheduleFlag: "H1" }),
    ]);
    expect(names).toEqual(["Metformin 500"]);
  });
});
