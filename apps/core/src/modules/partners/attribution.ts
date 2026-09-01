import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { loadEnv } from "../../kernel/config";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { attributionIds, receivableExpectations } from "../../kernel/db/schema";
import { percentAmount } from "../tariff";
import { counterpartyFacts, requireAgreementAt } from "./agreements";
import { PartnersError } from "./errors";
import { attributionIssued, attributionVoided, expectationWrittenOff } from "./events";
import type { ResolvedAgreement } from "./agreements";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DD13 — ONE OUTBOUND REFERRAL, ONE ATTRIBUTION ID, ONE PARTNER, AT REFERRAL TIME.
 *
 * ═══ THE ID IS MINTED HERE, ONCE, AND THAT IS WHAT MAKES V6 A RULE RATHER THAN A CONFLICT ═══
 *
 * A referral slip carries a code and a QR of that same code (11h's barcode wedge reads it back at
 * the desk). Because the id exists in exactly one row, bound to exactly one counterparty, "which
 * partner has the claim" is never a question a reconciliation has to answer by judgement: **the
 * partner whose id is on the slip is the partner with the claim**, and a statement line quoting a
 * different partner's id is `disputed` (V6, `statements.ts`).
 *
 * ═══ WHAT THE EXPECTATION IS, AND WHY IT IS A DIFFERENT TABLE FROM THE LEDGER (DD5) ═══
 *
 * Issuing a slip creates ONE `receivable_expectations` row in state `expected`. That row is a
 * CLAIM — it walks `expected → matched → disputed → written_off` and is deliberately NOT
 * append-only. No `commission_accruals` row is written here, because no money has been confirmed
 * yet: the ledger records money and the expectation records a claim, and mixing them is what makes
 * an append-only ledger need an UPDATE.
 *
 * ═══ THE RATE AND THE WINDOW ARE BOTH DATA (DD3) ═══
 *
 * `receivableRateBps` and `unclaimedExpiryDays` are read off the agreement version in force at the
 * referral instant. Neither is defaulted, for the reason `accrualTermsSchema` gives about
 * `eligibleCategories`: an agreement whose receivable terms were never configured must fail LOUDLY
 * rather than silently accrue nothing and never expire. No rate, no window and no partner code
 * appears anywhere in `apps/`.
 *
 * The version is pinned at the ATTRIBUTION's own instant and snapshotted onto every row it
 * produces — DD6's ruling, transposed: the terms live when the hospital REFERRED are the terms
 * that govern the commission on that referral, and an amendment cannot rewrite what a past
 * referral was worth.
 */

/**
 * DD14's fifth flag, read HERE and NOT through `loadConfig()`, for the reason
 * `modules/partners/consumer.ts` and `modules/billing/invoices.ts` each carry in their own headers
 * (F1): `loadConfig()` requires `DATABASE_URL` and `SECRET_KEY`, `apps/core/.env` exists on the
 * build host and can NEVER exist in CI, so a bare call on this path resolves on exactly one
 * machine in the world and throws on the machine that decides.
 *
 * `z.enum(["true","false"])`, never a coercing boolean: under coercion the string "false" is
 * non-empty and therefore TRUE, which would arm a receivable lane for an operator who wrote the
 * value that means off. The spelling is `kernel/config.ts`'s, duplicated deliberately rather than
 * approximated, and `attribution.test.ts` pins the two readers against each other BY EXECUTION on
 * all six inputs so the duplicate cannot drift.
 */
const receivableFlag = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

export function receivableCommissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env === process.env) loadEnv();
  return receivableFlag.parse(env.RECEIVABLE_COMMISSION_ENABLED);
}

/** Every entry point in this lane opens with it, so the flag cannot be load-bearing in one door only. */
export function requireReceivableLane(): void {
  if (!receivableCommissionEnabled()) {
    throw new PartnersError(
      "receivable_disabled",
      "RECEIVABLE_COMMISSION_ENABLED is off: the receivable-commission lane creates and settles nothing",
    );
  }
}

/**
 * THE RECEIVABLE HALF OF AN AGREEMENT'S `terms`, READ OFF `rawTerms`.
 *
 * `accrualTermsSchema` (T6's, and in no other task's Files list) is a plain `z.object` and
 * therefore STRIPS the keys below rather than refusing them — which is exactly why
 * `ResolvedAgreement` carries `rawTerms` beside the parsed value. This lane parses its own half
 * out of that, so neither schema has to know about the other's keys.
 */
