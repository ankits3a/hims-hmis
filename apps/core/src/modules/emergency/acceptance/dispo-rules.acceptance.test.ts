import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { alerts, erDepartureRecords, erEpisodes, resources } from "../../../kernel/db/schema";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErMlcWorld } from "../../../../test/helpers/emergency";
import {
  assignErDoctor, decideDisposition, dischargeFromEr, handToUnit, issueErMed, openMlc, placeInBay, recordAbscond, recordLama, recordLwbs,
  registerArrival, registerUnidentified, sweepErCareClocks, triage,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErMlcWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 5 (#812) — THE DISPOSITION RULES beyond "done means" (spec §4.5): one disposition, decided by a doctor with a
 * reason; the discharge summary; LAMA's signature or witnessed refusal; LWBS before the doctor; abscond tells security
 * (and, for an MLC, the duty manager for the police); every exit frees the bay; a departed episode leaves the clocks.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const SUMMARY = {
  diagnosis: "Acute gastroenteritis with mild dehydration", treatmentGiven: "IV fluids 1 L, ondansetron 4 mg IV",
  medicines: [{ name: "ORS", dose: "1 sachet in 1 L water", frequency: "after each loose stool", days: 3 }],
  returnIf: ["repeated_vomiting", "less_urine", "drowsiness"], followUp: { department: "MED", onDate: "2026-10-20" },
};

describe("ER lane 5 er-dispo — the rules", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErMlcWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErMlcWorld(db);
  });

  let n = 0;
  const arrive = async (gate: Date) => {
    n += 1;
    const p = await w.patient("female", 30 + n, `Patient ${String(n)}`);
    return registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
  };
  const toBay = async (episodeId: string, at: Date) => {
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId, level: 3, decision: { lifeSaving: false, highRisk: false, resources: "many", dangerVitals: false } }, { now: at });
    const bay = await w.bed(`ER-R${String(n)}`, { class: "emergency" });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId, bedId: bay }, { now: at });
    return bay;
  };
  const toDoctor = async (episodeId: string, at: Date) => {
    const bay = await toBay(episodeId, at);
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId, doctorId: w.erDoctor.id }, { now: at });
    return bay;
  };
  const bayStatus = async (bay: string) => (await db.select().from(resources).where(eq(resources.id, bay)))[0]!.status;

  it("one disposition per episode, by a doctor with a reason; an exit act that does not match it is refused", async () => {
    const gate = new Date(Date.now() - 60 * MIN);
    const a = await arrive(gate);
    const bay = await toDoctor(a.episodeId, gate);
    await expect(decideDisposition(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, disposition: "discharge", reason: "Better" }))
      .rejects.toMatchObject({ code: "not_a_doctor" });
    await expect(dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, summary: SUMMARY }))
      .rejects.toMatchObject({ code: "disposition_reason_needed" });
    await decideDisposition(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, disposition: "discharge", reason: "Tolerating orally, vitals normal" });
    await expect(decideDisposition(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, disposition: "admit", reason: "x" }))
      .rejects.toMatchObject({ code: "disposition_already_decided" });
    await expect(handToUnit(db, w.erDoctor, {
      idempotencyKey: key(), episodeId: a.episodeId, consultantId: w.doctor.id, requestedClass: "general", provisionalDiagnosis: "AGE",
    })).rejects.toMatchObject({ code: "disposition_mismatch" });
    // The discharge: the summary is the departure's paper; the bay goes to cleaning.
    const d = await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, summary: SUMMARY });
    expect(d).toMatchObject({ outcome: "discharged", bayReleased: bay });
    expect(await bayStatus(bay)).toBe("cleaning");
    const [rec] = await db.select().from(erDepartureRecords).where(eq(erDepartureRecords.episodeId, a.episodeId));
    expect(rec).toMatchObject({ kind: "discharge_summary", signedBy: w.erDoctor.id, document: { returnIf: SUMMARY.returnIf } });
    await expect(db.execute(sql`delete from er_departure_records where id = ${rec!.id}`)).rejects.toThrow(/er_departure_append_only/);
  });

  it("LAMA: the risks and a signature, or a refusal witnessed by a second staff member; a duty manager may record it", async () => {
    const gate = new Date(Date.now() - 60 * MIN);
    const a = await arrive(gate);
    const bay = await toDoctor(a.episodeId, gate);
    const lama = (actor: typeof w.erDoctor, signer: Record<string, unknown>) => recordLama(db, actor, {
      idempotencyKey: key(), episodeId: a.episodeId, risksExplained: "Risk of perforation and death explained in Hindi", signer, goingTo: "Private hospital, Patna",
    });
    await expect(lama(w.erDoctor, { kind: "refused_to_sign", witnessId: w.erDoctor.id })).rejects.toMatchObject({ code: "lama_witness_needed" });
    await expect(lama(w.erNurse, { kind: "patient", name: "Patient" })).rejects.toMatchObject({ code: "not_a_doctor" });
    await expect(lama(w.mortuary, { kind: "refused_to_sign", witnessId: w.erNurse.id })).resolves.toMatchObject({ outcome: "lama", bayReleased: bay });
    expect(await bayStatus(bay)).toBe("cleaning");
  });

  it("LWBS before the doctor, from the last-seen time; not once the doctor has the patient", async () => {
    const gate = new Date(Date.now() - 90 * MIN);
    const a = await arrive(gate);
    await expect(recordLwbs(db, w.erDesk, { idempotencyKey: key(), episodeId: a.episodeId, lastSeenAt: new Date(gate.getTime() - MIN).toISOString() }))
      .rejects.toMatchObject({ code: "last_seen_before_arrival" });
    const seen = new Date(gate.getTime() + 40 * MIN);
    await expect(recordLwbs(db, w.erDesk, { idempotencyKey: key(), episodeId: a.episodeId, lastSeenAt: seen.toISOString() }))
      .resolves.toMatchObject({ outcome: "lwbs", departedAt: seen.toISOString(), bayReleased: null });
    const b = await arrive(gate);
    await toDoctor(b.episodeId, gate);
    await expect(recordLwbs(db, w.erDesk, { idempotencyKey: key(), episodeId: b.episodeId, lastSeenAt: seen.toISOString() }))
      .rejects.toMatchObject({ code: "episode_wrong_state" });
  });

  it("abscond: security is told; an MLC patient's absconding goes to the duty manager for the police; the bay is freed", async () => {
    await ensureRole(db, "security_guard");
    const guard = (await mkUser(db, "er.guard", ["security_guard"])).actor;
    const gate = new Date(Date.now() - 60 * MIN);
    const u = await registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "ambulance_108", arrivedAt: gate.toISOString() }, { now: gate });
    const bay = await toBay(u.episodeId, gate);
    const r = await recordAbscond(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, lastSeenAt: new Date(gate.getTime() + 30 * MIN).toISOString(), searched: true });
    expect(r).toMatchObject({ outcome: "absconded", securityAlerted: 1, policeToBeInformed: true, bayReleased: bay });
    expect(await db.select().from(alerts).where(and(eq(alerts.userId, guard.id), eq(alerts.kind, "er.absconded")))).toHaveLength(1);
    expect(await db.select().from(alerts).where(and(eq(alerts.userId, w.mortuary.id), eq(alerts.kind, "er.absconded_mlc")))).toHaveLength(1);
    expect(await bayStatus(bay)).toBe("cleaning");
  });

  it("a departed episode leaves the care clocks: an unsigned verbal order no longer rings once the patient has gone", async () => {
    const gate = new Date(Date.now() - 4 * 60 * MIN);
    const a = await arrive(gate);
    await toDoctor(a.episodeId, gate);
    await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "assault" }, { now: gate });
    await issueErMed(db, w.erNurse, {
      idempotencyKey: key(), episodeId: a.episodeId, ownMedicine: "Family's paracetamol", doseWords: "1 g", route: "oral", units: 1, orderedBy: w.erDoctor.id, verbal: { readBack: true },
    }, { now: new Date(gate.getTime() + MIN) });
    await recordLama(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, risksExplained: "Explained", signer: { kind: "patient", name: "Patient" } }, { now: new Date(gate.getTime() + 10 * MIN) });
    expect(await sweepErCareClocks(db, new Date())).toMatchObject({ verbal: 0 });
    expect((await db.select().from(erEpisodes).where(eq(erEpisodes.id, a.episodeId)))[0]).toMatchObject({ state: "departed", outcome: "lama" });
  });
});
