import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { erMlcs, events } from "../../../kernel/db/schema";
import { setPin } from "../../../kernel/auth/identity";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErMlcWorld } from "../../../../test/helpers/emergency";
import {
  addMlcAddendum, countersignMlc, handOverEvidence, mlcOfEpisode, openMlc, readMlc, readMlcDesk, recordBelongings, recordPoliceIntimation,
  registerArrival, registerUnidentified,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErMlcWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 4 (#811) — THE MLC's RULES beyond "done means" (spec §3.7, §4.4): the MLCs opened by rule, the police's own
 * arrival as the intimation, who may open and countersign, two staff on every custody link, the evidence chain's order,
 * the late flag, and one case per episode.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 4 er-mlc — the rules", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErMlcWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErMlcWorld(db);
  });

  const walkIn = async (now = new Date()) => {
    const p = await w.patient("female", 28, "Anita Kumari");
    return registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in" }, { now });
  };

  it("an unknown patient is an MLC by default; a patient the police bring is one too, their arrival the intimation", async () => {
    const now = new Date();
    const u = await registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "ambulance_108" }, { now });
    expect(await mlcOfEpisode(db, u.episodeId)).toMatchObject({ category: "unknown_unconscious", openedByRule: true, late: false });

    const p = await w.patient("male", 40, "Mohan Lal");
    const gate = new Date(now.getTime() - 5 * MIN);
    const a = await registerArrival(db, w.erDesk, {
      idempotencyKey: key(), patientId: p, arrivalMode: "police", arrivedAt: gate.toISOString(),
      broughtBy: { kind: "police", name: "SI Vikram", policeStation: "PS Gandhi Maidan", badgeNo: "B-221" },
    }, { now });
    const m = (await mlcOfEpisode(db, a.episodeId))!;
    const read = await readMlc(db, w.erDesk, m.id, { now });
    expect(read).toMatchObject({
      category: "police_brought", openedByRule: true,
      intimation: { metAt: gate.toISOString(), breached: false },
      intimationRecord: { mode: "police_present", station: "PS Gandhi Maidan", receiverName: "SI Vikram", intimatedAt: gate.toISOString() },
    });
    // The MLC's events correlate on the case, not the episode (the episode's stream stays the clinical one).
    const onEpisode = (await db.select({ name: events.name }).from(events).where(eq(events.correlationId, a.episodeId))).map((e) => e.name);
    expect(onEpisode).not.toContain("er.mlc_opened");
    // A second intimation is refused; the doctor's own MLC on the same episode too — a change is an addendum.
    await expect(recordPoliceIntimation(db, w.erDesk, {
      idempotencyKey: key(), mlcId: m.id, mode: "written", station: "PS Gandhi Maidan", receiverName: "HC Ram",
    }, { now })).rejects.toMatchObject({ code: "intimation_recorded" });
    await expect(openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "assault" }, { now }))
      .rejects.toMatchObject({ code: "mlc_already_open", detail: { mlcNo: m.mlcNo } });
  });

  it("only a doctor opens an MLC; one opened 6 hours after the gate is flagged late; the serial runs per year", async () => {
    const t0 = new Date();
    const a = await walkIn(new Date(t0.getTime() - 7 * 60 * MIN));
    await expect(openMlc(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, category: "burns" }, { now: t0 }))
      .rejects.toMatchObject({ code: "not_a_doctor" });
    const m = await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "burns" }, { now: t0 });
    expect(m.late).toBe(true);
    const b = await walkIn(t0);
    const m2 = await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: b.episodeId, category: "sexual_assault", pocso: true }, { now: t0 });
    expect(m2.late).toBe(false);
    const [n1, n2] = [m.mlcNo, m2.mlcNo].map((n) => Number(n.slice(-6)));
    expect(n2).toBe(n1! + 1);
    // Free by law (BNSS s.397) is stamped on the case for lane 6's bill desk; the MLC desk shows no money.
    expect(await readMlc(db, w.erDesk, m2.mlcId, { now: t0 })).toMatchObject({ freeByLaw: true, pocso: true });
    const desk = await readMlcDesk(db, w.erDesk, { now: t0 });
    expect(desk.owed.map((r) => r.mlcNo).sort()).toEqual([m.mlcNo, m2.mlcNo].sort());
  });

  it("the faculty countersign: a senior doctor, never the opener and never a resident; once", async () => {
    const now = new Date();
    const a = await walkIn(now);
    const m = await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "poisoning" }, { now });
    await expect(countersignMlc(db, w.erDoctor, { idempotencyKey: key(), mlcId: m.mlcId }, { now })).rejects.toMatchObject({ code: "countersign_own_mlc" });
    await expect(countersignMlc(db, w.resident, { idempotencyKey: key(), mlcId: m.mlcId }, { now })).rejects.toMatchObject({ code: "cosigner_not_senior" });
    await expect(countersignMlc(db, w.erNurse, { idempotencyKey: key(), mlcId: m.mlcId }, { now })).rejects.toMatchObject({ code: "cosigner_not_senior" });
    expect(await countersignMlc(db, w.doctor, { idempotencyKey: key(), mlcId: m.mlcId }, { now })).toMatchObject({ withinTarget: true });
    await expect(countersignMlc(db, w.doctor, { idempotencyKey: key(), mlcId: m.mlcId }, { now })).rejects.toMatchObject({ code: "mlc_countersigned" });
    expect((await readMlc(db, w.erDesk, m.mlcId, { now })).countersignedBy).toMatchObject({ userId: w.doctor.id });
    // An addendum is a doctor's: the desk cannot write one.
    await expect(addMlcAddendum(db, w.erDesk, { idempotencyKey: key(), mlcId: m.mlcId, text: "x" }, { now })).rejects.toMatchObject({ code: "not_a_doctor" });
  });

  it("belongings and evidence: two staff on every link; a seal is collected before it moves, and handed over once", async () => {
    const now = new Date();
    const a = await walkIn(now);
    const m = await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "assault" }, { now });
    const items = [{ description: "Mobile phone (black)", qty: 1 }, { description: "Cash, sealed envelope", qty: 1 }];
    const keptIn = { kind: "locker" as const, ref: "ER locker 4" };
    await expect(recordBelongings(db, w.erDesk, { idempotencyKey: key(), mlcId: m.mlcId, items, keptIn, secondPerson: { username: "er.desk2", pin: "0000" } }, { now }))
      .rejects.toMatchObject({ code: "second_check_failed" });
    await expect(recordBelongings(db, w.desk2, { idempotencyKey: key(), mlcId: m.mlcId, items, keptIn, secondPerson: w.deskPin }, { now }))
      .rejects.toMatchObject({ code: "second_checker_same" });
    // A user without the MLC grant cannot witness.
    await ensureRole(db, "kitchen_staff");
    const cook = (await mkUser(db, "er.cook", ["kitchen_staff"])).actor;
    await setPin(db, cook.id, "1357");
    await expect(recordBelongings(db, w.erDesk, { idempotencyKey: key(), mlcId: m.mlcId, items, keptIn, secondPerson: { username: "er.cook", pin: "1357" } }, { now }))
      .rejects.toMatchObject({ code: "second_check_failed" });
    const b = await recordBelongings(db, w.erDesk, { idempotencyKey: key(), mlcId: m.mlcId, items, keptIn, secondPerson: w.deskPin }, { now });
    expect(b.witnessedBy).toBe(w.desk2.id);

    const ev = (action: "collected" | "stored" | "handed_over", extra: object = {}) => handOverEvidence(db, w.erDoctor, {
      idempotencyKey: key(), mlcId: m.mlcId, kind: "clothes", description: "Blood-stained shirt", sealNo: "s-101", action,
      secondPerson: w.pins.nurse2, ...extra,
    }, { now });
    await expect(ev("stored")).rejects.toMatchObject({ code: "seal_not_collected" });
    expect((await ev("collected")).link).toBe(2);
    expect((await ev("stored")).link).toBe(3);
    const officer = { receiver: { name: "SI Vikram", rank: "SI", station: "PS Gandhi Maidan" } };
    expect((await ev("handed_over", officer)).link).toBe(4);
    await expect(ev("handed_over", officer)).rejects.toMatchObject({ code: "seal_already_handed_over" });
    const chain = (await readMlc(db, w.erDesk, m.mlcId, { now })).custody;
    expect(chain.map((c) => [c.link, c.kind, c.action, c.sealNo, c.witnessedBy.userId])).toEqual([
      [1, "belongings", "listed", null, w.desk2.id],
      [2, "evidence", "collected", "S-101", w.nurse2.id],
      [3, "evidence", "stored", "S-101", w.nurse2.id],
      [4, "evidence", "handed_over", "S-101", w.nurse2.id],
    ]);
  });

  it("the countersign stays owed past 24 h; a refused examination is an addendum; the MLC row itself never changes", async () => {
    const now = new Date();
    const a = await walkIn(now);
    const m = await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "fall_from_height" }, { now });
    await addMlcAddendum(db, w.erDoctor, { idempotencyKey: key(), mlcId: m.mlcId, text: "Patient refused examination of the back.", examinationRefused: true }, { now });
    const before = (await db.select().from(erMlcs).where(eq(erMlcs.id, m.mlcId)))[0];
    const later = new Date(now.getTime() + 25 * 60 * MIN);
    const desk = await readMlcDesk(db, w.erDesk, { now: later });
    expect(desk.owed.map((r) => [r.mlcNo, r.countersign.breached])).toEqual([[m.mlcNo, true]]);
    expect((await readMlc(db, w.erDesk, m.mlcId, { now: later })).addenda[0]).toMatchObject({ examinationRefused: true });
    expect((await db.select().from(erMlcs).where(eq(erMlcs.id, m.mlcId)))[0]).toEqual(before);
  });
});
