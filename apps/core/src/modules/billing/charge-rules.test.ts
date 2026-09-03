import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { attributionIds, counterparties, couponDefinitions, invoices, opdEncounters, partnerAgreements, registrationConfig } from "../../kernel/db/schema";
import { getEncounter } from "../opd";
// FD-7 T9 — importing the module REGISTERS its benefit-source provider (`partners.module.ts:39`).
// Without it `resolveRegisteredSources` returns nothing and a partner slip prices as no discount,
// which is what the first draft of these tests actually measured.
import { PartnersModule } from "../partners";
import { registerPatient } from "../patients";
import { feeQuote, feeServiceFor, FEE_LINE_ID } from "./charge-rules";
import { loadBillingConfig } from "./config";
import { previewInvoice } from "./invoices";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T10, D8 — the OPD fee branch.
 *
 * THE SEEDED FIXTURE every number below is derived from (test/helpers/billing.ts `seedBillingBase`):
 *   · OPD-CONSULT-NEW and OPD-CONSULT-RENEWAL, category "consultation", EXEMPT healthcare
 *     (sac 999312), each priced 50000 paise; `charge_rules.opdConsult` names those two ids.
 *   · An exempt line carries no tax head at all, so a single consult prices to
 *     gross 50000 = base 50000, cgst 0, sgst 0, raw total 50000, roundTotalToRupee(50000) = 50000
 *     (rounding 0) — NET PAYABLE 50000.
 *
 * DISCLOSED SHAPING: `opd_encounters` rows are inserted DIRECTLY (the T5/T8 precedent — opening a
 * real visit needs the whole Class-A workflow activation, which proves nothing about a branch
 * lookup). `visit_type` is plain text with no CHECK, which is what lets the fourth case below
 * exist at all: the union is a TypeScript claim about that column, not a database one.
 */
describe("the OPD fee branch: feeServiceFor and the fee quote (D8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

  const NOW = new Date("2026-08-19T06:00:00Z"); // 11:30 IST — IST day 2026-08-19
  const SERVICE_DAY = "2026-08-19";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  async function mkTestPatient(name = "Branch Patient"): Promise<string> {
    const actor: Actor = { type: "user", id: "branch-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name, sex: "female", ageYears: 40 }));
    return patient.id;
  }

  /** See the shaping disclosure in this file's header. */
  async function shapeEncounter(visitType: string): Promise<string> {
    const id = newId();
    await db.insert(opdEncounters).values({
      id, visitNo: `VFX-${id}`, patientId: await mkTestPatient(), workflowInstanceId: newId(), serviceDate: SERVICE_DAY,
      visitType, status: "waiting", intendedPayer: "self", openedBy: "shaped", updatedBy: "shaped", openedAt: NOW,
    });
    return id;
  }

  async function encounterOf(visitType: string) {
    return (await getEncounter(db, await shapeEncounter(visitType)))!;
  }

  const codeOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

  it("a NEW visit charges chargeRules.opdConsult.new", async () => {
    const cfg = await loadBillingConfig(db);
    expect(feeServiceFor(await encounterOf("new"), cfg.chargeRules)).toBe(base.consultNewServiceId);
  });

  it("a RENEWAL visit charges chargeRules.opdConsult.renewal", async () => {
    const cfg = await loadBillingConfig(db);
    expect(feeServiceFor(await encounterOf("renewal"), cfg.chargeRules)).toBe(base.consultRenewalServiceId);
  });

  it("a REVISIT is FREE — the branch is null, and null is the free branch, not a missing mapping", async () => {
    const cfg = await loadBillingConfig(db);
    expect(feeServiceFor(await encounterOf("revisit"), cfg.chargeRules)).toBeNull();
  });

  it("a visit type outside the three OPD stamps has no rule at all: fee_not_applicable", async () => {
    const cfg = await loadBillingConfig(db);
    const encounter = await encounterOf("day_care");
    let thrown: unknown = null;
    try {
      feeServiceFor(encounter, cfg.chargeRules);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      name: "BillingError", code: "fee_not_applicable", detail: { encounterId: encounter.id, visitType: "day_care" },
    });
  });

  it("feeQuote composes the branch with previewInvoice, prices the fee line, and persists NOTHING", async () => {
    const newVisit = await shapeEncounter("new");
    const quote = await feeQuote(db, newVisit, NOW);
    expect(quote).toMatchObject({
      encounterId: newVisit, visitType: "new", free: false, feeServiceId: base.consultNewServiceId,
    });
    expect(quote.draft!.lines).toHaveLength(1);
    expect(quote.draft!.lines[0]).toMatchObject({
      lineId: FEE_LINE_ID, serviceId: base.consultNewServiceId, qty: 1, unitPaise: 50_000, grossPaise: 50_000,
      discountPaise: 0, taxableBasePaise: 50_000, netPaise: 50_000,
    });
    // Exempt healthcare: no head to compute, so nothing to round either.
    expect(quote.draft!.lines[0]!.gst).toMatchObject({ sacCode: "999312", exempt: true, cgstPaise: 0, sgstPaise: 0 });
    expect(quote.draft!.totals).toMatchObject({
      grossPaise: 50_000, taxableBasePaise: 50_000, cgstPaise: 0, sgstPaise: 0,
      rawTotalPaise: 50_000, netPayablePaise: 50_000, roundingPaise: 0,
    });
    expect(await db.select().from(invoices)).toHaveLength(0); // a quote is a question

    const revisit = await shapeEncounter("revisit");
    expect(await feeQuote(db, revisit, NOW)).toEqual({
      encounterId: revisit, visitType: "revisit", free: true, feeServiceId: null, draft: null,
      // RC-1 T5 — a shaped row has no department and no anchor: free with NO story, never un-freed.
      // The anchored freeReason is proved in opd/fee-status.test.ts, where real masters exist.
      freeReason: null,
      // RC-2 T5 / D7 — the payer travels on the FREE branch too, which is the branch with no draft
      // to read it from. This exhaustive `toEqual` is what caught the addition, which is the point
      // of writing it exhaustively.
      intendedPayer: "self",
      // FD-7 T9 / R4 — and it caught this one too. The partner slip travels on the FREE branch as
      // well: a review visit still carries the slip, and the partner's accrual hangs off the slip
      // rather than off whether this particular visit was charged for.
      attributionCode: null,
    });

    expect(await codeOf(feeQuote(db, "no-such-encounter", NOW)))
      .toMatchObject({ name: "BillingError", code: "unknown_encounter" });
  });
});

