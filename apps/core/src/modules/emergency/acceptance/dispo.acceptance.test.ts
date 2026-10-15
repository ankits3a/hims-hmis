import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { istDayString } from "../../../kernel/approvals/cumulative";
import {
  erChargeLines, erEpisodes, ipdAdmissions, ipdChargeLines, ipdMortuaryRegister, orders, patients, resources,
} from "../../../kernel/db/schema";
import { admit, planAdmission, takeDeposit } from "../../ipd";
import { serviceIdForLabCode } from "../../../../scripts/seed-lab-catalogue";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErMlcWorld } from "../../../../test/helpers/emergency";
import {
  assignErDoctor, declareStabilised, handToUnit, openMlc, placeErOrder, placeInBay, readErBoard, recordErDeathIntent, recordPoliceIntimation,
  referOut, registerArrival, registerErChargeSink, registerErEncounterResolver, sweepErBoarding, triage,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErMlcWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 5 (#812, decision 0076) — "DONE MEANS" FOR er-dispo (spec SPEC-emergency-2026-10-15 §7). Every check calls
 * the INTENT functions; every clock instant is passed in.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const PAPER = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Desk Witness" };

describe("ER lane 5 er-dispo — done means", () => {
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

  /** A named walk-in, triaged, in a bay, seen by the ER doctor: `in_treatment`. */
  const inTreatment = async (gate: Date, name = "Ramesh Prasad") => {
    const p = await w.patient("male", 52, name);
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
    const t1 = new Date(gate.getTime() + 2 * MIN);
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 2, decision: { lifeSaving: false, highRisk: true, resources: "many", dangerVitals: false } }, { now: t1 });
    const bay = await w.bed(`ER-B${name.length}${String(gate.getTime() % 1000)}`, { class: "emergency" });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: bay }, { now: t1 });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: t1 });
    return { ...a, bay };
  };

  it("(a) hand_to_unit raises the IPD admission with the gate time and 'stabilised' copied; the patient boards until the bed is placed", async () => {
    const gate = new Date(Date.now() - 3 * 60 * MIN);
    const e = await inTreatment(gate);
    await placeErOrder(db, w.erDoctor, { idempotencyKey: key(), episodeId: e.episodeId, serviceIds: [serviceIdForLabCode("CBC")], indication: "Chest pain" }, { now: new Date(gate.getTime() + 5 * MIN), orderKinds: w.decls });
    const stabilisedAt = new Date(gate.getTime() + 40 * MIN);
    await declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: e.episodeId }, { now: stabilisedAt });
    const t = new Date(gate.getTime() + 60 * MIN);
    const h = await handToUnit(db, w.erDoctor, {
      idempotencyKey: key(), episodeId: e.episodeId, reason: "Inferior STEMI for the cath lab", consultantId: w.doctor.id, requestedClass: "general",
      provisionalDiagnosis: "Inferior wall STEMI",
    }, { now: t });
    expect(h).toMatchObject({ boarding: true, state: "disposition_decided", admissionNo: null });
    const [adm] = await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, h.admissionId));
    expect(adm).toMatchObject({ source: "er", sourceRef: e.episodeId, state: "requested" });
    expect(adm!.erArrivedAt?.toISOString()).toBe(gate.toISOString());
    expect(adm!.stabilisedAt?.toISOString()).toBe(stabilisedAt.toISOString());
    // Boarding: still on the ER board, in its bay, with the word on the tile.
    const board = await readErBoard(db, w.erDesk, { now: t });
    expect(board.stats.boarding).toBe(1);
    expect(board.inTreatment.find((x) => x.episodeId === e.episodeId)?.chips).toContain("boarding");
    expect(await sweepErBoarding(db, new Date(t.getTime() + MIN))).toEqual({ departed: 0, lapsed: 0 });

    // The admission desk finds the bed: IPD admits, and the next tick takes the patient out of the ER.
    const t2 = new Date(t.getTime() + 90 * MIN);
    // Stabilised in the ER, so the ordinary deposit applies (paid at the desk — never asked of the ER).
    const planned = await planAdmission(db, w.admitDesk, { idempotencyKey: key(), admissionId: h.admissionId, payerKind: "cash", requestedClass: "general", plan: { kind: "medical" } }, { now: t2 });
    const { receiptId } = await takeDeposit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId: h.admissionId, amountPaise: planned.depositRequiredPaise, tender: "cash", payer: { name: "Synthetic Payer", relation: "relative" },
    }, { now: t2 });
    const ward = await w.bed("W-ER-1");
    await admit(db, w.admitDesk, { idempotencyKey: key(), admissionId: h.admissionId, bedId: ward, consent: PAPER, deposit: { receiptId } }, { now: t2 });
    expect(await sweepErBoarding(db, new Date(t2.getTime() + MIN))).toEqual({ departed: 1, lapsed: 0 });
    expect(await sweepErBoarding(db, new Date(t2.getTime() + 2 * MIN))).toEqual({ departed: 0, lapsed: 0 });
    const [ep] = await db.select().from(erEpisodes).where(eq(erEpisodes.id, e.episodeId));
    expect(ep).toMatchObject({ state: "departed", outcome: "admitted", admissionId: h.admissionId, boardingSince: null });
    expect((await db.select().from(resources).where(eq(resources.id, e.bay)))[0]!.status).toBe("cleaning");
    // The ER lab line is on the IP running bill, dated the ER day, once; the ER line says where it went.
    const [o] = await db.select().from(orders).where(eq(orders.encounterNo, e.episodeNo));
    const ipLines = await db.select().from(ipdChargeLines).where(and(eq(ipdChargeLines.admissionId, h.admissionId), eq(ipdChargeLines.source, "ipd.order")));
    expect(ipLines.map((l) => [l.orderId, l.serviceDate])).toEqual([[o!.id, istDayString(new Date(gate.getTime() + 5 * MIN))]]);
    const erLines = await db.select().from(erChargeLines).where(eq(erChargeLines.episodeId, e.episodeId));
    expect(erLines.map((l) => [l.status, l.movedToAdmissionId, l.movedIpdLineId])).toEqual([["moved", h.admissionId, ipLines[0]!.id]]);
  });

  it("(b) a referral with the reason 'cannot pay' is refused; a clinical referral leaves with its note and frees the bay", async () => {
    const gate = new Date(Date.now() - 60 * MIN);
    const e = await inTreatment(gate);
    const ref = (reason: string) => referOut(db, w.erDoctor, {
      idempotencyKey: key(), episodeId: e.episodeId, reason, facility: "AIIMS Patna", note: "Polytrauma, needs neurosurgery", escort: "doctor", transport: "own_ambulance",
    });
    await expect(ref("cannot_pay")).rejects.toMatchObject({ code: "referral_not_for_money" });
    expect((await db.select().from(erEpisodes).where(eq(erEpisodes.id, e.episodeId)))[0]!.state).toBe("in_treatment");
    await expect(ref("specialty_not_available")).resolves.toMatchObject({ state: "departed", outcome: "referred_out", bayReleased: e.bay });
    expect((await db.select().from(resources).where(eq(resources.id, e.bay)))[0]!.status).toBe("cleaning");
  });

  it("(c) death in the ER refuses without an MCCD number unless the case is an MLC already intimated to the police", async () => {
    const gate = new Date(Date.now() - 2 * 60 * MIN);
    const died = new Date(gate.getTime() + 60 * MIN).toISOString();
    // A plain case: the MCCD number or nothing.
    const a = await inTreatment(gate, "Shanti Devi");
    await expect(recordErDeathIntent(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, diedAt: died })).rejects.toMatchObject({ code: "mccd_required" });
    const ok = await recordErDeathIntent(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, diedAt: died, mccdNo: "MCCD-2026-0091" });
    expect(ok).toMatchObject({ outcome: "died", mlc: false, bayReleased: a.bay });
    expect((await db.select().from(patients).where(eq(patients.id, a.patientId)))[0]).toMatchObject({ deathCertificateNo: "MCCD-2026-0091", deathKind: null });
    expect((await db.select().from(ipdMortuaryRegister).where(eq(ipdMortuaryRegister.erEpisodeId, a.episodeId)))[0]).toMatchObject({ mlc: false, status: "expected" });

    // An MLC: refused until the police are intimated, then recorded without a number (the post-mortem decides).
    const b = await inTreatment(gate, "Mohan Lal");
    const m = await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: b.episodeId, category: "poisoning" }, { now: new Date(gate.getTime() + 10 * MIN) });
    await expect(recordErDeathIntent(db, w.erDoctor, { idempotencyKey: key(), episodeId: b.episodeId, diedAt: died })).rejects.toMatchObject({ code: "mccd_required" });
    await recordPoliceIntimation(db, w.erDesk, { idempotencyKey: key(), mlcId: m.mlcId, mode: "written", station: "PS Kotwali", receiverName: "HC Ram Singh" });
    const mlcDeath = await recordErDeathIntent(db, w.erDoctor, { idempotencyKey: key(), episodeId: b.episodeId, diedAt: died });
    expect(mlcDeath).toMatchObject({ outcome: "died", mlc: true });
    expect((await db.select().from(patients).where(eq(patients.id, b.patientId)))[0]).toMatchObject({ deathCertificateNo: null, deathKind: "medico_legal" });
    expect((await db.select().from(ipdMortuaryRegister).where(eq(ipdMortuaryRegister.id, mlcDeath.mortuaryEntryId)))[0]).toMatchObject({ mlc: true });
  });
});
