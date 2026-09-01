import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdQueueEntries } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { cancelEscalation, demandRecheck, escalate } from "./escalation";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ VD-1 T3 — TWO HANDS ON THE CANCEL BUTTON ═══
 *
 * A bay with a nurse and a supervisor both watching a 214/132 flash has two people who may press
 * CANCEL, and the ten-second window makes a double-press likely rather than exotic. Without a
 * lock, both transactions read `escalation = 'escalated'`, both pass the state check, and both
 * append a `queue.escalation_cancelled` — two audit rows saying a single act happened twice, with
 * two different names on it. The class would still come out right, which is what makes it the
 * dangerous kind of race: the damage is entirely in the record.
 *
 * The lock is on the ENCOUNTER row, not the entry — a row outside the entry's own write path,
 * which is `callNext`'s idiom and `joinQueue`'s, inherited rather than invented. It also means
 * escalate, cancel and join all serialise on one lock, so there is no lock ORDER to get wrong.
 *
 * **This suite must actually race**, and starting both promises before awaiting either turned out
 * NOT to be enough — see `warmPool` below, which exists because mutant C survived without it.
 */
/**
 * ═══ THE POOL MUST BE WARM, OR THE RACE DOES NOT RACE ═══
 *
 * MEASURED, and it is why this helper exists rather than being assumed away. The first version of
 * the suite below started both promises before awaiting either — which is necessary and is NOT
 * sufficient. `pg.Pool` opens connections lazily: caller #1 reuses the idle connection left by the
 * fixture, caller #2 has to establish a NEW one (TCP plus auth), and those few milliseconds are
 * longer than the whole first transaction. So caller #2 began its SELECT after caller #1 had
 * committed, read `cancelled`, and lost on the state check — the right answer, reached without the
 * lock ever being tested.
 *
 * The proof: mutant C (`cancelEscalation` with the `FOR UPDATE` removed) SURVIVED this suite, and
 * a probe reported `settled: ["ok", "escalation_state_conflict"], events: 1` — the unlocked code
 * behaving perfectly, because nothing concurrent had happened. A green race test that cannot fail
 * is worse than no race test: it certifies the lock while proving nothing about it (ledger §2.99).
 *
 * Opening the connections FIRST removes the establishment cost from the measured window.
 */
async function warmPool(db: Db, n = 4): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => db.execute(sql`select pg_sleep(0.05)`)));
}

const MON = new Date("2026-08-17T04:00:00.000Z");
const DOB_61 = new Date(Date.UTC(1965, 0, 15));
const DANGER = { sbp: 208, dbp: 126, pulse: 104, spo2: 95, tempC: 36.9, heightCm: 168, weightKg: 71.5 };
const WORSE = { ...DANGER, sbp: 214, dbp: 132 };

describe("VD-1 T3 — the cancel race", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let sup: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let patient: { id: string; uhid: string };

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
    sup = await mkUser(db, "sup", ["front_office_supervisor"]);
    patient = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_61 });
  });

  it("two people press CANCEL at once: ONE revert, ONE audit row, one loser with a code", async () => {
    const enc = (await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON)).encounter.id;
    await demandRecheck(db, vd.actor, enc, DANGER, MON);
    await escalate(db, vd.actor, enc, WORSE, MON);

    const at = new Date(MON.getTime() + 3_000);
    await warmPool(db);
    // BOTH started before EITHER is awaited, ON ALREADY-OPEN CONNECTIONS — now they overlap.
    const results = await Promise.allSettled([
      cancelEscalation(db, vd.actor, enc, at),
      cancelEscalation(db, sup.actor, enc, at),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ code: "escalation_state_conflict" });

    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, enc)))[0]!;
    expect(entry.escalation).toBe("cancelled");
    expect(entry.danger).toBe(false);
    // ONE name on the record, and it is the winner's — not whichever wrote last.
    expect([vd.actor.id, sup.actor.id]).toContain(entry.escalationBy);
    expect(await db.select().from(events).where(eq(events.name, "queue.escalation_cancelled"))).toHaveLength(1);
  });

  it("two people escalate at once: ONE bump, ONE audit row — the recheck state is consumed once", async () => {
    const enc = (await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON)).encounter.id;
    await demandRecheck(db, vd.actor, enc, DANGER, MON);

    await warmPool(db);
    const results = await Promise.allSettled([
      escalate(db, vd.actor, enc, WORSE, MON),
      escalate(db, sup.actor, enc, WORSE, MON),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(lost[0]!.reason).toMatchObject({ code: "escalation_state_conflict" });
    expect(await db.select().from(events).where(eq(events.name, "queue.escalated"))).toHaveLength(1);

    // And the class the loser would have stamped is not a second, wrong `escalated_from_class`:
    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, enc)))[0]!;
    expect(entry.escalatedFromClass).toBe(3);
  });
});