/**
 * RC-2 T1 / D2 — THE COUPON THE CLERK IS HOLDING REACHES THE QUOTE.
 *
 * ═══ THE DEFECT, AND WHY IT IS THE RC-1 T1 CLASS AGAIN ═══
 *
 * `charge-rules.ts` claims in its own header that "a quote and the invoice that follows it can
 * never disagree about the money", because both run `previewInvoice`. For a coupon that claim was
 * FALSE: `previewInvoice` declares `couponCodes`, `feeQuote` accepted none, so the counter could
 * only ever quote the undiscounted number and then bill the discounted one. One screen over, RC-1
 * T1 fixed the same shape — a field the caller was entitled to send that the boundary silently
 * dropped — which is why this task exists rather than being folded into RC-3's rendering.
 *
 * ═══ THE MUTANT IS THE SHIPPED CODE, AND THE FAIL-FIRST RED IS THE KILL (rule 21) ═══
 *
 * These cases were first run against a `feeQuote` whose signature took `opts` and IGNORED it —
 * today's semantics, expressed in today's types. Recorded red before the forward landed:
 *
 *     expect(received).toBe(expected)   Expected: 45000   Received: 50000
 *
 * i.e. the quote charged the full consult while the invoice behind it took the 10% off. No scratch
 * file was needed: the mutant was a one-line absence in the function under test.
 *
 * ═══ THE FIXTURE'S MONEY, HAND-DERIVED ═══
 *
 * `seedBillingBase` prices OPD-CONSULT-NEW at 50 000 paise, category "consultation", EXEMPT
 * healthcare — no tax head moves. The coupon invented here is 1 000 bps (10%) scoped to that
 * category, single-use, and belongs to NO plan: `resolveCoupons` matches `byCode` OR `byPlan`, so a
 * presented code needs no membership instance behind it, which is exactly the walk-in case.
 *
 *     gross 50 000 · coupon percentAmount(50 000, 1 000) = 5 000 · NET PAYABLE 45 000
 *
 * Every code and title below is INVENTED HERE (Plan 09 DD3 / O-9); production catalogs are empty.
 */