export const receivableTermsSchema = z.object({
  /** What a partner owes US on a referral, in bps of the referred service's value. */
  receivableRateBps: z.number().int().nonnegative().max(10_000),
  /**
   * V5's unclaimed window, in days. NOT defaulted, deliberately: an expectation with no window
   * never expires, and "the partner never confirmed it and nobody noticed" is precisely the
   * outcome V5 exists to prevent.
   */
  unclaimedExpiryDays: z.number().int().positive(),
});

export type ReceivableTerms = z.infer<typeof receivableTermsSchema>;

export function receivableTermsOf(agreement: ResolvedAgreement): ReceivableTerms {
  const parsed = receivableTermsSchema.safeParse(agreement.rawTerms);
  if (!parsed.success) {
    // The same refusal `resolveAgreementAt` makes about its own half, for the same reason: an
    // agreement that expected nothing because its jsonb was misspelled is indistinguishable from
    // one that earns nothing, and only one of those is a bug.
    throw new PartnersError(
      "unknown_agreement",
      `partner_agreements ${agreement.agreementId} (v${String(agreement.versionNo)}) has no receivable terms this lane can read`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/**
 * DD6's snapshot for the receivable direction — the RESOLVED NUMBERS, never a pointer, plus the
 * provenance that says which claim a ledger row answers.
 *
 * `commission_accruals` carries no attribution column (it is the seventeen-table budget, not an
 * omission — the phase relay records the ruling), so the attribution and the expectation travel in
 * the snapshot the way T6's own basis does. Nothing here is identity: an id, a code, a rate.
 */
export function receivableSnapshotOf(
  agreement: ResolvedAgreement,
  terms: ReceivableTerms,
  pinnedAt: Date,
  provenance: { attributionId: string; expectationId: string; statementRef: string; statementLineNo: number },
): Record<string, unknown> {
  return {
    agreementId: agreement.agreementId,
    versionNo: agreement.versionNo,
    effectiveFrom: agreement.effectiveFrom.toISOString(),
    receivableRateBps: terms.receivableRateBps,
    pinnedAt: pinnedAt.toISOString(),
    pinnedTo: "attribution.issued_at",
    ...provenance,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The printed code. It is DERIVED FROM THE ROW'S OWN ID rather than drawn from a sequence, so a
 * code scanned off a slip names exactly one row and nothing has to be looked up to mint it.
 * `attribution_ids_code_ux` is the backstop; `RF` is this system's own prefix and is not, and can
 * never be, a partner's code (DD3).
 */
export function attributionCodeFor(id: string): string {
  return `RF-${id.slice(-10)}`;
}

export type AttributionSlip = {
  attributionId: string;
  code: string;
  counterpartyId: string;
  patientId: string | null;
  serviceHint: string | null;
  expectationId: string;
  /** What we expect the partner to owe: `percentAmount(referredValuePaise, receivableRateBps)`. */
  expectedPaise: number;
  issuedAt: Date;
  expiresAt: Date;
  /** What the slip's QR encodes — the code, and only the code (DD15: no identity on a partner slip). */
  qrPayload: string;
};

export type IssueAttributionInput = {
  counterpartyId: string;
  /** Optional: an outbound referral may precede registration. It never reaches partner-facing output. */
  patientId?: string | null;
  serviceHint?: string | null;
  /** The value of the service being referred out, integer paise. The rate applies to it. */
  referredValuePaise: number;
};

/**
 * ISSUE ONE SLIP.
 *
 * O-7 — a SUSPENDED or TERMINATED counterparty gets no new slip. Honouring and settling continue
 * (an existing expectation still matches, and receivables stay collectible), but an attribution is
 * the act of creating a NEW claim, and O-7 stops new accruals at the term date. A terminated
 * partner is usually stopped one step earlier anyway, by its agreement window having closed —
 * this is the louder refusal in front of it.
 */
export async function issueAttribution(
  db: Db,
  actor: Actor,
  input: IssueAttributionInput,
  at: Date,
): Promise<AttributionSlip> {
  requireReceivableLane();
  if (!Number.isSafeInteger(input.referredValuePaise) || input.referredValuePaise < 0) {
    throw new PartnersError(
      "unknown_attribution",
      `referredValuePaise must be a non-negative integer number of paise, got ${String(input.referredValuePaise)}`,
    );
  }

  const facts = await counterpartyFacts(db, input.counterpartyId);
  if (facts === null) {
    throw new PartnersError("unknown_counterparty", `no counterparty ${input.counterpartyId}`);
  }
  if (facts.status === "suspended") {
    throw new PartnersError("counterparty_suspended", `counterparty ${input.counterpartyId} is suspended: no new referral may be attributed to it`);
  }
  if (facts.status === "terminated") {
    throw new PartnersError("counterparty_terminated", `counterparty ${input.counterpartyId} is terminated: no new referral may be attributed to it`);
  }

  const agreement = await requireAgreementAt(db, input.counterpartyId, at);
  const terms = receivableTermsOf(agreement);
  const expectedPaise = percentAmount(input.referredValuePaise, terms.receivableRateBps);
  const expiresAt = new Date(at.getTime() + terms.unclaimedExpiryDays * DAY_MS);

  const attributionId = newId();
  const code = attributionCodeFor(attributionId);
  const expectationId = newId();

  await withTx(db, async (tx) => {
    await tx.insert(attributionIds).values({
      id: attributionId,
      code,
      counterpartyId: input.counterpartyId,
      patientId: input.patientId ?? null,
      serviceHint: input.serviceHint ?? null,
      state: "issued",
      issuedBy: actor.id,
      issuedAt: at,
      expiresAt,
    });
    await tx.insert(receivableExpectations).values({
      id: expectationId,
      counterpartyId: input.counterpartyId,
      attributionId,
      agreementId: agreement.agreementId,
      amountPaise: expectedPaise,
      state: "expected",
      expectedAt: at,
      dueAt: expiresAt,
      updatedBy: actor.id,
      updatedAt: at,
      createdAt: at,
    });
    await appendEvent(tx, attributionIssued.make({
      actor,
      occurredAt: at,
      idempotencyKey: `partners.attribution_issued:${attributionId}`,
      payload: {
        attributionId, expectationId, counterpartyId: input.counterpartyId, code,
        expectedPaise, expiresAt: expiresAt.toISOString(),
      },
    }));
  });

  return {
    attributionId, code, counterpartyId: input.counterpartyId,
    patientId: input.patientId ?? null,
    serviceHint: input.serviceHint ?? null,
    expectationId, expectedPaise, issuedAt: at, expiresAt,
    qrPayload: code,
  };
}

/** What the desk's barcode wedge gets back when a slip is scanned. NO identity field (DD15). */
export type ScannedAttribution = {
  attributionId: string;
  code: string;
  counterpartyId: string;
  state: string;
  serviceHint: string | null;
  issuedAt: Date;
  expiresAt: Date | null;
  expectation: { id: string; state: string; amountPaise: number; dueAt: Date | null } | null;
};

/**
 * THE WEDGE'S LOOKUP — exact, on the printed code, and nothing else.
 *
 * A scanner types the payload one keystroke at a time and finishes with Enter (11h's owner ruling
 * 5), so what arrives here is a whole code or nothing. There is deliberately no prefix match and
 * no similarity: a slip either scanned or it did not, and guessing at a half-read barcode is the
 * fuzzy-join mistake (V7) wearing a different hat.
 */
export async function findAttributionByCode(exec: Db | Tx, code: string): Promise<ScannedAttribution | null> {
  const rows = await exec.select().from(attributionIds).where(eq(attributionIds.code, code.trim()));
  const row = rows[0];
  if (row === undefined) return null;
  const claims = await exec
    .select({
      id: receivableExpectations.id,
      state: receivableExpectations.state,
      amountPaise: receivableExpectations.amountPaise,
      dueAt: receivableExpectations.dueAt,
    })
    .from(receivableExpectations)
    .where(eq(receivableExpectations.attributionId, row.id))
    .orderBy(asc(receivableExpectations.seq))
    .limit(1);
  const claim = claims[0];
  return {
    attributionId: row.id,
    code: row.code,
    counterpartyId: row.counterpartyId,
    state: row.state,
    serviceHint: row.serviceHint,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    expectation: claim === undefined
      ? null
      : { id: claim.id, state: claim.state, amountPaise: claim.amountPaise, dueAt: claim.dueAt },
  };
}

/**
 * RC-2 review MAJOR 5 — DOES THIS SLIP BIND TO THIS PATIENT? A BOOLEAN, AND DELIBERATELY NOT A FIELD.
 *
 * `attribution_ids.patient_id` is populated by `issueAttribution` and was compared to nothing, so
 * one slip discounted unlimited bills for unlimited patients. The obvious repair — surfacing the
 * column on `ScannedAttribution` — is WRONG and the suite says so: **DD15 keeps the scanned result
 * identity-free**, and `attribution.test.ts`'s "carries no identity field" pins the exact key set.
 * A referral discount needs to know whether a binding HOLDS, not who it names.
 *
 * So this answers the question and returns nothing else. A slip naming NO patient is a bearer
 * leaflet and binds to everyone — that is what `issueAttribution` allowing a null means, not an
 * oversight.
 */
export async function attributionBindsToPatient(
  exec: Db | Tx,
  attributionId: string,
  patientId: string | null,
): Promise<boolean> {
  const rows = await exec
    .select({ patientId: attributionIds.patientId })
    .from(attributionIds)
    .where(eq(attributionIds.id, attributionId));
  const bound = rows[0]?.patientId ?? null;
  return bound === null || bound === patientId;
}

export type VoidAttributionResult = {
  attributionId: string;
  expectationIds: string[];
  state: "void";
};

/**
 * V4 — A CANCELLED TEST VOIDS ITS EXPECTATION.
 *
 * The referral did not happen, so there is nothing to be owed for it. The slip goes `void` and
 * every OPEN expectation it backs goes `written_off` with the cancellation as its reason — the same
 * end state V5's expiry reaches, distinguished by the reason and not by a second state.
 *
 * **A CONFIRMED CLAIM IS NOT VOIDABLE.** An expectation that has already reached `matched` records
 * money a partner's own statement confirmed, and cancelling a test after the partner has paid for
 * it is a credit to settle, not a claim to erase. That refusal is `expectation_state_conflict`.
 */
export async function voidAttribution(
  db: Db,
  actor: Actor,
  input: { attributionId: string; reason: string },
  at: Date,
): Promise<VoidAttributionResult> {
  requireReceivableLane();
  return withTx(db, async (tx) => {
    const rows = await tx.select().from(attributionIds).where(eq(attributionIds.id, input.attributionId));
    const row = rows[0];
    if (row === undefined) {
      throw new PartnersError("unknown_attribution", `no attribution ${input.attributionId}`);
    }

    // EVERY claim against this slip, whoever raised it. A V6 dispute row — another partner's
    // statement quoting this id — is one of them, and it carries ITS OWN `counterparty_id`, which
    // is why the event below reads the claim's rather than the slip's.
    const claims = await tx
      .select({
        id: receivableExpectations.id,
        state: receivableExpectations.state,
        amountPaise: receivableExpectations.amountPaise,
        counterpartyId: receivableExpectations.counterpartyId,
      })
      .from(receivableExpectations)
      .where(eq(receivableExpectations.attributionId, input.attributionId))
      .orderBy(asc(receivableExpectations.seq));
    const settled = claims.find((c) => c.state === "matched");
    if (settled !== undefined) {
      throw new PartnersError(
        "expectation_state_conflict",
        `expectation ${settled.id} is already matched against a partner statement and cannot be voided`,
        { expectationId: settled.id, state: settled.state },
      );
    }

    const open = claims.filter((c) => c.state === "expected" || c.state === "disputed");
    for (const claim of open) {
      await tx
        .update(receivableExpectations)
        .set({ state: "written_off", disputeReason: input.reason, writtenOffAt: at, updatedBy: actor.id, updatedAt: at })
        .where(eq(receivableExpectations.id, claim.id));
      await appendEvent(tx, expectationWrittenOff.make({
        actor,
        occurredAt: at,
        idempotencyKey: `partners.expectation_written_off:${claim.id}`,
        payload: {
          expectationId: claim.id, counterpartyId: claim.counterpartyId,
          amountPaise: claim.amountPaise, reason: input.reason,
        },
      }));
    }

    await tx.update(attributionIds).set({ state: "void" }).where(eq(attributionIds.id, input.attributionId));
    await appendEvent(tx, attributionVoided.make({
      actor,
      occurredAt: at,
      idempotencyKey: `partners.attribution_voided:${input.attributionId}`,
      payload: {
        attributionId: input.attributionId, counterpartyId: row.counterpartyId,
        expectationIds: open.map((c) => c.id), reason: input.reason,
      },
    }));

    return { attributionId: input.attributionId, expectationIds: open.map((c) => c.id), state: "void" as const };
  });
}

export type ExpirySweepResult = {
  expiredExpectationIds: string[];
  expiredAttributionIds: string[];
};

/**
 * V5 — AN UNCLAIMED SLIP EXPIRES AFTER THE CONFIGURED DAYS.
 *
 * `due_at` was stamped at issuance from the agreement's own `unclaimedExpiryDays` (DD3: the window
 * is DATA), so this sweep reads a stored instant and never a constant. It writes `written_off`,
 * events each one, and marks the slip `expired` — and DD13 is explicit that the expectation
 * "appears in the aging read model BEFORE it does", which is what makes the sweep a formality
 * rather than a surprise: `aging.ts` shows an expectation ageing past its due date every day it is
 * unconfirmed.
 *
 * `at` is the caller's instant, never `new Date()` inside a writer — the house rule that lets a
 * replay of this sweep write the same rows.
 */
export async function expireUnclaimed(
  db: Db,
  actor: Actor,
  input: { at: Date; counterpartyId?: string },
): Promise<ExpirySweepResult> {
  requireReceivableLane();
  return withTx(db, async (tx) => {
    const wheres = [
      eq(receivableExpectations.state, "expected"),
      sql`${receivableExpectations.dueAt} is not null`,
      lt(receivableExpectations.dueAt, input.at),
    ];
    if (input.counterpartyId !== undefined) {
      wheres.push(eq(receivableExpectations.counterpartyId, input.counterpartyId));
    }
    const due = await tx
      .select({
        id: receivableExpectations.id,
        counterpartyId: receivableExpectations.counterpartyId,
        attributionId: receivableExpectations.attributionId,
        amountPaise: receivableExpectations.amountPaise,
      })
      .from(receivableExpectations)
      .where(and(...wheres))
      .orderBy(asc(receivableExpectations.seq));

    const expiredAttributionIds: string[] = [];
    for (const row of due) {
      await tx
        .update(receivableExpectations)
        .set({
          state: "written_off",
          disputeReason: "unclaimed_expiry",
          writtenOffAt: input.at,
          updatedBy: actor.id,
          updatedAt: input.at,
        })
        .where(eq(receivableExpectations.id, row.id));
      await appendEvent(tx, expectationWrittenOff.make({
        actor,
        occurredAt: input.at,
        idempotencyKey: `partners.expectation_written_off:${row.id}`,
        payload: {
          expectationId: row.id, counterpartyId: row.counterpartyId,
          amountPaise: row.amountPaise, reason: "unclaimed_expiry",
        },
      }));
      if (row.attributionId !== null) {
        // Only a slip nobody ever claimed goes `expired`; one already `claimed` or `void` keeps
        // the state that says so.
        const marked = await tx
          .update(attributionIds)
          .set({ state: "expired" })
          .where(and(eq(attributionIds.id, row.attributionId), eq(attributionIds.state, "issued")))
          .returning({ id: attributionIds.id });
        if (marked[0] !== undefined) expiredAttributionIds.push(marked[0].id);
      }
    }
    return { expiredExpectationIds: due.map((r) => r.id), expiredAttributionIds };
  });
}

/** Open claims for one counterparty, oldest first — the reconciliation's own worklist. */
export async function openExpectations(
  exec: Db | Tx,
  counterpartyId: string,
): Promise<{ id: string; attributionId: string | null; amountPaise: number; expectedAt: Date; dueAt: Date | null }[]> {
  return exec
    .select({
      id: receivableExpectations.id,
      attributionId: receivableExpectations.attributionId,
      amountPaise: receivableExpectations.amountPaise,
      expectedAt: receivableExpectations.expectedAt,
      dueAt: receivableExpectations.dueAt,
    })
    .from(receivableExpectations)
    .where(
      and(
        eq(receivableExpectations.counterpartyId, counterpartyId),
        eq(receivableExpectations.state, "expected"),
        isNull(receivableExpectations.statementRef),
      ),
    )
    .orderBy(asc(receivableExpectations.seq));
}
