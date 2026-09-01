import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdQueueEntries } from "../../kernel/db/schema";
import { listBench, setBenchState } from "./bench";
import { openVisit } from "./encounters";
import { listQueue } from "./queue";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ VD-1 T4 — THE BENCH ═══
 *
 * Ramdev Mahto is on the rest chairs at 09:52 with 172/104 held on his chart. Salma Khatoon has
 * stepped out. The property under test in every leg below is the same one: **neither of them
 * becomes callable, and neither of them loses their place.** A bench state that leaked into the
 * callable set would hand a doctor a patient with no vitals; a bench state that cost a turn would
 * make stepping out a punishment.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const DOB = new Date(Date.UTC(1958, 0, 15));
const adultOk = { heightCm: 164, weightKg: 61.5, sbp: 128, dbp: 82, pulse: 76, spo2: 97, tempC: 36.6 };

describe("VD-1 T4 — the bench, the recall, and the held turn", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let ramdev: { id: string };
  let salma: { id: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    ramdev = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB });
    salma = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB });
  });

  const visit = async (patientId: string): Promise<string> =>
    (await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, MON)).encounter.id;

  it("resting and away keep the entry OFF the callable set and KEEP its place", async () => {
    const first = await visit(ramdev.id);
    const second = await visit(salma.id);
    const seqBefore = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, first)))[0]!.seq;

    await setBenchState(db, vd.actor, first, { state: "resting", restMinutes: 5 }, MON);
    await setBenchState(db, vd.actor, second, { state: "away" }, MON);

    // Neither is callable — the queue's `waiting` filter never sees a `waiting_vitals` row.
    const queue = await listQueue(db, vd.actor, dra.doctorId, "2026-08-17", MON);
    expect(queue!.ordered).toHaveLength(0);
    expect(queue!.waitingVitals).toBe(2);

    // The turn is the seq, and nothing touched it.
    const after = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, first)))[0]!;
    expect(after.seq).toBe(seqBefore);
    expect(after.status).toBe("waiting_vitals");
  });

  it("the recall is a stored instant, and `recallDue` is DERIVED on every read", async () => {
    const enc = await visit(ramdev.id);
    const set = await setBenchState(db, vd.actor, enc, { state: "resting", restMinutes: 5 }, MON);
    expect(set.recallAt).toEqual(new Date(MON.getTime() + 5 * 60_000));

    // Four minutes in: not due. Six minutes in: due — computed from the clock, not fired once,
    // so a bench repainted after a restart still knows he is overdue.
    const early = await listBench(db, vd.actor, { serviceDate: "2026-08-17" }, new Date(MON.getTime() + 4 * 60_000));
    expect(early.find((r) => r.encounterId === enc)!.recallDue).toBe(false);
    const late = await listBench(db, vd.actor, { serviceDate: "2026-08-17" }, new Date(MON.getTime() + 6 * 60_000));
    expect(late.find((r) => r.encounterId === enc)!.recallDue).toBe(true);
  });

  it("a rest with no recall time is refused — that is a forgotten patient, not a default", async () => {
    const enc = await visit(ramdev.id);
    await expect(setBenchState(db, vd.actor, enc, { state: "resting" }, MON))
      .rejects.toMatchObject({ code: "invalid_bench_state" });
    const row = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, enc)))[0]!;
    expect(row.benchState).toBeNull();
    expect(row.recallAt).toBeNull();
  });

  it("coming back clears the state and is its own recorded fact", async () => {
    const enc = await visit(salma.id);
    await setBenchState(db, vd.actor, enc, { state: "away" }, MON);
    await setBenchState(db, vd.actor, enc, { state: null }, new Date(MON.getTime() + 60_000));

    const row = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, enc)))[0]!;
    expect(row.benchState).toBeNull();
    expect(row.recallAt).toBeNull();
    // Two rows, not one: "she is back" is a fact, not the absence of one.
    const ev = await db.select().from(events).where(eq(events.name, "bench.state_set"));
    expect(ev).toHaveLength(2);
    expect((ev[1]!.payload as { state: string | null }).state).toBeNull();
  });

  it("the ✓ row: a saved chart marks the bench, and it is the ACTIVE chart that counts", async () => {
    const enc = await visit(ramdev.id);
    const before = await listBench(db, vd.actor, { serviceDate: "2026-08-17" }, MON);
    expect(before.find((r) => r.encounterId === enc)!.vitalsDone).toBe(false);

    const r = await recordVitals(db, vd.actor, enc, adultOk, MON);
    const after = await listBench(db, vd.actor, { serviceDate: "2026-08-17" }, MON);
    const row = after.find((x) => x.encounterId === enc)!;
    expect(row.vitalsDone).toBe(true);
    expect(row.vitalsId).toBe(r.vitals.id);
    expect(row.doctorName.length).toBeGreaterThan(0); // the rail names the doctor the ✓ went to
  });

  it("a chart saved BEFORE the rest keeps its tick — the rail must not drop it when it matters most", async () => {
    const enc = await visit(ramdev.id);
    await recordVitals(db, vd.actor, enc, { ...adultOk, sbp: 172, dbp: 104 }, MON);
    const set = await setBenchState(db, vd.actor, enc, { state: "resting", restMinutes: 5 }, MON);
    expect(set.vitalsDone).toBe(true); // read, not assumed
    expect(set.benchState).toBe("resting");
  });
});
