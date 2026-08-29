import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  couponDefinitions, couponRedemptions, coveredMembers, entitlementCounters, entitlementMovements,
  holderBookImports, importQuarantine, membershipInstances, membershipPlans, patientMatchQueue,
} from "./membership";
import { counterparties } from "./partners";
import { invoices } from "./billing";
import { patients } from "./patients";
import type { Db } from "../client";

/**
 * PLAN 09 T1 — the instrument tables, and the two constraints that carry Assertion Book rows A4
 * and A5: the append-only trigger on the two movement logs, and the partial unique index that
 * stops a single-use coupon being redeemed twice.
 *
 * Every code, name and number below is INVENTED HERE (O-9). A fixture tests a CLASS — a card
 * reissued to a different holder, a coupon redeemed twice, a restore after lapse — and a class
 * does not care which invented name carries it.
 */
const AT = new Date("2026-09-01T09:00:00.000Z");
const FROM = new Date("2026-09-01T00:00:00.000Z");
const TO = new Date("2027-08-31T18:29:59.000Z"); // an IST day boundary, expressed in UTC (K7)

const PARTNER = "01HCP00000000000000PARTNER";
const PLAN = "01HPLAN000000000000000001";
const INSTANCE = "01HINS0000000000000000001";
const PATIENT = "01HPAT0000000000000000001";
const INVOICE = "01HINV0000000000000000001";
const COUPON = "01HCPN0000000000000000001";
const COUNTER = "01HCTR0000000000000000001";

async function seedInstrument(db: Db): Promise<void> {
  await db.insert(patients).values({
    id: PATIENT, uhid: "HMS-00000001-1", name: "Invented Holder", sex: "female", administrativeGender: "female",
    createdBy: "test", updatedBy: "test",
  });
  await db.insert(counterparties).values({
    id: PARTNER, code: "CP-INVENTED-1", name: "Invented Referral House",
    payeeClass: "channel_partner", createdBy: "test",
  });
  await db.insert(membershipPlans).values({
    id: PLAN, code: "PLAN-INVENTED-1", title: "Invented Family Plan", kind: "membership",
    counterpartyId: PARTNER, benefits: { note: "invented" }, entitlements: { note: "invented" },
    familyCap: 4, validityDays: 365, createdBy: "test",
  });
  await db.insert(membershipInstances).values({
    id: INSTANCE, planId: PLAN, counterpartyId: PARTNER, cardCode: "CARD-INVENTED-1",
    patientId: PATIENT, holderName: "Invented Holder", validFrom: FROM, validTo: TO,
    origin: "import", partnerSaleRef: "SALE-INVENTED-1", activatedAt: AT,
  });
  await db.insert(invoices).values({
    id: INVOICE, invoiceNo: "INV-TEST-1", patientId: PATIENT, tariffVersionId: "01HTV00000000000000000001",
    grossPaise: 100000, discountPaise: 0, taxableBasePaise: 100000, cgstPaise: 0, sgstPaise: 0,
    rawTotalPaise: 100000, roundingPaise: 0, netPayablePaise: 100000, issuedBy: "test",
    issuedAt: AT, serviceDay: "2026-09-01",
  });
  await db.insert(couponDefinitions).values({
    id: COUPON, code: "COUPON-INVENTED-1", title: "Invented Coupon", counterpartyId: PARTNER,
    benefit: { note: "invented" }, scope: { note: "invented" }, validFrom: FROM, validTo: TO,
    createdBy: "test",
  });
  await db.insert(entitlementCounters).values({
    id: COUNTER, instanceId: INSTANCE, benefitKey: "invented_benefit", grantedQty: 2,
    validFrom: FROM, validTo: TO,
  });
}

const redemption = (
  over: Partial<typeof couponRedemptions.$inferInsert> = {},
): typeof couponRedemptions.$inferInsert => ({
  id: "01HRED0000000000000000001", couponId: COUPON, state: "redeemed", singleUse: true,
  patientId: PATIENT, invoiceId: INVOICE, amountPaise: 5000, actorId: "u1", ...over,
});

