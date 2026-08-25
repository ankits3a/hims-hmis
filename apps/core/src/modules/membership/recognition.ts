import { eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { getApproval } from "../../kernel/approvals/worklist";
import { withTx } from "../../kernel/db/client";
import { couponDefinitions, membershipInstances, membershipPlans } from "../../kernel/db/schema";
import { listMergedLoserIds, resolvePatientId, visiblePatientIds } from "../patients";
import { couponUnusableReason, membershipUsableAt } from "./coupon-rules";
import { MembershipError } from "./errors";
import { instrumentGraceHonored } from "./events";
import type { CouponUnusableReason } from "./coupon-rules";
import type {
  BenefitScope, BenefitTerm, ResolvedCoupon, ResolvedInstruments, ResolvedMembership,
} from "./instruments";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T3 — RECOGNITION AT THE COUNTER: who is standing there, what they hold, and what the
 * hospital is willing to say about it.
 *
 * ═══ THIS SHIPS BEFORE THE BILLING INTEGRATION, AND THE ORDER IS STRUCTURAL (DD8) ═══
 *
 * The standing ruling is that a counter discount cannot be backfilled: a member billed before
 * recognition worked is a member who paid the wrong amount, and there is no clean way back. So
 * recognition is deployed, the holder book imported and the reconcile queue cleared BEFORE
 * `MEMBER_BENEFITS_ENABLED` is flipped. T4 calls `resolveInstruments` from the module index; until
 * it does, nothing here prices anything, which is the mechanical half of the same ruling.
 *
 * ═══ THE SEALED GATE IS `visiblePatientIds()` AND IT IS NEVER RE-IMPLEMENTED (DD15) ═══
 *
 * 11h's independent review found a sealed patient reachable through a chip-scoped query whose two
 * halves were each individually correct (§2.89). The lesson written into this phase at design time
 * is that confidentiality has exactly ONE decision point — `modules/patients`' own helper — and
 * every caller here funnels through it. Nothing in this file reads `patients.is_confidential`, and
 * nothing post-filters a result set: the visible ids become a SQL predicate, and in the search
 * provider that predicate is inside the same query that produces both the rows and their count
 * (C1).
 *
 * ═══ THERE IS NO TIME AUTHORITY HERE EITHER ═══
 *
 * `at` is a QUERY PARAMETER — which instruments were live at that instant — and never a term of
 * the arithmetic. `ResolvedInstruments` deliberately carries no timestamp (see `instruments.ts`):
 * the money moment is `PricingContext.asOf`, pinned once by the impure loader, and a second
 * authority on the same instant inside the money path is the defect O-2 exists to prevent.
 */

/**
 * O-1/E-32's disclosure line, rendered at HONOURING time.
 *
 * It ships with the recognition surface rather than with the sale lane, because the guardrails of a
 * disabled lane are the whole point of the structural-OFF pattern: `MEMBERSHIP_SALES_ENABLED` is
 * false for the whole of Phase 1 and this sentence is still what a member is shown the moment the
 * hospital honours a card. It is carried in the RESPONSE rather than looked up by the screen so
 * that every client — the counter, a printed slip, a future kiosk — says the same thing, and so a
 * screen cannot quietly stop saying it.
 */
export const MEMBERSHIP_DISCLOSURE =
  "This benefit comes from a membership or discount card. It is a discount on the hospital's own " +
  "charges, it is not insurance, and it does not change the treatment offered or its priority. " +
  "Ask at the counter for the card's terms.";

/** The four states `membership_instances.status` may hold. Nothing narrows it in SQL, so it is narrowed here. */
const INSTANCE_STATUSES = ["active", "expired", "suspended", "cancelled"] as const;
type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

/**
 * An unrecognised status must never READ AS ACTIVE. There is no CHECK constraint on this column —
 * migration 0022 constrains `counterparties.status` and the two accrual directions, and not this
 * one — so a value a future lane invents would otherwise reach `membershipUsableAt`'s
 * `!== "active"` test and be refused by luck rather than by decision. `cancelled` is the closed
 * answer: unknown means it prices nothing.
 */
function instanceStatus(raw: string): InstanceStatus {
  return (INSTANCE_STATUSES as readonly string[]).includes(raw) ? (raw as InstanceStatus) : "cancelled";
}

/**
 * THE SHAPE OF A CONFIGURED BENEFIT TERM, parsed on the way OUT of `jsonb` (the M3 belt).
 *
 * DD3 fixes the shape here and the VALUES nowhere: every percentage, cap and key is a
 * commissioning row. Nothing parses these columns on the way out of the database by default —
 * drizzle hands back `unknown` — so a fractional paise or a missing key in a seeded catalog would
 * otherwise reach `benefitCandidate`'s `assertPaise` as a runtime surprise at a counter.
 *
 * `z.coerce` appears nowhere near these values (§3.19): `z.coerce.number()` would silently turn a
 * configured string `"12.5"` into a fractional paise instead of refusing it.
 */
const benefitScopeSchema: z.ZodType<BenefitScope> = z.object({
  serviceCategories: z.array(z.string()).nullable().default(null),
  serviceIds: z.array(z.string()).nullable().default(null),
});

/**
 * `kind` accepts the short spellings too, and that is a documented tolerance rather than drift.
 * `kernel/db/schema/membership.ts` describes `coupon_definitions.benefit` as
 * `{ kind: 'percent'|'flat', … }` — written before T2 fixed `BenefitTerm`'s union at
 * `percent_bps | flat_paise`. A commissioning file written against the column comment must not be
 * refused at a counter, so both spellings map onto the one union the arithmetic uses.
 */
const benefitKindSchema = z
  .enum(["percent_bps", "flat_paise", "percent", "flat"])
  .transform((k): BenefitTerm["kind"] => (k === "percent" || k === "percent_bps" ? "percent_bps" : "flat_paise"));

const benefitTermSchema = z.object({
  benefitKey: z.string().min(1),
  title: z.string().min(1),
  kind: benefitKindSchema,
  value: z.number(),
  capPaise: z.number().nullable().default(null),
  scope: benefitScopeSchema.default({ serviceCategories: null, serviceIds: null }),
});

const planBenefitsSchema = z.array(benefitTermSchema);

/** A coupon's own single term. Its cap and its minimum bill are COLUMNS, so they are not read here. */
const couponBenefitSchema = benefitTermSchema.pick({ title: true, kind: true, value: true });

function parsePlanBenefits(planId: string, raw: unknown): BenefitTerm[] {
  const parsed = planBenefitsSchema.safeParse(raw ?? []);
  if (!parsed.success) {
    // A catalog row whose terms cannot be read is a COMMISSIONING error, and the counter must say
    // so rather than honour a card for an amount nobody can name. `unknown_plan` is the closed
    // union's code for "this plan cannot be resolved"; the detail carries the issues.
    throw new MembershipError("unknown_plan", `plan ${planId} carries unreadable benefit terms`, parsed.error.issues);
  }
  return parsed.data;
}

/** One instance row as recognition reads it — the projection both the seam and the view are built from. */
type InstanceRow = {
  instanceId: string;
  planId: string;
  planTitle: string;
  planBenefits: unknown;
  queuePerk: boolean;
  cardCode: string;
  status: string;
  origin: string;
  verified: boolean;
  validFrom: Date;
  validTo: Date;
};

/** Codes as typed, folded to the one comparable form both lookup lanes use. */
function normaliseCodes(presented: readonly string[] | undefined): string[] {
  return [...new Set((presented ?? []).map((c) => c.trim().toLowerCase()).filter((c) => c !== ""))];
}

/**
 * ═══ MERGE IS RESOLVED AT READ TIME; INSTRUMENTS ARE NEVER RE-LINKED (DD11) ═══
 *
 * `registration.ts` is explicit that a merge never rewrites another module's rows, so an instance
 * issued before a merge still points at the LOSER's id for ever. Resolving only forwards
 * (`resolvePatientId`) would therefore find nothing for the survivor — the card would go dark at
 * the counter the day the hospital tidied its own duplicate records. So the survivor's whole merge
 * TREE is queried, through the patients module's own `listMergedLoserIds`.
 */
async function mergeTree(db: Db, patientId: string | null): Promise<{ patientId: string | null; ids: string[] }> {
  if (patientId === null || patientId === "") return { patientId: null, ids: [] };
  const survivor = await resolvePatientId(db, patientId);
  if (survivor === null) return { patientId: null, ids: [] };
  return { patientId: survivor, ids: [survivor, ...(await listMergedLoserIds(db, survivor))] };
}

async function loadInstances(db: Db, args: { patientIds: string[]; codes: string[] }): Promise<InstanceRow[]> {
  const byPatient = args.patientIds.length === 0 ? undefined : inArray(membershipInstances.patientId, args.patientIds);
  // Card codes are partner data and a desk types what it reads off the card, so the comparison is
  // case-insensitive. It is a literal `in`, never a LIKE: a presented code is exact or it is not
  // this card, and a prefix here would let one code recognise a family of them.
  const byCode = args.codes.length === 0 ? undefined : sql`lower(${membershipInstances.cardCode}) in ${args.codes}`;
  const conditions = [byPatient, byCode].filter((c) => c !== undefined);
  if (conditions.length === 0) return [];
  return db
    .select({
      instanceId: membershipInstances.id,
      planId: membershipInstances.planId,
      planTitle: membershipPlans.title,
      planBenefits: membershipPlans.benefits,
      queuePerk: membershipPlans.queuePerk,
      cardCode: membershipInstances.cardCode,
      status: membershipInstances.status,
      origin: membershipInstances.origin,
      verified: membershipInstances.verified,
      validFrom: membershipInstances.validFrom,
      validTo: membershipInstances.validTo,
    })
    .from(membershipInstances)
    .innerJoin(membershipPlans, eq(membershipPlans.id, membershipInstances.planId))
    .where(or(...conditions))
    .orderBy(membershipInstances.seq); // arrival order — ULIDs cannot carry it (§3.26)
}

function toResolvedMembership(row: InstanceRow): ResolvedMembership {
  return {
    instanceId: row.instanceId,
    planId: row.planId,
    planTitle: row.planTitle,
    cardCode: row.cardCode,
    status: instanceStatus(row.status),
    validFrom: row.validFrom,
    validTo: row.validTo,
    benefits: parsePlanBenefits(row.planId, row.planBenefits),
  };
}

/**
 * Presented coupon codes, plus every coupon the resolved instances' own plans bundle.
 *
 * A BUNDLED COUPON IS INSTANCE-BOUND AND A PRESENTED ONE IS NOT, which is what
 * `ResolvedCoupon.instanceId` means and why the bundled spelling wins the dedupe: a coupon that
 * arrived with a card is redeemed against that card's instance, and T4's redemption writer needs
 * the link. Deduping the other way would silently unbind it.
 */
async function resolveCoupons(
  db: Db,
  args: { codes: string[]; instances: InstanceRow[] },
): Promise<ResolvedCoupon[]> {
  const planIds = [...new Set(args.instances.map((i) => i.planId))];
  const byCode = args.codes.length === 0 ? undefined : sql`lower(${couponDefinitions.code}) in ${args.codes}`;
  const byPlan = planIds.length === 0 ? undefined : inArray(couponDefinitions.planId, planIds);
  const conditions = [byCode, byPlan].filter((c) => c !== undefined);
  if (conditions.length === 0) return [];

  const rows = await db.select().from(couponDefinitions).where(or(...conditions));
  const instanceOfPlan = new Map(args.instances.map((i) => [i.planId, i.instanceId] as const));

  const out = new Map<string, ResolvedCoupon>();
  for (const row of rows) {
    const benefit = couponBenefitSchema.safeParse(row.benefit ?? {});
    if (!benefit.success) {
      throw new MembershipError("unknown_coupon", `coupon ${row.id} carries an unreadable benefit`, benefit.error.issues);
    }
    const scope = benefitScopeSchema.safeParse(row.scope ?? {});
    if (!scope.success) {
      throw new MembershipError("unknown_coupon", `coupon ${row.id} carries an unreadable scope`, scope.error.issues);
    }
    const bundled = row.planId === null ? undefined : instanceOfPlan.get(row.planId);
    const resolved: ResolvedCoupon = {
      couponId: row.id,
      code: row.code,
      title: row.title,
      instanceId: bundled ?? null,
      benefit: {
        // relay note 13 — the coupon's OWN CODE is the benefit key, because it becomes
        // `AdjustmentCandidate.ruleKey`, which is the string the D-8 audit record shows a member.
        benefitKey: row.code,
        title: row.title,
        kind: benefit.data.kind,
        value: benefit.data.value,
        capPaise: row.capPaise,
        scope: scope.data,
      },
      minBillPaise: row.minBillPaise,
      validFrom: row.validFrom,
      validTo: row.validTo,
      weekdayMask: row.weekdayMask,
      windowStartMinute: row.windowStartMinute,
      windowEndMinute: row.windowEndMinute,
      status: row.status === "retired" ? "retired" : "active",
    };
    const existing = out.get(row.id);
    if (existing === undefined || (existing.instanceId === null && resolved.instanceId !== null)) {
      out.set(row.id, resolved);
    }
  }
  return [...out.values()];
}

export type ResolveInstrumentsInput = {
  /** The patient at the counter, or null when nobody has been identified yet. */
  patientId?: string | null;
  /** Card and coupon codes physically presented. */
  presentedCodes?: string[];
  /** WHICH INSTRUMENTS WERE LIVE AT THIS INSTANT. A query parameter, never a term of the arithmetic. */
  at: Date;
  /**
   * The draft's GROSS total, for K4's minimum-bill threshold. The COMPOSER owns this number (T4,
   * relay note 12) and passes it as `{ ...resolved, billGrossPaise }`; a recognition surface with
   * no draft in front of it has no bill yet, which is what the 0 default means.
   */
  billGrossPaise?: number;
};

/**
 * THE SEAM T2 DEFINED AND T4 CONSUMES: everything the money path is allowed to know about the
 * instruments this person holds, resolved ONCE, before any transaction.
 *
 * IT TAKES NO ACTOR, AND THAT IS DELIBERATE. Its caller is the billing composer, whose subject is
 * an invoice's own patient — already resolved, already authorised. Confidentiality is decided by
 * the surfaces that take a caller: `recogniseForActor` below and the search provider beside it,
 * both through `visiblePatientIds`. Putting a permission check inside a pure resolution step would
 * mean the money path had two authorities on the same question and neither could be audited from
 * the declaration (`kernel/search/types.ts` states the same rule for providers).
 */
export async function resolveInstruments(db: Db, input: ResolveInstrumentsInput): Promise<ResolvedInstruments> {
  const codes = normaliseCodes(input.presentedCodes);
  const { patientId, ids } = await mergeTree(db, input.patientId ?? null);
  const rows = await loadInstances(db, { patientIds: ids, codes });
  return {
    patientId,
    memberships: rows.map(toResolvedMembership),
    coupons: await resolveCoupons(db, { codes, instances: rows }),
    billGrossPaise: input.billGrossPaise ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------
// The counter's own view — what a desk is shown when it recognises somebody
// ---------------------------------------------------------------------------------------------

export type RecognisedMembership = {
  instanceId: string;
  planId: string;
  planTitle: string;
  cardCode: string;
  status: InstanceStatus;
  /** `'import' | 'counter' | 'grace'` — a grace-honored instance says so on the screen (O-1). */
  origin: string;
  /** C-17. Shown, never acted on here: verification gates T6's ACCRUAL, never the member's benefit. */
  verified: boolean;
  /** `membershipUsableAt` — the shipped IST-calendar-day predicate, not a second copy of it. */
  usable: boolean;
  validFrom: Date;
  validTo: Date;
  /** DD16 — the plan grants the E-32 queue perk. See `RECOGNITION_PERK_NOTE`. */
  queuePerk: boolean;
  benefits: { benefitKey: string; title: string }[];
};

export type RecognisedCoupon = {
  couponId: string;
  code: string;
  title: string;
  instanceId: string | null;
  /** `null` when the coupon applies. Otherwise the ONE sentence the member is owed (relay note 14). */
  unusableReason: CouponUnusableReason | null;
};

export type RecognitionResult = {
  patientId: string | null;
  memberships: RecognisedMembership[];
  coupons: RecognisedCoupon[];
  /** E-32 — rendered at honouring time, carried by the response so every client says it. */
  disclosure: string;
};

/**
 * DD16's PLAN FLAG IS READ AND SHOWN, AND NOT WRITTEN ONTO A QUEUE ENTRY — a plan defect this task
 * REPORTS rather than works around.
 *
 * DD16 says this phase writes `opd_queue_entries.perk = true` "through the OPD module's index".
 * Measured at T3: `modules/opd/index.ts` exports no writer for it (`registerConsultStartGuard`,
 * `getEncounter`, `getVisit`, `listVisits`, `patientTimeline`, `classifyVisit`, `loadOpdConfig`,
 * `orderQueue`, `nextInQueue`, `classOf`), the write itself belongs where a queue entry is created
 * (`modules/opd/queue.ts`), and NO task in Plan 09 names ANY file under `modules/opd/`. So the
 * ruling's write has no owner in this phase and cannot be made from here without touching a frozen
 * file. What recognition can honestly do is SURFACE the fact — the desk sees that the plan carries
 * the perk — and that is what `queuePerk` is.
 */
export const RECOGNITION_PERK_NOTE =
  "DD16's perk WRITE has no owner in Plan 09: no task's Files list names a file under modules/opd/.";

function toRecognisedMembership(row: InstanceRow, resolved: ResolvedMembership, at: Date): RecognisedMembership {
  return {
    instanceId: row.instanceId,
    planId: row.planId,
    planTitle: row.planTitle,
    cardCode: row.cardCode,
    status: resolved.status,
    origin: row.origin,
    verified: row.verified,
    usable: membershipUsableAt(resolved, at),
    validFrom: row.validFrom,
    validTo: row.validTo,
    queuePerk: row.queuePerk,
    benefits: resolved.benefits.map((b) => ({ benefitKey: b.benefitKey, title: b.title })),
  };
}

/**
 * THE HONOURING RESPONSE: the same resolution the money path gets, projected to what a desk may see.
 *
 * ═══ WHAT IS NOT HERE, AND WHY (E-32 / DD15) ═══
 *
 * No amount, no cap, no sale price and no commission — not because the counter could not compute
 * one, but because the guardrail is that NO COUNTER SCREEN SHOWS A SALES FIGURE. A cashier looking
 * at a rupee number beside a member's name is a cashier being nudged, and the nudge is exactly what
 * E-32 exists to keep off a trust hospital's counter. The benefit's own TITLE is what a member is
 * told; the arithmetic happens once, on the invoice, where it can be audited.
 *
 * ═══ THE SEALED GATE RUNS BEFORE ANY INSTRUMENT ROW IS READ ═══
 *
 * `visiblePatientIds` is asked first, and a patient this caller may not see yields no id — so no
 * instrument, no coupon and no count. A presented CARD CODE with no patient is still answered, and
 * that is deliberate: a card handed across a counter is a physical object in the room, it names no
 * patient until somebody links it, and refusing to read it would send the desk to the partner's
 * WhatsApp group instead.
 */
export async function recogniseForActor(
  db: Db,
  actor: Actor,
  input: { patientId?: string | null; presentedCodes?: string[]; at: Date },
): Promise<RecognitionResult> {
  const codes = normaliseCodes(input.presentedCodes);
  const { patientId, ids } = await mergeTree(db, input.patientId ?? null);
  const visible = patientId === null ? [] : await visiblePatientIds(db, actor, [patientId]);
  const gatedPatientId = visible[0] ?? null;
  const gatedIds = gatedPatientId === null ? [] : ids;

  const rows = await loadInstances(db, { patientIds: gatedIds, codes });
  const coupons = await resolveCoupons(db, { codes, instances: rows });
  return {
    patientId: gatedPatientId,
    memberships: rows.map((row) => toRecognisedMembership(row, toResolvedMembership(row), input.at)),
    coupons: coupons.map((c) => ({
      couponId: c.couponId,
      code: c.code,
      title: c.title,
      instanceId: c.instanceId,
      // No bill in front of the counter yet, so K4's minimum-bill leg is evaluated against 0 and a
      // coupon with a threshold reads as `min_bill_not_met` until there is a draft to measure. That
      // is the honest answer to "will this apply right now", and it is why the reason is a sentence
      // rather than a boolean.
      unusableReason: couponUnusableReason(c, { at: input.at, billGrossPaise: 0 }),
    })),
    disclosure: MEMBERSHIP_DISCLOSURE,
  };
}

// ---------------------------------------------------------------------------------------------
// O-1 — grace-honor: refuse by default, honour by approval, accrue nothing
// ---------------------------------------------------------------------------------------------

/** The approval type `scripts/seed-membership.ts` registers. Named here because the check reads it. */
export const GRACE_HONOR_APPROVAL_TYPE = "membership_grace_honor";

/** The approval's subject type. A CARD CODE is the subject: it is what the counter is holding. */
export const GRACE_HONOR_SUBJECT_TYPE = "membership_card";

export type GraceHonorInput = {
  cardCode: string;
  patientId: string;
  planId: string;
  /** O-1 — REQUIRED. The default answer at this counter is refuse-with-event. */
  approvalId: string;
  reason: string;
  at: Date;
};

export type GraceHonorResult = { instanceId: string; cardCode: string; origin: "grace"; verified: false };

/**
 * O-1 — HONOURING A CARD THE BOOK DOES NOT KNOW, BEHIND AN APPROVAL.
 *
 * A card the holder book has never heard of is either partner feed lag — which the partner book
 * names as routine — or fraud, and the person at the counter cannot tell them apart. Refusing
 * outright makes the system the enemy of a member who paid; honouring silently makes the ledger
 * wrong in a way nobody can find later. An approval makes it rare, attributable and reversible.
 *
 * ═══ THE LOAD-BEARING HALF: IT ACCRUES NOTHING (C-17) ═══
 *
 * The instance is created with `origin = 'grace'` and `verified = false`. There is no partner sale
 * reference to attribute to — that is the whole reason this path exists — so there is nothing for
 * T6's consumer to pay a commission on until a real book row arrives and matches it. Honouring is
 * the member's business; accrual is the partner's, and the two are deliberately not one event.
 *
 * The approval is verified AGAINST THE APPROVALS ROW AT EXECUTION TIME (check-on-execute, Global
 * Constraint 1) — never through an event consumer, and never by trusting an id the caller supplied
 * without binding it to this card and this patient. That binding is `invoices.ts`'s
 * `assertGrantedApproval` shape, transplanted rather than reinvented.
 */
export async function graceHonor(db: Db, actor: Actor, input: GraceHonorInput): Promise<GraceHonorResult> {
  const cardCode = input.cardCode.trim();
  if (cardCode === "") throw new MembershipError("unknown_instrument", "a grace-honor needs the card code as presented");
  const approvalId = (input.approvalId ?? "").trim();
  if (approvalId === "") {
    throw new MembershipError(
      "grace_honor_approval_required",
      "honouring a card the book does not know needs a granted membership_grace_honor approval (O-1)",
    );
  }

  const approval = await getApproval(db, approvalId);
  if (!approval || approval.status !== "granted") {
    throw new MembershipError("grace_honor_approval_required", `approval ${approvalId} is not granted`);
  }
  const bound =
    approval.typeKey === GRACE_HONOR_APPROVAL_TYPE &&
    approval.subjectType === GRACE_HONOR_SUBJECT_TYPE &&
    approval.subjectId === cardCode &&
    approval.patientId === input.patientId;
  if (!bound) {
    throw new MembershipError("approval_subject_mismatch", `approval ${approvalId} does not bind to this card`, {
      expected: {
        typeKey: GRACE_HONOR_APPROVAL_TYPE, subjectType: GRACE_HONOR_SUBJECT_TYPE,
        subjectId: cardCode, patientId: input.patientId,
      },
      got: {
        typeKey: approval.typeKey, subjectType: approval.subjectType,
        subjectId: approval.subjectId, patientId: approval.patientId,
      },
    });
  }

  const plans = await db
    .select({ id: membershipPlans.id, validityDays: membershipPlans.validityDays })
    .from(membershipPlans)
    .where(eq(membershipPlans.id, input.planId));
  const plan = plans[0];
  if (plan === undefined) throw new MembershipError("unknown_plan", `unknown plan ${input.planId}`);

  const instanceId = newId();
  const validTo = new Date(input.at.getTime() + plan.validityDays * 86_400_000);
  const reason = input.reason.trim();
  await withTx(db, async (tx) => {
    await tx.insert(membershipInstances).values({
      id: instanceId,
      planId: plan.id,
      cardCode,
      patientId: input.patientId,
      // The book does not know this card, so it does not know a holder name either. The card code
      // is the only true thing available and a made-up name would look like provenance.
      holderName: cardCode,
      validFrom: input.at,
      validTo,
      status: "active",
      origin: "grace", // O-1
      verified: false, // C-17 — accrues NOTHING until a real book row matches it
    });
    await appendEvent(
      tx,
      instrumentGraceHonored.make({
        actor,
        patientId: input.patientId,
        payload: { instanceId, cardCode, patientId: input.patientId, approvalId, reason },
      }),
    );
  });
  return { instanceId, cardCode, origin: "grace", verified: false };
}
