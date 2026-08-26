import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { differingByOneChar } from "../../../test/helpers/mutate";
import { loadConfig } from "../../kernel/config";
import {
  attributionIds, counterparties, events, partnerAgreements, receivableExpectations,
} from "../../kernel/db/schema";
import {
  attributionCodeFor, expireUnclaimed, findAttributionByCode, issueAttribution,
  openExpectations, receivableCommissionEnabled, receivableTermsOf, voidAttribution,
} from "./attribution";
import { resolveAgreementAt } from "./agreements";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T7 — ATTRIBUTION AT REFERRAL TIME (DD13), THE FLAG THAT GATES IT (DD14/O-8), AND THE TWO
 * ENDS OF A CLAIM'S LIFE: V4's cancellation and V5's expiry.
 *
 * Assertion Book row **G5** lives here — `RECEIVABLE_COMMISSION_ENABLED` is load-bearing — and so
 * do V4 and V5. G1/G2/G4 are in `statements.test.ts`, G3 and V7 in `reconcile.test.ts`, V2 and
 * DD15's shape rule in `aging.test.ts`.
 *
 * ═══ EVERY PARTNER, RATE, WINDOW AND PERSON BELOW IS INVENTED HERE (DD3 / owner ruling O-9) ═══
 *
 * The out-of-git partner book supplies nothing to this repository. Each fixture tests a CLASS — a
 * slip nobody claims, a cancelled test, a suspended partner — and a class does not care which
 * invented rate carries it.
 *
 * ═══ THE FLAG IS ARMED FOR THIS SUITE AND NOWHERE ELSE ═══
 *
 * `RECEIVABLE_COMMISSION_ENABLED` defaults to false (DD14) and this file DELETES it in `afterAll`.
 * The G5 legs delete it in `beforeEach` instead of setting it, because the state that ships is the
 * variable being ABSENT and a test that only ever sets `"false"` never exercises it.
 */
const FLAG = "RECEIVABLE_COMMISSION_ENABLED";

const CLERK: Actor = { type: "user", id: "t7-referral-clerk" };
const NOW = new Date("2026-08-19T06:00:00Z"); // 11:30 IST
const AGREEMENT_FROM = new Date("2026-04-01T00:00:00Z");

const DAY_MS = 24 * 60 * 60 * 1000;

