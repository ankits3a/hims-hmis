import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { createUser } from "../../kernel/auth/identity";
import { assignRole } from "../../kernel/auth/permissions";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { opdEncounters, registrationConfig, roles } from "../../kernel/db/schema";
import { getEncounter } from "../opd";
import { registerPatient } from "../patients";
import { createService } from "../tariff";
import { feeQuote } from "./charge-rules";
import { loadBillingConfig, updateBillingConfig } from "./config";
import { consultPricesView, decideConsultPrices, proposeConsultPrices } from "./consult-prices";
import { encounterFeeStatuses } from "./fee-status";
import { setFeeSwitch } from "./fee-switches";
import { feeGate } from "./gate";
import { BillingError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * THE CONSULTATION PRICE LIST AND THE REVISIT FEE (owner, 2026-10-05). `seedBillingBase` prices new
 * and renewal at 50000 paise from 2026-01-01. Times are in the past on purpose: the gate reads the
 * real clock, and a version effective in the future would make these tests a time bomb.
 */
describe("the consultation price list and the revisit fee", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let editor: Actor;
  const T_PROPOSE = new Date("2026-09-01T04:00:00Z");
  const T_DECIDE = new Date("2026-09-01T05:00:00Z");
  const T_VISIT = new Date("2026-09-02T05:00:00Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    const { id } = await createUser(db, { username: "price_editor", fullName: "Price Editor", password: "p1234567" });
    await db.insert(roles).values({ key: "tariff_editor", title: "Tariff editor" }).onConflictDoNothing();
    await assignRole(db, { userId: id, roleKey: "tariff_editor", scopeType: "hospital" });
    editor = { type: "user", id };
  });

  async function wireRevisit(): Promise<string> {
    const { serviceId } = await withTx(db, (tx) =>
      createService(tx, base.drafter, { code: "OPD-CONSULT-REVISIT", name: "OPD Consultation (Revisit)", category: "consultation" }),
    );
    const cfg = await loadBillingConfig(db);
    await withTx(db, (tx) => updateBillingConfig(tx, { chargeRules: { ...cfg.chargeRules, opdConsult: { ...cfg.chargeRules.opdConsult, revisit: serviceId } } }));
    return serviceId;
  }

  async function revisit() {
    const clerk: Actor = { type: "user", id: "revisit-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Revisit Patient", sex: "male", ageYears: 52 }));
    const id = newId();
    await db.insert(opdEncounters).values({
      id, visitNo: `VRV-${id}`, patientId: patient.id, workflowInstanceId: newId(), serviceDate: "2026-09-02",
      visitType: "revisit", status: "waiting", intendedPayer: "self", openedBy: "shaped", updatedBy: "shaped", openedAt: T_VISIT,
    });
    return (await getEncounter(db, id))!;
  }

  async function approvedRevisitPrice(paise: number): Promise<void> {
    const proposed = await proposeConsultPrices(db, editor, { prices: { revisit: paise } }, T_PROPOSE);
    await decideConsultPrices(db, base.owner, proposed.pending!.versionId, { approve: true, note: "ok" }, T_DECIDE);
  }

  it("shows the prices in force; revisit has no service until one is wired", async () => {
    const view = await consultPricesView(db, T_PROPOSE);
    expect(view.rows).toEqual([
      { branch: "new", serviceId: base.consultNewServiceId, code: "OPD-CONSULT-NEW", activePaise: 50000 },
      { branch: "renewal", serviceId: base.consultRenewalServiceId, code: "OPD-CONSULT-RENEWAL", activePaise: 50000 },
      { branch: "revisit", serviceId: null, code: null, activePaise: null },
    ]);
    expect(view.pending).toBeNull();
  });

  it("a proposal waits for a second person, and approving it puts the new prices into use", async () => {
    const proposed = await proposeConsultPrices(db, editor, { prices: { new: 10000, renewal: 50000 }, note: "owner's ₹100" }, T_PROPOSE);
    expect(proposed.pending).toMatchObject({
      approvalStatus: "pending", proposedBy: { id: editor.id, name: "Price Editor" }, note: "owner's ₹100",
      prices: { new: 10000, renewal: 50000, revisit: null },
    });
    expect(proposed.rows[0]!.activePaise).toBe(50000); // not in use yet

    await expect(proposeConsultPrices(db, editor, { prices: { new: 20000 } }, T_PROPOSE)).rejects.toMatchObject({ code: "consult_price_pending" });
    // The proposer cannot approve their own price (requester ≠ approver).
    await expect(decideConsultPrices(db, editor, proposed.pending!.versionId, { approve: true, note: "mine" }, T_DECIDE)).rejects.toThrow();

    const decided = await decideConsultPrices(db, base.owner, proposed.pending!.versionId, { approve: true, note: "approved" }, T_DECIDE);
    expect(decided.pending).toBeNull();
    expect(decided.rows.map((r) => r.activePaise)).toEqual([10000, 50000, null]);
  });

  it("a rejected proposal changes nothing and frees the list for the next one", async () => {
    const proposed = await proposeConsultPrices(db, editor, { prices: { new: 10000 } }, T_PROPOSE);
    const after = await decideConsultPrices(db, base.owner, proposed.pending!.versionId, { approve: false, note: "not yet" }, T_DECIDE);
    expect(after.pending).toBeNull();
    expect(after.rows[0]!.activePaise).toBe(50000);
    await expect(proposeConsultPrices(db, editor, { prices: { new: 12000 } }, T_DECIDE)).resolves.toMatchObject({ pending: { prices: { new: 12000 } } });
  });

  it("refuses a proposal that changes nothing, and a revisit price with no revisit service", async () => {
    await expect(proposeConsultPrices(db, editor, { prices: { new: 50000 } }, T_PROPOSE)).rejects.toMatchObject({ code: "consult_price_unchanged" });
    await expect(proposeConsultPrices(db, editor, { prices: { revisit: 10000 } }, T_PROPOSE)).rejects.toBeInstanceOf(BillingError);
    await expect(proposeConsultPrices(db, editor, { prices: { revisit: 10000 } }, T_PROPOSE)).rejects.toMatchObject({ code: "revisit_fee_unwired" });
  });

  it("a revisit stays FREE while its service is wired but unpriced, or priced at ₹0", async () => {
    await wireRevisit();
    const enc = await revisit();
    expect((await feeQuote(db, enc.id, T_VISIT)).free).toBe(true);
    expect(await feeGate(db, enc)).toEqual({ ok: true });

    await approvedRevisitPrice(0);
    const q = await feeQuote(db, enc.id, T_VISIT);
    expect(q).toMatchObject({ free: true, feesOff: false, feeServiceId: null });
    expect(await feeGate(db, enc)).toEqual({ ok: true });
  });

  it("a revisit priced above ₹0 is CHARGED: the quote prices it and the doctor's door waits for payment", async () => {
    const revisitId = await wireRevisit();
    await approvedRevisitPrice(10000);
    const enc = await revisit();
    const q = await feeQuote(db, enc.id, T_VISIT);
    expect(q).toMatchObject({ free: false, feeServiceId: revisitId });
    expect(q.draft!.lines.map((l) => l.serviceId)).toEqual([revisitId]);
    expect(await feeGate(db, enc)).toMatchObject({ ok: false, code: "fee_unsettled" });
    const statuses = await encounterFeeStatuses(db, [enc]);
    expect(statuses.get(enc.id)).toBe("unsettled");
  });

  it("the consultation fee switch still makes a priced revisit free, and says so", async () => {
    await wireRevisit();
    await approvedRevisitPrice(10000);
    await setFeeSwitch(db, base.owner, "opdConsult", true, new Date("2026-09-01T06:00:00Z"));
    const enc = await revisit();
    expect(await feeQuote(db, enc.id, T_VISIT)).toMatchObject({ free: true, feesOff: true });
    expect(await feeGate(db, enc)).toEqual({ ok: true });
  });

  it("a config patch that names only new and renewal keeps the wired revisit service", async () => {
    const revisitId = await wireRevisit();
    await withTx(db, (tx) => updateBillingConfig(tx, { chargeRules: { opdConsult: { new: base.consultNewServiceId, renewal: base.consultRenewalServiceId } } }));
    expect((await loadBillingConfig(db)).chargeRules.opdConsult.revisit).toBe(revisitId);
  });
});
