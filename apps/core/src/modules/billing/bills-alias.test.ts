import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { issueDuesInvoice, issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase, testCfg } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { useBreakGlass } from "../../kernel/auth/break-glass";
import { withTx } from "../../kernel/db/client";
import { registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { billsAliasRows } from "./bills-alias";
import type { Db } from "../../kernel/db/client";

/**
 * #852 — board §4's bill rows on a SEALED record the reader may not open: date, bill number and
 * where it stands. No amount, no line, no payer — and nothing at all for a record the reader can
 * open (the full bill reads already serve that), an absent id, or an agent credential.
 */
describe("#852 billsAliasRows", () => {
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
    cashier = await mkCashier(db, "ba_cashier");
    await openSessionFor(db, cashier, 100_000);
  });

  const patient = async (sealed: boolean): Promise<string> => {
    const clerk: Actor = { type: "user", id: "ba-clerk" };
    const { patient: p } = await withTx(db, (tx) => registerPatient(tx, clerk, {
      name: "Sealed Bill Name", sex: "female", ageYears: 50, phone: "9811200001",
      ...(sealed ? { isConfidential: true, alias: "R-852" } : {}),
    }));
    return p.id;
  };

  it("a sealed record: every bill as date, number and status only — no amounts on the wire", async () => {
    const id = await patient(true);
    const paid = await issuePaidInvoice(db, cashier, { patientId: id, serviceId: base.genericServiceId });
    const due = await issueDuesInvoice(db, cashier, { patientId: id, serviceId: base.genericServiceId });

    const rows = await billsAliasRows(db, cashier.actor, id, { unsettledOnly: false });
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => Object.keys(r).sort())).toEqual([["date", "invoiceNo", "status"], ["date", "invoiceNo", "status"]]);
    expect(new Set(rows!.map((r) => r.invoiceNo))).toEqual(new Set([paid.invoiceNo, due.invoiceNo]));
    expect(rows!.find((r) => r.invoiceNo === paid.invoiceNo)?.status).toBe("settled");
    expect(rows!.find((r) => r.invoiceNo === due.invoiceNo)?.status).toBe("unpaid");
    for (const r of rows!) expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const wire = JSON.stringify(rows);
    expect(wire).not.toMatch(/paise/i);
    for (const leak of ["Sealed Bill Name", "9811200001", String(paid.totals.netPayablePaise), paid.invoiceId]) expect(wire).not.toContain(leak);
  });

  it("the front desk's narrow dues grant reads only what it reads elsewhere: the unsettled bills", async () => {
    const id = await patient(true);
    await issuePaidInvoice(db, cashier, { patientId: id, serviceId: base.genericServiceId });
    const due = await issueDuesInvoice(db, cashier, { patientId: id, serviceId: base.genericServiceId });
    const rows = await billsAliasRows(db, cashier.actor, id, { unsettledOnly: true });
    expect(rows).toEqual([expect.objectContaining({ invoiceNo: due.invoiceNo, status: "unpaid" })]);
  });

  it("refuses (null) a record the reader CAN open, a broken glass, an absent id and an agent", async () => {
    const open = await patient(false);
    await issuePaidInvoice(db, cashier, { patientId: open, serviceId: base.genericServiceId });
    expect(await billsAliasRows(db, cashier.actor, open, { unsettledOnly: false })).toBeNull();

    const sealed = await patient(true);
    await useBreakGlass(db, testCfg, cashier.actor, { patientId: sealed, reason: "emergency billing" });
    expect(await billsAliasRows(db, cashier.actor, sealed, { unsettledOnly: false })).toBeNull();

    expect(await billsAliasRows(db, cashier.actor, "01NOSUCH00000000000000000", { unsettledOnly: false })).toBeNull();
    expect(await billsAliasRows(db, { type: "agent", id: "relay" } as Actor, sealed, { unsettledOnly: false })).toBeNull();
  });
});
