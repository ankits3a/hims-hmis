import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedBillingBase } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import {
  attributionIds, commissionAccruals, counterparties, events, membershipInstances, membershipPlans,
  opdEncounters, partnerAgreements, registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { previewInvoice } from "../billing";
import { registerBenefitSourceProvider } from "../billing";
import { PartnersModule } from "./partners.module";
import { REFERRAL_SOURCE_KEY, referralSource, resolveReferral } from "./sources";
import type { PricingContext } from "../tariff";
import type { Db } from "../../kernel/db/client";

/**
 * RC-2 T2 / D3 — REFERRAL AS A DISCOUNT, AND THE ENUM IT MUST NEVER BE KEYED ON.
 *
 * ═══ EVERY PARTNER, RATE, CODE AND PERSON BELOW IS INVENTED HERE (Plan 09 DD3 / O-9) ═══
 *
 * The out-of-git partner book supplies nothing to this repository. Each fixture tests a CLASS — an
 * unlawful payee class, a suspended partner, a slip nobody may still present — and a class does not
 * care which invented rate carries it.
 *
 * ═══ THE FIXTURE'S MONEY, HAND-DERIVED ═══
 *
 * `seedBillingBase` prices OPD-CONSULT-NEW at 50 000 paise, category "consultation", EXEMPT
 * healthcare — no tax head moves anywhere below.
 *
 *   referral 1 000 bps (10%)  → 5 000 · net 45 000
 *   membership 2 000 bps (20%) → 10 000 · net 40 000
 *   both present               → BEST SINGLE BENEFIT: membership wins at 10 000, referral is a
 *                                recorded LOSER at 5 000, net 40 000 — never 15 000 off.
 */
const CLERK: Actor = { type: "user", id: "rc2-t2-clerk" };
const FLAG = "MEMBER_BENEFITS_ENABLED";
const NOW = new Date("2026-09-01T06:00:00Z"); // 11:30 IST
const AGREEMENT_FROM = new Date("2026-04-01T00:00:00Z");
const SERVICE_DAY = "2026-09-01";

/** The patient-discount terms this lane parses off the SAME jsonb `accrualTermsSchema` strips. */
function termsWith(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payableRateBps: 1_000, eligibleCategories: ["consultation"], kicker: null,
    patientDiscountBps: 1_000, patientDiscountCategories: ["consultation"],
    patientDiscountCapPaise: null, patientDiscountTitle: "Invented partner referral",
    ...over,
  };
}

