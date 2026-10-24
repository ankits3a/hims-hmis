import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { erEpisodes, erPreAlerts, events } from "../../../kernel/db/schema";
import { emergencyAdmit } from "../../ipd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErWorld } from "../../../../test/helpers/emergency";
import {
  cancelPreAlert, lapseErPreAlerts, preAlert, printErBand, readErBoard, readErDesk, recordBroughtDead, registerArrival,
  registerUnidentified,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 1 (#808) — the lane section's rules (spec SPEC-emergency §4.1 rules and edge cases, §5 A), each through the
 * intents: one open episode per patient, the admitted inpatient, the 24-hour return, the pre-alert and its lapse, the
 * retried request, brought dead, the wall board without names, the name alert, and who may act.
 */

jest.setTimeout(120_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 1 er-arrival — the arrival rules", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  const arrive = (patientId: string, over: Record<string, unknown> = {}, now?: Date) => registerArrival(db, w.erDesk, {
    idempotencyKey: key(), patientId, arrivalMode: "walk_in", ...over,
  }, now === undefined ? {} : { now });

  it("one open episode per patient: the second is refused and shows the first", async () => {
    const p = await w.patient("male", 50, "Mohan Lal");
    const first = await arrive(p);
    await expect(arrive(p)).rejects.toMatchObject({
      code: "episode_already_open", detail: { episodeId: first.episodeId, episodeNo: first.episodeNo, state: "arrived" },
    });
    expect(await db.select().from(erEpisodes).where(eq(erEpisodes.patientId, p))).toHaveLength(1);
  });

  it("a patient lying on a ward bed is refused with the ward and bed — the ward team's patient", async () => {
    const p = await w.patient("female", 60, "Kamla Devi");
    const bed = await w.bed("T-ER-W1", { class: "emergency" });
    const adm = await emergencyAdmit(db, w.admitDesk, { idempotencyKey: key(), patientId: p, bedId: bed, consultantId: w.doctor.id, isolation: "none", mlc: false });
    await expect(arrive(p)).rejects.toMatchObject({
      code: "patient_admitted", fix: "Call the ward team", detail: { admissionId: adm.admissionId, bedCode: "T-ER-W1" },
    });
  });

  it("a second arrival within 24 hours is a NEW episode flagged 'returned within 24 h'", async () => {
    const p = await w.patient("male", 30, "Sanjay Yadav");
    const now = new Date();
    const first = await arrive(p, { arrivedAt: new Date(now.getTime() - 10 * 60 * MIN).toISOString() }, new Date(now.getTime() - 10 * 60 * MIN));
    expect(first.returnedWithin24h).toBe(false);
    // The first visit ended (the disposition lane's act, written directly until it lands).
    await db.update(erEpisodes).set({ state: "departed", outcome: "discharged" }).where(eq(erEpisodes.id, first.episodeId));
    const again = await arrive(p, {}, now);
    expect(again.episodeId).not.toBe(first.episodeId);
    expect(again.returnedWithin24h).toBe(true);
    expect(again.band.band.alertWords).toContain("Returned within 24 h");
    const board = await readErBoard(db, w.erDesk, { now });
    expect(board.waiting.find((t) => t.episodeId === again.episodeId)!.chips).toContain("returned_24h");
  });

  it("a pre-alert puts an Expected card on the board; its arrivals claim it; it lapses two hours after its expected time", async () => {
    const now = new Date();
    const call = await preAlert(db, w.erDesk, {
      idempotencyKey: key(), mode: "ambulance_108", etaMinutes: 10, count: 2, sex: "male", complaint: "Road accident, bleeding",
    }, { now });
    let board = await readErBoard(db, w.erDoctor, { now });
    expect(board.expected).toEqual([expect.objectContaining({ preAlertId: call.preAlertId, count: 2, arrivedCount: 0, complaint: "Road accident, bleeding" })]);
    expect((await readErBoard(db, w.erDoctor, { now, wall: true })).expected[0]!.complaint).toBeNull();
    // The first of the two arrives unknown: the card stays for the second.
    await registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "male", ageBand: "young_adult", arrivalMode: "ambulance_108", preAlertId: call.preAlertId }, { now });
    board = await readErBoard(db, w.erDoctor, { now });
    expect(board.expected[0]).toMatchObject({ arrivedCount: 1 });
    // Nobody else comes: the lapse closes it at expected time + 2 h, not before.
    expect(await lapseErPreAlerts(db, new Date(now.getTime() + 129 * MIN))).toBe(0);
    expect(await lapseErPreAlerts(db, new Date(now.getTime() + 131 * MIN))).toBe(1);
    expect(await lapseErPreAlerts(db, new Date(now.getTime() + 132 * MIN))).toBe(0);
    const row = (await db.select().from(erPreAlerts).where(eq(erPreAlerts.id, call.preAlertId)))[0]!;
    expect(row).toMatchObject({ state: "cancelled", cancelReason: "lapsed", arrivedCount: 1 });
    await expect(registerUnidentified(db, w.erDesk, {
      idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "ambulance_108", preAlertId: call.preAlertId,
    })).rejects.toMatchObject({ code: "pre_alert_closed" });
    await expect(cancelPreAlert(db, w.erDesk, { idempotencyKey: key(), preAlertId: call.preAlertId, reason: "not_coming" }))
      .rejects.toMatchObject({ code: "pre_alert_closed" });
  });

  it("a retried request with the same idempotency key records ONE arrival (§6 edge 8)", async () => {
    const body = { idempotencyKey: key(), sex: "female", ageBand: "elderly", arrivalMode: "walk_in" };
    const a = await registerUnidentified(db, w.erDesk, body);
    const b = await registerUnidentified(db, w.erDesk, body);
    expect(b).toEqual(a);
    expect(await db.select().from(erEpisodes)).toHaveLength(1);
  });

  it("brought dead is terminal at once: no band, never open, examined after arrival; a casualty nurse may record it", async () => {
    const now = new Date();
    const gate = new Date(now.getTime() - 20 * MIN);
    await expect(recordBroughtDead(db, w.erNurse, {
      idempotencyKey: key(), unidentified: { sex: "male", ageBand: "adult" }, arrivalMode: "police", arrivedAt: gate.toISOString(),
      examinedBy: w.erDoctor.id, examinedAt: new Date(gate.getTime() - MIN).toISOString(), ecgStripRecorded: true,
    }, { now })).rejects.toMatchObject({ code: "examined_before_arrival" });
    const bd = await recordBroughtDead(db, w.erNurse, {
      idempotencyKey: key(), unidentified: { sex: "male", ageBand: "adult" }, arrivalMode: "police", arrivedAt: gate.toISOString(),
      examinedBy: w.erDoctor.id, examinedAt: new Date(gate.getTime() + 3 * MIN).toISOString(), ecgStripRecorded: true,
    }, { now });
    expect(bd).toMatchObject({ state: "brought_dead", alias: expect.stringMatching(/^Unknown-/) });
    await expect(printErBand(db, w.erDesk, { idempotencyKey: key(), episodeId: bd.episodeId, site: "wrist" }))
      .rejects.toMatchObject({ code: "episode_wrong_state" });
    const board = await readErBoard(db, w.erDesk, { now });
    expect(board.stats).toMatchObject({ inDepartment: 0, broughtDeadToday: 1 });
    const names = (await db.select({ name: events.name }).from(events).where(eq(events.correlationId, bd.episodeId))).map((e) => e.name);
    expect(names).toEqual(["er.brought_dead"]);
  });

  it("the wall board carries no names: an alias or initials, no UHID; two people of one first name carry 'Name alert'", async () => {
    const a = await w.patient("male", 45, "Ramesh Kumar");
    const b = await w.patient("male", 52, "Ramesh Singh");
    const c = await w.patient("female", 30, "Pooja Sharma");
    for (const p of [a, b, c]) await arrive(p);
    const u = await registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "female", ageBand: "teen", arrivalMode: "police" });
    const desktop = await readErBoard(db, w.erDesk);
    const wall = await readErBoard(db, w.erDesk, { wall: true });
    expect(desktop.waiting.map((t) => t.label).sort()).toEqual(["Pooja Sharma", "Ramesh Kumar", "Ramesh Singh", u.alias].sort());
    expect(wall.waiting.map((t) => t.label).sort()).toEqual(["P. S.", "R. K.", "R. S.", u.alias].sort());
    expect(wall.waiting.every((t) => t.uhid === null)).toBe(true);
    const chips = Object.fromEntries(desktop.waiting.map((t) => [t.label, t.chips]));
    expect(chips["Ramesh Kumar"]).toContain("name_alert");
    expect(chips["Ramesh Singh"]).toContain("name_alert");
    expect(chips["Pooja Sharma"]).not.toContain("name_alert");
    expect(chips[u.alias]).toEqual(expect.arrayContaining(["unidentified", "police"]));
    expect(desktop.stats).toMatchObject({ inDepartment: 4, waitingTriage: 4 });
  });

  it("who may act: a doctor reads the board but registers nothing; nobody without the grants does either", async () => {
    await expect(registerUnidentified(db, w.erDoctor, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "walk_in" }))
      .rejects.toMatchObject({ code: "er_forbidden" });
    await expect(readErBoard(db, w.nobody)).rejects.toMatchObject({ code: "er_forbidden" });
    await expect(readErDesk(db, w.erDoctor)).rejects.toMatchObject({ code: "er_forbidden" });
    await expect(readErBoard(db, w.erDoctor)).resolves.toMatchObject({ wall: false });
    // The casualty nurse registers at night when no clerk is at the desk.
    await expect(registerUnidentified(db, w.erNurse, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "walk_in" }))
      .resolves.toMatchObject({ state: "arrived" });
  });

  it("a new named patient is registered at the desk with a name, sex and age band — no date of birth asked", async () => {
    const r = await registerArrival(db, w.erDesk, {
      idempotencyKey: key(), newPatient: { name: "Geeta Kumari", sex: "female", ageBand: "child" }, arrivalMode: "private_vehicle",
      broughtBy: { kind: "relative", name: "Raju", relation: "father" },
    });
    expect(r.band.band).toMatchObject({ name: "Geeta Kumari", ageSex: "~6 y F", size: "paediatric", allergyWords: ["Allergy: none recorded"] });
  });
});
