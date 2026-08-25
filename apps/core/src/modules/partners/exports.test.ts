import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { commissionAccruals, counterparties, partnerAgreements, patients, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { issueAttribution } from "./attribution";
import { assertIdentityFree, exportCounterpartyStatement, identityLeaks } from "./exports";
import type { Db } from "../../kernel/db/client";

const FLAG = "RECEIVABLE_COMMISSION_ENABLED";

/**
 * PLAN 09 T8 — DD15's EXPORT-SHAPE TEST.
 *
 * ═══ WHY THIS IS NOT THE SAME TEST AS `aging.test.ts`'S ═══
 *
 * `aging.test.ts` proves ONE reader (`agingReport`) never carries identity by walking its output
 * inside the test. This file proves the same property for `exportCounterpartyStatement` — the
 * partner-facing combination of the ledger AND the claims — and it also exercises the REUSABLE
 * guard (`identityLeaks` / `assertIdentityFree`) directly, because that guard is production code
 * called from `exports.ts` and `pnl.ts` both, and it earns its own coverage independent of either
 * caller.
 *
 * ═══ §2.49 — AN EMPTY EXPORT PASSES EVERY LEG BELOW VACUOUSLY, SO THE FIXTURE MUST BE NON-EMPTY ═══
 *
 * The first two legs below run against an export carrying a REAL registered patient behind a
 * receivable claim and a REAL commission-ledger row, so "no key is a patients column" and "no value
 * is this patient's name/UHID/phone" are measurements, not tautologies. The THIRD leg is the one the
 * brief asks for by name: a row shape DELIBERATELY carrying a patient field, fed to the same guard
 * the export calls, and asserted to be REFUSED — proving the check can fail before trusting that it
 * did not.
 *
 * Every partner, person and amount below is INVENTED HERE (DD3 / owner ruling O-9).
 */
const CLERK: Actor = { type: "user", id: "t8-pnl-clerk" };
const NOW = new Date("2026-08-25T06:00:00Z");

describe("exportCounterpartyStatement: DD15's identity-free guarantee", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });

  beforeEach(async () => {
    process.env[FLAG] = "true"; // `issueAttribution` refuses with the receivable lane off (DD14)
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
  });

  async function partnerFor(name = "Invented Export Partner"): Promise<{ counterpartyId: string; agreementId: string }> {
    const counterpartyId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-EXP-${counterpartyId.slice(-6)}`, name,
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
    const agreementId = newId();
    await db.insert(partnerAgreements).values({
      id: agreementId, counterpartyId, versionNo: 1, effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      effectiveTo: null, status: "active", createdBy: "test",
      terms: { payableRateBps: 1_000, eligibleCategories: ["diagnostics"], receivableRateBps: 1_500, unclaimedExpiryDays: 60 },
    });
    return { counterpartyId, agreementId };
  }

  /**
   * A REAL patient behind a REAL commission-ledger row and a REAL open claim — the ledger row is
   * inserted directly rather than run through a full invoice/payment flow, because the accrual
   * arithmetic itself is T6's own tested property; this fixture only needs a genuine
   * `commission_accruals` row to exist for the export to combine.
   */
  async function exportWithAPatientBehindIt(): Promise<{
    result: Awaited<ReturnType<typeof exportCounterpartyStatement>>;
    patient: { id: string; name: string; uhid: string; phone: string };
  }> {
    const { counterpartyId, agreementId } = await partnerFor();
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Baburao Ghotikar", sex: "male", ageYears: 52, phone: "9820100199" }));

    await db.insert(commissionAccruals).values({
      id: newId(),
      counterpartyId,
      payeeClass: "channel_partner",
      agreementId,
      direction: "payable",
      instrumentId: newId(), // no FK — a plain reference to a membership instance (see schema header)
      kind: "accrual",
      state: "accrued",
      amountPaise: 12_000,
      rateSnapshot: { payableRateBps: 1_000 },
      occurredAt: NOW,
    });

    await issueAttribution(
      db, CLERK,
      { counterpartyId, patientId: patient.id, serviceHint: "outbound imaging", referredValuePaise: 400_000 },
      NOW,
    );

    return {
      result: await exportCounterpartyStatement(db, { counterpartyId, asOf: NOW }),
      patient: { id: patient.id, name: patient.name, uhid: patient.uhid, phone: "9820100199" },
    };
  }

  it("the export is not vacuous — it carries one commission row and one receivable claim", async () => {
    const { result } = await exportWithAPatientBehindIt();
    expect(result.rows.map((r) => r.kind).sort()).toEqual(["commission", "receivable"]);
  });

  it("DD15 leg 1 — NO KEY of the export is a `patients` column, at any depth", async () => {
    const { result } = await exportWithAPatientBehindIt();
    expect(identityLeaks(result)).toEqual([]);
    // The comparison set is genuinely populated — an empty set would pass the leg above against
    // anything (§2.49), the same non-vacuity check `aging.test.ts` runs against its own list.
    expect(identityLeaks({ uhid: "x" })).toEqual(["uhid"]);
  });

  it("DD15 leg 2 — no VALUE of the export is this patient's name, UHID, phone or id", async () => {
    const { result, patient } = await exportWithAPatientBehindIt();
    const serialised = JSON.stringify(result);
    for (const secret of [patient.name, patient.uhid, patient.phone, patient.id]) {
      expect({ secret, leaked: serialised.includes(secret) }).toEqual({ secret, leaked: false });
    }
    // …and the fixture really does hold them, so the leg above is a measurement, not a tautology.
    const stored = await db.select().from(patients);
    expect(stored[0]).toMatchObject({ id: patient.id, name: patient.name, uhid: patient.uhid });
  });

  it("DD15's synthetic leg — a row shape carrying a patient field is REFUSED, not merely noticed", () => {
    // `name` and `uhid` are genuine `patients` columns (unlike `membership_instances.holderName`,
    // which is a DIFFERENT table's own holder-name field and correctly does NOT trip this guard —
    // DD15 is about the `patients` table specifically, the same scope `aging.test.ts` uses).
    const bad = { rowId: "01ROW00000000000000000001", kind: "commission", name: "Someone Real", uhid: "HMS0000001" };
    expect(identityLeaks(bad).sort()).toEqual(["name", "uhid"]);
    expect(() => assertIdentityFree(bad, "test fixture")).toThrow(/identity-bearing field/);
    expect(() => assertIdentityFree(bad, "test fixture")).toThrow(/uhid/);
  });

  it("a shape with none of the forbidden keys passes the same guard cleanly", () => {
    const fine = { rowId: "01ROW00000000000000000002", kind: "receivable", counterpartyId: "cp1", amountPaise: 5000 };
    expect(identityLeaks(fine)).toEqual([]);
    expect(() => assertIdentityFree(fine, "test fixture")).not.toThrow();
  });

  it("an empty ledger and an empty claim book export cleanly — the lane reads fine while it is off", async () => {
    const { counterpartyId } = await partnerFor();
    const result = await exportCounterpartyStatement(db, { counterpartyId, asOf: NOW });
    expect(result.rows).toEqual([]);
    expect(identityLeaks(result)).toEqual([]);
  });

  it("a export row carries exactly the fields the type declares — ids, a kind, a state, dates, amounts", async () => {
    const { result } = await exportWithAPatientBehindIt();
    const expectedKeys = [
      "amountPaise", "attributionId", "counterpartyId", "instrumentId", "kind", "occurredAt",
      "periodKey", "rowId", "state",
    ];
    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(expectedKeys);
    }
  });
});