describe("RC-2 T2 — a referral discount is keyed on a resolved counterparty, never on an enum (D3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    // THE SEAM IS ARMED THE WAY PRODUCTION ARMS IT. Constructing the real module is the assertion:
    // if `PartnersModule`'s constructor ever stops registering the provider, every ordinary-path
    // case below goes red. Duplicating the registration here instead would test this file against
    // itself and leave the actual wiring — the thing that can silently rot — unproven.
    new PartnersModule();
  });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });

  let consultServiceId = "";

  beforeEach(async () => {
    process.env[FLAG] = "true";
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    consultServiceId = (await seedBillingBase(db)).consultNewServiceId;
  });

  async function partnerWithSlip(args: {
    payeeClass?: string; status?: string; state?: string; expiresAt?: Date | null;
    terms?: Record<string, unknown> | null; patientId?: string;
  } = {}): Promise<{ counterpartyId: string; code: string }> {
    const counterpartyId = newId();
    const code = `INV-SLIP-${counterpartyId.slice(-6)}`;
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-CP-${counterpartyId.slice(-6)}`, name: "Invented Channel Partner",
      payeeClass: args.payeeClass ?? "channel_partner", status: args.status ?? "active", createdBy: "test",
    });
    if (args.terms !== null) {
      await db.insert(partnerAgreements).values({
        id: newId(), counterpartyId, versionNo: 1, effectiveFrom: AGREEMENT_FROM, effectiveTo: null,
        status: "active", createdBy: "test", terms: args.terms ?? termsWith(),
      });
    }
    await db.insert(attributionIds).values({
      id: newId(), code, counterpartyId, state: args.state ?? "issued",
      patientId: args.patientId ?? null, // MAJOR 5 — null is a bearer leaflet, a value is a binding
      expiresAt: args.expiresAt ?? null, issuedBy: "test", issuedAt: AGREEMENT_FROM,
    });
    return { counterpartyId, code };
  }

  /** Disclosed shaping (the charge-rules/T5/T8 precedent): the pricing branch is what is under test. */
  async function shapeVisit(over: Record<string, unknown> = {}): Promise<{ encounterId: string; patientId: string }> {
    const encounterId = newId();
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Anita Deshmukh", sex: "female", ageYears: 39 }));
    await db.insert(opdEncounters).values({
      id: encounterId, visitNo: `VT2-${encounterId}`, patientId: patient.id, workflowInstanceId: newId(),
      serviceDate: SERVICE_DAY, visitType: "new", status: "waiting", intendedPayer: "self",
      openedBy: "shaped", updatedBy: "shaped", openedAt: NOW, ...over,
    });
    return { encounterId, patientId: patient.id };
  }

  /** The one consult line every case below prices, through the SAME core the fee quote runs. */
  async function quoteFor(encounterId: string, opts: { attributionCode?: string } = {}) {
    return previewInvoice(db, {
      encounterId,
      lines: [{ lineId: "fee", serviceId: consultServiceId, qty: 1 }],
      attributionCode: opts.attributionCode,
    }, NOW);
  }

  // ── THE TRAP THE PHASE EXISTS TO AVOID (spike S3, §2.149) ──────────────────────────────────

  /**
   * THE SHARP ONE. `openLabWalkinInTx` (encounters.ts:340) writes `referralSource: input.referralSource
   * ?? "external_rmp"` — so a direct lab walk-in that named no referrer carries the enum value that
   * looks most like a referral. A source keyed on that column discounts bills nobody referred.
   *
   * The mutant is a source keyed on the enum; the discriminating input is an encounter carrying
   * `external_rmp` and NO presented slip; the kill is a discount appearing at all.
   */
  it("an encounter stamped external_rmp with NO slip presented proposes NOTHING — the enum is capture, not a payee", async () => {
    const { encounterId } = await shapeVisit({ referralSource: "external_rmp", referrerName: "Some Clinic" });
    const draft = await quoteFor(encounterId); // no attributionCode: nothing was presented

    expect(draft.totals.netPayablePaise).toBe(50_000);
    expect(draft.lines[0]!.winner).toBeNull();
    expect(draft.lines[0]!.candidates).toHaveLength(0);
  });

  /**
   * ═══ THE RULE-21 MUTANT, INLINE AND DISCLOSED (RC-1 T2's permission-inversion precedent) ═══
   *
   * The mutant is the design decision REVERSED: a provider keyed on `opd_encounters.referral_source`
   * instead of on a resolved counterparty — the obvious implementation, and the one D3 rejected.
   * It is registered here rather than copied into a scratch file because what has to be shown is the
   * DAMAGE, not a second copy of the arithmetic: the same encounter, the same absence of any slip,
   * and a discount appearing anyway.
   *
   * Expected kill: the case above asserts 50 000 on this exact input; under the mutant it is 45 000.
   * That is money off a bill nobody referred, on every direct lab walk-in in the hospital, because
   * `openLabWalkinInTx` stamps `external_rmp` when the caller names no referrer.
   */
  it("MUTANT — keying on the enum instead of a counterparty discounts a bill nobody referred", async () => {
    const { encounterId } = await shapeVisit({ referralSource: "external_rmp", referrerName: "Some Clinic" });

    const unregister = registerBenefitSourceProvider("t2_mutant_enum", async (mutDb, args) => {
      if (args.patientId === null) return null;
      const rows = await mutDb.select().from(opdEncounters).where(eq(opdEncounters.patientId, args.patientId));
      const stamped = rows[0]?.referralSource ?? null;
      if (stamped === null || stamped === "self") return null;
      return referralSource({
        attributionId: "mutant", code: stamped, counterpartyId: "no-such-partner",
        payeeClass: "channel_partner", discountBps: 1_000, categories: ["consultation"],
        capPaise: null, title: "Mutant enum referral",
      });
    });
    try {
      const draft = await quoteFor(encounterId); // still NO slip presented
      // THE DAMAGE, asserted so the kill is a measured number and not a claim:
      expect(draft.totals.netPayablePaise).toBe(45_000);
      expect(draft.lines[0]!.winner).toMatchObject({ ruleKey: "external_rmp", amountPaise: 5_000 });
    } finally {
      unregister();
    }

    // And with the mutant withdrawn, the shipped resolver refuses the same input. DIED.
    const draft = await quoteFor(encounterId);
    expect(draft.totals.netPayablePaise).toBe(50_000);
    expect(draft.lines[0]!.candidates).toHaveLength(0);
  });

  /**
   * A STATIC GUARD, so the trap cannot be reintroduced by a later edit that "just reads the column
   * while it is right there". `sources.test.ts`'s purity scan is the precedent for asserting a
   * property of the FILE rather than of one execution.
   */
  it("the source module cannot reach the encounter's referral columns at all", () => {
    const text = readFileSync(join(__dirname, "sources.ts"), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // the comments discuss the trap deliberately

    // The DB columns, and the OPD module that owns them. `referralSource` in camelCase is NOT in
    // this list and must not be: it is this file's own exported factory name, and a guard that
    // fires on the thing it is protecting is a guard somebody deletes.
    expect(code).not.toMatch(/referral_source|referrer_name|referrerName/);
    expect(code).not.toMatch(/from "\.\.\/opd"|opdEncounters/);
  });

  // ── THE LEGAL BRANCH (IMC 2002 cl. 6.4) ────────────────────────────────────────────────────

  it("an external_rmp counterparty with a VALID slip and real terms still proposes nothing", async () => {
    const { code } = await partnerWithSlip({ payeeClass: "external_rmp" });
    expect(await resolveReferral(db, { code, patientId: null, at: NOW })).toBeNull();

    const { encounterId } = await shapeVisit();
    const draft = await quoteFor(encounterId, { attributionCode: code });
    expect(draft.totals.netPayablePaise).toBe(50_000);
    expect(draft.lines[0]!.candidates).toHaveLength(0);
  });

  // ── THE ORDINARY PATH, AND BEST SINGLE BENEFIT ─────────────────────────────────────────────

  it("a resolved channel partner discounts the quote and names the slip as the rule key", async () => {
    const { code, counterpartyId } = await partnerWithSlip();
    const { encounterId } = await shapeVisit();
    const draft = await quoteFor(encounterId, { attributionCode: code });

    expect(draft.totals.netPayablePaise).toBe(45_000);
    expect(draft.lines[0]!.winner).toMatchObject({
      sourceKey: REFERRAL_SOURCE_KEY, ruleKey: code, kind: "percent_bps", amountPaise: 5_000,
      discountCategory: null, requiresApproval: false, rejected: null,
    });
    // D4 — the FACT travels so the partner ledger is reconstructible; the money does not move.
    expect(draft.lines[0]!.winner!.reason).toContain(counterpartyId);
  });

  it("BEST SINGLE BENEFIT: a bigger membership WINS and the referral is recorded as a loser, never summed", async () => {
    const { code } = await partnerWithSlip();
    const { encounterId, patientId } = await shapeVisit();
    const planId = newId();
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-PLAN-${planId.slice(-6)}`, title: "Invented Member Card", kind: "membership",
      benefits: [{
        benefitKey: "INV-MEMBER-20", title: "Invented member consultation benefit", kind: "percent_bps",
        value: 2_000, capPaise: null, scope: { serviceCategories: ["consultation"], serviceIds: null },
      }],
      entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: newId(), planId, cardCode: `T2-${planId.slice(-6)}`, holderName: "Anita Deshmukh",
      patientId, validFrom: AGREEMENT_FROM, validTo: new Date("2026-12-31T00:00:00Z"),
      status: "active", origin: "import",
    });

    const draft = await quoteFor(encounterId, { attributionCode: code });
    const line = draft.lines[0]!;

    expect(line.winner).toMatchObject({ ruleKey: "INV-MEMBER-20", amountPaise: 10_000 });
    expect(line.discountPaise).toBe(10_000);          // NOT 15 000 — no stacking, the owner's ruling
    expect(draft.totals.netPayablePaise).toBe(40_000);
    // The loser survives in the audit record, which is what lets the seat say why the chip greyed out.
    const referralCandidate = line.candidates.find((c) => c.sourceKey === REFERRAL_SOURCE_KEY);
    expect(referralCandidate).toMatchObject({ ruleKey: code, amountPaise: 5_000 });
    expect(line.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("D4 — neither path writes a commission accrual or emits a commission event", async () => {
    const { code } = await partnerWithSlip();
    const { encounterId } = await shapeVisit();
    await quoteFor(encounterId, { attributionCode: code });

    expect(await db.select().from(commissionAccruals)).toHaveLength(0);
    const names = (await db.select().from(events)).map((e) => e.name);
    expect(names.filter((n) => n.startsWith("commission."))).toHaveLength(0);
  });

  // ── EVERY REFUSAL RETURNS null AND STILL LETS THE PATIENT BE BILLED ─────────────────────────

  it.each([
    ["no code presented", async () => ({ code: undefined })],
    ["an unknown code", async () => ({ code: "NOT-A-REAL-SLIP" })],
    ["a voided slip", async () => ({ code: (await partnerWithSlip({ state: "void" })).code })],
    ["an expired slip", async () => ({ code: (await partnerWithSlip({ expiresAt: new Date("2026-08-01T00:00:00Z") })).code })],
    ["a suspended counterparty", async () => ({ code: (await partnerWithSlip({ status: "suspended" })).code })],
    ["no governing agreement", async () => ({ code: (await partnerWithSlip({ terms: null })).code })],
    ["terms carrying no patient-discount key", async () => ({
      code: (await partnerWithSlip({ terms: { payableRateBps: 1_000, eligibleCategories: ["consultation"], kicker: null } })).code,
    })],
  ])("refuses %s — null, never a throw, so the patient can still be billed", async (_label, make) => {
    const { code } = await make();
    expect(await resolveReferral(db, { code, patientId: null, at: NOW })).toBeNull();

    const { encounterId } = await shapeVisit();
    const draft = await quoteFor(encounterId, { attributionCode: code });
    expect(draft.totals.netPayablePaise).toBe(50_000);
  });

  it("an agreement configured at 0 bps proposes nothing — a real agreement that discounts nothing", async () => {
    const { code } = await partnerWithSlip({ terms: termsWith({ patientDiscountBps: 0 }) });
    const { encounterId } = await shapeVisit();
    const draft = await quoteFor(encounterId, { attributionCode: code });
    expect(draft.totals.netPayablePaise).toBe(50_000);
    expect(draft.lines[0]!.candidates).toHaveLength(0);
  });

  it("a discount scoped to another category does not reach a consultation line", async () => {
    const { code } = await partnerWithSlip({ terms: termsWith({ patientDiscountCategories: ["diagnostics"] }) });
    const { encounterId } = await shapeVisit();
    const draft = await quoteFor(encounterId, { attributionCode: code });
    expect(draft.totals.netPayablePaise).toBe(50_000);
  });

  it("an over-cap ask is proposed as a REJECTED candidate carrying the ask, not the clamp", async () => {
    const { code } = await partnerWithSlip({ terms: termsWith({ patientDiscountCapPaise: 2_000 }) });
    const { encounterId } = await shapeVisit();
    const draft = await quoteFor(encounterId, { attributionCode: code });
    const candidate = draft.lines[0]!.candidates.find((c) => c.sourceKey === REFERRAL_SOURCE_KEY);
    expect(candidate).toMatchObject({ amountPaise: 5_000, rejected: { code: "over_cap" } });
    expect(draft.totals.netPayablePaise).toBe(50_000); // rejected candidates are excluded from the contest
  });

  // ── THE INDEPENDENT REVIEW'S FINDINGS, EACH WITH ITS OWN EXECUTED PROOF ────────────────────

  /**
   * REVIEW CRITICAL 1. `resolveAgreementAt` parses the agreement through `accrualTermsSchema`, whose
   * `payableRateBps` and `eligibleCategories` are REQUIRED and undefaulted, and THROWS
   * `PartnersError` when they are absent. Nothing caught it, and billing's `toHttp` has no
   * `PartnersError` arm, so the quote and the invoice both 500 — the counter could not bill at all.
   *
   * The shape is not exotic: nothing in `apps/core/src` writes `partner_agreements`, so the jsonb is
   * hand-authored at commissioning, and RC-2 taught the operator to write the PATIENT-DISCOUNT keys.
   * This fixture is exactly what a commissioning engineer following RC-2's docs would produce.
   */
  it("CRITICAL 1 — an agreement carrying ONLY the patient-discount keys refuses, and the bill still prices", async () => {
    const { code } = await partnerWithSlip({
      terms: {
        patientDiscountBps: 1_000, patientDiscountCategories: ["consultation"],
        patientDiscountCapPaise: null,
        // NO payableRateBps, NO eligibleCategories — the accrual lane's required keys are absent.
      },
    });
    // Before the fix this REJECTED with PartnersError instead of resolving to null.
    expect(await resolveReferral(db, { code, patientId: null, at: NOW })).toBeNull();

    const { encounterId } = await shapeVisit();
    const draft = await quoteFor(encounterId, { attributionCode: code });
    expect(draft.totals.netPayablePaise).toBe(50_000); // priced, not thrown — the patient can pay
    expect(draft.lines[0]!.candidates).toHaveLength(0);
  });

  /**
   * REVIEW MAJOR 5. `attribution_ids.patient_id` was populated and never compared, so one slip
   * discounted unlimited bills for unlimited patients — append `&referral=<code>` to every quote in
   * the hospital and every consultation takes 10% off, attributed to a partner who referred one
   * person, with the slip still `issued`.
   */
  it("MAJOR 5 — a slip issued FOR one patient does not discount another patient's bill", async () => {
    const { encounterId: mine, patientId: mineId } = await shapeVisit();
    const { encounterId: theirs } = await shapeVisit();
    const { code } = await partnerWithSlip({ patientId: mineId });

    const ownBill = await quoteFor(mine, { attributionCode: code });
    expect(ownBill.totals.netPayablePaise).toBe(45_000); // the patient it was issued for: discounted

    const strangersBill = await quoteFor(theirs, { attributionCode: code });
    expect(strangersBill.totals.netPayablePaise).toBe(50_000); // anyone else: nothing
    expect(strangersBill.lines[0]!.candidates).toHaveLength(0);
  });

  it("MAJOR 5 — a slip naming NO patient stays a bearer instrument, which is what a leaflet is", async () => {
    const { code } = await partnerWithSlip(); // patientId null
    const { encounterId } = await shapeVisit();
    expect((await quoteFor(encounterId, { attributionCode: code })).totals.netPayablePaise).toBe(45_000);
  });

  // ── PURITY, ASSERTED RATHER THAN CLAIMED (the membership sources.test.ts precedent) ─────────

  it("propose is pure and synchronous: no clock, no await, no db import in the proposing half", () => {
    const text = readFileSync(join(__dirname, "sources.ts"), "utf8");
    const proposeHalf = text.slice(text.indexOf("export function referralSource"));
    expect(proposeHalf).not.toMatch(/await |async |Date\.now|new Date\(/);
  });

  it("propose runs with Date.now stubbed to throw — the instant comes from ctx.asOf alone", () => {
    const source = referralSource({
      attributionId: "a", code: "INV-PURE-1", counterpartyId: "cp", payeeClass: "channel_partner",
      discountBps: 1_000, categories: ["consultation"], capPaise: null, title: "Invented",
    });
    const ctx = {
      asOf: NOW,
      services: { svc: { category: "consultation" } },
    } as unknown as PricingContext;

    const realNow = Date.now;
    Date.now = () => { throw new Error("propose read a clock"); };
    try {
      const out = source.propose(ctx, { lineId: "l", serviceId: "svc", qty: 1 }, 50_000);
      expect(out).toHaveLength(1);
      expect(out[0]!.amountPaise).toBe(5_000);
    } finally {
      Date.now = realNow;
    }
  });

  it("B7 — the candidate's sourceKey IS the source's own key, or it sorts last on every tie", () => {
    const source = referralSource({
      attributionId: "a", code: "INV-KEY-1", counterpartyId: "cp", payeeClass: "channel_partner",
      discountBps: 500, categories: ["consultation"], capPaise: null, title: "Invented",
    });
    const ctx = { asOf: NOW, services: { svc: { category: "consultation" } } } as unknown as PricingContext;
    const [candidate] = source.propose(ctx, { lineId: "l", serviceId: "svc", qty: 1 }, 50_000);
    expect(candidate!.sourceKey).toBe(source.key);
    expect(source.key).toBe(REFERRAL_SOURCE_KEY);
  });

  it("the registry drops a provider that resolves to null, rather than appending an empty source", async () => {
    const unregister = registerBenefitSourceProvider("t2_probe_null", async () => null);
    try {
      const { encounterId } = await shapeVisit();
      const draft = await quoteFor(encounterId);
      expect(draft.lines[0]!.candidates).toHaveLength(0);
    } finally {
      unregister();
    }
  });
});
