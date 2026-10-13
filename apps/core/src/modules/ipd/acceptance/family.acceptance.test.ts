import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { authManifest } from "../../../kernel/auth/manifest";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import {
  events, ipdAdmissionDeposits, ipdAdmissions, ipdChargeLines, ipdFamilyCallbacks, ipdFamilyLinks, notifications, patients,
} from "../../../kernel/db/schema";
import { patientsManifest } from "../../patients";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { mkDischargeWorld } from "../../../../test/helpers/ipd";
import {
  backfillDowntime, closeFamilyCallback, familyGate, familyStopConsumer, ipdManifest, issueFamilyLink, listFamilyCallbacks,
  postNightlyIpdCharges, readFamilyBillDetails, readFamilyPanel, readFamilyView, recordAbscond, recordDeath, requestFamilyCallback,
  sendFamilyOtp, setCondition, takeDeposit, verifyFamilyOtp,
} from "../index";
import { IpdError } from "../errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { DischargeWorld } from "../../../../test/helpers/ipd";
import type { FamilyOtpSender } from "../index";

/**
 * E3.3 (#731) — "DONE MEANS" FOR THE FAMILY LINK (spec SPEC-ipd-core §4.3, §4.9 G, §4.10 edges 14–17; decision 0072).
 * Every call takes an EXPLICIT instant (IST, `+05:30`); nothing here reads the clock for a decision it asserts.
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = (): string => randomUUID();
const PAPER = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Desk Witness" };
const ATTENDANT_PHONE = "9812345678";
/** The server secret the phone HMAC is keyed with (the test env's `SECRET_KEY`). */
const KEY = Buffer.from(process.env.SECRET_KEY ?? "0".repeat(64), "hex");
const CONSENT = { consentedBy: "Sita Devi", relation: "spouse" as const, method: "verbal" as const };

/** A recording SMS sender: what was sent, to whom. */
class FakeSender implements FamilyOtpSender {
  readonly name = "fake";
  sent: { to: string; otp: string }[] = [];
  async send(to: string, otp: string): Promise<void> { this.sent.push({ to, otp }); await Promise.resolve(); }
}

async function refusal(p: Promise<unknown>): Promise<IpdError> {
  try { await p; } catch (e) { if (e instanceof IpdError) return e; throw e; }
  throw new Error("expected a refusal, the act succeeded");
}

