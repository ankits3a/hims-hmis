import { getTableColumns } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { counterparties, partnerAgreements, patients, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { expireUnclaimed, issueAttribution } from "./attribution";
import { importStatement } from "./statements";
import { AGING_BUCKETS, agingReport, bucketFor, receivableTotalPaise } from "./aging";
import type { AgingItem } from "./aging";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T7 — V2 (a hospital attribution absent from a statement AGES AND APPEARS) and DD15
 * (nothing partner-facing carries identity).
 *
 * ═══ WHY V2 IS THE ONE THAT JUSTIFIES ISSUING AN EXPECTATION AT REFERRAL TIME ═══
 *
 * A reconciliation built only from statements can check a partner's arithmetic against itself and
 * nothing more. The referral a partner simply never mentions is invisible to it, for ever, and it
 * is also the single most likely way this hospital loses money on a channel agreement. So the
 * claim is raised when the referral is made, and this report is where it becomes visible — older
 * every day, moving bucket to bucket, long before V5's sweep writes it off.
 *
 * ═══ DD15's TEST IS TWO LEGS, AND THE SECOND ONE IS THE ONE THAT CAN CATCH A REAL LEAK ═══
 *
 *  1. THE SHAPE — every key of every row is compared against `patients`' own column list, read from
 *     the drizzle table rather than typed out here, so a column added to `patients` next year is
 *     compared without anybody remembering to update a list.
 *  2. THE VALUES — the fixture links its attribution to a REAL REGISTERED PATIENT carrying a
 *     distinctive invented name, UHID and phone, and the whole serialised report is searched for
 *     them. §2.49: a shape test alone passes vacuously against a report whose fixture has no
 *     patient at all, and the 11h review's lesson is that two correct halves can be jointly blind.
 *
 * Every partner, person and amount below is INVENTED HERE (DD3 / owner ruling O-9).
 */
const FLAG = "RECEIVABLE_COMMISSION_ENABLED";

const CLERK: Actor = { type: "user", id: "t7-aging-clerk" };
const NOW = new Date("2026-08-19T06:00:00Z");
const AGREEMENT_FROM = new Date("2026-01-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** The patients-table columns, TS name and SQL name, read from the schema rather than transcribed. */
const PATIENT_FIELDS = new Set(
  Object.entries(getTableColumns(patients)).flatMap(([tsName, column]) => [
    tsName.toLowerCase(), column.name.toLowerCase(),
  ]),
);

/** Every key of every object in a value, however deeply nested. */
function keyPaths(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) { for (const v of value) keyPaths(v, out); return out; }
  if (value instanceof Date) return out;
  if (value === null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.add(k);
    keyPaths(v, out);
  }
  return out;
}

describe("the aging read model: V2, and DD15's identity-free rule", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });

  beforeEach(async () => {
    process.env[FLAG] = "true";
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
  });

  async function partnerFor(name = "Invented Diagnostic Partner"): Promise<{ counterpartyId: string }> {
    const counterpartyId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-CP-${counterpartyId.slice(-6)}`, name,
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: newId(), counterpartyId, versionNo: 1, effectiveFrom: AGREEMENT_FROM,
      effectiveTo: null, status: "active", createdBy: "test",
      terms: {
        payableRateBps: 1_000, eligibleCategories: ["diagnostics"], kicker: null,
        receivableRateBps: 1_500, unclaimedExpiryDays: 60,
      },
    });
    return { counterpartyId };
  }

  const at = (daysAgo: number): Date => new Date(NOW.getTime() - daysAgo * DAY_MS);

  // ── V2 — THE REFERRAL NOBODY MENTIONED ────────────────────────────────────────────────────

  it("V2 — a hospital attribution ABSENT from every statement ages and appears in the report", async () => {
    const { counterpartyId } = await partnerFor();
    const mentioned = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, at(10));
    const silent = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 200_000 }, at(75));

    // The partner's statement mentions ONE of the two.
    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-001", statementPeriod: "2026-M08",
      csv: `attribution_ref,partner_ref,amount_paise\n${mentioned.code},,60000\n`,
    }, NOW);

    const report = await agingReport(db, { counterpartyId, asOf: NOW });

    // THE ONE IT DID NOT MENTION IS STILL THERE, and it is 75 days old.
    expect(report.items.map((i) => [i.expectationId, i.state, i.ageDays, i.bucket])).toEqual([
      [silent.expectationId, "expected", 75, "61-90"],
    ]);
    expect(report.totals).toEqual({
      outstandingPaise: 30_000, // percentAmount(200 000, 1 500)
      disputedPaise: 0,
      writtenOffPaise: 0,
      confirmedPaise: 60_000,   // MONEY, from the append-only ledger
      outstandingCount: 1,
      disputedCount: 0,
    });
    expect(report.buckets).toEqual([
      { bucket: "0-30", count: 0, amountPaise: 0 },
      { bucket: "31-60", count: 0, amountPaise: 0 },
      { bucket: "61-90", count: 1, amountPaise: 30_000 },
      { bucket: "90+", count: 0, amountPaise: 0 },
    ]);
  });

  it("V2 — it appears BEFORE V5 writes it off, which is what makes the sweep a formality", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 200_000 }, at(75));

    const before = await agingReport(db, { counterpartyId, asOf: NOW });
    expect(before.items[0]).toMatchObject({ expectationId: slip.expectationId, state: "expected", overdue: true });

    await expireUnclaimed(db, CLERK, { at: NOW });

    const after = await agingReport(db, { counterpartyId, asOf: NOW });
    expect(after.items).toEqual([]);
    expect(after.totals).toMatchObject({ outstandingPaise: 0, writtenOffPaise: 30_000 });
  });

  it("the buckets are exactly the four, and the boundaries are inclusive at the top of each", () => {
    expect(AGING_BUCKETS).toEqual(["0-30", "31-60", "61-90", "90+"]);
    expect([0, 30, 31, 60, 61, 90, 91, 400].map(bucketFor)).toEqual([
      "0-30", "0-30", "31-60", "31-60", "61-90", "61-90", "90+", "90+",
    ]);
  });

  it("claims spread across the ages land in their own buckets, oldest first", async () => {
    const { counterpartyId } = await partnerFor();
    for (const days of [5, 45, 75, 200]) {
      await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 100_000 }, at(days));
    }
    const report = await agingReport(db, { counterpartyId, asOf: NOW });
    expect(report.items.map((i) => [i.ageDays, i.bucket])).toEqual([
      [200, "90+"], [75, "61-90"], [45, "31-60"], [5, "0-30"],
    ]);
    expect(report.buckets.map((b) => b.count)).toEqual([1, 1, 1, 1]);
    expect(report.totals.outstandingPaise).toBe(60_000); // 4 × percentAmount(100 000, 1 500)
  });

  it("a DISPUTED line is on the worklist too — it is contested, not closed", async () => {
    const { counterpartyId } = await partnerFor();
    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-002", statementPeriod: "2026-M08",
      csv: "attribution_ref,partner_ref,amount_paise\nRF-NOSUCHSLIP,,90000\n",
    }, NOW);

    const report = await agingReport(db, { counterpartyId, asOf: NOW });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      state: "disputed", disputeReason: "unknown_attribution", attributionId: null,
      attributionCode: null, statementRef: "INV-STMT-002", amountPaise: 90_000,
    });
    // A dispute is NOT outstanding money and it is NOT confirmed money — it is its own total.
    expect(report.totals).toMatchObject({ outstandingPaise: 0, disputedPaise: 90_000, confirmedPaise: 0, disputedCount: 1 });
    // …and it is not in the ageing buckets, which are what the hospital still expects to collect.
    expect(report.buckets.every((b) => b.count === 0)).toBe(true);
  });

  it("the report scopes to ONE partner, or spans them all", async () => {
    const a = await partnerFor("Invented Partner A");
    const b = await partnerFor("Invented Partner B");
    await issueAttribution(db, CLERK, { counterpartyId: a.counterpartyId, referredValuePaise: 100_000 }, at(5));
    await issueAttribution(db, CLERK, { counterpartyId: b.counterpartyId, referredValuePaise: 200_000 }, at(5));

    expect((await agingReport(db, { counterpartyId: a.counterpartyId, asOf: NOW })).totals.outstandingPaise).toBe(15_000);
    expect((await agingReport(db, { asOf: NOW })).totals.outstandingPaise).toBe(45_000);
  });

  it("`confirmedPaise` is the LEDGER's sum, corrections included — never a sum over claims", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, at(60));
    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-AUG", statementPeriod: "2026-M08",
      csv: `attribution_ref,partner_ref,amount_paise\n${slip.code},,60000\n`,
    }, at(30));
    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-SEP", statementPeriod: "2026-M09",
      csv: `our ref,their ref,amount paise,period\n${slip.code},,75000,2026-M08\n`,
    }, NOW);

    // Two expectation rows say 60 000 and 75 000; the LEDGER says 60 000 + 15 000. Summing the
    // claims would report 135 000 for a referral worth 75 000 — the double count DD5 exists to stop.
    const report = await agingReport(db, { counterpartyId, asOf: NOW });
    expect(report.totals.confirmedPaise).toBe(75_000);
    expect(await receivableTotalPaise(db, counterpartyId)).toBe(75_000);
  });

  it("an empty ledger reports zeros rather than failing — the lane reads fine while it is off", async () => {
    const { counterpartyId } = await partnerFor();
    const report = await agingReport(db, { counterpartyId, asOf: NOW });
    expect(report.items).toEqual([]);
    expect(report.totals).toEqual({
      outstandingPaise: 0, disputedPaise: 0, writtenOffPaise: 0, confirmedPaise: 0,
      outstandingCount: 0, disputedCount: 0,
    });
  });

  // ── DD15 — NOTHING PARTNER-FACING CARRIES IDENTITY ────────────────────────────────────────

  /** The fixture that makes both legs below non-vacuous: a REAL patient behind the referral. */
  async function reportWithAPatientBehindIt(): Promise<{
    report: Awaited<ReturnType<typeof agingReport>>;
    patient: { id: string; name: string; uhid: string; phone: string };
  }> {
    const { counterpartyId } = await partnerFor();
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Yashodhara Kelkar", sex: "female", ageYears: 47, phone: "9820100117" }));
    await issueAttribution(
      db, CLERK,
      { counterpartyId, patientId: patient.id, serviceHint: "outbound imaging", referredValuePaise: 400_000 },
      at(20),
    );
    return {
      report: await agingReport(db, { counterpartyId, asOf: NOW }),
      patient: { id: patient.id, name: patient.name, uhid: patient.uhid, phone: "9820100117" },
    };
  }

  it("DD15 leg 1 — NO KEY of the report is a `patients` column, at any depth", async () => {
    const { report } = await reportWithAPatientBehindIt();
    expect(report.items).toHaveLength(1); // the fixture is not vacuous

    const offenders = [...keyPaths(report)].filter((k) => PATIENT_FIELDS.has(k.toLowerCase()));
    expect(offenders).toEqual([]);
    // The list the comparison is made against is read from the schema and is genuinely populated —
    // an empty set would make the leg above pass against anything (§2.49).
    expect(PATIENT_FIELDS.has("uhid")).toBe(true);
    expect(PATIENT_FIELDS.has("is_confidential")).toBe(true);
    expect(PATIENT_FIELDS.size).toBeGreaterThan(20);
  });

  it("DD15 leg 2 — no VALUE of the report is this patient's name, UHID, phone or id", async () => {
    const { report, patient } = await reportWithAPatientBehindIt();
    const serialised = JSON.stringify(report);

    for (const secret of [patient.name, patient.uhid, patient.phone, patient.id]) {
      expect({ secret, leaked: serialised.includes(secret) }).toEqual({ secret, leaked: false });
    }
    // …and the fixture really does hold them, so the leg above is a measurement and not a tautology.
    const stored = await db.select().from(patients);
    expect(stored[0]).toMatchObject({ id: patient.id, name: patient.name, uhid: patient.uhid });
  });

  it("DD15 leg 2's negative control — the same search FINDS a leak when one is planted", async () => {
    const { report, patient } = await reportWithAPatientBehindIt();
    const leaky = {
      ...report,
      items: report.items.map((i) => ({ ...i, holderName: patient.name, uhid: patient.uhid })),
    };
    expect(JSON.stringify(leaky).includes(patient.uhid)).toBe(true);
    expect([...keyPaths(leaky)].filter((k) => PATIENT_FIELDS.has(k.toLowerCase())).sort()).toEqual(["uhid"]);
  });

  it("an aging item carries exactly the fields the read model declares — ids, a code, dates, amounts", async () => {
    const { report } = await reportWithAPatientBehindIt();
    const expected: (keyof AgingItem)[] = [
      "ageDays", "amountPaise", "attributionCode", "attributionId", "bucket", "counterpartyId",
      "disputeReason", "dueAt", "expectationId", "expectedAt", "overdue", "serviceHint", "state",
      "statementPeriod", "statementRef",
    ];
    expect(Object.keys(report.items[0]!).sort()).toEqual(expected);
  });
});