describe("RC-2 T1 — a presented coupon reaches the quote, not just the invoice (D2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  const FLAG = "MEMBER_BENEFITS_ENABLED";
  const NOW = new Date("2026-09-01T06:00:00Z"); // 11:30 IST, a Tuesday
  const SERVICE_DAY = "2026-09-01";
  const COUPON_ID = "01HT4RC2CPN000000000001";
  const COUPON_CODE = "RC2-QUOTE-10";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => {
    delete process.env[FLAG];
    await teardown();
  });

  beforeEach(async () => {
    process.env[FLAG] = "true"; // D1: the flag is armed IN TESTS ONLY; no deployed default changes
    new PartnersModule(); // arms the referral provider exactly as production does
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await seedBillingBase(db);
    await db.insert(couponDefinitions).values({
      id: COUPON_ID, code: COUPON_CODE, title: "Invented counter coupon", planId: null,
      benefit: { kind: "percent_bps", value: 1_000, title: "Invented counter coupon" },
      scope: { serviceCategories: ["consultation"], serviceIds: null },
      minBillPaise: 0, singleUse: true,
      validFrom: new Date("2026-01-01T00:00:00Z"), validTo: new Date("2026-12-31T00:00:00Z"),
      createdBy: "test",
    });
  });

  /** Same shaping disclosure as this file's header: the branch is what is under test, not the workflow. */
  async function shapeNewVisit(): Promise<string> {
    const id = newId();
    const actor: Actor = { type: "user", id: "rc2-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name: "Sunita Rao", sex: "female", ageYears: 44 }));
    await db.insert(opdEncounters).values({
      id, visitNo: `VRC2-${id}`, patientId: patient.id, workflowInstanceId: newId(), serviceDate: SERVICE_DAY,
      visitType: "new", status: "waiting", intendedPayer: "self", openedBy: "shaped", updatedBy: "shaped", openedAt: NOW,
    });
    return id;
  }

  it("quotes the coupon the clerk presented, and agrees with the invoice that follows to the paise", async () => {
    const encounterId = await shapeNewVisit();

    const quoted = await feeQuote(db, encounterId, NOW, { couponCodes: [COUPON_CODE] });
    expect(quoted.free).toBe(false);
    expect(quoted.draft!.totals.netPayablePaise).toBe(45_000); // THE KILL: shipped code returned 50 000

    // The header's own claim, now true for a coupon: the quote and the invoice behind it are one core.
    const invoiceSide = await previewInvoice(
      db, { encounterId, lines: [{ lineId: FEE_LINE_ID, serviceId: quoted.feeServiceId!, qty: 1 }], couponCodes: [COUPON_CODE] }, NOW,
    );
    expect(quoted.draft!.totals.netPayablePaise).toBe(invoiceSide.totals.netPayablePaise);
    expect(await db.select().from(invoices)).toHaveLength(0); // a quote is still a question
  });

  /**
   * S2's finding, asserted rather than assumed: the BEST-SINGLE-BENEFIT ruling needs the seat to
   * name the winner, and `PricedLine` has carried `winner` + `candidates` since Plan 06. RC-2
   * designs no new wire type for it; it owes proof that the field survives the quote.
   */
  it("names the winning benefit on the quoted line, so the seat can say which chip won", async () => {
    const quoted = await feeQuote(db, await shapeNewVisit(), NOW, { couponCodes: [COUPON_CODE] });
    const line = quoted.draft!.lines[0]!;
    expect(line.winner).toMatchObject({ ruleKey: COUPON_CODE, amountPaise: 5_000 });
    expect(line.candidates.map((c) => c.ruleKey)).toContain(COUPON_CODE);
    expect(line.discountPaise).toBe(5_000);
  });

  it("presenting no code changes nothing — the undiscounted quote is still the shipped one", async () => {
    const quoted = await feeQuote(db, await shapeNewVisit(), NOW);
    expect(quoted.draft!.totals.netPayablePaise).toBe(50_000);
    expect(quoted.draft!.lines[0]!.winner).toBeNull();
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     FD-7 T9 / OWNER RULING R4 — THE SLIP THE DESK CAPTURED
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  /**
   * `attributionCode` was a PER-REQUEST PARAMETER with no durable home. This file's own comment said
   * "the clerk attaches the slip during registration, long before billing is opened" — and there was
   * no column to attach it to, so the slip died between the desk and the cashier unless it was
   * re-typed. Migration 0059 gave it one on the encounter; these are the two reads.
   */
  async function shapeVisitWithSlip(code: string | null): Promise<string> {
    const id = await shapeNewVisit();
    await db.update(opdEncounters).set({ attributionCode: code }).where(eq(opdEncounters.id, id));
    return id;
  }

  it("FD-7 T9: the quote falls back to the slip the desk captured", async () => {
    const quoted = await feeQuote(db, await shapeVisitWithSlip("PTR-9911"), NOW);
    // Returned so the billing screen can PRE-FILL — echoing the caller's own parameter back would
    // make the field useless, so this is the STORED value on both branches.
    expect(quoted.attributionCode).toBe("PTR-9911");
  });

  /**
   * ═══ AND IT MUST PRICE, NOT MERELY REPORT ═══
   *
   * Two mutants survived the first draft of these tests: deleting the fallback, and deleting
   * `opts.attributionCode` from it. Both passed, because every assertion above reads the REPORTED
   * field and none of them reads the MONEY. A stored slip that shows up in a response and changes
   * no price is exactly the rail-with-no-consumer defect this phase keeps finding, so the partner
   * rows below exist to make the fallback move a number.
   *
   * The agreement's `patientDiscountBps` is 1 000 (10%) on "consultation": 50 000 gross → 45 000.
   */
  async function issuePartnerSlip(code: string): Promise<void> {
    const counterpartyId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `CP-${code}`, name: "Invented Referrer",
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: newId(), counterpartyId, versionNo: 1, effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      effectiveTo: null, status: "active", createdBy: "test",
      terms: {
        payableRateBps: 1_000, eligibleCategories: ["consultation"], kicker: null,
        patientDiscountBps: 1_000, patientDiscountCategories: ["consultation"],
        patientDiscountCapPaise: null, patientDiscountTitle: "Invented partner referral",
      },
    });
    await db.insert(attributionIds).values({
      id: newId(), code, counterpartyId, state: "issued", issuedBy: "test",
      issuedAt: new Date("2026-01-01T00:00:00Z"),
    });
  }

  it("FD-7 T9: the stored slip DISCOUNTS the quote with no code passed at all", async () => {
    await issuePartnerSlip("PTR-PRICES");
    const withSlip = await feeQuote(db, await shapeVisitWithSlip("PTR-PRICES"), NOW);
    const without = await feeQuote(db, await shapeVisitWithSlip(null), NOW);

    // THE KILL for a fallback that reports but does not price.
    expect(withSlip.draft!.totals.netPayablePaise).toBe(45_000);
    expect(without.draft!.totals.netPayablePaise).toBe(50_000);
  });

  /** And `opts` still reaches the pricing, which is the other half of the same line. */
  it("FD-7 T9: a code passed explicitly prices even when the encounter stored none", async () => {
    await issuePartnerSlip("PTR-TYPED-ONLY");
    const quoted = await feeQuote(db, await shapeVisitWithSlip(null), NOW, { attributionCode: "PTR-TYPED-ONLY" });
    expect(quoted.draft!.totals.netPayablePaise).toBe(45_000);  // THE KILL for dropping opts
    expect(quoted.attributionCode).toBeNull();                  // …and it is still the STORED value reported
  });

  /** R4 keeps the slip editable at billing, so the cashier looking at the paper still wins. */
  it("FD-7 T9: an explicitly passed code overrides the stored one", async () => {
    const quoted = await feeQuote(db, await shapeVisitWithSlip("PTR-STORED"), NOW, { attributionCode: "PTR-TYPED" });
    // The quote is PRICED with the typed code…
    expect(quoted.free).toBe(false);
    // …and still REPORTS the stored one, because that is what the pre-fill is for.
    expect(quoted.attributionCode).toBe("PTR-STORED");
  });

  /**
   * THE FREE BRANCH RETURNS IT TOO, and a mutant proved this needed its own row: nulling the free
   * branch's `attributionCode` broke nothing, because the only free-branch assertion in this file is
   * over a visit that has no slip. A review visit still carries the partner's slip — the accrual
   * hangs off the slip, not off whether this particular visit was charged for — and the billing
   * screen must pre-fill on that branch as well or the cashier silently drops the partner.
   */
  it("FD-7 T9: a FREE revisit still reports the slip, so the pre-fill works on both branches", async () => {
    const id = newId();
    const actor: Actor = { type: "user", id: "rc2-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name: "Meena Iyer", sex: "female", ageYears: 52 }));
    await db.insert(opdEncounters).values({
      id, visitNo: `VRC2F-${id}`, patientId: patient.id, workflowInstanceId: newId(), serviceDate: SERVICE_DAY,
      visitType: "revisit", status: "waiting", intendedPayer: "self", openedBy: "shaped", updatedBy: "shaped",
      openedAt: NOW, attributionCode: "PTR-ON-A-FREE-VISIT",
    });

    const quoted = await feeQuote(db, id, NOW);
    expect(quoted.free).toBe(true);                                   // the branch with no draft
    expect(quoted.attributionCode).toBe("PTR-ON-A-FREE-VISIT");       // THE KILL
  });

  it("FD-7 T9: a visit with no slip quotes null, not an empty string", async () => {
    expect((await feeQuote(db, await shapeVisitWithSlip(null), NOW)).attributionCode).toBeNull();
  });

  it("an unknown code is quoted as no discount, never as an error — the clerk retypes, the counter does not stall", async () => {
    const quoted = await feeQuote(db, await shapeNewVisit(), NOW, { couponCodes: ["NOT-A-REAL-CODE"] });
    expect(quoted.draft!.totals.netPayablePaise).toBe(50_000);
  });
});

