import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  entitlementCounters, entitlementMovements, events, membershipInstances, membershipPlans, registrationConfig,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { seedSodPairs } from "../../kernel/auth/sod";
import { registerPatient } from "../patients";
import { cardsToday, recogniseAtCounter, recordRecognition } from "./counter-view";
import { instrumentRecognised } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * UX-AUDIT 2026-09-28 · BOARD — the card-recognition counter's view and its "cards today" list.
 *
 * Two owner rulings of 28-Sep-2026 (money) are pinned here at the WIRE, where a screen cannot undo
 * them: a card's rupee balance is never on the recognise response (only visit counts are), and an
 * expired, suspended or cancelled card's only act is "bill at full rate" — never an apply act.
 *
 * Every card code, plan and person below is INVENTED HERE (DD3 / owner ruling O-9).
 */
const clerk: Actor = { type: "user", id: "clerk-cv-1" };
const PLAN_ID = "01HTESTPLANCV000000000001";
const AT = new Date("2026-09-28T06:10:00Z"); // 11:40 IST, the board's own clock
/** A money balance whose figure must never reach the wire. Distinctive, so a leak is findable. */
const BALANCE_PAISE = 125_037;

const PLAN_BENEFITS = [
  { benefitKey: "free-consult", title: "Free OPD consultation", kind: "percent_bps", value: 10_000, capPaise: null, scope: { serviceCategories: ["consultation"], serviceIds: null } },
  { benefitKey: "lab-rate", title: "Member rate · lab tests", kind: "percent_bps", value: 1_500, capPaise: null, scope: { serviceCategories: ["lab"], serviceIds: null } },
  { benefitKey: "wallet", title: "Care wallet", kind: "flat_paise", value: 50_000, capPaise: null, scope: { serviceCategories: null, serviceIds: null } },
];

