import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { events, labOrderables, opdEncounters, registrationConfig, services } from "../../kernel/db/schema";
import { getEncounter } from "../opd";
import { registerPatient } from "../patients";
import { feeQuote, feeServiceFor } from "./charge-rules";
import { feeOffAt, loadBillingConfig, updateBillingConfig } from "./config";
import { encounterFeeStatuses } from "./fee-status";
import { feeSwitchesView, setFeeSwitch } from "./fee-switches";
import { previewInvoice } from "./invoices";
import type { Db } from "../../kernel/db/client";

/**
 * THE FEE SWITCHES (owner, 2026-10-01): consultation and laboratory fees can be switched off (free)
 * and on (charged at the tariff's price). Fixture numbers are `seedBillingBase`'s: both consult
 * services and the generic service are priced 50000 paise. Encounters are shaped directly, the
 * charge-rules.test.ts precedent.
 */
describe("the fee switches: consultation and laboratory fees, off and on", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  const owner: Actor = { type: "user", id: "the-owner" };
  const T0 = new Date("2026-10-01T04:00:00Z");
  const T1 = new Date("2026-10-01T05:00:00Z");
  const T2 = new Date("2026-10-01T06:00:00Z");
  const T3 = new Date("2026-10-01T07:00:00Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  async function visit(visitType: string, openedAt: Date) {
    const clerk: Actor = { type: "user", id: "switch-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Switch Patient", sex: "female", ageYears: 40 }));
    const id = newId();
    await db.insert(opdEncounters).values({
      id, visitNo: `VFX-${id}`, patientId: patient.id, workflowInstanceId: newId(), serviceDate: "2026-10-01",
      visitType, status: "waiting", intendedPayer: "self", openedBy: "shaped", updatedBy: "shaped", openedAt,
    });
    return (await getEncounter(db, id))!;
  }
  const rules = async () => (await loadBillingConfig(db)).chargeRules;

  /** A laboratory test: a service the lab's own catalogue names. Priced only when `pricePaise` says so. */
  async function labTest(code: string): Promise<string> {
    const id = newId();
    await db.insert(services).values({ id, code: `LAB-${code}`, name: code, category: "consultation", createdBy: "t", updatedBy: "t" });
    await db.insert(labOrderables).values({
      serviceId: id, code, nameEn: code, discipline: "biochemistry", specimenType: "serum", container: "plain", tatMinutesRoutine: 240, createdBy: "t", updatedBy: "t",
    });
    return id;
  }

  it("with no switch ever flipped, a new visit is charged and the screen reads both fees as on", async () => {
    expect(feeServiceFor(await visit("new", T1), await rules())).toBe(base.consultNewServiceId);
    const view = await feeSwitchesView(db, T1);
    expect(view.switches).toEqual([
      { kind: "opdConsult", off: false, changedAt: null, changedBy: null },
      { kind: "lab", off: false, changedAt: null, changedBy: null },
      { kind: "imaging", off: false, changedAt: null, changedBy: null },
    ]);
    expect(view.consultPaise).toEqual({ new: 50000, renewal: 50000 });
  });

  it("consultation switched off: new and renewal visits are free, the quote says why, and the flip is audited", async () => {
    const view = await setFeeSwitch(db, owner, "opdConsult", true, T1);
    expect(view.switches[0]).toEqual({ kind: "opdConsult", off: true, changedAt: T1.toISOString(), changedBy: "the-owner" });

    const fresh = await visit("new", T2);
    expect(feeServiceFor(fresh, await rules())).toBeNull();
    expect(feeServiceFor(await visit("renewal", T2), await rules())).toBeNull();
    const quote = await feeQuote(db, fresh.id, T2);
    expect(quote).toMatchObject({ free: true, feesOff: true, draft: null, feeServiceId: null });
    expect((await encounterFeeStatuses(db, [{ id: fresh.id, visitType: "new" }])).get(fresh.id)).toBe("free");

    const audit = await db.select().from(events).where(eq(events.name, "fee_switch.changed"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: "the-owner", payload: { kind: "opdConsult", off: true } });
  });

  it("a tap that changes nothing writes no flip and no audit row", async () => {
    await setFeeSwitch(db, owner, "opdConsult", true, T1);
    await setFeeSwitch(db, owner, "opdConsult", true, T2);
    await setFeeSwitch(db, owner, "lab", false, T2);
    expect((await rules()).feeSwitches).toEqual({ opdConsult: [{ at: T1.toISOString(), off: true, by: "the-owner" }] });
    expect(await db.select().from(events).where(eq(events.name, "fee_switch.changed"))).toHaveLength(1);
  });

  it("switched back on: a visit opened while it was free stays free; one opened before or after is charged", async () => {
    const before = await visit("new", T0);
    await setFeeSwitch(db, owner, "opdConsult", true, T1);
    const during = await visit("new", T2);
    await setFeeSwitch(db, owner, "opdConsult", false, T3);
    const after = await visit("new", new Date(T3.getTime() + 60_000));

    const r = await rules();
    expect(feeServiceFor(during, r)).toBeNull();
    expect(feeServiceFor(before, r)).toBe(base.consultNewServiceId);
    expect(feeServiceFor(after, r)).toBe(base.consultNewServiceId);
    // The queue's reader is handed `id` and `visitType` alone and must reach the same answers.
    const statuses = await encounterFeeStatuses(db, [before, during, after].map((e) => ({ id: e.id, visitType: e.visitType })));
    expect([before, during, after].map((e) => statuses.get(e.id))).toEqual(["unsettled", "free", "unsettled"]);
    expect((await feeQuote(db, after.id, T3)).draft?.totals.netPayablePaise).toBe(50000);
  });

  it("a review visit is free with or without the switch, and is not blamed on it", async () => {
    await setFeeSwitch(db, owner, "opdConsult", true, T1);
    const review = await visit("revisit", T2);
    expect(await feeQuote(db, review.id, T2)).toMatchObject({ free: true, feesOff: false });
  });

  it("a config patch naming the fee branch can neither erase the flips nor forge one", async () => {
    await setFeeSwitch(db, owner, "opdConsult", true, T1);
    const { opdConsult } = await rules();
    await withTx(db, (tx) => updateBillingConfig(tx, { chargeRules: { opdConsult } }, T2));
    expect((await rules()).feeSwitches?.opdConsult).toHaveLength(1);
    await withTx(db, (tx) => updateBillingConfig(tx, { chargeRules: { opdConsult, feeSwitches: { opdConsult: [], lab: [{ at: T2.toISOString(), off: true, by: "forged" }] } } }, T2));
    expect((await rules()).feeSwitches).toEqual({ opdConsult: [{ at: T1.toISOString(), off: true, by: "the-owner" }] });
  });

  it("imaging switched off (decision 0065): a study ordered while it is off is free, one ordered before or after is not", async () => {
    expect(feeOffAt(await rules(), "imaging", T1)).toBe(false);
    await setFeeSwitch(db, owner, "imaging", true, T1);
    await setFeeSwitch(db, owner, "imaging", false, T3);
    expect(feeOffAt(await rules(), "imaging", T0)).toBe(false);
    expect(feeOffAt(await rules(), "imaging", T2)).toBe(true);
    expect(feeOffAt(await rules(), "imaging", new Date(T3.getTime() + 1))).toBe(false);
    expect((await feeSwitchesView(db, T3)).switches.map((s) => s.kind)).toEqual(["opdConsult", "lab", "imaging"]);
    /** The lab switch is its own: imaging off does not make tests free. */
    expect((await rules()).feeSwitches?.lab).toBeUndefined();
  });

  it("only a named person switches a fee", async () => {
    await expect(setFeeSwitch(db, { type: "system", id: "cron" } as Actor, "lab", true, T1)).rejects.toMatchObject({ code: "fee_not_applicable" });
    expect((await rules()).feeSwitches).toBeUndefined();
  });

  it("laboratory fee switched off: a test bills at ₹0 — even one the tariff never priced — and nothing else moves", async () => {
    const unpriced = await labTest("TSH");
    const lines = [{ lineId: "t", serviceId: unpriced, qty: 1 }, { lineId: "g", serviceId: base.genericServiceId, qty: 1 }];
    // Charged: an unpriced test refuses the bill, as it always has.
    await expect(previewInvoice(db, { lines }, T1)).rejects.toMatchObject({ code: "tariff_item_missing" });
    const genericAlone = await previewInvoice(db, { lines: [lines[1]!] }, T1);

    await setFeeSwitch(db, owner, "lab", true, T1);
    const free = await previewInvoice(db, { lines }, T2);
    expect(free.lines.find((l) => l.lineId === "t")?.grossPaise).toBe(0);
    expect(free.lines.find((l) => l.lineId === "g")?.grossPaise).toBe(genericAlone.lines[0]!.grossPaise);
    expect(free.totals.netPayablePaise).toBe(genericAlone.totals.netPayablePaise);
    // The lab's switch does not free the consultation.
    expect(feeServiceFor(await visit("new", T2), await rules())).toBe(base.consultNewServiceId);

    await setFeeSwitch(db, owner, "lab", false, T3);
    await expect(previewInvoice(db, { lines }, T3)).rejects.toMatchObject({ code: "tariff_item_missing" });
  });
});
