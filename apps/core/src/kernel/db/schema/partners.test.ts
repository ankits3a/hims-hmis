import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  attributionIds, commissionAccrualSubjects, commissionAccruals, counterparties, partnerAgreements,
  partnerRefMap, receivableExpectations,
} from "./partners";
import { invoices } from "./billing";
import { patients } from "./patients";
import type { Db } from "../client";

/**
 * PLAN 09 T1 — the partner tables, and above all the three constraints that make C-1 structural.
 *
 * Assertion Book rows A1, A2 and A4 are pinned here BY EXECUTION against the real migration, not
 * by reading the DDL: the spike measured (§3 Q1) that all four bypass probes are refused, and this
 * file is where that measurement becomes a standing one. A3 is STRUCK — the composite FK already
 * refuses a parent-side class change, so there is no trigger to test and the property rides A2's
 * constraint; the last test below asserts it anyway, because "there is nothing to test" and "the
 * property does not hold" look identical in a suite that omits it.
 *
 * Every name, code and number below is INVENTED HERE (O-9). Nothing is transcribed from anywhere.
 */
const AT = new Date("2026-09-01T09:00:00.000Z");
const PARTNER = "01HCP00000000000000PARTNER";
const RMP = "01HCP0000000000000000RMP01";
const AGREEMENT = "01HAG0000000000000000AGR01";

/** The three classes, and the two facts about them this file exists to hold apart. */
async function seedCounterparties(db: Db): Promise<void> {
  await db.insert(counterparties).values([
    { id: PARTNER, code: "CP-INVENTED-1", name: "Invented Referral House", payeeClass: "channel_partner", createdBy: "test" },
    { id: RMP, code: "RMP-INVENTED-1", name: "Invented Referring Doctor", payeeClass: "external_rmp", createdBy: "test" },
  ]);
  await db.insert(partnerAgreements).values({
    id: AGREEMENT, counterpartyId: PARTNER, versionNo: 1, effectiveFrom: AT,
    terms: { note: "invented terms — the real ones are config rows loaded at commissioning" },
    status: "active", createdBy: "test",
  });
}

const accrual = (
  over: Partial<typeof commissionAccruals.$inferInsert> = {},
): typeof commissionAccruals.$inferInsert => ({
  id: "01HACC000000000000000ROW1",
  counterpartyId: PARTNER,
  payeeClass: "channel_partner",
  agreementId: AGREEMENT,
  direction: "payable",
  kind: "accrual",
  amountPaise: 50000,
  rateSnapshot: { note: "invented" },
  occurredAt: AT,
  ...over,
});

