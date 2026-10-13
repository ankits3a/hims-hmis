import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { receipts, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { BillingError } from "./errors";
import { recordReceipt, recordReceiptInTx, registerReceiptGuard } from "./index";
import type { Db } from "../../kernel/db/client";

/**
 * IPD E1.2 review (RED 3) — the receipt guard seam. A module pushes a guard in; EVERY advance receipt runs it inside
 * the receipt's transaction — the generic `POST /billing/receipts` path (`recordReceipt`) as much as a module's own
 * in-transaction write — and a refusal leaves no receipt behind. Synthetic people and amounts.
 */
jest.setTimeout(60_000);

describe("registerReceiptGuard", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let cashier: { id: string; actor: Actor };
  let patientId: string;
  let unregister: (() => void) | null = null;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await seedBillingBase(db);
    cashier = await mkCashier(db, "guard.cashier");
    await openSessionFor(db, cashier, 0);
    const clerk: Actor = { type: "user", id: "guard-clerk" };
    patientId = (await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Guard Patient", sex: "female", ageYears: 40 }))).patient.id;
  });
  afterEach(() => { unregister?.(); unregister = null; });

  it("the generic receipt path runs the guard in its transaction and writes nothing when it refuses", async () => {
    const seen: { patientId: string; totalPaise: number; purpose: string | null }[] = [];
    unregister = registerReceiptGuard("test", async (_tx, ctx) => {
      seen.push({ patientId: ctx.patientId, totalPaise: ctx.totalPaise, purpose: ctx.purpose });
      throw new BillingError("receipt_guard_refused", "Scheme patients pay nothing unless an approver marks a line non-covered.");
    });
    await expect(recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 50_000 }] }))
      .rejects.toMatchObject({ code: "receipt_guard_refused" });
    expect(seen).toEqual([{ patientId, totalPaise: 50_000, purpose: null }]);
    expect(await db.select().from(receipts)).toHaveLength(0);
  });

  it("the in-transaction variant passes its purpose, and with no guard a receipt is written as before", async () => {
    const purposes: (string | null)[] = [];
    unregister = registerReceiptGuard("test", async (_tx, ctx) => { purposes.push(ctx.purpose); });
    await withTx(db, (tx) => recordReceiptInTx(tx, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 10_000 }] }, new Date(), { purpose: "ipd_deposit" }));
    expect(purposes).toEqual(["ipd_deposit"]);
    unregister();
    unregister = null;
    await expect(recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 10_000 }] })).resolves.toMatchObject({ totalPaise: 10_000 });
    expect(await db.select().from(receipts)).toHaveLength(2);
  });
});