/**
 * RC-2 T5 / D7 — THE QUOTE NAMES THE PAYER, ON BOTH BRANCHES.
 *
 * Corporate v0 is naming, not machinery: no rate list, no e-authorisation record, no claim file —
 * Plan 21 owns those and a second home would be worse than none. What the seat needs today is the
 * one fact that lets it say "bill to panel — nothing to collect", and the one fact that EXPLAINS
 * something RC-2 T3 introduced: with a non-`self` payer, member, coupon and referral benefits do
 * not compose at all, so the bill shows no chips. Without the payer on the quote that absence is
 * unexplained; with it, the seat can say why.
 *
 * `PricedDraft.intendedPayer` was already there — but a review-window revisit has `draft: null`, so
 * the free branch could not answer. Lifting it to the quote makes both branches answer identically.
 */
describe("RC-2 T5 — the quote names the payer on both branches (D7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  const NOW = new Date("2026-09-01T06:00:00Z");
  const SERVICE_DAY = "2026-09-01";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await seedBillingBase(db);
  });

  async function shaped(visitType: string, intendedPayer: string): Promise<string> {
    const id = newId();
    const actor: Actor = { type: "user", id: "t5-clerk" };
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, actor, { name: "Payer Subject", sex: "other", ageYears: 50 }));
    await db.insert(opdEncounters).values({
      id, visitNo: `VT5-${id}`, patientId: patient.id, workflowInstanceId: newId(), serviceDate: SERVICE_DAY,
      visitType, status: "waiting", intendedPayer, openedBy: "shaped", updatedBy: "shaped", openedAt: NOW,
    });
    return id;
  }

  it.each(["self", "tpa", "pmjay", "corporate"])(
    "a PRICED visit carries intendedPayer=%s, and it agrees with the draft's own copy",
    async (payer) => {
      const quote = await feeQuote(db, await shaped("new", payer), NOW);
      expect(quote.free).toBe(false);
      expect(quote.intendedPayer).toBe(payer);
      expect(quote.draft!.intendedPayer).toBe(payer); // one fact, two places, never disagreeing
    },
  );

  it.each(["self", "corporate"])(
    "a FREE visit carries intendedPayer=%s too — the branch with no draft to read it from",
    async (payer) => {
      const quote = await feeQuote(db, await shaped("revisit", payer), NOW);
      expect(quote.free).toBe(true);
      expect(quote.draft).toBeNull(); // …which is exactly why the field cannot live only on the draft
      expect(quote.intendedPayer).toBe(payer);
    },
  );
});
