import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  ROSTER_ESCALATION_KINDS, alerts, erChargeLines, erDepartureRecords, erEpisodes, events, ipdAdmissions, ipdChargeLines, patients, resources,
} from "../../../kernel/db/schema";
import { admit, cancelAdmission, planAdmission, requestAdmission, takeDeposit, viewAdmission } from "../../ipd";
import { serviceIdForLabCode } from "../../../../scripts/seed-lab-catalogue";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { mkErMlcWorld } from "../../../../test/helpers/emergency";
import {
  assignErDoctor, decideDisposition, declareStabilised, erChargeSink, handToUnit, placeErOrder, placeInBay, recordAbscond,
  recordErDeathIntent, recordLama, registerArrival, registerErChargeSink, registerErEncounterResolver, registerUnidentified,
  sweepErBoarding, triage,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErMlcWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 5 (#812) — the review of 91b605a7, each finding as a check that failed on that commit.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const PAPER = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Desk Witness" };

describe("ER lane 5 er-dispo — the review's findings", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErMlcWorld;
  const off: (() => void)[] = [];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErMlcWorld(db);
    off.push(registerErEncounterResolver(), registerErChargeSink());
  });
  afterEach(() => { while (off.length > 0) off.pop()!(); });

  let n = 0;
  const inTreatment = async (gate: Date, opts: { unknown?: boolean } = {}) => {
    n += 1;
    const a = opts.unknown === true
      ? await registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "ambulance_108", arrivedAt: gate.toISOString() }, { now: gate })
      : await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: await w.patient("male", 40 + n, `Review Patient ${String(n)}`), arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 2, decision: { lifeSaving: false, highRisk: true, resources: "many", dangerVitals: false } }, { now: gate });
    const bay = await w.bed(`ER-RV${String(n)}`, { class: "emergency" });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: bay }, { now: gate });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: gate });
    return { ...a, bay };
  };
  const hand = (episodeId: string, now: Date, over: Record<string, unknown> = {}) => handToUnit(db, w.erDoctor, {
    idempotencyKey: key(), episodeId, reason: "Needs ward care", consultantId: w.doctor.id, requestedClass: "general", provisionalDiagnosis: "CAP", ...over,
  }, { now });
  const admission = async (id: string) => (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, id)))[0]!;

  it("#1 #2 a boarding patient who leaves another way: one departure record, the bay freed, the open request cancelled", async () => {
    const gate = new Date(Date.now() - 60 * MIN);
    const a = await inTreatment(gate);
    const h = await hand(a.episodeId, gate);
    const done = await recordLama(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, risksExplained: "Explained", signer: { kind: "patient", name: "Patient" } });
    expect(done).toMatchObject({ outcome: "lama", bayReleased: a.bay });
    expect((await db.select().from(erDepartureRecords).where(eq(erDepartureRecords.episodeId, a.episodeId))).map((r) => r.kind)).toEqual(["lama"]);
    expect((await admission(h.admissionId)).state).toBe("cancelled");
    expect((await db.select().from(resources).where(eq(resources.id, a.bay)))[0]!.status).toBe("cleaning");
    // A death while boarding, likewise (with its MCCD number).
    const b = await inTreatment(gate);
    const hb = await hand(b.episodeId, gate);
    await expect(recordErDeathIntent(db, w.erDoctor, { idempotencyKey: key(), episodeId: b.episodeId, diedAt: new Date().toISOString(), mccdNo: "MCCD-9" }))
      .resolves.toMatchObject({ outcome: "died" });
    expect((await admission(hb.admissionId)).state).toBe("cancelled");
  });

  it("#3 IPD cancels the hand-off: the doctor may decide again (audited), or hand off again under a new attempt", async () => {
    const t0 = new Date(Date.now() - 60 * MIN);
    const a = await inTreatment(t0);
    const h = await hand(a.episodeId, t0);
    await cancelAdmission(db, w.admitDesk, { idempotencyKey: key(), admissionId: h.admissionId, reason: "clinical_change" });
    expect(await sweepErBoarding(db, new Date())).toMatchObject({ lapsed: 1 });
    // Hand off again — a second admission request, the first stays cancelled.
    const again = await hand(a.episodeId, new Date());
    expect(again.admissionId).not.toBe(h.admissionId);
    await cancelAdmission(db, w.admitDesk, { idempotencyKey: key(), admissionId: again.admissionId, reason: "clinical_change" });
    await sweepErBoarding(db, new Date());
    // …or decide otherwise, with a reason, and the decision event names the one it replaces.
    await decideDisposition(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, disposition: "discharge", reason: "Improved; ward not needed" });
    expect((await db.select().from(erEpisodes).where(eq(erEpisodes.id, a.episodeId)))[0]).toMatchObject({ disposition: "discharge" });
    const decided = (await db.select().from(events).where(and(eq(events.correlationId, a.episodeId), eq(events.name, "er.disposition_decided"))))
      .map((e) => (e.payload as { previous?: string | null }).previous ?? null);
    expect(decided).toContain("admit");
  });

  it("#4 a request already raised for the episode (its ER transaction lost) is adopted, never duplicated", async () => {
    const gate = new Date(Date.now() - 60 * MIN);
    const a = await inTreatment(gate);
    const raised = await requestAdmission(db, w.erDoctor, {
      idempotencyKey: key(), patientId: a.patientId, source: "er", sourceRef: a.episodeId, consultantId: w.doctor.id, requestedClass: "general",
      isolation: "none", provisionalDiagnosis: "CAP", mlc: false,
    });
    const h = await hand(a.episodeId, gate);
    expect(h.admissionId).toBe(raised.admissionId);
    expect(await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.patientId, a.patientId))).toHaveLength(1);
  });

  it("#5 a doctor without the admission desk's permission cannot name a bed: refused before anything is raised", async () => {
    const gate = new Date(Date.now() - 60 * MIN);
    const a = await inTreatment(gate);
    const bed = await w.bed("W-RV-1");
    await expect(hand(a.episodeId, gate, { bedId: bed })).rejects.toMatchObject({ code: "bed_needs_admission_desk" });
    expect(await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.patientId, a.patientId))).toEqual([]);
  });

  it("#6 #9 #13 boarding past a day, stabilised after the hand-off, a moved order cancelled before the work: the IP bill reverses it", async () => {
    const t0 = new Date(Date.now() - 27 * 60 * MIN);
    const a = await inTreatment(t0);
    await placeErOrder(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, serviceIds: [serviceIdForLabCode("CBC")], indication: "Fever" }, { now: t0, orderKinds: w.decls });
    const h = await hand(a.episodeId, new Date(t0.getTime() + 10 * MIN));
    const stab = new Date(t0.getTime() + 20 * MIN);
    await declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId }, { now: stab });
    expect((await admission(h.admissionId)).stabilisedAt?.toISOString()).toBe(stab.toISOString());
    expect((await viewAdmission(db, w.admitDesk, h.admissionId)).erArrivedAt).toBe(t0.toISOString());
    // A day and more later (#9: no advice expiry while boarding), the desk admits.
    const t2 = new Date();
    const planned = await planAdmission(db, w.admitDesk, { idempotencyKey: key(), admissionId: h.admissionId, payerKind: "cash", requestedClass: "general", plan: { kind: "medical" } }, { now: t2 });
    const { receiptId } = await takeDeposit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId: h.admissionId, amountPaise: planned.depositRequiredPaise, tender: "cash", payer: { name: "Synthetic Payer", relation: "relative" },
    }, { now: t2 });
    await admit(db, w.admitDesk, { idempotencyKey: key(), admissionId: h.admissionId, bedId: await w.bed("W-RV-2"), consent: PAPER, deposit: { receiptId } }, { now: t2 });
    await sweepErBoarding(db, new Date(t2.getTime() + MIN));
    const [line] = await db.select().from(erChargeLines).where(eq(erChargeLines.episodeId, a.episodeId));
    expect(line!.status).toBe("moved");
    // #6: the order is cancelled before the work — IPD's own reversal line answers it.
    const outcome = await db.transaction((tx) => erChargeSink.reverse(tx as never, w.erDoctor, { orderItemId: line!.orderItemId!, workStarted: false, reason: "duplicate", at: new Date() }));
    expect(outcome).toBe("reversed");
    const ipLines = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, h.admissionId));
    expect(ipLines.map((l) => l.source).sort()).toEqual(["ipd.order", "ipd.reversal"]);
  });

  it("#7 #12 #14 the desk records an abscond; security hears the IST time; an MLC's police duty goes on its own ladder", async () => {
    expect(ROSTER_ESCALATION_KINDS).toContain("er_abscond_mlc");
    const src = readFileSync(join(__dirname, "..", "dispo.ts"), "utf8");
    expect(src).toMatch(/escalationRecipients\(tx, "er_abscond_mlc"/);
    await ensureRole(db, "security_guard");
    await mkUser(db, "er.rv.guard", ["security_guard"]);
    const gate = new Date(Date.now() - 60 * MIN);
    const u = await inTreatment(gate, { unknown: true });
    const seen = new Date(gate.getTime() + 30 * MIN);
    const r = await recordAbscond(db, w.erDesk, { idempotencyKey: key(), episodeId: u.episodeId, lastSeenAt: seen.toISOString(), searched: true });
    expect(r).toMatchObject({ outcome: "absconded", policeToBeInformed: true });
    const ist = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(seen);
    const told = await db.select().from(alerts).where(eq(alerts.kind, "er.absconded_mlc"));
    expect(told.length).toBeGreaterThan(0);
    const sec = await db.select().from(alerts).where(eq(alerts.kind, "er.absconded"));
    expect(sec.map((x) => x.body)).toEqual([`Last seen ${ist} IST`]);
  });

  it("#8 an ER death on an unknown merged into the true record marks the TRUE record deceased", async () => {
    const gate = new Date(Date.now() - 60 * MIN);
    const u = await inTreatment(gate, { unknown: true });
    const truth = await w.patient("male", 44, "True Record");
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: truth }).where(eq(patients.id, u.patientId));
    await recordErDeathIntent(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, diedAt: new Date().toISOString(), mccdNo: "MCCD-77" });
    expect((await db.select().from(patients).where(eq(patients.id, truth)))[0]).toMatchObject({ deathCertificateNo: "MCCD-77" });
    expect((await db.select().from(patients).where(eq(patients.id, truth)))[0]!.deceasedAt).not.toBeNull();
  });

  it("#10 a refer-out decision 'because the patient cannot pay' is refused", async () => {
    const a = await inTreatment(new Date(Date.now() - 60 * MIN));
    await expect(decideDisposition(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, disposition: "refer_out", reason: "Family cannot pay here" }))
      .rejects.toMatchObject({ code: "referral_not_for_money" });
  });
});