describe("attribution: one referral, one id, one partner (DD13)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });

  beforeEach(async () => {
    process.env[FLAG] = "true";
    await truncateAll(db);
  });

  /** An invented partner with an invented agreement version carrying BOTH lanes' terms. */
  async function partnerFor(args: {
    receivableRateBps?: number;
    unclaimedExpiryDays?: number;
    status?: string;
    payeeClass?: string;
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    terms?: Record<string, unknown>;
  } = {}): Promise<{ counterpartyId: string; agreementId: string }> {
    const counterpartyId = newId();
    const agreementId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-CP-${counterpartyId.slice(-6)}`, name: "Invented Diagnostic Partner",
      payeeClass: args.payeeClass ?? "channel_partner", status: args.status ?? "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: agreementId, counterpartyId, versionNo: 1,
      effectiveFrom: args.effectiveFrom ?? AGREEMENT_FROM,
      effectiveTo: args.effectiveTo ?? null, status: "active", createdBy: "test",
      terms: args.terms ?? {
        payableRateBps: 1_000, eligibleCategories: ["diagnostics"], kicker: null,
        receivableRateBps: 1_500, unclaimedExpiryDays: 45,
      },
    });
    return { counterpartyId, agreementId };
  }

  // ── THE FLAG (DD14 / O-8) — Assertion Book row G5 ──────────────────────────────────────────

  /**
   * ═══ BOOK ROW G5 — `RECEIVABLE_COMMISSION_ENABLED` IS LOAD-BEARING ═══
   *
   * One referral, flag off. The mutant is an `issueAttribution` that creates the expectation
   * regardless; the assertion that kills it is the COUNT of rows in both tables, not the refusal —
   * a lane that threw and wrote anyway would pass a refusal-only test.
   */
  it("G5 — with the flag OFF, one referral creates NO attribution and NO expectation", async () => {
    delete process.env[FLAG];
    const { counterpartyId } = await partnerFor();

    await expect(
      issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW),
    ).rejects.toMatchObject({ code: "receivable_disabled" });

    expect(await db.select().from(attributionIds)).toHaveLength(0);
    expect(await db.select().from(receivableExpectations)).toHaveLength(0);
  });

  it("G5 — the string \"false\" is OFF, not a non-empty truthy string", async () => {
    process.env[FLAG] = "false";
    const { counterpartyId } = await partnerFor();
    await expect(
      issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW),
    ).rejects.toMatchObject({ code: "receivable_disabled" });
    expect(await db.select().from(receivableExpectations)).toHaveLength(0);
  });

  /**
   * The duplicated reader is pinned against `kernel/config.ts`'s BY EXECUTION on all six inputs, the
   * discipline `consumer.test.ts` and `entitlements.test.ts` each keep for their own flag: the
   * spelling is copied deliberately (F1 — `loadConfig()` cannot run on this path) and a copy that
   * nothing compares drifts.
   */
  it("the local flag reader and kernel/config.ts agree on all six inputs", () => {
    const inputs: (string | undefined)[] = ["true", "false", "TRUE", "1", "", undefined];
    const attempt = (fn: () => boolean): boolean | "throws" => {
      try { return fn(); } catch { return "throws"; }
    };
    const observed = inputs.map((value) => {
      const env = { DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! } as NodeJS.ProcessEnv;
      if (value !== undefined) env[FLAG] = value;
      return {
        value,
        kernel: attempt(() => loadConfig(env).receivableCommissionEnabled),
        local: attempt(() => receivableCommissionEnabled(env)),
      };
    });
    // Pinned by EXECUTION and not by shape: a duplicate that nothing compares drifts, and the six
    // inputs include the two that matter — "false" (which a coercing boolean reads as TRUE) and
    // the variable being absent, which is what ships.
    expect(observed).toEqual([
      { value: "true", kernel: true, local: true },
      { value: "false", kernel: false, local: false },
      { value: "TRUE", kernel: "throws", local: "throws" },
      { value: "1", kernel: "throws", local: "throws" },
      { value: "", kernel: "throws", local: "throws" },
      { value: undefined, kernel: false, local: false },
    ]);
  });

  // ── ISSUANCE (DD13) ───────────────────────────────────────────────────────────────────────

  it("issues ONE id to ONE partner and creates ONE expectation priced off the agreement's rate", async () => {
    const { counterpartyId, agreementId } = await partnerFor({ receivableRateBps: 1_500 });

    const slip = await issueAttribution(
      db, CLERK,
      { counterpartyId, serviceHint: "outbound imaging", referredValuePaise: 400_000 },
      NOW,
    );

    // percentAmount(400 000, 1 500) = divHalfUp(400 000 · 1 500, 10 000) = 60 000
    expect(slip.expectedPaise).toBe(60_000);
    expect(slip.code).toBe(attributionCodeFor(slip.attributionId));
    expect(slip.qrPayload).toBe(slip.code); // DD15 — the QR carries the code and nothing else
    expect(slip.expiresAt).toEqual(new Date(NOW.getTime() + 45 * DAY_MS));

    const attributions = await db.select().from(attributionIds);
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({
      id: slip.attributionId, counterpartyId, state: "issued", issuedBy: CLERK.id,
    });

    const claims = await db.select().from(receivableExpectations);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      counterpartyId, attributionId: slip.attributionId, agreementId,
      amountPaise: 60_000, state: "expected", statementRef: null,
    });
    expect(claims[0]!.dueAt).toEqual(slip.expiresAt);

    const spine = await db.select().from(events).orderBy(asc(events.seq));
    expect(spine.map((e) => e.name)).toEqual(["attribution.issued"]);
    // DD15 — the payload carries ids and amounts, and no identity field of any kind.
    expect(Object.keys(spine[0]!.payload as Record<string, unknown>).sort()).toEqual([
      "attributionId", "code", "counterpartyId", "expectationId", "expectedPaise", "expiresAt",
    ]);
  });

  it("issuing a SECOND slip to the same partner mints a second id — one referral, one claim", async () => {
    const { counterpartyId } = await partnerFor();
    const a = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 100_000 }, NOW);
    const b = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 200_000 }, NOW);
    expect(a.attributionId).not.toBe(b.attributionId);
    expect(a.code).not.toBe(b.code);
    expect(await openExpectations(db, counterpartyId)).toHaveLength(2);
  });

  it("an agreement with NO receivable terms refuses LOUDLY rather than expecting nothing", async () => {
    const { counterpartyId } = await partnerFor({
      terms: { payableRateBps: 1_000, eligibleCategories: ["diagnostics"], kicker: null },
    });
    await expect(
      issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW),
    ).rejects.toMatchObject({ code: "unknown_agreement" });
    expect(await db.select().from(receivableExpectations)).toHaveLength(0);
  });

  it("an agreement carrying a rate but NO expiry window also refuses — a claim that never expires is V5's own failure", async () => {
    const { counterpartyId } = await partnerFor({
      terms: { payableRateBps: 1_000, eligibleCategories: ["diagnostics"], kicker: null, receivableRateBps: 1_500 },
    });
    await expect(
      issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW),
    ).rejects.toMatchObject({ code: "unknown_agreement" });
  });

  it("no active agreement at the referral instant is `no_effective_agreement`, and nothing is written", async () => {
    const { counterpartyId } = await partnerFor({ effectiveFrom: new Date("2026-09-01T00:00:00Z") });
    await expect(
      issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW),
    ).rejects.toMatchObject({ code: "no_effective_agreement" });
    expect(await db.select().from(attributionIds)).toHaveLength(0);
  });

  /** O-7 — a suspended or terminated partner gets no NEW claim; existing ones still settle. */
  it("O-7 — a SUSPENDED partner may not be sent a new referral", async () => {
    const { counterpartyId } = await partnerFor({ status: "suspended" });
    await expect(
      issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW),
    ).rejects.toMatchObject({ code: "counterparty_suspended" });
  });

  it("O-7 — a TERMINATED partner may not be sent a new referral", async () => {
    const { counterpartyId } = await partnerFor({ status: "terminated" });
    await expect(
      issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW),
    ).rejects.toMatchObject({ code: "counterparty_terminated" });
  });

  it("an unknown counterparty is a typed refusal, not a foreign-key error", async () => {
    await expect(
      issueAttribution(db, CLERK, { counterpartyId: newId(), referredValuePaise: 1 }, NOW),
    ).rejects.toMatchObject({ code: "unknown_counterparty" });
  });

  // ── THE WEDGE'S LOOKUP (11h's barcode lane) ───────────────────────────────────────────────

  it("a scanned code resolves EXACTLY, and carries no identity field (DD15)", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(
      db, CLERK,
      { counterpartyId, patientId: null, serviceHint: "outbound imaging", referredValuePaise: 400_000 },
      NOW,
    );

    const scanned = await findAttributionByCode(db, `  ${slip.code}  `);
    expect(scanned).toMatchObject({
      attributionId: slip.attributionId, code: slip.code, counterpartyId, state: "issued",
      expectation: { id: slip.expectationId, state: "expected", amountPaise: 60_000 },
    });
    expect(Object.keys(scanned!).sort()).toEqual([
      "attributionId", "code", "counterpartyId", "expectation", "expiresAt", "issuedAt",
      "serviceHint", "state",
    ]);
  });

  it("a code differing by ONE CHARACTER resolves to nothing — there is no prefix and no similarity", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    // NOT `${…slice(0, -1)}X` — one ULID in 32 already ends in X, and that "mutation" is the
    // original code. See test/helpers/mutate.ts; it cost this phase a red CI on its own CLOSE.
    expect(await findAttributionByCode(db, differingByOneChar(slip.code))).toBeNull();
    expect(await findAttributionByCode(db, slip.code.slice(0, -1))).toBeNull();
  });

  // ── V4 — A CANCELLED TEST VOIDS ITS EXPECTATION ───────────────────────────────────────────

  it("V4 — voiding a slip writes off its open expectation and marks the slip `void`", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);

    const result = await voidAttribution(
      db, CLERK, { attributionId: slip.attributionId, reason: "referred test cancelled at the desk" },
      new Date(NOW.getTime() + DAY_MS),
    );

    expect(result).toEqual({
      attributionId: slip.attributionId, expectationIds: [slip.expectationId], state: "void",
    });
    const claims = await db.select().from(receivableExpectations);
    expect(claims[0]).toMatchObject({
      state: "written_off", disputeReason: "referred test cancelled at the desk",
    });
    expect(claims[0]!.writtenOffAt).toEqual(new Date(NOW.getTime() + DAY_MS));
    const attributions = await db.select().from(attributionIds);
    expect(attributions[0]!.state).toBe("void");

    const spine = await db.select().from(events).orderBy(asc(events.seq));
    expect(spine.map((e) => e.name)).toEqual([
      "attribution.issued", "expectation.written_off", "attribution.voided",
    ]);
  });

  it("V4 — a slip whose claim a statement already MATCHED cannot be voided", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    // Shaped directly: the statement lane is `statements.test.ts`'s subject, not this file's.
    await db
      .update(receivableExpectations)
      .set({ state: "matched", statementRef: "INV-STMT-1", matchedAt: NOW })
      .where(eq(receivableExpectations.id, slip.expectationId));

    await expect(
      voidAttribution(db, CLERK, { attributionId: slip.attributionId, reason: "cancelled" }, NOW),
    ).rejects.toMatchObject({ code: "expectation_state_conflict" });

    // AND NOTHING MOVED — the refusal is a whole-transaction one, not a partial write.
    const attributions = await db.select().from(attributionIds);
    expect(attributions[0]!.state).toBe("issued");
  });

  it("voiding an unknown slip is a typed refusal", async () => {
    await expect(
      voidAttribution(db, CLERK, { attributionId: newId(), reason: "cancelled" }, NOW),
    ).rejects.toMatchObject({ code: "unknown_attribution" });
  });

  // ── V5 — AN UNCLAIMED SLIP EXPIRES AFTER THE CONFIGURED DAYS ──────────────────────────────

  /**
   * The window is the AGREEMENT's `unclaimedExpiryDays` (DD3: it is data), stamped onto `due_at` at
   * issuance. The two legs are the boundary: one day BEFORE the window closes nothing expires; one
   * day after, exactly the one slip does.
   */
  it("V5 — a slip nobody claims expires after the configured days, and not before", async () => {
    const { counterpartyId } = await partnerFor({ unclaimedExpiryDays: 45 });
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);

    const dayBefore = new Date(NOW.getTime() + 44 * DAY_MS);
    expect(await expireUnclaimed(db, CLERK, { at: dayBefore })).toEqual({
      expiredExpectationIds: [], expiredAttributionIds: [],
    });
    expect((await db.select().from(receivableExpectations))[0]!.state).toBe("expected");

    const dayAfter = new Date(NOW.getTime() + 46 * DAY_MS);
    expect(await expireUnclaimed(db, CLERK, { at: dayAfter })).toEqual({
      expiredExpectationIds: [slip.expectationId], expiredAttributionIds: [slip.attributionId],
    });

    const claims = await db.select().from(receivableExpectations);
    expect(claims[0]).toMatchObject({ state: "written_off", disputeReason: "unclaimed_expiry" });
    expect((await db.select().from(attributionIds))[0]!.state).toBe("expired");
    const spine = await db.select().from(events).orderBy(asc(events.seq));
    expect(spine.map((e) => e.name)).toEqual(["attribution.issued", "expectation.written_off"]);
  });

  it("V5 — the window is per-agreement DATA: two partners with different windows expire on different days", async () => {
    const quick = await partnerFor({
      terms: { payableRateBps: 1_000, eligibleCategories: ["diagnostics"], kicker: null, receivableRateBps: 1_000, unclaimedExpiryDays: 10 },
    });
    const slow = await partnerFor({
      terms: { payableRateBps: 1_000, eligibleCategories: ["diagnostics"], kicker: null, receivableRateBps: 1_000, unclaimedExpiryDays: 90 },
    });
    const quickSlip = await issueAttribution(db, CLERK, { counterpartyId: quick.counterpartyId, referredValuePaise: 100_000 }, NOW);
    await issueAttribution(db, CLERK, { counterpartyId: slow.counterpartyId, referredValuePaise: 100_000 }, NOW);

    const swept = await expireUnclaimed(db, CLERK, { at: new Date(NOW.getTime() + 30 * DAY_MS) });
    expect(swept.expiredExpectationIds).toEqual([quickSlip.expectationId]);
  });

  it("V5 — a MATCHED claim is never swept, however old", async () => {
    const { counterpartyId } = await partnerFor({ unclaimedExpiryDays: 45 });
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await db
      .update(receivableExpectations)
      .set({ state: "matched", statementRef: "INV-STMT-2", matchedAt: NOW })
      .where(eq(receivableExpectations.id, slip.expectationId));

    expect(await expireUnclaimed(db, CLERK, { at: new Date(NOW.getTime() + 400 * DAY_MS) }))
      .toEqual({ expiredExpectationIds: [], expiredAttributionIds: [] });
  });

  it("V5 — the sweep can be scoped to ONE partner", async () => {
    const a = await partnerFor({ terms: { payableRateBps: 1, eligibleCategories: [], kicker: null, receivableRateBps: 1_000, unclaimedExpiryDays: 5 } });
    const b = await partnerFor({ terms: { payableRateBps: 1, eligibleCategories: [], kicker: null, receivableRateBps: 1_000, unclaimedExpiryDays: 5 } });
    const slipA = await issueAttribution(db, CLERK, { counterpartyId: a.counterpartyId, referredValuePaise: 100_000 }, NOW);
    await issueAttribution(db, CLERK, { counterpartyId: b.counterpartyId, referredValuePaise: 100_000 }, NOW);

    const swept = await expireUnclaimed(db, CLERK, { at: new Date(NOW.getTime() + 10 * DAY_MS), counterpartyId: a.counterpartyId });
    expect(swept.expiredExpectationIds).toEqual([slipA.expectationId]);
    expect(await openExpectations(db, b.counterpartyId)).toHaveLength(1);
  });

  it("the expiry sweep refuses with the flag OFF rather than reporting a clean pass having written nothing", async () => {
    delete process.env[FLAG];
    await expect(expireUnclaimed(db, CLERK, { at: NOW })).rejects.toMatchObject({ code: "receivable_disabled" });
  });

  // ── DD6, transposed to the receivable direction ───────────────────────────────────────────

  it("the receivable terms are READ OFF `rawTerms`, which the accrual schema strips", async () => {
    const { counterpartyId } = await partnerFor();
    const agreement = await resolveAgreementAt(db, counterpartyId, NOW);
    // T6's schema is a plain z.object and drops the receivable half entirely…
    expect(agreement!.terms).not.toHaveProperty("receivableRateBps");
    // …and `rawTerms` is what carries it to this lane.
    expect(receivableTermsOf(agreement!)).toEqual({ receivableRateBps: 1_500, unclaimedExpiryDays: 45 });
  });
});
