import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkOtPatient, seedOtBase } from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import { daycareEncounters, resources } from "../../kernel/db/schema";
import { assignResource } from "../../kernel/resources/registry";
import { KERNEL_RESOURCE_KINDS } from "../../kernel/resources/kinds";
import { bookCase } from "./booking";
import { admitToBay } from "./recovery";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T6 / A19 — **TWO ADMISSIONS, ONE BAY.**
 *
 * The same shape as A12's theatre race and for the same reason: a STATE assertion, a deterministic
 * overlap produced with a barrier, and one bay rather than two — because two bays have no
 * contention and discriminate nothing.
 *
 * This inherits the kernel fix finding T5-a bought (`registry.concurrency.test.ts`). Before it,
 * `assignResource` was a read-check-write and both admissions succeeded: two post-anaesthesia
 * patients recorded in one bay, each nurse told the bay was hers.
 *
 * **A19 matters more than it looks.** The unit has TWO bays. A silent double-assignment does not
 * merely misreport a board — it means the second patient has no bay at all while the system says
 * she does, on the one ward where nobody is continuously watched.
 */
const LIST_DATE = "2026-09-02";
const PROBE_MS = 400;
jest.setTimeout(40_000);
const delay = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

describe("the recovery bays under contention (Plan 15 T6, A19)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let f: OtBaseFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); f = await seedOtBase(db); });

  /** An encounter that is ready to be put in a bay. The gate walk is A12's subject, not this one's. */
  async function anEncounter(name: string, phone: string): Promise<string> {
    const patientId = await mkOtPatient(db, f.coordinator, name, { phone });
    const r = await bookCase(db, f.incharge, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: LIST_DATE, payerClass: "self_pay", force: true,
    });
    return r.encounterId;
  }

  it("A19 — two concurrent admissions to ONE bay: exactly one succeeds", async () => {
    const a = await anEncounter("Sunita Devi", "9800001111");
    const b = await anEncounter("Meena Kumari", "9800002211");
    const bay = f.bayIds[0]!;

    let releaseBarrier: () => void = () => { /* replaced below */ };
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });

    // A assigns and holds its transaction open, guaranteeing B's read overlaps it.
    const first = withTx(db, async (tx) => {
      await assignResource(tx, f.recoveryNurse, KERNEL_RESOURCE_KINDS, bay, {
        occupantType: "daycare_encounter", occupantRef: a,
      });
      await tx.update(daycareEncounters).set({ bayResourceId: bay }).where(eq(daycareEncounters.id, a));
      await barrier;
    });
    first.catch(() => { /* observed below */ });
    await delay(50);

    // B is the REAL `admitToBay`.
    const second = admitToBay(db, f.recoveryNurse, { encounterId: b, bayResourceId: bay });
    second.catch(() => { /* observed below */ });

    // A STATE, never a duration (§2.99).
    const state = await Promise.race([
      second.then(() => "settled", () => "settled"),
      delay(PROBE_MS).then(() => "pending"),
    ]);
    expect(state).toBe("pending");

    releaseBarrier();
    const [aResult, bResult] = await Promise.allSettled([first, second]);
    expect(aResult.status).toBe("fulfilled");
    expect(bResult.status).toBe("rejected");
    expect(String((bResult as PromiseRejectedResult).reason)).toMatch(/is occupied by daycare_encounter/);

    // ONE occupant, and it is A's. And B's encounter has NO bay — the loser's whole transaction
    // rolled back, so nothing claims she is somewhere she is not.
    const row = (await db.select().from(resources).where(eq(resources.id, bay)))[0]!;
    expect({ status: row.status, occupantRef: row.occupantRef })
      .toEqual({ status: "occupied", occupantRef: a });
    const loser = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, b)))[0]!;
    expect(loser.bayResourceId).toBeNull();
  });

  /** The non-discriminating leg, labelled: two bays have no contention. */
  it("A19 — two admissions to DIFFERENT bays both succeed: this leg discriminates NOTHING", async () => {
    const a = await anEncounter("Sunita Devi", "9800001111");
    const b = await anEncounter("Meena Kumari", "9800002211");
    await admitToBay(db, f.recoveryNurse, { encounterId: a, bayResourceId: f.bayIds[0]! });
    await admitToBay(db, f.recoveryNurse, { encounterId: b, bayResourceId: f.bayIds[1]! });
    const board = await db.select().from(resources).where(eq(resources.kind, "bed"));
    expect(board.filter((r) => r.occupantRef !== null)).toHaveLength(2);
  });
});