describe("UX-AUDIT 2026-09-28 · BOARD — recognition at the counter", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    await db.insert(membershipPlans).values({
      id: PLAN_ID, code: "INV-CV-PLAN", title: "Invented Family Card", kind: "card",
      benefits: PLAN_BENEFITS, entitlements: {}, validityDays: 365, queuePerk: false, createdBy: "test",
    });
  });

  async function mkPatient(name: string, phone: string): Promise<{ id: string; uhid: string }> {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name, sex: "female", phone, dob: new Date("1974-03-02T00:00:00Z") }));
    return { id: patient.id, uhid: patient.uhid };
  }

  async function issueCard(a: { id: string; cardCode: string; patientId?: string; status?: string; validTo?: Date }): Promise<void> {
    await db.insert(membershipInstances).values({
      id: a.id, planId: PLAN_ID, cardCode: a.cardCode, holderName: "Book Holder", patientId: a.patientId,
      validFrom: new Date("2026-04-01T00:00:00Z"), validTo: a.validTo ?? new Date("2027-03-31T00:00:00Z"),
      status: a.status ?? "active", origin: "import",
    });
  }

  async function countersFor(instanceId: string): Promise<void> {
    await db.insert(entitlementCounters).values([
      { id: `${instanceId}C1`, instanceId, benefitKey: "free-consult", grantedQty: 4, validFrom: new Date("2026-04-01T00:00:00Z"), validTo: new Date("2027-03-31T00:00:00Z") },
      { id: `${instanceId}C2`, instanceId, benefitKey: "wallet", unit: "paise", grantedQty: BALANCE_PAISE, validFrom: new Date("2026-04-01T00:00:00Z"), validTo: new Date("2027-03-31T00:00:00Z") },
    ]);
    await db.insert(entitlementMovements).values({ id: `${instanceId}M1`, counterId: `${instanceId}C1`, delta: -1, kind: "consume", actorId: "test" });
  }

  it("names the holder and leaves benefits as COUNTS; the rupee balance is nowhere on the wire", async () => {
    const p = await mkPatient("Invented Sunita", "9700000101");
    await issueCard({ id: "01HCARDCV00000000000000A1", cardCode: "IV-4471-2093", patientId: p.id });
    await countersFor("01HCARDCV00000000000000A1");

    const r = await recogniseAtCounter(db, clerk, { presentedCodes: ["iv-4471-2093"], at: AT });

    const m = r.memberships[0]!;
    expect(m).toMatchObject({ standing: "usable", linked: true, nextAct: "take_to_bill" });
    expect(m.holder).toMatchObject({ patientId: p.id, uhid: p.uhid, name: "Invented Sunita", ageYears: 52, sex: "female", restricted: false });
    expect(m.allowances).toEqual([
      { benefitKey: "free-consult", title: "Free OPD consultation", allowance: { kind: "visits", granted: 4, remaining: 3 } },
      { benefitKey: "lab-rate", title: "Member rate · lab tests", allowance: { kind: "every_visit" } },
      { benefitKey: "wallet", title: "Care wallet", allowance: { kind: "on_the_bill" } },
    ]);
    // OWNER RULING 28-Sep-2026 — no rupee figure: not the balance, not a unit word, not a paise field.
    const wire = JSON.stringify(r);
    expect(wire).not.toContain(String(BALANCE_PAISE));
    expect(wire).not.toMatch(/paise|₹|amount|balance/i);
  });

  it("an EXPIRED card offers no apply act — its one act is bill at full rate — and suspended/cancelled read the same", async () => {
    const p = await mkPatient("Invented Irfan", "9700000102");
    await issueCard({ id: "01HCARDCV00000000000000B1", cardCode: "IV-3310-0457", patientId: p.id, validTo: new Date("2026-09-14T00:00:00Z") });
    await issueCard({ id: "01HCARDCV00000000000000B2", cardCode: "IV-1187-0344", patientId: p.id, status: "suspended" });
    await issueCard({ id: "01HCARDCV00000000000000B3", cardCode: "IV-1187-0999", patientId: p.id, status: "cancelled" });

    const r = await recogniseAtCounter(db, clerk, { patientId: p.id, at: AT });

    expect(r.memberships.map((m) => [m.cardCode, m.standing, m.nextAct])).toEqual([
      ["IV-3310-0457", "expired", "bill_full_rate"],
      ["IV-1187-0344", "suspended", "bill_full_rate"],
      ["IV-1187-0999", "cancelled", "bill_full_rate"],
    ]);
    expect(r.memberships.some((m) => m.nextAct === "take_to_bill")).toBe(false);
  });

  it("a usable card the book has not linked goes to Reconcile, never to the bill", async () => {
    await issueCard({ id: "01HCARDCV00000000000000C1", cardCode: "IV-5520-1904" });
    const r = await recogniseAtCounter(db, clerk, { presentedCodes: ["IV-5520-1904"], at: AT });
    expect(r.memberships[0]).toMatchObject({ standing: "usable", linked: false, holder: null, nextAct: "reconcile" });
  });

  it("cards today: this counter's own recognitions since IST midnight, one row per code, no match first", async () => {
    const p = await mkPatient("Invented Anil", "9700000103");
    await issueCard({ id: "01HCARDCV00000000000000D1", cardCode: "IV-0902-6615", patientId: p.id });
    const other: Actor = { type: "user", id: "another-counter" };

    for (const code of ["IV-0902-6615", "IV-0902-6615", "NO-SUCH-CARD"]) {
      const r = await recogniseAtCounter(db, clerk, { presentedCodes: [code], at: AT });
      await recordRecognition(db, clerk, [code], r, AT);
    }
    // Another counter's recognition, and this counter's own from YESTERDAY (IST), are not today's list.
    const theirs = await recogniseAtCounter(db, other, { presentedCodes: ["IV-0902-6615"], at: AT });
    await recordRecognition(db, other, ["IV-0902-6615"], theirs, AT);
    await withTx(db, (tx) => appendEvent(tx, instrumentRecognised.make({
      actor: clerk, occurredAt: new Date("2026-09-27T18:00:00Z"), // 23:30 IST on the 27th
      payload: { code: "IV-OLD-0001", source: "none", instanceId: null, origin: null, standing: null, linked: false },
    })));

    const rows = await cardsToday(db, clerk, AT);
    expect(rows.map((r) => [r.code, r.source, r.standing, r.needsYou])).toEqual([
      ["NO-SUCH-CARD", "none", null, true],
      ["IV-0902-6615", "card", "usable", false],
    ]);
    expect(rows[1]!.holder).toMatchObject({ name: "Invented Anil" });
    expect(JSON.stringify(rows)).not.toMatch(/paise|₹/i);
    expect(await db.select().from(events).where(eq(events.name, "instrument.recognised"))).toHaveLength(5);
  });
});
