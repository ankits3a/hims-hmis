import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedLabDeskBase, serviceIdForLabCode } from "../../../test/helpers/lab";
import { withTx } from "../../kernel/db/client";
import { events, invoices, opdEncounters, workflowInstances } from "../../kernel/db/schema";
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { getEncounter } from "../opd";
import { deskWalkinOrder } from "./desk";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ INTEGRATION REVIEW — A `V` NUMBER WAS BEING WRITTEN INTO `encounter_id` COLUMNS ═══
 *
 * `deskOrder` took an `encounterNo` and passed it, unresolved, into FOUR different `encounterId`
 * fields: the invoice, the lab item's workflow subject, and two event envelopes. Every one of those
 * columns holds a ULID everywhere else in the system.
 *
 * The money consequence is the one that made it a MAJOR. `billing/fee-status.ts` matches
 * `inArray(invoices.encounterId, encounters.map(e => e.id))` — a V-number can never equal a ULID,
 * so NO lab invoice could ever be matched to its encounter. Combined with `opd_encounters.type`
 * defaulting to `'opd'`, every lab walk-in sat on the cashier's collection worklist by name and
 * UHID, owing a consult fee nobody could invoice or clear: a permanently uncollectable queue on a
 * logged PHI surface.
 *
 * ═══ WHY THIS FILE ASSERTS THE JOIN AND NOT JUST THE COLUMN ═══
 *
 * Asserting `invoice.encounterId === encounter.id` proves the column. It does NOT prove the thing
 * that was broken, because the defect was never really about a column — it was about a JOIN that
 * silently returned nothing. So the second case runs the reader's own query shape. A test that
 * checks the value where the contract is the lookup is the shape that let this survive: it is the
 * same lesson the argon2 guard learned an hour earlier, where asserting a returned object passed
 * while the value it described was rejected by the library that had to accept it.
 *
 * No single PR could have seen this: the writer is in `lab`, the reader is in `billing`, and each
 * is correct about its own half.
 */
describe("lab desk — the encounter link is an ID, not a visit number", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    fx.unregister();
    fx.unregister = registerEncounterResolver("V", async (exec, no) => {
      const e = await getEncounter(exec, no);
      return e ? { patientId: e.patientId, intendedPayer: e.intendedPayer } : null;
    });
  });
  afterEach(() => { fx.unregister(); });

  async function walkIn(): Promise<{ encounterId: string; visitNo: string; invoiceId: string }> {
    const placed = await withTx(db, (tx) => deskWalkinOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, serviceDate: fx.serviceDate,
      walkIn: { referrerName: "Dr Sharma" },
      items: [{ serviceId: serviceIdForLabCode("CBC") }],
      credit: { reason: "outside prescription" },
    }));
    const [enc] = await db.select().from(opdEncounters).where(eq(opdEncounters.visitNo, placed.encounterNo));
    return { encounterId: enc!.id, visitNo: placed.encounterNo, invoiceId: placed.invoice.invoiceId };
  }

  it("the invoice carries the encounter's ID — a walk-in's bill is linkable at all", async () => {
    const { encounterId, visitNo, invoiceId } = await walkIn();
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv!.encounterId).toBe(encounterId);
    /** THE KILL, stated as its own assertion: the number is not the id and must never stand in. */
    expect(inv!.encounterId).not.toBe(visitNo);
  });

  it("THE READER'S OWN QUERY finds it — which is the thing that was actually broken", async () => {
    const { encounterId } = await walkIn();
    /** `billing/fee-status.ts`'s shape: invoices selected BY ENCOUNTER ID. This returned 0 rows. */
    const found = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.encounterId, encounterId));
    expect(found).toHaveLength(1);
  });

  it("the event envelope and the workflow subject carry the ID too — all four sites, not just the money one", async () => {
    const { encounterId, visitNo } = await walkIn();

    const desked = await db.select().from(events).where(eq(events.name, "lab.order_desked"));
    expect(desked).toHaveLength(1);
    expect(desked[0]!.encounterId).toBe(encounterId);
    /** The PAYLOAD still carries the human-facing number under its own name — that field is correct. */
    expect((desked[0]!.payload as { encounterNo?: string }).encounterNo).toBe(visitNo);

    const labItemInstances = await db
      .select().from(workflowInstances).where(eq(workflowInstances.subjectType, "lab_item"));
    expect(labItemInstances.length).toBeGreaterThan(0);
    for (const wi of labItemInstances) expect(wi.encounterId).toBe(encounterId);
  });
});
