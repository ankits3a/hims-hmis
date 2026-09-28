import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { issuePaidInvoiceByTender, mkBillingManager, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { approveRequest } from "../../kernel/approvals/decisions";
import { withTx } from "../../kernel/db/client";
import { approvals, events, receiptTenders, reconResolutions, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { uploadSettlement } from "./recon";
import { RECON_CHARGE_MANAGER_MAX_PAISE, resolveMismatch } from "./recon-resolve";
import type { Db } from "../../kernel/db/client";

/**
 * UX-AUDIT 2026-09-28 · BOARD — deciding a settlement mismatch (dispute / bank charge / wrong statement
 * row), and OWNER RULING 2026-09-28: the billing manager writes off at most ₹50.00 per receipt as a bank
 * charge; above that only the owner's granted `billing_recon_charge_owner` applies it.
 *
 * THE FIXTURE (recon.test.ts's own): one card tender of 50000 paise, fee 150 bps → expected-net
 * 49250 (stamped at capture), tolerance 100. A statement row settling S makes the shortfall 49250 − S:
 *   S = 48000 → 1250 (₹12.50, the board's example)   · S = 44250 → 5000 (₹50.00, the line itself)
 *   S = 44249 → 5001 (one paisa over the line)       · S = 49500 → −250 (over-settled)
 */
describe("recon-resolve.ts: deciding a settlement mismatch (board) under the owner's ₹50.00 line", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  const NOW = new Date("2026-08-19T06:00:00Z");
  const OFFICE: Actor = { type: "user", id: "recon-office" };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  let n = 0;
  /** A card tender settled at `settledPaise` by an uploaded statement — mismatched unless within 100 of 49250. */
  async function mismatched(settledPaise: number): Promise<{ tenderId: string; patientId: string }> {
    n += 1;
    const cashier = await mkCashier(db, `cashier-resolve-${String(n)}`);
    await openSessionFor(db, cashier, 100_000);
    const { patient } = await withTx(db, (tx) => registerPatient(tx, { type: "user", id: "clerk" }, { name: `Resolve ${String(n)}`, sex: "male", ageYears: 50 }));
    const ref = `CARD-RES-${String(n)}`;
    const paid = await issuePaidInvoiceByTender(db, cashier, { patientId: patient.id, serviceId: base.consultNewServiceId, mode: "card", refText: ref });
    await uploadSettlement(db, OFFICE, { csv: `ref,settledPaise,settledOn\n${ref},${String(settledPaise)},2026-08-19`, source: "card" }, NOW);
    const [tender] = await db.select().from(receiptTenders).where(eq(receiptTenders.receiptId, paid.receiptId!));
    return { tenderId: tender!.id, patientId: patient.id };
  }

  const stateOf = async (tenderId: string): Promise<string> =>
    (await db.select().from(receiptTenders).where(eq(receiptTenders.id, tenderId)))[0]!.state;

  test("the owner's line is ₹50.00", () => {
    expect(RECON_CHARGE_MANAGER_MAX_PAISE).toBe(5_000);
  });

  test("dispute: the tender stays mismatched, the decision and a tender.resolved event are written, a second dispute is refused", async () => {
    const { tenderId } = await mismatched(48_000);
    const r = await resolveMismatch(db, OFFICE, { tenderId, outcome: "dispute", reason: "raised with HDFC" }, NOW);
    expect(r).toMatchObject({ status: "resolved", outcome: "dispute", shortPaise: 1_250, state: "mismatched" });
    expect(await stateOf(tenderId)).toBe("mismatched");
    const rows = await db.select().from(reconResolutions).where(eq(reconResolutions.tenderId, tenderId));
    expect(rows).toEqual([expect.objectContaining({ outcome: "disputed", shortPaise: 1_250, settledPaise: 48_000, reason: "raised with HDFC", actorId: "recon-office", approvalId: null })]);
    const ev = await db.select().from(events).where(eq(events.name, "tender.resolved"));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ tenderId, outcome: "disputed", shortPaise: 1_250, approvalId: null });

    await expect(resolveMismatch(db, OFFICE, { tenderId, outcome: "dispute", reason: "again" }, NOW)).rejects.toMatchObject({ code: "recon_already_disputed" });
  });

  test("bank charge at or under ₹50.00: the office writes it off itself — ₹12.50 and exactly ₹50.00 reconcile with no approval", async () => {
    for (const settled of [48_000, 44_250]) {
      const { tenderId } = await mismatched(settled);
      const r = await resolveMismatch(db, OFFICE, { tenderId, outcome: "bank_charge", reason: "MDR difference" }, NOW);
      expect(r).toMatchObject({ status: "resolved", outcome: "bank_charge", shortPaise: 49_250 - settled, state: "reconciled" });
      expect(await stateOf(tenderId)).toBe("reconciled");
    }
    expect(await db.select().from(approvals).where(eq(approvals.typeKey, "billing_recon_charge_owner"))).toHaveLength(0);
    const charges = await db.select().from(reconResolutions).where(eq(reconResolutions.outcome, "bank_charge"));
    expect(charges.map((c) => c.shortPaise).sort((a, b) => a - b)).toEqual([1_250, 5_000]);
  });

  test("OWNER RULING 2026-09-28: one paisa over ₹50.00 asks the OWNER and changes nothing until the owner's grant is carried", async () => {
    const { tenderId, patientId } = await mismatched(44_249); // short 5001
    const first = await resolveMismatch(db, OFFICE, { tenderId, outcome: "bank_charge", reason: "bank kept more than its fee" }, NOW);
    expect(first).toMatchObject({ status: "awaiting_owner", shortPaise: 5_001 });
    if (first.status !== "awaiting_owner") throw new Error("expected the owner to be asked");
    expect(await stateOf(tenderId)).toBe("mismatched");
    expect(await db.select().from(reconResolutions)).toHaveLength(0);
    const [asked] = await db.select().from(approvals).where(eq(approvals.id, first.approvalId));
    expect(asked!).toMatchObject({
      typeKey: "billing_recon_charge_owner", approverRole: "owner", subjectType: "receipt_tender", subjectId: tenderId,
      patientId, amountPaise: 5_001, status: "pending",
    });

    // Asking again files nothing new.
    const again = await resolveMismatch(db, OFFICE, { tenderId, outcome: "bank_charge", reason: "asking again" }, NOW);
    expect(again).toMatchObject({ status: "awaiting_owner", approvalId: first.approvalId });
    expect(await db.select().from(approvals).where(eq(approvals.typeKey, "billing_recon_charge_owner"))).toHaveLength(1);

    // Pending is not granted.
    await expect(resolveMismatch(db, OFFICE, { tenderId, outcome: "bank_charge", reason: "x", approvalId: first.approvalId }, NOW))
      .rejects.toMatchObject({ code: "approval_not_granted" });
    // A billing manager cannot decide the owner's question.
    const manager = await mkBillingManager(db, "manager-recon-charge");
    await expect(approveRequest(db, manager.actor, { approvalId: first.approvalId, note: "manager tries" })).rejects.toThrow();
    expect(await stateOf(tenderId)).toBe("mismatched");

    await approveRequest(db, base.owner, { approvalId: first.approvalId, note: "owner accepts the charge" });
    // After the owner's yes, pressing the act again applies THAT grant — no id to carry by hand.
    const applied = await resolveMismatch(db, OFFICE, { tenderId, outcome: "bank_charge", reason: "owner accepted" }, NOW);
    expect(applied).toMatchObject({ status: "resolved", state: "reconciled", shortPaise: 5_001 });
    expect(await stateOf(tenderId)).toBe("reconciled");
    const [row] = await db.select().from(reconResolutions).where(eq(reconResolutions.tenderId, tenderId));
    expect(row!).toMatchObject({ outcome: "bank_charge", shortPaise: 5_001, approvalId: first.approvalId });
  });

  test("OWNER RULING 2026-09-28: an owner's grant for another tender or another amount does not apply", async () => {
    const a = await mismatched(40_000); // short 9250
    const b = await mismatched(41_000); // short 8250
    const askA = await resolveMismatch(db, OFFICE, { tenderId: a.tenderId, outcome: "bank_charge", reason: "a" }, NOW);
    if (askA.status !== "awaiting_owner") throw new Error("expected the owner to be asked");
    await approveRequest(db, base.owner, { approvalId: askA.approvalId, note: "owner accepts a" });
    await expect(resolveMismatch(db, OFFICE, { tenderId: b.tenderId, outcome: "bank_charge", reason: "b", approvalId: askA.approvalId }, NOW))
      .rejects.toMatchObject({ code: "approval_subject_mismatch" });
    expect(await stateOf(b.tenderId)).toBe("mismatched");
  });

  test("a bank charge needs a SHORT settlement; an over-settled row is refused", async () => {
    const { tenderId } = await mismatched(49_500);
    await expect(resolveMismatch(db, OFFICE, { tenderId, outcome: "bank_charge", reason: "x" }, NOW)).rejects.toMatchObject({ code: "not_short_settled" });
    expect(await stateOf(tenderId)).toBe("mismatched");
  });

  test("wrong statement row: the tender returns to captured and the corrected statement reconciles it", async () => {
    const { tenderId } = await mismatched(48_000);
    const r = await resolveMismatch(db, OFFICE, { tenderId, outcome: "reupload", reason: "row belonged to another day" }, NOW);
    expect(r).toMatchObject({ status: "resolved", state: "captured" });
    const [back] = await db.select().from(receiptTenders).where(eq(receiptTenders.id, tenderId));
    expect(back!).toMatchObject({ state: "captured", settledPaise: null, reconciledAt: null, mismatchNote: null });
    const ref = `CARD-RES-${String(n)}`;
    const second = await uploadSettlement(db, OFFICE, { csv: `ref,settledPaise,settledOn\n${ref},49250,2026-08-20`, source: "card" }, NOW);
    expect(second).toMatchObject({ rowsMatched: 1, rowsMismatched: 0 });
    expect(await stateOf(tenderId)).toBe("reconciled");
  });

  test("only a mismatched tender can be decided", async () => {
    const { tenderId } = await mismatched(49_250); // within tolerance → reconciled
    expect(await stateOf(tenderId)).toBe("reconciled");
    await expect(resolveMismatch(db, OFFICE, { tenderId, outcome: "dispute", reason: "x" }, NOW)).rejects.toMatchObject({ code: "tender_not_mismatched" });
    await expect(resolveMismatch(db, OFFICE, { tenderId: "no-such", outcome: "dispute", reason: "x" }, NOW)).rejects.toMatchObject({ code: "unknown_tender" });
  });
});
