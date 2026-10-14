import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { authManifest } from "../../kernel/auth/manifest";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { events, ipdAdmissionDeposits, notifications, patients } from "../../kernel/db/schema";
import { runNotifyPump } from "../../kernel/notify/pump";
import { patientsManifest } from "../patients";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole } from "../../../test/helpers/opd";
import { mkChargesWorld } from "../../../test/helpers/ipd";
import * as ipd from "./index";
import { backfillDowntime, ipdManifest, issueFamilyLink, postNightlyIpdCharges, readBillDesk, runIpdBillDeskNightly, takeDeposit } from "./index";
import type { AppConfig } from "../../kernel/config";
import type { ChannelAdapter, SendMeta } from "../../kernel/notify/adapters";
import type { NotifyPumpOptions } from "../../kernel/notify/pump";
import type { Db } from "../../kernel/db/client";
import type { ChargesWorld } from "../../../test/helpers/ipd";

/**
 * #761 — THE DAILY TOTALS REACH THE REGISTERED ATTENDANT, ONLY AS AN APPROVED TEMPLATE, ONLY WITH CONSENT.
 *
 * The pump is driven directly with the SAME seam and registrations `registerAllJobs` installs (`ipdAttendantRecipient`,
 * `ipdTemplateRegistrations`, read from config) and recording, non-sink adapters. Every instant is explicit IST.
 * The seam is reached through the module namespace so this file compiles and FAILS against the code before #761.
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = (): string => randomUUID();
const PAPER = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Desk Witness" };
const ATTENDANT_PHONE = "9812345678";
const NEW_PHONE = "9898989898";
const DESK_PHONE = "0612-2200000";
const DIAGNOSIS = "Dengue haemorrhagic fever";
const ON = { whatsappTemplateName: "crk_ipd_daily_totals_v1", dltTemplateId: null, deskPhone: DESK_PHONE };
const CONSENT = { consentedBy: "Sita Devi", relation: "spouse" as const, method: "verbal" as const };
const SECRET = Buffer.alloc(32, 7);

type Call = { channel: string; to: string; text: string; meta: SendMeta };
type Seam = {
  ipdAttendantRecipient(cfg: unknown, secretKey?: Buffer): unknown;
  ipdTemplateRegistrations(cfg: unknown): unknown;
  dailyTotalsSendingOf(cfg: unknown): unknown;
  recordAttendantConsent(db: Db, actor: unknown, admissionId: string, input: unknown, opts: unknown): Promise<unknown>;
  stopAttendantMessages(db: Db, actor: unknown, admissionId: string, opts: unknown): Promise<unknown>;
  readAttendantMessages(db: Db, actor: unknown, admissionId: string, sending: unknown): Promise<{ state: string; words: string }>;
};
const seam = ipd as unknown as Seam;

describe("#761 daily totals to the attendant — the recipient seam, consent, stop and the approved-template switch", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ChargesWorld;
  let calls: Call[];
  let serial = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    calls = [];
    w = await mkChargesWorld(db);
    const registry = new ModuleRegistry();
    registry.install(authManifest);
    registry.install(patientsManifest);
    registry.install(ipdManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "front_office");
    for (const p of ["ipd.family.issue", "ipd.bill.view", "ipd.billdesk.view"]) await grantPermissionToRole(db, registry, "front_office", p);
  });

  const fake = (channel: ChannelAdapter["channel"]): ChannelAdapter => ({
    channel,
    async send(to, text, meta) { calls.push({ channel, to, text, meta }); return { providerMessageId: `pm-${channel}` }; },
  });
  const adapters = { whatsapp: fake("whatsapp"), sms: fake("sms"), web_push: fake("web_push") };
  const pump = (at: string, cfg: AppConfig["ipdDailyTotals"] | undefined) => runNotifyPump(db, {
    now: ist(at), adapters,
    recipientResolvers: { attendant: seam.ipdAttendantRecipient(cfg, SECRET) },
    templateRegistrations: seam.ipdTemplateRegistrations(cfg),
  } as NotifyPumpOptions);

  /** Admitted 10 Mar, a relative paid ₹5,000; the nightly run of 12 Mar posts days 10 and 11 (₹4,400) and queues the totals for 11 Mar. */
  const admitted = async (): Promise<{ admissionId: string; patientId: string }> => {
    serial += 1;
    const patientId = await w.patient("male", 45, `Ramesh Kumar Test${String(serial)}`);
    const bedId = await w.bed(`AM-G-${String(serial)}`, { class: "general" });
    const done = await backfillDowntime(db, w.admitDesk, {
      idempotencyKey: key(), paperSerial: `AM-${String(serial)}`, patientId, bedId, consultantId: w.doctor.id, requestedClass: "general",
      isolation: "none", provisionalDiagnosis: DIAGNOSIS, mlc: false, payerKind: "cash",
      requestedAt: ist("2026-03-10T10:00:00").toISOString(), admittedAt: ist("2026-03-10T10:00:00").toISOString(), consent: PAPER,
    }, { now: ist("2026-03-10T10:00:00") });
    await takeDeposit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId: done.admissionId, amountPaise: 500_000, tender: "cash",
      payer: { name: "Sita Devi", relation: "relative", phone: ATTENDANT_PHONE },
    }, { now: ist("2026-03-10T10:30:00") });
    return { admissionId: done.admissionId, patientId };
  };
  const night = async (date: string) => {
    await postNightlyIpdCharges(db, ist(`${date}T00:05:00`));
    await runIpdBillDeskNightly(db, ist(`${date}T00:06:00`));
  };
  const rows = async (admissionId: string) => db.select().from(notifications).where(eq(notifications.refId, admissionId));
  const consent = (admissionId: string, at: string) => seam.recordAttendantConsent(db, w.admitDesk, admissionId, { consent: CONSENT }, { now: ist(at) });

  it("OFF until config names an approved template: recorded 'not sent: template not configured' on the bill desk, no adapter called", async () => {
    const { admissionId } = await admitted();
    await consent(admissionId, "2026-03-10T11:00:00");
    await night("2026-03-12");
    await pump("2026-03-12T09:00:00", undefined);
    expect(calls).toEqual([]);
    expect((await rows(admissionId))[0]).toMatchObject({ status: "suppressed", lastError: "template_pending", sentAt: null });
    const desk = await readBillDesk(db, w.admitDesk, ist("2026-03-12T10:00:00"), seam.dailyTotalsSendingOf(undefined) as never);
    expect(desk.dailyTotals).toMatchObject({ billDate: "2026-03-11", sent: 0, sending: { on: false } });
    expect(desk.dailyTotals.notSent).toEqual([expect.objectContaining({ admissionId, words: "Not sent: template not configured" })]);
    // A template id without the desk phone the message names is still off.
    const half = { ...ON, deskPhone: null };
    expect(seam.dailyTotalsSendingOf(half)).toMatchObject({ on: false, missing: ["IPD_BILL_DESK_PHONE"] });
  });

  it("ON with consent: at 09:00 IST, to the attendant's phone (never the patient's), as the approved WhatsApp template, variables only", async () => {
    const { admissionId, patientId } = await admitted();
    await consent(admissionId, "2026-03-10T11:00:00");
    await night("2026-03-12");
    // Queued for 09:00 IST: nothing goes before it.
    await pump("2026-03-12T08:59:00", ON);
    expect(calls).toEqual([]);
    await pump("2026-03-12T09:00:00", ON);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    const patientPhone = (await db.select({ phone: patients.phone }).from(patients).where(eq(patients.id, patientId)))[0]!.phone;
    expect(c!.to).toBe(ATTENDANT_PHONE);
    expect(c!.to).not.toBe(patientPhone);
    expect(c!.channel).toBe("whatsapp");
    expect(c!.meta.registration).toEqual({ whatsappTemplateName: ON.whatsappTemplateName, dltTemplateId: null });
    expect(c!.meta.variables).toEqual(["Ramesh", "4,400", "600", DESK_PHONE]);
    for (const word of [DIAGNOSIS, "Dengue", "room", "nursing", "RMO", "general", "AM-G", "Kumar"]) expect(c!.text).not.toContain(word);
    // The phone travels nowhere in the row: params hold a reference.
    const [row] = await rows(admissionId);
    expect(JSON.stringify(row!.params)).not.toContain(ATTENDANT_PHONE);
    expect(row).toMatchObject({ status: "sent", sentChannel: "whatsapp" });
    const desk = await readBillDesk(db, w.admitDesk, ist("2026-03-12T10:00:00"), seam.dailyTotalsSendingOf(ON) as never);
    expect(desk.dailyTotals).toMatchObject({ sent: 1, waiting: 0, notSent: [] });
  });

  it("no consent → not sent, with the reason; a live family link to the same attendant is consent", async () => {
    const a = await admitted();
    await night("2026-03-12");
    await pump("2026-03-12T09:00:00", ON);
    expect(calls).toEqual([]);
    expect((await rows(a.admissionId))[0]).toMatchObject({ status: "suppressed", lastError: "no_consent" });
    const desk = await readBillDesk(db, w.admitDesk, ist("2026-03-12T10:00:00"), seam.dailyTotalsSendingOf(ON) as never);
    expect(desk.dailyTotals.notSent).toEqual([expect.objectContaining({ admissionId: a.admissionId, words: "Not sent: no consent recorded" })]);

    await issueFamilyLink(db, w.admitDesk, a.admissionId, { consent: CONSENT }, { now: ist("2026-03-12T11:00:00"), secretKey: SECRET });
    await night("2026-03-13");
    await pump("2026-03-13T09:00:00", ON);
    expect(calls.map((c) => c.to)).toEqual([ATTENDANT_PHONE]);
  });

  it("a stop at the desk is honoured from the next send, beats the consent, and is audited; re-consent clears it", async () => {
    const { admissionId } = await admitted();
    await consent(admissionId, "2026-03-10T11:00:00");
    await seam.stopAttendantMessages(db, w.admitDesk, admissionId, { now: ist("2026-03-11T18:00:00") });
    await night("2026-03-12");
    await pump("2026-03-12T09:00:00", ON);
    expect(calls).toEqual([]);
    expect((await rows(admissionId))[0]).toMatchObject({ status: "suppressed", lastError: "opted_out" });
    expect((await seam.readAttendantMessages(db, w.admitDesk, admissionId, seam.dailyTotalsSendingOf(ON))).state).toBe("stopped");
    const names = (await db.select({ name: events.name }).from(events).where(eq(events.correlationId, admissionId))).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["ipd.attendant_messages.consented", "ipd.attendant_messages.stopped"]));

    await consent(admissionId, "2026-03-12T12:00:00");
    await night("2026-03-13");
    await pump("2026-03-13T09:00:00", ON);
    expect(calls.map((c) => c.to)).toEqual([ATTENDANT_PHONE]);
  });

  it("contact truth at send time: a phone corrected after queueing is the one used; a patient sealed after queueing gets nothing", async () => {
    const a = await admitted();
    await consent(a.admissionId, "2026-03-10T11:00:00");
    const b = await admitted();
    await consent(b.admissionId, "2026-03-10T11:00:00");
    await night("2026-03-12");
    await db.update(ipdAdmissionDeposits).set({ payerPhone: NEW_PHONE }).where(eq(ipdAdmissionDeposits.admissionId, a.admissionId));
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, b.patientId));
    await pump("2026-03-12T09:00:00", ON);
    expect(calls.map((c) => c.to)).toEqual([NEW_PHONE]);
    expect((await rows(b.admissionId))[0]).toMatchObject({ status: "suppressed", lastError: "recipient_blocked" });
  });

  it("the attendant the row was queued for is no longer the registered one: nothing goes to the old attendant, and the desk's stop is not bypassed", async () => {
    const { admissionId } = await admitted();
    await consent(admissionId, "2026-03-10T11:00:00");
    await night("2026-03-12");
    // Before 09:00 another relative pays: the card now names them, and the desk records their stop.
    await takeDeposit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId, amountPaise: 100_000, tender: "cash",
      payer: { name: "Mohan Lal", relation: "relative", phone: NEW_PHONE },
    }, { now: ist("2026-03-12T08:00:00") });
    await seam.stopAttendantMessages(db, w.admitDesk, admissionId, { now: ist("2026-03-12T08:10:00") });
    expect((await seam.readAttendantMessages(db, w.admitDesk, admissionId, seam.dailyTotalsSendingOf(ON))).state).toBe("stopped");
    await pump("2026-03-12T09:00:00", ON);
    expect(calls).toEqual([]);
    expect((await rows(admissionId))[0]!.status).not.toBe("sent");
  });

  it("a family link counts as consent only for the phone it was issued to: a phone changed since issue gets nothing", async () => {
    const { admissionId } = await admitted();
    await issueFamilyLink(db, w.admitDesk, admissionId, { consent: CONSENT }, { now: ist("2026-03-11T11:00:00"), secretKey: SECRET });
    await night("2026-03-12");
    await db.update(ipdAdmissionDeposits).set({ payerPhone: NEW_PHONE }).where(eq(ipdAdmissionDeposits.admissionId, admissionId));
    await pump("2026-03-12T09:00:00", ON);
    expect(calls).toEqual([]);
    expect((await rows(admissionId))[0]).toMatchObject({ status: "suppressed", lastError: "no_consent" });
  });

  it("at most one message per admission per day: a second nightly run and a second pump send nothing more", async () => {
    const { admissionId } = await admitted();
    await consent(admissionId, "2026-03-10T11:00:00");
    await night("2026-03-12");
    await runIpdBillDeskNightly(db, ist("2026-03-12T08:30:00"));
    await pump("2026-03-12T09:00:00", ON);
    await pump("2026-03-12T09:05:00", ON);
    expect(await rows(admissionId)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});
