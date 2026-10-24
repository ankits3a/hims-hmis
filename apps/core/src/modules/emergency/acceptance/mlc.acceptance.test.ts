import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { alerts, erChargeLines, erMlcs, ipdMortuaryRegister, patients, tasks } from "../../../kernel/db/schema";
import { recordPoliceClearance, receiveBody, releaseBody } from "../../ipd";
import { seedOrgDepartments } from "../../roster";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErMlcWorld } from "../../../../test/helpers/emergency";
import {
  addMlcAddendum, assignErDoctor, callSpecialty, countersignMlc, declareStabilised, giveErDose, issueErMed, openMlc, placeErOrder,
  placeInBay, readMlc, readMlcDesk, recordBroughtDead, recordConsent, recordErNote, recordErVitals, recordPoliceIntimation, recordProcedure,
  registerArrival, registerErChargeSink, registerErEncounterResolver, sweepErMlcClocks, triage,
} from "../index";
import { serviceIdForLabCode } from "../../../../scripts/seed-lab-catalogue";
import type { Db } from "../../../kernel/db/client";
import type { ErMlcWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 4 (#811, decision 0076) — "DONE MEANS" FOR er-mlc (spec SPEC-emergency-2026-10-15 §7), plus lane 3's (c)
 * re-run with an MLC patient (its `it.todo` "(c-2)"). Every check calls the INTENT functions; every clock instant is
 * passed in.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 4 er-mlc — done means", () => {
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

  /** A named patient walked in, and the ER doctor opens an assault MLC on them. */
  const assault = async (now: Date) => {
    const p = await w.patient("male", 34, "Suresh Yadav");
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in" }, { now });
    const m = await openMlc(db, w.erDoctor, {
      idempotencyKey: key(), episodeId: a.episodeId, category: "assault",
      informant: { name: "Brother", relation: "brother", words: "He was hit with a stick near the market." },
      injuries: [{ site: "left forearm", kind: "contusion", sizeCm: "4 x 3" }],
    }, { now });
    return { ...a, ...m };
  };

  it("(a) a brought-dead arrival opens an MLC, posts no charge, and the body cannot be released without police clearance", async () => {
    const now = new Date();
    const gate = new Date(now.getTime() - 15 * MIN);
    const bd = await recordBroughtDead(db, w.erDesk, {
      idempotencyKey: key(), unidentified: { sex: "female", ageBand: "adult" }, arrivalMode: "ambulance_108", arrivedAt: gate.toISOString(),
      examinedBy: w.erDoctor.id, examinedAt: new Date(gate.getTime() + 4 * MIN).toISOString(), ecgStripRecorded: true,
    }, { now });
    // Always an MLC, opened by rule.
    const mlc = await readMlc(db, w.erDesk, bd.mlcId, { now });
    expect(mlc).toMatchObject({ mlcNo: bd.mlcNo, category: "brought_dead", openedByRule: true, episodeState: "brought_dead", mortuaryEntryId: bd.mortuaryEntryId });
    expect(bd.mlcNo).toMatch(/^MLC\d{2}-\d{6}$/);
    // The patient is deceased by the `brought_dead` kind — with no MCCD number (the hospital issues none).
    const [p] = await db.select().from(patients).where(eq(patients.id, bd.patientId));
    expect(p).toMatchObject({ deathKind: "brought_dead", deathCertificateNo: null });
    expect(p!.deceasedAt).not.toBeNull();
    // No charge: nothing on the ER charge sink, and the terminal episode takes no order.
    await expect(placeErOrder(db, w.erDoctor, {
      idempotencyKey: key(), episodeId: bd.episodeId, serviceIds: [serviceIdForLabCode("CBC")], indication: "x",
    }, { now, orderKinds: w.decls })).rejects.toMatchObject({ code: "episode_wrong_state" });
    expect(await db.select().from(erChargeLines).where(eq(erChargeLines.episodeId, bd.episodeId))).toEqual([]);

    // The body: in the IPD mortuary register under the ER episode, an MLC.
    const [entry] = await db.select().from(ipdMortuaryRegister).where(eq(ipdMortuaryRegister.erEpisodeId, bd.episodeId));
    expect(entry).toMatchObject({ id: bd.mortuaryEntryId, admissionId: null, status: "expected", mlc: true, policeClearance: false });
    const received = await receiveBody(db, w.mortuary, { idempotencyKey: key(), entryId: entry!.id, identityCheckedBy: w.witness.id }, { now });
    expect(received).toMatchObject({ status: "received", erEpisodeId: bd.episodeId, erEpisodeNo: bd.episodeNo, admissionId: null });
    const kin = { name: "Kamla Devi", relation: "mother", idProofRef: "XXXX-5678" };
    await expect(releaseBody(db, w.mortuary, { idempotencyKey: key(), entryId: entry!.id, releasedTo: kin }, { now }))
      .rejects.toMatchObject({ code: "police_clearance_required" });
    await recordPoliceClearance(db, w.mortuary, { idempotencyKey: key(), entryId: entry!.id, ref: "PS Kotwali inquest 41/26" }, { now });
    expect(await releaseBody(db, w.mortuary, { idempotencyKey: key(), entryId: entry!.id, releasedTo: kin }, { now }))
      .toMatchObject({ status: "released" });
  });

  it("(b) an MLC without police intimation after 1 h becomes a task; without countersign after 24 h, an obligation", async () => {
    const t0 = new Date();
    const m = await assault(t0);
    expect(new Date(m.intimationDueAt).getTime() - t0.getTime()).toBe(60 * MIN);
    expect(new Date(m.countersignDueAt).getTime() - t0.getTime()).toBe(24 * 60 * MIN);
    const intimationTasks = () => db.select().from(tasks).where(eq(tasks.kind, "er_mlc_intimation"));

    // The police intimation: a task at the 1-hour target, once; 30 minutes on, one climb to the duty manager.
    expect(await sweepErMlcClocks(db, new Date(t0.getTime() + 59 * MIN))).toEqual({ tasks: 0, climbs: 0, breaches: 0 });
    expect(await sweepErMlcClocks(db, new Date(t0.getTime() + 60 * MIN))).toEqual({ tasks: 1, climbs: 0, breaches: 0 });
    expect(await sweepErMlcClocks(db, new Date(t0.getTime() + 61 * MIN))).toEqual({ tasks: 0, climbs: 0, breaches: 0 });
    const [task] = await intimationTasks();
    expect(task).toMatchObject({ priority: "stat", patientId: m.patientId });
    expect(task!.note).toContain(m.mlcNo);
    expect(await sweepErMlcClocks(db, new Date(t0.getTime() + 90 * MIN))).toEqual({ tasks: 0, climbs: 1, breaches: 0 });
    const toldDm = await db.select().from(alerts).where(and(eq(alerts.userId, w.mortuary.id), eq(alerts.kind, "er.mlc_intimation_overdue")));
    expect(toldDm).toHaveLength(1);
    expect(toldDm[0]!.title).toContain(m.mlcNo);
    expect(toldDm[0]!.body).not.toContain("Suresh");
    // Written to the police: the obligation is met (late), the task closed.
    const t1 = new Date(t0.getTime() + 95 * MIN);
    const r = await recordPoliceIntimation(db, w.erDesk, {
      idempotencyKey: key(), mlcId: m.mlcId, mode: "written", station: "PS Kotwali", receiverName: "HC Ram Singh", receiverRank: "HC", gdEntryNo: "GD 17",
    }, { now: t1 });
    expect(r.withinTarget).toBe(false);
    expect((await intimationTasks())[0]!.state).toBe("cancelled");

    // The faculty countersign: nothing before 24 h; past it, the obligation is BREACHED and told once — and still owed.
    expect(await sweepErMlcClocks(db, new Date(t0.getTime() + (24 * 60 - 1) * MIN))).toEqual({ tasks: 0, climbs: 0, breaches: 0 });
    const t2 = new Date(t0.getTime() + (24 * 60 + 1) * MIN);
    expect(await sweepErMlcClocks(db, t2)).toEqual({ tasks: 0, climbs: 0, breaches: 1 });
    expect(await sweepErMlcClocks(db, new Date(t2.getTime() + MIN))).toEqual({ tasks: 0, climbs: 0, breaches: 0 });
    expect(await db.select().from(alerts).where(and(eq(alerts.userId, w.ms.id), eq(alerts.kind, "er.mlc_countersign_overdue")))).toHaveLength(1);
    const desk = await readMlcDesk(db, w.erDesk, { now: t2 });
    expect(desk.owed.map((x) => [x.mlcNo, x.intimation.breached, x.countersign.metAt, x.countersign.breached])).toEqual([[m.mlcNo, true, null, true]]);
    // A senior doctor countersigns: owed no more.
    await countersignMlc(db, w.doctor, { idempotencyKey: key(), mlcId: m.mlcId }, { now: t2 });
    expect((await readMlcDesk(db, w.erDesk, { now: t2 })).owed).toEqual([]);
  });

  it("(c) an MLC record cannot be deleted; an edit is an addendum", async () => {
    const now = new Date();
    const m = await assault(now);
    await expect(db.execute(sql`delete from er_mlcs where id = ${m.mlcId}`)).rejects.toThrow(/er_mlc_append_only/);
    await expect(db.execute(sql`update er_mlcs set category = 'other' where id = ${m.mlcId}`)).rejects.toThrow(/er_mlc_append_only/);
    await expect(db.update(erMlcs).set({ injuries: [] }).where(eq(erMlcs.id, m.mlcId))).rejects.toThrow(/er_mlc_append_only/);
    // The correction: an addendum names the new category; the original stays on the record beside it.
    const later = new Date(now.getTime() + 30 * MIN);
    await addMlcAddendum(db, w.erDoctor, {
      idempotencyKey: key(), mlcId: m.mlcId, category: "road_accident", text: "Re-examined: tyre-mark abrasions; history revised by the patient.",
      injuries: [{ site: "right thigh", kind: "abrasion" }],
    }, { now: later });
    const read = await readMlc(db, w.erDesk, m.mlcId, { now: later });
    expect(read).toMatchObject({ category: "road_accident", originalCategory: "assault", injuries: [{ site: "left forearm" }] });
    expect(read.addenda.map((a) => [a.category, a.by.userId])).toEqual([["road_accident", w.erDoctor.id]]);
    const [row] = await db.select().from(erMlcs).where(eq(erMlcs.id, m.mlcId));
    expect(row).toMatchObject({ category: "assault" });
  });

  it("(c-2) lane 3's (c) again with an MLC patient: no clinical intent refuses on MLC state — intimation overdue, countersign breached", async () => {
    await seedOrgDepartments(db);
    const bay = await w.bed("ER-R8", { class: "emergency" });
    const t0 = new Date(Date.now() - 25 * 60 * MIN);
    const m = await assault(t0);
    await sweepErMlcClocks(db, new Date());
    const owed = (await readMlcDesk(db, w.erDesk)).owed[0]!;
    expect([owed.intimation.breached, owed.countersign.breached]).toEqual([true, true]);
    const e = m.episodeId;
    const acts: [string, () => Promise<unknown>][] = [
      ["triage", () => triage(db, w.erNurse, { idempotencyKey: key(), episodeId: e, level: 2, decision: { lifeSaving: false, highRisk: true, resources: "many", dangerVitals: false } })],
      ["record_er_vitals", () => recordErVitals(db, w.erNurse, { idempotencyKey: key(), episodeId: e, vitals: { pulse: 120, spo2: 93 } })],
      ["place_in_bay", () => placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: e, bedId: bay })],
      ["assign_er_doctor", () => assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: e, doctorId: w.erDoctor.id })],
      ["record_er_note", () => recordErNote(db, w.erDoctor, { idempotencyKey: key(), episodeId: e, kind: "assessment", text: "Assault, forearm contusion" })],
      ["place_er_order", () => placeErOrder(db, w.erDoctor, { idempotencyKey: key(), episodeId: e, serviceIds: [serviceIdForLabCode("CBC")], indication: "Assault" }, { orderKinds: w.decls })],
      ["issue_er_med", () => issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: e, ownMedicine: "Family's inhaler", doseWords: "2 puffs", route: "inhaled", units: 1, orderedBy: w.erDoctor.id })],
      ["record_consent", () => recordConsent(db, w.erDoctor, { idempotencyKey: key(), episodeId: e, kind: "procedure", about: "Suturing", signedBy: "emergency", method: "paper", secondDoctorId: w.doctor.id })],
      ["record_procedure", () => recordProcedure(db, w.erDoctor, { idempotencyKey: key(), episodeId: e, name: "Suturing", performedBy: w.erDoctor.id })],
      ["call_specialty", () => callSpecialty(db, w.erDoctor, { idempotencyKey: key(), episodeId: e, departmentCode: "SUR", urgency: "urgent", reason: "Forearm wound" })],
      ["declare_stabilised", () => declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: e })],
    ];
    for (const [name, act] of acts) {
      await expect([name, await act().then(() => "ok", (err: unknown) => (err as { code?: string }).code ?? String(err))]).toEqual([name, "ok"]);
    }
    const issued = await issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: e, ownMedicine: "Family's paracetamol", doseWords: "1 g", route: "oral", units: 1, orderedBy: w.erDoctor.id });
    await expect(giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: issued.issueId, outcome: "given" })).resolves.toMatchObject({ outcome: "given" });
  });
});
