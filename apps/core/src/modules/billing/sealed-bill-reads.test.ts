import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase, testCfg } from "../../../test/helpers/billing";
import { ensureRole, mkPatient, mkUser, seedOpdBase } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { patients, phiAccessLog, registrationConfig } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { BillingController } from "./billing.controller";
import type { Db } from "../../kernel/db/client";

/**
 * #858 — every read of a restricted record's bill by a reader WITHOUT the restricted-records grant leaves one
 * `billing.sealed_bill_read` access row: the profile's bill list and one bill in full (already), and now also
 * `GET /billing/invoices/:id` and its `/print`. A reader with the grant, or an ordinary record, leaves none.
 */
describe("#858 the invoice read, its print and its full view log a restricted record's read", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  it("one row per read without the grant; none for an ordinary record or a reader holding the grant", async () => {
    const base = await seedBillingBase(db);
    await seedOpdBase(db); // the printed invoice reads the letterhead from opd_config
    const cashier = await mkCashier(db, "cash1");
    await openSessionFor(db, cashier, 100000);
    const patient = await mkPatient(db, cashier.actor, { name: "Asha Devi" });
    const { invoiceId } = await issuePaidInvoice(db, cashier, { patientId: patient.id, serviceId: base.genericServiceId });

    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await ensureRole(db, "sealed_reader");
    for (const p of ["billing.invoice.read", "patients.confidential.read"]) await grantPermissionToRole(db, registry, "sealed_reader", p);
    const granted = await mkUser(db, "sealed.reader", ["sealed_reader"]);

    const ctl = new BillingController(db, testCfg);
    const rows = () => db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "billing.sealed_bill_read"));
    const readAll = async (actor: typeof cashier.actor): Promise<void> => {
      await ctl.invoice(actor, invoiceId);
      await ctl.print(actor, invoiceId);
      await ctl.invoiceFull(actor, invoiceId);
    };

    await readAll(cashier.actor);
    expect(await rows()).toHaveLength(0);

    await db.update(patients).set({ isConfidential: true, alias: "Patient 9" }).where(eq(patients.id, patient.id));
    await ctl.invoice(cashier.actor, invoiceId);
    expect(await rows()).toHaveLength(1);
    await ctl.print(cashier.actor, invoiceId);
    expect(await rows()).toHaveLength(2);
    await ctl.invoiceFull(cashier.actor, invoiceId);
    const logged = await rows();
    expect(logged).toHaveLength(3);
    expect(logged.every((r) => r.patientId === patient.id && r.actorId === cashier.actor.id && r.sealed)).toBe(true);

    await readAll(granted.actor);
    expect(await rows()).toHaveLength(3);
  });
});