describe("E3.3 family link — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: DischargeWorld;
  let desk: Actor;
  let sender: FakeSender;
  let serial = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkDischargeWorld(db);
    const registry = new ModuleRegistry();
    registry.install(authManifest);
    registry.install(patientsManifest);
    registry.install(ipdManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "front_office");
    await grantPermissionToRole(db, registry, "front_office", "ipd.family.issue");
    await grantPermissionToRole(db, registry, "front_office", "ipd.discharge.view");
    await ensureRole(db, "doctor");
    await grantPermissionToRole(db, registry, "doctor", "ipd.condition.set");
    desk = (await mkUser(db, "fam.desk", ["front_office"])).actor;
    sender = new FakeSender();
  });

  /** A cash patient admitted (downtime back-fill, explicit instants), with a deposit paid by a relative with a phone. */
  const admitWithAttendant = async (at: string): Promise<{ admissionId: string; patientId: string }> => {
    serial += 1;
    const patientId = await w.patient("female", 52, `Sunita Devi Test${String(serial)}`);
    const bedId = await w.bed(`FAM-G-${String(serial)}`, { class: "general" });
    const done = await backfillDowntime(db, w.admitDesk, {
      idempotencyKey: key(), paperSerial: `FAM-${String(serial)}`, patientId, bedId, consultantId: w.doctor.id, requestedClass: "general",
      isolation: "none", provisionalDiagnosis: "Dengue fever", mlc: false, payerKind: "cash",
      requestedAt: ist(at).toISOString(), admittedAt: ist(at).toISOString(), consent: PAPER,
    }, { now: ist(at) });
    await takeDeposit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId: done.admissionId, amountPaise: 1_000_000, tender: "cash",
      payer: { name: "Sita Devi", relation: "relative", phone: ATTENDANT_PHONE },
    }, { now: new Date(ist(at).getTime() + 30 * 60_000) });
    return { admissionId: done.admissionId, patientId };
  };
  const tokenOf = (path: string): string => path.replace("/family#", "");
  /** Issue, send, verify on device `dev`: the attendant's verified session cookies. */
  const verified = async (admissionId: string, at: string, dev = "device-aaaaaaaaaaaaaaaaaaaa") => {
    const issued = await issueFamilyLink(db, desk, admissionId, { consent: CONSENT }, { now: ist(at), secretKey: KEY });
    const token = tokenOf(issued.path);
    await sendFamilyOtp(db, token, dev, sender, { at: ist(at), secretKey: KEY });
    const s = await verifyFamilyOtp(db, token, dev, sender.sent.at(-1)!.otp, ist(at));
    return { token, cookies: { device: dev, session: s.sessionToken }, linkId: issued.linkId };
  };

  it("(i) the OTP goes only to the registered attendant's phone; a different phone or another browser cannot receive or verify", async () => {
    const { admissionId } = await admitWithAttendant("2026-03-10T10:00:00");
    const issued = await issueFamilyLink(db, desk, admissionId, { consent: CONSENT }, { now: ist("2026-03-10T11:00:00"), secretKey: KEY });
    expect(issued.phoneMasked).toBe("******5678");
    const token = tokenOf(issued.path);
    // Before the OTP the page shows only the masked phone: no name, no ward.
    const gate = await familyGate(db, token, {}, ist("2026-03-10T11:01:00"));
    expect(gate).toEqual({ status: "needs_otp", phoneMasked: "******5678", purpose: "inpatient_updates" });

    // The code goes to the registered phone — the caller has no way to name a number.
    await sendFamilyOtp(db, token, "device-aaaaaaaaaaaaaaaaaaaa", sender, { at: ist("2026-03-10T11:02:00"), secretKey: KEY });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe(ATTENDANT_PHONE);
    const code = sender.sent[0]!.otp;
    expect(code).toMatch(/^\d{6}$/);

    // Another browser cannot redeem that code, even with the right digits.
    expect((await refusal(verifyFamilyOtp(db, token, "device-bbbbbbbbbbbbbbbbbbbb", code, ist("2026-03-10T11:03:00")))).code).toBe("family_otp_invalid");
    // Nor can a wrong code from the right browser; the right one can.
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await refusal(verifyFamilyOtp(db, token, "device-aaaaaaaaaaaaaaaaaaaa", wrong, ist("2026-03-10T11:03:30")))).code).toBe("family_otp_invalid");
    const s = await verifyFamilyOtp(db, token, "device-aaaaaaaaaaaaaaaaaaaa", code, ist("2026-03-10T11:04:00"));
    // The session works only with the device cookie that verified.
    await readFamilyView(db, token, { device: "device-aaaaaaaaaaaaaaaaaaaa", session: s.sessionToken }, ist("2026-03-10T11:05:00"));
    expect((await refusal(readFamilyView(db, token, { device: "device-bbbbbbbbbbbbbbbbbbbb", session: s.sessionToken }, ist("2026-03-10T11:05:00")))).code)
      .toBe("family_session_required");

    // The attendant's phone on record changes: the old link sends nothing to the new number (a new link is needed).
    await db.update(ipdAdmissionDeposits).set({ payerPhone: "9000000001" }).where(eq(ipdAdmissionDeposits.admissionId, admissionId));
    expect((await refusal(sendFamilyOtp(db, token, "device-aaaaaaaaaaaaaaaaaaaa", sender, { at: ist("2026-03-10T11:10:00"), secretKey: KEY }))).code).toBe("family_phone_changed");
    expect(sender.sent).toHaveLength(1);

    // Rate limit: three sends an hour.
    const again = await issueFamilyLink(db, desk, admissionId, { consent: CONSENT }, { now: ist("2026-03-10T12:00:00"), secretKey: KEY });
    expect(again.phoneMasked).toBe("******0001");
    const t2 = tokenOf(again.path);
    for (const m of ["01", "02", "03"]) await sendFamilyOtp(db, t2, "device-aaaaaaaaaaaaaaaaaaaa", sender, { at: ist(`2026-03-10T12:${m}:00`), secretKey: KEY });
    expect((await refusal(sendFamilyOtp(db, t2, "device-aaaaaaaaaaaaaaaaaaaa", sender, { at: ist("2026-03-10T12:04:00"), secretKey: KEY }))).code).toBe("family_otp_limit");
    expect(sender.sent.slice(1).every((x) => x.to === "9000000001")).toBe(true);
    // The re-issue revoked the first link.
    expect((await familyGate(db, token, {}, ist("2026-03-10T12:05:00"))).status).toBe("closed");
    // Five wrong codes an hour, then even the right code is refused until the hour passes.
    const latest = sender.sent.at(-1)!.otp;
    const bad = latest === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) {
      expect((await refusal(verifyFamilyOtp(db, t2, "device-aaaaaaaaaaaaaaaaaaaa", bad, ist("2026-03-10T12:06:00")))).code).toBe("family_otp_invalid");
    }
    expect((await refusal(verifyFamilyOtp(db, t2, "device-aaaaaaaaaaaaaaaaaaaa", latest, ist("2026-03-10T12:07:00")))).code).toBe("family_otp_limit");
  });

  it("(ii) a sealed, a medico-legal or a team-switched-off admission refuses the link, and a live link closes when the patient is sealed", async () => {
    const sealed = await admitWithAttendant("2026-03-10T10:00:00");
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, sealed.patientId));
    const e1 = await refusal(issueFamilyLink(db, desk, sealed.admissionId, { consent: CONSENT }, { now: ist("2026-03-10T11:00:00"), secretKey: KEY }));
    expect(e1.code).toBe("family_link_refused");
    expect(e1.detail).toEqual({ reason: "sealed" });
    expect((await readFamilyPanel(db, desk, sealed.admissionId)).blocked).toBe("sealed");

    const mlc = await admitWithAttendant("2026-03-10T10:00:00");
    await db.update(ipdAdmissions).set({ mlc: true }).where(eq(ipdAdmissions.id, mlc.admissionId));
    expect((await refusal(issueFamilyLink(db, desk, mlc.admissionId, { consent: CONSENT }, { now: ist("2026-03-10T11:00:00"), secretKey: KEY }))).detail).toEqual({ reason: "mlc" });

    const psych = await admitWithAttendant("2026-03-10T10:00:00");
    const live = await verified(psych.admissionId, "2026-03-10T11:00:00");
    await setCondition(db, w.doctor, psych.admissionId, { word: "stable", familyOff: "psychiatric" }, { now: ist("2026-03-10T11:30:00") });
    expect((await refusal(issueFamilyLink(db, desk, psych.admissionId, { consent: CONSENT }, { now: ist("2026-03-10T11:31:00"), secretKey: KEY }))).detail).toEqual({ reason: "family_off" });
    // Turning it off revoked the live link.
    expect((await db.select().from(ipdFamilyLinks).where(eq(ipdFamilyLinks.id, live.linkId)))[0]).toMatchObject({ status: "revoked", revokedReason: "family_off" });
    expect((await refusal(readFamilyView(db, live.token, live.cookies, ist("2026-03-10T11:32:00")))).code).toBe("family_link_closed");

    // A link issued before the patient was sealed shows nothing from that moment.
    const later = await admitWithAttendant("2026-03-10T10:00:00");
    const s = await verified(later.admissionId, "2026-03-10T11:00:00");
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, later.patientId));
    expect((await refusal(readFamilyView(db, s.token, s.cookies, ist("2026-03-10T11:05:00")))).code).toBe("family_link_closed");
    expect((await familyGate(db, s.token, s.cookies, ist("2026-03-10T11:05:00"))).status).toBe("closed");
  });

  it("(iii) death and absconding revoke the link (the consumer), and the page closes at once", async () => {
    const consumer = familyStopConsumer(db);
    const deliver = async (admissionId: string, name: string) => {
      const ev = (await db.select().from(events).where(and(eq(events.name, name), eq(events.correlationId, admissionId))))[0]!;
      await consumer({ seq: Number(ev.seq), eventId: ev.eventId, name: ev.name, payload: ev.payload, patientId: ev.patientId, correlationId: ev.correlationId, occurredAt: ev.occurredAt } as never);
      // Idempotent by event id: a redelivery changes nothing.
      await consumer({ seq: Number(ev.seq), eventId: ev.eventId, name: ev.name, payload: ev.payload, patientId: ev.patientId, correlationId: ev.correlationId, occurredAt: ev.occurredAt } as never);
    };

    const dead = await admitWithAttendant("2026-03-10T10:00:00");
    const d = await verified(dead.admissionId, "2026-03-10T11:00:00");
    await readFamilyView(db, d.token, d.cookies, ist("2026-03-10T11:01:00"));
    await recordDeath(db, w.doctor, {
      idempotencyKey: key(), admissionId: dead.admissionId, diedAt: ist("2026-03-10T18:00:00").toISOString(), certifiedBy: w.doctor.id,
    }, { now: ist("2026-03-10T18:10:00") });
    // Closed at once, before the worker runs.
    expect((await refusal(readFamilyView(db, d.token, d.cookies, ist("2026-03-10T18:11:00")))).code).toBe("family_link_closed");
    await deliver(dead.admissionId, "ipd.admission.deceased");
    expect((await db.select().from(ipdFamilyLinks).where(eq(ipdFamilyLinks.id, d.linkId)))[0]).toMatchObject({ status: "revoked", revokedReason: "deceased" });
    expect(await db.select().from(events).where(and(eq(events.name, "ipd.family.link_revoked"), eq(events.correlationId, dead.admissionId)))).toHaveLength(1);
    expect((await refusal(sendFamilyOtp(db, d.token, d.cookies.device, sender, { at: ist("2026-03-10T18:12:00"), secretKey: KEY }))).code).toBe("family_link_closed");

    const gone = await admitWithAttendant("2026-03-10T10:00:00");
    const g = await verified(gone.admissionId, "2026-03-10T11:00:00");
    await recordAbscond(db, w.duty, {
      idempotencyKey: key(), admissionId: gone.admissionId, lastSeenAt: ist("2026-03-10T20:00:00").toISOString(), searchDone: true,
    }, { now: ist("2026-03-10T21:00:00") });
    expect((await refusal(readFamilyView(db, g.token, g.cookies, ist("2026-03-10T21:01:00")))).code).toBe("family_link_closed");
    await deliver(gone.admissionId, "ipd.admission.absconded");
    expect((await db.select().from(ipdFamilyLinks).where(eq(ipdFamilyLinks.id, g.linkId)))[0]).toMatchObject({ status: "revoked", revokedReason: "absconded" });
  });

  it("(iv) a clinical question becomes a callback request to the ward desk — nothing answers it", async () => {
    const { admissionId } = await admitWithAttendant("2026-03-10T10:00:00");
    const s = await verified(admissionId, "2026-03-10T11:00:00");
    const question = "Is her platelet count better today? Should we worry about the fever?";
    const outboxBefore = (await db.select().from(notifications)).length;
    const answer = await requestFamilyCallback(db, s.token, s.cookies, question, ist("2026-03-10T12:00:00"));
    // The reply is only an acknowledgement: no text, no answer field.
    expect(Object.keys(answer).sort()).toEqual(["callbackId", "status"]);
    expect(answer.status).toBe("open");
    const row = (await db.select().from(ipdFamilyCallbacks).where(eq(ipdFamilyCallbacks.id, answer.callbackId)))[0]!;
    expect(row).toMatchObject({ admissionId, text: question, status: "open", closedAt: null });
    // Nothing was sent back to the family (no outbox row), and the event log carries no words of the question.
    expect(await db.select().from(notifications)).toHaveLength(outboxBefore);
    const ev = (await db.select().from(events).where(eq(events.name, "ipd.family.callback_requested")))[0]!;
    expect(JSON.stringify(ev.payload)).not.toContain("platelet");
    // The ward desk sees it and closes it after calling back.
    const list = await listFamilyCallbacks(db, desk);
    expect(list.rows.map((r) => [r.id, r.text, r.phoneMasked])).toEqual([[answer.callbackId, question, "******5678"]]);
    await closeFamilyCallback(db, desk, answer.callbackId, "Called the wife, explained", { now: ist("2026-03-10T12:30:00") });
    expect((await listFamilyCallbacks(db, desk)).rows).toEqual([]);
    expect((await listFamilyCallbacks(db, desk, { status: "done" })).rows[0]).toMatchObject({ status: "done", note: "Called the wife, explained" });
  });

  it("(v) the totals view carries no line items; the explicit 'Show bill details' step shows them and is logged", async () => {
    const { admissionId } = await admitWithAttendant("2026-03-10T10:00:00");
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    const lines = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId));
    expect(lines.length).toBeGreaterThan(0);
    await setCondition(db, w.doctor, admissionId, { word: "improving" }, { now: ist("2026-03-12T09:40:00") });
    const s = await verified(admissionId, "2026-03-12T10:00:00");

    const view = await readFamilyView(db, s.token, s.cookies, ist("2026-03-12T10:05:00"));
    expect(view).toMatchObject({ status: "in_hospital", name: expect.stringMatching(/^Sunita$/), dayOfStay: 3, condition: { word: "improving" } });
    expect(view.totals.billPaise).toBeGreaterThan(0);
    expect(view.totals.depositPaise).toBe(1_000_000);
    const text = JSON.stringify(view);
    for (const l of lines) expect(text).not.toContain(l.serviceName);
    expect(text).not.toContain("Dengue");
    expect(text).not.toMatch(/"lines"/);
    const logged = () => db.select().from(events).where(and(eq(events.name, "ipd.family.bill_details_viewed"), eq(events.correlationId, admissionId)));
    expect(await logged()).toHaveLength(0);

    const details = await readFamilyBillDetails(db, s.token, s.cookies, ist("2026-03-12T10:06:00"));
    expect(details.lines.length).toBe(lines.length);
    expect(details.lines.map((l) => l.serviceName)).toEqual(expect.arrayContaining([lines[0]!.serviceName]));
    const log = await logged();
    expect(log).toHaveLength(1);
    expect(log[0]!.payload).toMatchObject({ admissionId, linkId: s.linkId, lines: lines.length });
    // Without a verified session the step is refused.
    expect((await refusal(readFamilyBillDetails(db, s.token, {}, ist("2026-03-12T10:07:00")))).code).toBe("family_session_required");
  });

  it("(vi) after the exit the page says Discharged for 24 hours, then the link expires", async () => {
    const { admissionId } = await admitWithAttendant("2026-03-10T10:00:00");
    const s = await verified(admissionId, "2026-03-11T09:00:00");
    await db.update(ipdAdmissions).set({ state: "discharged", endedAt: ist("2026-03-11T11:00:00") }).where(eq(ipdAdmissions.id, admissionId));
    const v = await readFamilyView(db, s.token, s.cookies, ist("2026-03-11T15:00:00"));
    expect(v.status).toBe("discharged");
    expect(v.tracker?.todo).toBe("go_home");
    expect((await refusal(readFamilyView(db, s.token, s.cookies, ist("2026-03-12T11:01:00")))).code).toBe("family_link_closed");
    expect((await db.select().from(ipdFamilyLinks).where(eq(ipdFamilyLinks.admissionId, admissionId)))[0]).toMatchObject({ status: "expired" });
  });
});
