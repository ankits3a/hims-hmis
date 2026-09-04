import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { opdEncounters, patients, phiAccessLog, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { issueInvoice, previewInvoice } from "./invoices";
import { collectionWorklist } from "./worklist";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ FD-8 — THE CASHIER'S DOOR ═══
 *
 * Measured before this was written: every route the `cashier` role may call is keyed on an id the
 * cashier must already hold, and the role holds **no `patients.read`** — so the patient picker
 * `/billing` renders answers 403 for the very person the screen is for. User 3 could not start their
 * own day except through a deep link from somebody else's screen.
 *
 * This is the narrow question a billing desk may safely ask: *of today's visits, which still owe
 * money?* It is a worklist, never a search — a patient who is not being billed today never appears.
 */
const SERVICE_DAY = "2026-09-04";
const NOW = new Date("2026-09-04T06:00:00Z"); // 11:30 IST
const clerk: Actor = { type: "user", id: "fd8-clerk" };

describe("the cashier's collection worklist (FD-8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    cashier = await mkCashier(db, "fd8_cashier");
    await openSessionFor(db, cashier, 100_000); // a receipt needs the drawer open (D9)
  });

  /** One OPD visit for a freshly registered patient, shaped the way the counter leaves it. */
  async function visitFor(name: string, day = SERVICE_DAY): Promise<{ encounterId: string; patientId: string }> {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name, sex: "female", ageYears: 33 }));
    const encounterId = newId();
    await db.insert(opdEncounters).values({
      id: encounterId, visitNo: `V-${encounterId.slice(-6)}`, patientId: patient.id, workflowInstanceId: newId(),
      serviceDate: day, visitType: "new", status: "waiting", intendedPayer: "self",
      openedBy: "shaped", updatedBy: "shaped", openedAt: NOW,
    });
    return { encounterId, patientId: patient.id };
  }

  it("lists today's unsettled visits with what the cashier needs to call the patient", async () => {
    const { encounterId, patientId } = await visitFor("Asha Devi");

    const rows = await collectionWorklist(db, cashier.actor, SERVICE_DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      encounterId, patientId, patientName: "Asha Devi", isConfidential: false, serviceDate: SERVICE_DAY,
    });
    expect(rows[0]!.uhid).toMatch(/^HMS\d+$/);
    // No queue entry was made, so there is no token — `null`, never a guess. A cashier calling a
    // number that is not on the patient's slip is worse than calling their name.
    expect(rows[0]!.tokenNo).toBeNull();
  });

  /**
   * THE KILL for a worklist that lists everybody. A settled visit is finished as far as this desk is
   * concerned; leaving it in the queue makes the cashier call a patient who has already left.
   */
  it("a visit whose fee is already settled DROPS OFF the list", async () => {
    const { encounterId, patientId } = await visitFor("Paid Patient");
    const lines = [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }];
    const priced = await previewInvoice(db, { encounterId, lines }, NOW);
    await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId, encounterId, lines,
      receipt: { tenders: [{ mode: "cash", amountPaise: priced.totals.netPayablePaise }] },
    }, NOW);

    expect(await collectionWorklist(db, cashier.actor, SERVICE_DAY)).toEqual([]);
  });

  it("another day's visit is not today's problem", async () => {
    await visitFor("Yesterday Patient", "2026-09-03");
    expect(await collectionWorklist(db, cashier.actor, SERVICE_DAY)).toEqual([]);
  });

  /**
   * A confidential patient who owes money must still be BILLABLE — refusing would send them to a
   * desk that cannot take their payment. The row appears, marked, exactly as the counter's duplicate
   * list does: the flag is a marker for the seat, never the access control.
   */
  it("a confidential patient still appears, and is marked", async () => {
    const { patientId } = await visitFor("Very Important Person");
    await db.update(patients).set({ isConfidential: true }).where(eq(patients.id, patientId));

    const rows = await collectionWorklist(db, cashier.actor, SERVICE_DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isConfidential).toBe(true);
  });

  /**
   * ═══ FD-23 CLOSE REVIEW — THE READ IS RECORDED, ONE ROW PER PATIENT ═══
   *
   * This list hands a cashier a NAME, a UHID and a confidential flag for everybody who owes money
   * today. Narrow is not the same as unrecorded: the function took an `Actor` it never used and
   * wrote nothing, so *"who looked at this patient's record"* returned nothing for the whole billing
   * floor. One row per DISTINCT patient, like the imaging worklist — a twenty-row list that leaves
   * a single audit row looks complete and answers nineteen questions wrong.
   */
  it("FD-23 close review: reading the worklist records PHI access, one row per patient", async () => {
    const a = await visitFor("Asha Devi");
    const b = await visitFor("Bhola Prasad");

    const rows = await collectionWorklist(db, cashier.actor, SERVICE_DAY);
    expect(rows).toHaveLength(2);

    const logged = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "billing.collection_worklist"));
    // THE KILL — an unlogged read leaves this empty, and a one-row-per-LIST read leaves it at 1.
    expect(logged).toHaveLength(2);
    expect(new Set(logged.map((r) => r.patientId))).toEqual(new Set([a.patientId, b.patientId]));
    expect(logged.every((r) => r.actorId === cashier.actor.id)).toBe(true);
    expect(logged[0]!.reason).toContain(SERVICE_DAY);
  });

  it("an empty day is an empty list, not an error", async () => {
    expect(await collectionWorklist(db, cashier.actor, SERVICE_DAY)).toEqual([]);
  });
});
