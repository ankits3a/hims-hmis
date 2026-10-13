import { createHash, randomUUID } from "node:crypto";
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
import { ipdFamilyOtps, ipdFamilySessions } from "../../../kernel/db/schema";
import { listFamilyCallbacks as listCallbacks } from "../family";
import {
  backfillDowntime, closeFamilyCallback, familyGate, familyStopConsumer, ipdManifest, issueFamilyLink, listFamilyCallbacks,
  postNightlyIpdCharges, readFamilyBillDetails, readFamilyPanel, readFamilyView, recordAbscond, recordDeath, requestFamilyCallback,
  sendFamilyOtp, setCondition, takeDeposit, verifyFamilyOtp,
} from "../index";
import { IpdError } from "../errors";
import { FamilyOtpUnavailable } from "../family-otp";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { DischargeWorld } from "../../../../test/helpers/ipd";
import type { FamilyOtpSender } from "../index";

/**
 * E3.3 review #764 — the review's guards on the family link (each failed first against the reviewed commit ef4324e2 or a
 * mutant restoring its behaviour). Same fixtures as `family.acceptance.test.ts`.
 * (Was: E3.3 (#731) — "DONE MEANS" FOR THE FAMILY LINK (spec SPEC-ipd-core §4.3, §4.9 G, §4.10 edges 14–17; decision 0072).
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

describe("E3.3 family link — review #764", () => {
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

  const wrongOf = (code: string): string => (code === "000000" ? "111111" : "000000");
  const outcome = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return e instanceof IpdError ? e.code : String(e); } };

  it("R1: parallel wrong guesses are counted atomically — at most five are compared, the rest are refused as over the limit", async () => {
    const { admissionId } = await admitWithAttendant("2026-03-10T10:00:00");
    const issued = await issueFamilyLink(db, desk, admissionId, { consent: CONSENT }, { now: ist("2026-03-10T11:00:00"), secretKey: KEY });
    const token = tokenOf(issued.path);
    const dev = "device-aaaaaaaaaaaaaaaaaaaa";
    await sendFamilyOtp(db, token, dev, sender, { at: ist("2026-03-10T11:01:00"), secretKey: KEY });
    const bad = wrongOf(sender.sent[0]!.otp);
    const results = await Promise.all(Array.from({ length: 9 }, () => outcome(verifyFamilyOtp(db, token, dev, bad, ist("2026-03-10T11:02:00")))));
    expect(results.filter((r) => r === "family_otp_invalid")).toHaveLength(5);
    expect(results.filter((r) => r === "family_otp_limit")).toHaveLength(4);
    // And the right code is refused too until the hour passes.
    expect(await outcome(verifyFamilyOtp(db, token, dev, sender.sent[0]!.otp, ist("2026-03-10T11:03:00")))).toBe("family_otp_limit");
  });

  it("Y3: one code mints exactly one session, even when two right verifies race", async () => {
    const { admissionId } = await admitWithAttendant("2026-03-10T10:00:00");
    const issued = await issueFamilyLink(db, desk, admissionId, { consent: CONSENT }, { now: ist("2026-03-10T11:00:00"), secretKey: KEY });
    const token = tokenOf(issued.path);
    const dev = "device-aaaaaaaaaaaaaaaaaaaa";
    await sendFamilyOtp(db, token, dev, sender, { at: ist("2026-03-10T11:01:00"), secretKey: KEY });
    const code = sender.sent[0]!.otp;
    const results = await Promise.all([0, 1, 2].map(() => outcome(verifyFamilyOtp(db, token, dev, code, ist("2026-03-10T11:02:00")))));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(await db.select().from(ipdFamilySessions).where(eq(ipdFamilySessions.linkId, issued.linkId))).toHaveLength(1);
  });

  it("R2/Y4: the desk list shows a sealed patient as 'Sealed patient' (no name, bed or ward) and a confidential one without bed or ward", async () => {
    const sealed = await admitWithAttendant("2026-03-10T10:00:00");
    const s1 = await verified(sealed.admissionId, "2026-03-10T11:00:00");
    await requestFamilyCallback(db, s1.token, s1.cookies, "Please call me", ist("2026-03-10T11:30:00"));
    const conf = await admitWithAttendant("2026-03-10T10:00:00");
    const s2 = await verified(conf.admissionId, "2026-03-10T11:00:00");
    await requestFamilyCallback(db, s2.token, s2.cookies, "Please call me too", ist("2026-03-10T11:31:00"));
    // Sealed and made confidential AFTER the callbacks were asked: the list must follow the patient row as it is now.
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, sealed.patientId));
    await db.update(patients).set({ isConfidential: true, alias: "Rose Alias" }).where(eq(patients.id, conf.patientId));
    const rows = (await listCallbacks(db, desk)).rows;
    const a = rows.find((r) => r.admissionId === sealed.admissionId)!;
    const b = rows.find((r) => r.admissionId === conf.admissionId)!;
    expect(a).toMatchObject({ privacy: "sealed", patientName: null, bedCode: null, wardName: null });
    expect(JSON.stringify(a)).not.toContain("Sunita");
    expect(b).toMatchObject({ privacy: "confidential", patientName: "Rose Alias", bedCode: null, wardName: null });
  });

  it("Y5: closing a callback twice at once closes it once and writes one event", async () => {
    const { admissionId } = await admitWithAttendant("2026-03-10T10:00:00");
    const s = await verified(admissionId, "2026-03-10T11:00:00");
    const cb = await requestFamilyCallback(db, s.token, s.cookies, "Call me", ist("2026-03-10T11:30:00"));
    const [x, y, z] = await Promise.all([1, 2, 3].map((n) => closeFamilyCallback(db, desk, cb.callbackId, `note ${String(n)}`, { now: ist("2026-03-10T12:00:00") })));
    expect([x!.closed, y!.closed, z!.closed].filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(events).where(and(eq(events.name, "ipd.family.callback_closed"), eq(events.correlationId, admissionId)))).toHaveLength(1);
  });

  it("Y6: the phone kept with a link is an HMAC under the server secret, not a bare hash; the send still matches it", async () => {
    const { admissionId } = await admitWithAttendant("2026-03-10T10:00:00");
    const issued = await issueFamilyLink(db, desk, admissionId, { consent: CONSENT }, { now: ist("2026-03-10T11:00:00"), secretKey: KEY });
    const link = (await db.select().from(ipdFamilyLinks).where(eq(ipdFamilyLinks.id, issued.linkId)))[0]!;
    expect(link.phoneHash).not.toBe(createHash("sha256").update(ATTENDANT_PHONE).digest("hex"));
    expect(link.phoneHash).not.toContain(ATTENDANT_PHONE);
    await sendFamilyOtp(db, tokenOf(issued.path), "device-aaaaaaaaaaaaaaaaaaaa", sender, { at: ist("2026-03-10T11:01:00"), secretKey: KEY });
    expect(sender.sent.at(-1)!.to).toBe(ATTENDANT_PHONE);
    // A different server secret does not match the stored phone.
    const other = Buffer.alloc(32, 7);
    expect(await outcome(sendFamilyOtp(db, tokenOf(issued.path), "device-aaaaaaaaaaaaaaaaaaaa", sender, { at: ist("2026-03-10T11:02:00"), secretKey: other })))
      .toBe("family_phone_changed");
  });

  it("Y7: the SMS goes out after the challenge is committed; a failed send is marked and does not use up the hour's sends", async () => {
    const { admissionId } = await admitWithAttendant("2026-03-10T10:00:00");
    const issued = await issueFamilyLink(db, desk, admissionId, { consent: CONSENT }, { now: ist("2026-03-10T11:00:00"), secretKey: KEY });
    const token = tokenOf(issued.path);
    let visibleAtSend = -1;
    const failing: FamilyOtpSender = { name: "failing", send: async () => {
      // Read from another connection: the challenge is visible only if it was committed before the send.
      visibleAtSend = (await db.select().from(ipdFamilyOtps).where(eq(ipdFamilyOtps.linkId, issued.linkId))).length;
      throw new FamilyOtpUnavailable("gateway down");
    } };
    for (const m of ["01", "02", "03", "04"]) {
      expect(await outcome(sendFamilyOtp(db, token, "device-aaaaaaaaaaaaaaaaaaaa", failing, { at: ist(`2026-03-10T11:${m}:00`), secretKey: KEY }))).toBe("family_otp_unavailable");
    }
    expect(visibleAtSend).toBeGreaterThan(0);
    const rows = await db.select().from(ipdFamilyOtps).where(eq(ipdFamilyOtps.linkId, issued.linkId));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.failedAt !== null)).toBe(true);
    // Four failures did not spend the three sends: a working gateway still gets through.
    await sendFamilyOtp(db, token, "device-aaaaaaaaaaaaaaaaaaaa", sender, { at: ist("2026-03-10T11:05:00"), secretKey: KEY });
    expect(sender.sent).toHaveLength(1);
  });

  it("Y8: a patient sealed after the link was issued has the link revoked on that path (patient.updated)", async () => {
    const { admissionId, patientId } = await admitWithAttendant("2026-03-10T10:00:00");
    const s = await verified(admissionId, "2026-03-10T11:00:00");
    const consumer = familyStopConsumer(db);
    const ev = (changes: { field: string; from: string | null; to: string | null }[]) =>
      ({ seq: 1, eventId: key(), name: "patient.updated", payload: { patientId, changes }, patientId, correlationId: null, occurredAt: new Date() }) as never;
    // A different field changing does nothing.
    await consumer(ev([{ field: "phone", from: "9000000000", to: "9000000002" }]));
    expect((await db.select().from(ipdFamilyLinks).where(eq(ipdFamilyLinks.id, s.linkId)))[0]!.status).toBe("active");
    await consumer(ev([{ field: "sensitiveContext", from: "false", to: "true" }]));
    expect((await db.select().from(ipdFamilyLinks).where(eq(ipdFamilyLinks.id, s.linkId)))[0]).toMatchObject({ status: "revoked", revokedReason: "sealed" });
  });
});