describe("the membership tables (Plan 09 T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await seedInstrument(db);
  });

  // ────────────────────────── DD5 — the movement logs are append-only ──────────────────────────

  /**
   * A4, on the membership side of the trigger set. Both UPDATE and DELETE, because a trigger
   * attached for UPDATE alone would let a consume be un-done by a DELETE and leave no trace.
   */
  it("A4: an entitlement movement cannot be UPDATED or DELETED — a restore is a NEGATING ROW", async () => {
    await db.insert(entitlementMovements).values({
      id: "01HMOV0000000000000000001", counterId: COUNTER, delta: -1, kind: "consume",
      invoiceId: INVOICE, actorId: "u1",
    });
    await expect(
      db.update(entitlementMovements).set({ delta: 0 }).where(eq(entitlementMovements.id, "01HMOV0000000000000000001")),
    ).rejects.toThrow(/partner_ledger_immutable/);
    await expect(
      db.delete(entitlementMovements).where(eq(entitlementMovements.id, "01HMOV0000000000000000001")),
    ).rejects.toThrow(/partner_ledger_immutable/);

    // So a restore is a second row naming the first, and REMAINING IS THE SUM — which is why the
    // counter carries no `remaining` column for the two to disagree about (DD10).
    await db.insert(entitlementMovements).values({
      id: "01HMOV0000000000000000002", counterId: COUNTER, delta: 1, kind: "restore",
      invoiceId: INVOICE, reversalOfId: "01HMOV0000000000000000001", lapsedRestore: true,
      reason: "credit note on the consuming line", actorId: "u1",
    });
    const movements = await db.select().from(entitlementMovements);
    const [counter] = await db.select().from(entitlementCounters);
    expect(counter!.grantedQty + movements.reduce((s, m) => s + m.delta, 0)).toBe(2);
    // C5 — a restore after the counter's own validity lapsed happens ANYWAY and is FLAGGED, because
    // refusing it would silently keep money the patient received no value for.
    expect(movements.filter((m) => m.lapsedRestore).map((m) => m.kind)).toEqual(["restore"]);
  });

  it("A4: a coupon redemption cannot be UPDATED or DELETED either", async () => {
    await db.insert(couponRedemptions).values(redemption());
    await expect(
      db.update(couponRedemptions).set({ state: "released" }).where(eq(couponRedemptions.id, redemption().id)),
    ).rejects.toThrow(/partner_ledger_immutable/);
    await expect(
      db.delete(couponRedemptions).where(eq(couponRedemptions.id, redemption().id)),
    ).rejects.toThrow(/partner_ledger_immutable/);
  });

  // ─────────────────── DD10 — the belt behind the lock: the single-use index ───────────────────

  /**
   * A5. The lock is the mechanism and the index is what survives a future writer who forgets it —
   * the spike measured the index firing 10/10 with the lock removed (§3 Q6). This is the index's
   * own assertion, taken without any lock at all.
   */
  it("A5: a single-use coupon cannot carry two REDEEMED rows at once", async () => {
    await db.insert(couponRedemptions).values(redemption());
    await expect(
      db.insert(couponRedemptions).values(redemption({ id: "01HRED0000000000000000002" })),
    ).rejects.toThrow(/coupon_redemptions_single_use_uq/);
    expect(await db.select().from(couponRedemptions)).toHaveLength(1);
  });

  it("a NOT-single-use coupon may be redeemed as often as it likes — the index is partial", async () => {
    // The other side of the predicate. Without this leg, an index that refused EVERY second
    // redemption would pass A5 and quietly break every multi-use coupon the hospital ever issues.
    await db.insert(couponRedemptions).values([
      redemption({ id: "01HRED0000000000000000003", singleUse: false }),
      redemption({ id: "01HRED0000000000000000004", singleUse: false }),
    ]);
    expect(await db.select().from(couponRedemptions)).toHaveLength(2);
  });

  /**
   * O-4's release, and the reason `cycle_no` exists at all (see schema/membership.ts's header).
   * A release is a ROW because the table is append-only; the released coupon must then be
   * redeemable again, which is what the cycle in the index key buys. Both halves are asserted
   * here because either alone is a different, wrong design.
   */
  it("a released coupon can be redeemed again, on the next cycle, with nothing updated", async () => {
    await db.insert(couponRedemptions).values(redemption());
    await db.insert(couponRedemptions).values(
      redemption({
        id: "01HRED0000000000000000005", state: "released", releasedOfId: redemption().id,
        reason: "invoice entered in error", amountPaise: 0,
      }),
    );
    // Cycle 0 is spent — the released row does not free the SAME cycle, and it must not: that is
    // what stops a release being a licence to re-redeem the row it released.
    await expect(
      db.insert(couponRedemptions).values(redemption({ id: "01HRED0000000000000000006" })),
    ).rejects.toThrow(/coupon_redemptions_single_use_uq/);
    // The next cycle is free, which is O-4: the member is not punished for the hospital's own
    // correction of a sale that did not happen.
    await db.insert(couponRedemptions).values(redemption({ id: "01HRED0000000000000000007", cycleNo: 1 }));
    const rows = await db.select().from(couponRedemptions);
    expect(rows.map((r) => `${r.cycleNo}:${r.state}`).sort()).toEqual([
      "0:redeemed", "0:released", "1:redeemed",
    ]);
  });

  // ──────────────────── E1 — the card code is not the key, and that was measured ────────────────────

  it("the SAME card code may be reissued to a different holder; the partner's sale ref may not repeat", async () => {
    // E1's discriminating input, in the schema: a partner reissues a card number. A unique index on
    // `card_code` would have refused the correct row, so the idempotency key is
    // `(counterparty_id, partner_sale_ref)` and the card code carries an ordinary index.
    await db.insert(membershipInstances).values({
      id: "01HINS0000000000000000002", planId: PLAN, counterpartyId: PARTNER,
      cardCode: "CARD-INVENTED-1", holderName: "A Different Invented Holder",
      validFrom: FROM, validTo: TO, origin: "import", partnerSaleRef: "SALE-INVENTED-2",
    });
    expect(await db.select().from(membershipInstances)).toHaveLength(2);

    await expect(
      db.insert(membershipInstances).values({
        id: "01HINS0000000000000000003", planId: PLAN, counterpartyId: PARTNER,
        cardCode: "CARD-INVENTED-9", holderName: "Invented Holder", validFrom: FROM, validTo: TO,
        origin: "import", partnerSaleRef: "SALE-INVENTED-1",
      }),
    ).rejects.toThrow(/membership_instances_sale_ref_ux/);

    // …and a hospital-direct instance with NO sale reference is not caught by that index, because
    // NULLs are distinct. Two of them are two ordinary rows, not a duplicate.
    await db.insert(membershipInstances).values([
      { id: "01HINS0000000000000000004", planId: PLAN, cardCode: "CARD-INVENTED-10", holderName: "X", validFrom: FROM, validTo: TO, origin: "counter" },
      { id: "01HINS0000000000000000005", planId: PLAN, cardCode: "CARD-INVENTED-11", holderName: "Y", validFrom: FROM, validTo: TO, origin: "counter" },
    ]);
    expect(await db.select().from(membershipInstances)).toHaveLength(4);
  });

  it("an imported holder may have NO patient yet — the queue holds candidates, never a link (E3)", async () => {
    const unmatched = {
      id: "01HINS0000000000000000006", planId: PLAN, counterpartyId: PARTNER,
      cardCode: "CARD-INVENTED-2", holderName: "Invented Unmatched Holder", validFrom: FROM,
      validTo: TO, origin: "import" as const, partnerSaleRef: "SALE-INVENTED-3",
    };
    await db.insert(membershipInstances).values(unmatched);
    const [row] = await db.select().from(membershipInstances).where(eq(membershipInstances.id, unmatched.id));
    expect(row!.patientId).toBeNull(); // null = NOT MATCHED, never "missing"
    expect(row!.verified).toBe(false); // C-17 — nothing accrues until a book row is verified

    await db.insert(patientMatchQueue).values({
      id: "01HQUE0000000000000000001", instanceId: unmatched.id, reason: "fuzzy_match",
      candidates: [{ patientId: PATIENT, score: 0.91, why: "name+phone" }],
    });
    const [queued] = await db.select().from(patientMatchQueue);
    expect(queued!.state).toBe("open");
    expect(queued!.resolvedPatientId).toBeNull();
    // The link is a HUMAN's decision, and the FK means that decision can never name a patient who
    // does not exist.
    await expect(
      db.update(patientMatchQueue).set({ resolvedPatientId: "01HPAT000000000000NOSUCH" })
        .where(eq(patientMatchQueue.id, "01HQUE0000000000000000001")),
    ).rejects.toThrow();
    await db.update(patientMatchQueue)
      .set({ state: "resolved", resolvedPatientId: PATIENT, resolvedBy: "u1", resolvedAt: AT })
      .where(eq(patientMatchQueue.id, "01HQUE0000000000000000001"));
    expect((await db.select().from(patientMatchQueue))[0]!.resolvedPatientId).toBe(PATIENT);
  });

  it("over-cap members are RECORDED and flagged, never dropped (O-5)", async () => {
    // The plan's cap is four; the invented drop carries five. The fifth is honoured = false and the
    // overflow's provenance rides the instance, because "the member paid; the overflow is the
    // partner's data error" and quarantining the row would make a paying family invisible.
    await db.insert(coveredMembers).values(
      [1, 2, 3, 4, 5].map((n) => ({
        id: `01HMEM000000000000000000${n}`, instanceId: INSTANCE, memberNo: n,
        name: `Invented Member ${n}`, honoured: n <= 4, sourceRowNo: n,
      })),
    );
    await db.update(membershipInstances)
      .set({ capOverflow: { cap: 4, received: 5, overflowRows: [5] } })
      .where(eq(membershipInstances.id, INSTANCE));
    const members = await db.select().from(coveredMembers);
    expect(members.filter((m) => m.honoured)).toHaveLength(4);
    expect(members.filter((m) => !m.honoured).map((m) => m.memberNo)).toEqual([5]);
    // Member numbers are the FILE's own row order, which is what makes two imports of one drop
    // honour the same people — and the index says so at the database layer.
    await expect(
      db.insert(coveredMembers).values({
        id: "01HMEM0000000000000000006", instanceId: INSTANCE, memberNo: 1, name: "Invented Clash",
      }),
    ).rejects.toThrow(/covered_members_instance_no_ux/);
  });

  it("an import batch is named once per file, and its quarantined rows hold NO foreign key", async () => {
    await db.insert(holderBookImports).values({
      id: "01HIMP0000000000000000001", counterpartyId: PARTNER, fileName: "invented-drop.csv",
      fileHash: "sha256:invented", columnMapVersion: "v1", rowsTotal: 3, rowsAccepted: 1,
      rowsQuarantined: 2, importedBy: "u1",
    });
    await expect(
      db.insert(holderBookImports).values({
        id: "01HIMP0000000000000000002", counterpartyId: PARTNER, fileName: "invented-drop-resent.csv",
        fileHash: "sha256:invented", columnMapVersion: "v1", importedBy: "u1",
      }),
    ).rejects.toThrow(/holder_book_imports_file_ux/);

    // E2 — a duplicate key quarantines BOTH rows, with the reason, and neither wins. The batch id
    // is plain text with no FK (see the schema header), so this row survives its batch and can
    // carry a partner STATEMENT's line when T7 lands.
    await db.insert(importQuarantine).values([
      { id: "01HQAR0000000000000000001", source: "holder_book", batchId: "01HIMP0000000000000000001", rowNo: 2, reason: "duplicate_key", raw: { card: "CARD-INVENTED-3" } },
      { id: "01HQAR0000000000000000002", source: "holder_book", batchId: "01HIMP0000000000000000001", rowNo: 3, reason: "duplicate_key", raw: { card: "CARD-INVENTED-3" } },
      { id: "01HQAR0000000000000000003", source: "partner_statement", batchId: "STMT-INVENTED-1", rowNo: 4, reason: "unknown_columns", raw: { line: "…" } },
    ]);
    const quarantined = await db.select().from(importQuarantine);
    expect(quarantined.filter((q) => q.reason === "duplicate_key")).toHaveLength(2);
    expect(quarantined.map((q) => q.source).sort()).toEqual(["holder_book", "holder_book", "partner_statement"]);
  });
});
