import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { invoices, opdEncounters, registrationConfig } from "../../kernel/db/schema";
import { getEncounter } from "../opd";
import { registerPatient } from "../patients";
import { feeQuote, feeServiceFor, FEE_LINE_ID } from "./charge-rules";
import { loadBillingConfig } from "./config";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T10, D8 — the OPD fee branch.
 *
 * THE SEEDED FIXTURE every number below is derived from (test/helpers/billing.ts `seedBillingBase`):
 *   · OPD-CONSULT-NEW and OPD-CONSULT-RENEWAL, category "consultation", EXEMPT healthcare
 *     (sac 999312), each priced 50000 paise; `charge_rules.opdConsult` names those two ids.
 *   · An exempt line carries no tax head at all, so a single consult prices to
 *     gross 50000 = base 50000, cgst 0, sgst 0, raw total 50000, roundTotalToRupee(50000) = 50000
 *     (rounding 0) — NET PAYABLE 50000.
 *
 * DISCLOSED SHAPING: `opd_encounters` rows are inserted DIRECTLY (the T5/T8 precedent — opening a
 * real visit needs the whole Class-A workflow activation, which proves nothing about a branch
 * lookup). `visit_type` is plain text with no CHECK, which is what lets the fourth case below
 * exist at all: the union is a TypeScript claim about that column, not a database one.
 */
describe("the OPD fee branch: feeServiceFor and the fee quote (D8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

  const NOW = new Date("2026-08-19T06:00:00Z"); // 11:30 IST — IST day 2026-08-19
  const SERVICE_DAY = "2026-08-19";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  async function mkTestPatient(name = "Branch Patient"): Promise<string> {
    const actor: Actor = { type: "user", id: "branch-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name, sex: "female", ageYears: 40 }));
    return patient.id;
  }

  /** See the shaping disclosure in this file's header. */
  async function shapeEncounter(visitType: string): Promise<string> {
    const id = newId();
    await db.insert(opdEncounters).values({
      id, visitNo: `VFX-${id}`, patientId: await mkTestPatient(), workflowInstanceId: newId(), serviceDate: SERVICE_DAY,
      visitType, status: "waiting", intendedPayer: "self", openedBy: "shaped", updatedBy: "shaped", openedAt: NOW,
    });
    return id;
  }

  async function encounterOf(visitType: string) {
    return (await getEncounter(db, await shapeEncounter(visitType)))!;
  }

  const codeOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

  it("a NEW visit charges chargeRules.opdConsult.new", async () => {
    const cfg = await loadBillingConfig(db);
    expect(feeServiceFor(await encounterOf("new"), cfg.chargeRules)).toBe(base.consultNewServiceId);
  });

  it("a RENEWAL visit charges chargeRules.opdConsult.renewal", async () => {
    const cfg = await loadBillingConfig(db);
    expect(feeServiceFor(await encounterOf("renewal"), cfg.chargeRules)).toBe(base.consultRenewalServiceId);
  });

  it("a REVISIT is FREE — the branch is null, and null is the free branch, not a missing mapping", async () => {
    const cfg = await loadBillingConfig(db);
    expect(feeServiceFor(await encounterOf("revisit"), cfg.chargeRules)).toBeNull();
  });

  it("a visit type outside the three OPD stamps has no rule at all: fee_not_applicable", async () => {
    const cfg = await loadBillingConfig(db);
    const encounter = await encounterOf("day_care");
    let thrown: unknown = null;
    try {
      feeServiceFor(encounter, cfg.chargeRules);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      name: "BillingError", code: "fee_not_applicable", detail: { encounterId: encounter.id, visitType: "day_care" },
    });
  });

  it("feeQuote composes the branch with previewInvoice, prices the fee line, and persists NOTHING", async () => {
    const newVisit = await shapeEncounter("new");
    const quote = await feeQuote(db, newVisit, NOW);
    expect(quote).toMatchObject({
      encounterId: newVisit, visitType: "new", free: false, feeServiceId: base.consultNewServiceId,
    });
    expect(quote.draft!.lines).toHaveLength(1);
    expect(quote.draft!.lines[0]).toMatchObject({
      lineId: FEE_LINE_ID, serviceId: base.consultNewServiceId, qty: 1, unitPaise: 50_000, grossPaise: 50_000,
      discountPaise: 0, taxableBasePaise: 50_000, netPaise: 50_000,
    });
    // Exempt healthcare: no head to compute, so nothing to round either.
    expect(quote.draft!.lines[0]!.gst).toMatchObject({ sacCode: "999312", exempt: true, cgstPaise: 0, sgstPaise: 0 });
    expect(quote.draft!.totals).toMatchObject({
      grossPaise: 50_000, taxableBasePaise: 50_000, cgstPaise: 0, sgstPaise: 0,
      rawTotalPaise: 50_000, netPayablePaise: 50_000, roundingPaise: 0,
    });
    expect(await db.select().from(invoices)).toHaveLength(0); // a quote is a question

    const revisit = await shapeEncounter("revisit");
    expect(await feeQuote(db, revisit, NOW)).toEqual({
      encounterId: revisit, visitType: "revisit", free: true, feeServiceId: null, draft: null,
      // RC-1 T5 — a shaped row has no department and no anchor: free with NO story, never un-freed.
      // The anchored freeReason is proved in opd/fee-status.test.ts, where real masters exist.
      freeReason: null,
    });

    expect(await codeOf(feeQuote(db, "no-such-encounter", NOW)))
      .toMatchObject({ name: "BillingError", code: "unknown_encounter" });
  });
});