describe("the partner tables (Plan 09 T1)", () => {
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
    await seedCounterparties(db);
  });

  // ───────────────────── C-1 / DD4 — external_rmp is un-payable, by the DATABASE ─────────────────────

  /**
   * A1. The honest attempt: a payable row naming an `external_rmp` counterparty, with the class
   * copied honestly from the parent. The CHECK refuses it.
   *
   * This is the assertion C-1 asks for in as many words — "un-payable at the schema level (no
   * payout path), not by convention" — and it is the one a reviewer should read first.
   */
  it("A1: refuses a PAYABLE accrual naming an external_rmp counterparty (the CHECK)", async () => {
    await expect(
      db.insert(commissionAccruals).values(accrual({ counterpartyId: RMP, payeeClass: "external_rmp" })),
    ).rejects.toThrow(/commission_accruals_payable_class_ck/);
    expect(await db.select().from(commissionAccruals)).toHaveLength(0);
  });

  /**
   * A2. The forgery: name the RMP, but write a payable class onto the ledger row. The CHECK is
   * satisfied — the row SAYS `channel_partner` — and the composite FK is what refuses it, because
   * the pair `(rmp id, channel_partner)` does not exist in `counterparties`.
   */
  it("A2: refuses a payable row whose class DISAGREES with its counterparty's (the composite FK)", async () => {
    await expect(
      db.insert(commissionAccruals).values(accrual({ counterpartyId: RMP, payeeClass: "channel_partner" })),
    ).rejects.toThrow(/commission_accruals_counterparty_class_fk/);
    expect(await db.select().from(commissionAccruals)).toHaveLength(0);
  });

  it("a RECEIVABLE from an external RMP is legitimate and inserts — the block is one-directional", async () => {
    // DD4's other half, and it matters: an external-RMP counterparty may EXIST, and money owed TO
    // US by one is an ordinary claim. What cannot exist is money owed to them. A guard that
    // refused both would have made this ledger unable to record the very referrals it is for.
    await db.insert(commissionAccruals).values(
      accrual({ id: "01HACC00000000000000RECV1", counterpartyId: RMP, payeeClass: "external_rmp", direction: "receivable" }),
    );
    const rows = await db.select().from(commissionAccruals);
    expect(rows.map((r) => [r.direction, r.payeeClass])).toEqual([["receivable", "external_rmp"]]);
  });

  /**
   * ~~A3~~ — STRUCK by the plan, and asserted anyway. §3 Q1 measured that Postgres refuses the
   * parent-side class change from the FK ITSELF, because the default `ON UPDATE NO ACTION` is
   * checked in both directions: `update or delete on table "counterparties" violates foreign key
   * constraint … Key (id, payee_class)=(…, channel_partner) is still referenced`.
   *
   * There is no trigger to mutate, so there is no Book row — but a property nobody asserts is
   * indistinguishable from a property that has quietly stopped holding, and this one is the reason
   * the plan could delete a whole guard. The consequence is O-7's, and it is stated in the schema:
   * a counterparty's class is FROZEN while any accrual row exists, so `terminated` is a change to
   * `status` and must never be implemented as a change of class.
   */
  it("A3 (struck, asserted): a counterparty's class cannot change while an accrual points at it", async () => {
    await db.insert(commissionAccruals).values(accrual());
    await expect(
      db.update(counterparties).set({ payeeClass: "external_rmp" }).where(eq(counterparties.id, PARTNER)),
    ).rejects.toThrow(/commission_accruals_counterparty_class_fk/);
    // …and this is the operation O-7 actually wants, which is untouched by the freeze.
    await db.update(counterparties).set({ status: "suspended" }).where(eq(counterparties.id, PARTNER));
    const [row] = await db.select().from(counterparties).where(eq(counterparties.id, PARTNER));
    expect([row!.status, row!.payeeClass]).toEqual(["suspended", "channel_partner"]);
  });

  it("refuses a counterparty whose class is not one of the three", async () => {
    await expect(
      db.insert(counterparties).values({
        id: "01HCP0000000000000000BAD1", code: "CP-BAD", name: "Invented", payeeClass: "doctor", createdBy: "test",
      }),
    ).rejects.toThrow(/counterparties_payee_class_ck/);
  });

  // ─────────────────────────── DD5 — the ledger is append-only, by trigger ───────────────────────────

  /**
   * A4. `partner_ledger_forbid_mutation()` raises on BEFORE UPDATE OR DELETE. Both halves are
   * asserted, because a trigger attached for UPDATE alone would let a reversal be a DELETE.
   */
  it("A4: an accrual row cannot be UPDATED or DELETED — the ledger is a stream of deltas", async () => {
    await db.insert(commissionAccruals).values(accrual());
    await expect(
      db.update(commissionAccruals).set({ amountPaise: 1 }).where(eq(commissionAccruals.id, accrual().id)),
    ).rejects.toThrow(/partner_ledger_immutable/);
    await expect(
      db.delete(commissionAccruals).where(eq(commissionAccruals.id, accrual().id)),
    ).rejects.toThrow(/partner_ledger_immutable/);
    // The row survived both attempts, unchanged. A trigger that raised AFTER the write would pass
    // the two assertions above and still have moved the money.
    const rows = await db.select().from(commissionAccruals);
    expect(rows.map((r) => r.amountPaise)).toEqual([50000]);
  });

  it("a reversal is a NEGATIVE ROW and the sum is the answer — nothing is edited", async () => {
    await db.insert(commissionAccruals).values([
      accrual(),
      accrual({ id: "01HACC00000000000000REV01", kind: "reversal", amountPaise: -20000 }),
    ]);
    const rows = await db.select().from(commissionAccruals);
    expect(rows.reduce((sum, r) => sum + r.amountPaise, 0)).toBe(30000);
    // `seq` is the database's own arrival order — ULID ids cannot carry it (§3.26). Asserted as an
    // ORDER rather than as values, because this group's truncate deliberately has no
    // `restart identity` (see test/helpers/db.ts).
    const seqs = [...rows].sort((a, b) => Number(a.seq) - Number(b.seq)).map((r) => r.kind);
    expect(seqs).toEqual(["accrual", "reversal"]);
  });

  it("escrow is a state chosen at INSERT, never a later update (O-7)", async () => {
    await db.insert(commissionAccruals).values(accrual({ state: "escrowed" }));
    const [row] = await db.select().from(commissionAccruals);
    expect(row!.state).toBe("escrowed");
    // Releasing an escrow is therefore ALSO a row, which is what makes a suspension a decision with
    // a date on it rather than an absence nobody can find.
    await expect(
      db.update(commissionAccruals).set({ state: "accrued" }).where(eq(commissionAccruals.id, row!.id)),
    ).rejects.toThrow(/partner_ledger_immutable/);
  });

  // ──────────────────── DD12 — the subject row, and idempotency on the basis event ────────────────────

  it("one subject per (agreement, invoice, direction), which is what T6 locks FOR UPDATE", async () => {
    await db.insert(patients).values({
      id: "01HPAT0000000000000000001", uhid: "HMS-00000001-1", name: "Invented Patient",
      sex: "female", createdBy: "test", updatedBy: "test",
    });
    await db.insert(invoices).values({
      id: "01HINV0000000000000000001", invoiceNo: "INV-TEST-1", patientId: "01HPAT0000000000000000001",
      tariffVersionId: "01HTV00000000000000000001", grossPaise: 100000, discountPaise: 0,
      taxableBasePaise: 100000, cgstPaise: 0, sgstPaise: 0, rawTotalPaise: 100000, roundingPaise: 0,
      netPayablePaise: 100000, issuedBy: "test", issuedAt: AT, serviceDay: "2026-09-01",
    });
    const subject = {
      id: "01HSUB0000000000000000001", agreementId: AGREEMENT, invoiceId: "01HINV0000000000000000001",
      direction: "payable", counterpartyId: PARTNER,
    };
    await db.insert(commissionAccrualSubjects).values(subject);
    await expect(
      db.insert(commissionAccrualSubjects).values({ ...subject, id: "01HSUB0000000000000000002" }),
    ).rejects.toThrow(/commission_accrual_subjects_ux/);
    // The OTHER direction for the same invoice is a different subject, and must be: one invoice can
    // owe a partner and be owed by them at once.
    await db.insert(commissionAccrualSubjects).values({
      ...subject, id: "01HSUB0000000000000000003", direction: "receivable",
    });
    expect(await db.select().from(commissionAccrualSubjects)).toHaveLength(2);

    // DD12's second guard: one delta per basis event per subject, so a redelivered event finds its
    // own row already there instead of appending a second one.
    const withBasis = accrual({ id: "01HACC00000000000000BAS01", subjectId: subject.id, basisEventId: "01HEVT0000000000000000001" });
    await db.insert(commissionAccruals).values(withBasis);
    await expect(
      db.insert(commissionAccruals).values({ ...withBasis, id: "01HACC00000000000000BAS02" }),
    ).rejects.toThrow(/commission_accruals_basis_event_ux/);
  });

  // ──────────────────────────── DD13 — attribution and the explicit join ────────────────────────────

  it("a partner reference maps to exactly one attribution id, and the map is the only join (V7)", async () => {
    await db.insert(attributionIds).values({
      id: "01HATT0000000000000000001", code: "ATTR-INVENTED-1", counterpartyId: PARTNER, issuedBy: "test",
    });
    await db.insert(partnerRefMap).values({
      id: "01HMAP0000000000000000001", counterpartyId: PARTNER, partnerRef: "THEIR-REF-1",
      attributionId: "01HATT0000000000000000001", mappedBy: "test",
    });
    // The same partner cannot map one of their references twice. A fuzzy fallback is forbidden
    // (V7) precisely because this is the only join there is, so it has to be unambiguous.
    await expect(
      db.insert(partnerRefMap).values({
        id: "01HMAP0000000000000000002", counterpartyId: PARTNER, partnerRef: "THEIR-REF-1",
        attributionId: "01HATT0000000000000000001", mappedBy: "test",
      }),
    ).rejects.toThrow(/partner_ref_map_ref_ux/);
  });

  // ─────────────── DD5 — the expectation is NOT append-only, and that is the whole point ───────────────

  it("a receivable expectation WALKS its lifecycle in place, unlike the ledger beside it", async () => {
    await db.insert(receivableExpectations).values({
      id: "01HEXP0000000000000000001", counterpartyId: PARTNER, amountPaise: 25000, expectedAt: AT,
    });
    // The ledger records MONEY and is append-only; the expectation records a CLAIM and moves.
    // Mixing them is what makes an append-only ledger need an UPDATE (DD5), so this test and A4
    // are two halves of one design decision.
    await db.update(receivableExpectations)
      .set({ state: "matched", matchedAt: AT, updatedBy: "test" })
      .where(eq(receivableExpectations.id, "01HEXP0000000000000000001"));
    const [row] = await db.select().from(receivableExpectations);
    expect([row!.state, row!.matchedAt]).toEqual(["matched", AT]);

    await expect(
      db.update(receivableExpectations).set({ state: "settled" })
        .where(eq(receivableExpectations.id, "01HEXP0000000000000000001")),
    ).rejects.toThrow(/receivable_expectations_state_ck/);
  });

  it("one statement line lands once — a re-imported statement cannot double the claim", async () => {
    const line = {
      counterpartyId: PARTNER, amountPaise: 25000, expectedAt: AT,
      statementRef: "STMT-INVENTED-1", statementPeriod: "2026-Q2", statementLineNo: 7,
    };
    await db.insert(receivableExpectations).values({ ...line, id: "01HEXP0000000000000000002" });
    await expect(
      db.insert(receivableExpectations).values({ ...line, id: "01HEXP0000000000000000003" }),
    ).rejects.toThrow(/receivable_expectations_statement_line_ux/);
    // …while two expectations that came from NO statement are ordinary rows: the index is partial
    // for exactly that reason, and a total one would have made attribution-first expectations
    // (the normal case, V2) impossible after the first.
    await db.insert(receivableExpectations).values([
      { id: "01HEXP0000000000000000004", counterpartyId: PARTNER, amountPaise: 1000, expectedAt: AT },
      { id: "01HEXP0000000000000000005", counterpartyId: PARTNER, amountPaise: 1000, expectedAt: AT },
    ]);
    expect(await db.select().from(receivableExpectations)).toHaveLength(3);
  });
});
