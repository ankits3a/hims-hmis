import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { registrationConfig } from "../../kernel/db/schema";
import { issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { mkPatient } from "../../../test/helpers/opd";
import { parseSearchQuery } from "@hmis/contracts";
import { invoiceSearchProvider } from "./search-provider";
import type { Actor, SearchChip } from "@hmis/contracts";
import type { SearchProviderResult } from "../../kernel/search/types";
import type { Db } from "../../kernel/db/client";

describe("billing invoice search provider", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    // `seedBillingBase` seeds billing and tariff; UHID allocation is the patients module's own
    // precondition and no billing fixture owns it.
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  async function run(actor: Actor, text: string, chips: SearchChip[] = [], limit = 5): Promise<SearchProviderResult> {
    const query = { ...parseSearchQuery(text, limit), chips };
    return invoiceSearchProvider.run({ db, actor, query, limit, signal: new AbortController().signal });
  }

  it("finds an invoice by its NUMBER and by the PATIENT, in one query", async () => {
    const base = await seedBillingBase(db);
    const cashier = await mkCashier(db, "cash1");
    await openSessionFor(db, cashier, 100000); // a cashier issues from an OPEN session (Plan 08)
    const patient = await mkPatient(db, cashier.actor, { name: "Asha Devi" });
    const issued = await issuePaidInvoice(db, cashier, { patientId: patient.id, serviceId: base.genericServiceId });

    const byNumber = await run(cashier.actor, issued.invoiceNo);
    expect(byNumber.hits.map((h) => h.title)).toEqual([issued.invoiceNo]);

    // The same desk, thirty seconds later, holding a person instead of a printed bill.
    const byPatient = await run(cashier.actor, "asha");
    expect(byPatient.hits.map((h) => h.title)).toEqual([issued.invoiceNo]);
    expect(byPatient.hits[0]?.subtitle).toContain("Asha Devi");
  });

  it("carries the amount as PAISE and never as a formatted rupee string", async () => {
    const base = await seedBillingBase(db);
    const cashier = await mkCashier(db, "cash1");
    await openSessionFor(db, cashier, 100000); // a cashier issues from an OPEN session (Plan 08)
    const patient = await mkPatient(db, cashier.actor);
    const issued = await issuePaidInvoice(db, cashier, { patientId: patient.id, serviceId: base.genericServiceId });

    const hit = (await run(cashier.actor, issued.invoiceNo)).hits[0]!;
    // Money has exactly one implementation and one formatter (§15, Plan 06). A provider that
    // divided by 100 here would be a second one.
    expect(hit.meta?.netPayablePaise).toBe(String(issued.totals.netPayablePaise));
    expect(JSON.stringify(hit)).not.toContain("₹");
  });

  it("A CONFIDENTIAL PATIENT'S INVOICES ARE UNREACHABLE by the text lane — the gate is not re-implemented", async () => {
    const base = await seedBillingBase(db);
    const cashier = await mkCashier(db, "cash1");
    await openSessionFor(db, cashier, 100000); // a cashier issues from an OPEN session (Plan 08)
    const vip = await mkPatient(db, cashier.actor, { name: "Asha Confidential", phone: "9111111111", isConfidential: true, alias: "Guest One" });
    await issuePaidInvoice(db, cashier, { patientId: vip.id, serviceId: base.genericServiceId });

    const res = await run(cashier.actor, "asha");

    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("a patient chip needs no text", async () => {
    const base = await seedBillingBase(db);
    const cashier = await mkCashier(db, "cash1");
    await openSessionFor(db, cashier, 100000); // a cashier issues from an OPEN session (Plan 08)
    const patient = await mkPatient(db, cashier.actor);
    await issuePaidInvoice(db, cashier, { patientId: patient.id, serviceId: base.genericServiceId });

    const chips: SearchChip[] = [{ entity: "patient", id: patient.id, label: "Asha" }];
    expect((await run(cashier.actor, "", chips)).total).toBe(1);
  });

  it("a one-character query runs nothing", async () => {
    await seedBillingBase(db);
    const cashier = await mkCashier(db, "cash1");
    await openSessionFor(db, cashier, 100000); // a cashier issues from an OPEN session (Plan 08)
    expect(await run(cashier.actor, "a")).toEqual({ hits: [], total: 0 });
  });
});
