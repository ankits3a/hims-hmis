import { and, asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { attributionIds, partnerRefMap, receivableExpectations } from "../../kernel/db/schema";
import { requireReceivableLane } from "./attribution";
import { PartnersError } from "./errors";
import { expectationWrittenOff } from "./events";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DD13 / V7 — THE MAPPING TABLE IS THE ONLY JOIN, AND THERE IS NO FUZZY FALLBACK ANYWHERE.
 *
 * ═══ WHY THIS IS A DESIGN COMMITMENT AND NOT A PERFORMANCE CHOICE ═══
 *
 * A partner's statement speaks the partner's own reference space. The temptation is to close the
 * last few percent of a reconciliation with a similarity match — `similarity()`, a trigram index,
 * a prefix, "same digits ignoring the dashes". It works on the demo and it is wrong once in a
 * thousand rows, and the thousandth row is money credited against the wrong referral. Nobody can
 * audit that reconciliation afterwards and nobody can settle the dispute it creates, because the
 * evidence is a score rather than a decision.
 *
 * So the only bridge between the two reference spaces is A ROW SOMEBODY WROTE:
 * `partner_ref_map (counterparty_id, partner_ref) → attribution_id`, unique on the pair. A ref
 * that has no row does not resolve — it disputes (V1), loudly, into a worklist a human clears by
 * writing the missing mapping row. `reconcile.test.ts` ships the assertion that proves the absence
 * of a fallback in BOTH directions: a one-character difference resolves to nothing, and the source
 * of this lane contains no similarity operator at all.
 *
 * ═══ THE ATTRIBUTION-CODE LANE IS LOOKED UP GLOBALLY, ON PURPOSE (V6) ═══
 *
 * `resolveStatementRef` resolves OUR OWN printed code WITHOUT scoping the query to the statement's
 * counterparty, and that is what makes V6 expressible: scoping it would turn "partner B quoted
 * partner A's slip" into "partner B quoted a code we never issued", and the two are different
 * facts needing different conversations. The caller compares the resolved counterparty against the
 * statement's own and disputes the mismatch — `statements.ts` does exactly that, once.
 *
 * The `partner_ref` lane is scoped by construction, because the unique index is on the PAIR: a
 * partner's own reference means nothing outside that partner's space.
 */

export type RefResolution =
  | { outcome: "resolved"; attributionId: string; counterpartyId: string; via: "attribution_code" | "partner_ref" }
  | { outcome: "unknown" };

/**
 * THE ONLY JOIN. Two EXACT lookups, in order, and nothing after them.
 *
 * Both compare trimmed text with `=`. There is no `ilike`, no `similarity()`, no `%` operator and
 * no normalisation beyond stripping the whitespace a CSV cell arrives padded with — folding
 * somebody else's key space is an assumption this hospital cannot check.
 */
export async function resolveStatementRef(
  exec: Db | Tx,
  counterpartyId: string,
  line: { attributionCode?: string | null; partnerRef?: string | null },
): Promise<RefResolution> {
  const code = (line.attributionCode ?? "").trim();
  if (code !== "") {
    // GLOBAL on purpose — see this file's header. V6 needs to know the difference between "a slip
    // we never issued" and "another partner's slip".
    const rows = await exec
      .select({ id: attributionIds.id, counterpartyId: attributionIds.counterpartyId })
      .from(attributionIds)
      .where(eq(attributionIds.code, code));
    const row = rows[0];
    if (row !== undefined) {
      return { outcome: "resolved", attributionId: row.id, counterpartyId: row.counterpartyId, via: "attribution_code" };
    }
  }

  const ref = (line.partnerRef ?? "").trim();
  if (ref !== "") {
    const rows = await exec
      .select({ attributionId: partnerRefMap.attributionId, counterpartyId: attributionIds.counterpartyId })
      .from(partnerRefMap)
      .innerJoin(attributionIds, eq(partnerRefMap.attributionId, attributionIds.id))
      .where(and(eq(partnerRefMap.counterpartyId, counterpartyId), eq(partnerRefMap.partnerRef, ref)));
    const row = rows[0];
    if (row !== undefined) {
      return { outcome: "resolved", attributionId: row.attributionId, counterpartyId: row.counterpartyId, via: "partner_ref" };
    }
  }

  return { outcome: "unknown" };
}

export type PartnerRefMapping = {
  id: string;
  counterpartyId: string;
  partnerRef: string;
  attributionId: string;
  mappedBy: string;
  at: Date;
};

/**
 * A HUMAN WRITES THE BRIDGE. This is the only way a partner reference enters the join, and the
 * `mapped_by` column is why: the decision that these two references are the same referral has a
 * name against it, for ever, which is exactly what a similarity score cannot give a dispute.
 *
 * `partner_ref_map_ref_ux` refuses a second mapping for one `(counterparty, ref)` pair. The refusal
 * is caught and typed rather than left as an integrity error, because an operator re-entering a
 * mapping is an ordinary mistake and a 500 is not an answer to it.
 */
export async function mapPartnerRef(
  db: Db,
  actor: Actor,
  input: { counterpartyId: string; partnerRef: string; attributionId: string },
  at: Date,
): Promise<PartnerRefMapping> {
  requireReceivableLane();
  const ref = input.partnerRef.trim();
  if (ref === "") {
    throw new PartnersError("unknown_partner_ref", "a partner reference cannot be blank");
  }

  const attributions = await db
    .select({ id: attributionIds.id, counterpartyId: attributionIds.counterpartyId })
    .from(attributionIds)
    .where(eq(attributionIds.id, input.attributionId));
  const attribution = attributions[0];
  if (attribution === undefined) {
    throw new PartnersError("unknown_attribution", `no attribution ${input.attributionId}`);
  }
  // DD13's single-partner rule, enforced where the bridge is BUILT rather than where it is read: a
  // mapping that crossed partners would make V6 unenforceable by construction, because the fuzzy
  // join we refused would have been replaced by a hand-written wrong one.
  if (attribution.counterpartyId !== input.counterpartyId) {
    throw new PartnersError(
      "attribution_partner_mismatch",
      `attribution ${input.attributionId} belongs to ${attribution.counterpartyId}, not to ${input.counterpartyId}`,
      { attributionId: input.attributionId, ownedBy: attribution.counterpartyId, claimedBy: input.counterpartyId },
    );
  }

  const existing = await db
    .select({ id: partnerRefMap.id, attributionId: partnerRefMap.attributionId })
    .from(partnerRefMap)
    .where(and(eq(partnerRefMap.counterpartyId, input.counterpartyId), eq(partnerRefMap.partnerRef, ref)));
  if (existing[0] !== undefined) {
    throw new PartnersError(
      "duplicate_partner_ref",
      `${input.counterpartyId} already maps "${ref}" to attribution ${existing[0].attributionId}`,
      { partnerRef: ref, attributionId: existing[0].attributionId },
    );
  }

  const id = newId();
  await db.insert(partnerRefMap).values({
    id, counterpartyId: input.counterpartyId, partnerRef: ref,
    attributionId: input.attributionId, mappedBy: actor.id, at,
  });
  return { id, counterpartyId: input.counterpartyId, partnerRef: ref, attributionId: input.attributionId, mappedBy: actor.id, at };
}

/** Every mapping one partner has, in the order they were written. */
export async function listPartnerRefs(exec: Db | Tx, counterpartyId: string): Promise<PartnerRefMapping[]> {
  const rows = await exec
    .select()
    .from(partnerRefMap)
    .where(eq(partnerRefMap.counterpartyId, counterpartyId))
    .orderBy(asc(partnerRefMap.at));
  return rows.map((r) => ({
    id: r.id, counterpartyId: r.counterpartyId, partnerRef: r.partnerRef,
    attributionId: r.attributionId, mappedBy: r.mappedBy, at: r.at,
  }));
}

/**
 * THE OPERATOR'S END OF THE LIFECYCLE — write off a claim nobody is going to settle.
 *
 * `expected` and `disputed` are both write-offable (a claim the partner never confirmed, and one
 * it confirmed wrongly and would not correct). `matched` is not: money a statement confirmed is
 * collected or credited, never quietly forgotten, and that refusal is `expectation_state_conflict`.
 */
export async function writeOffExpectation(
  db: Db,
  actor: Actor,
  input: { expectationId: string; reason: string },
  at: Date,
): Promise<{ expectationId: string; state: "written_off" }> {
  requireReceivableLane();
  return withTx(db, async (tx) => {
    const rows = await tx
      .select()
      .from(receivableExpectations)
      .where(eq(receivableExpectations.id, input.expectationId));
    const row = rows[0];
    if (row === undefined) {
      throw new PartnersError("unknown_expectation", `no receivable expectation ${input.expectationId}`);
    }
    if (row.state !== "expected" && row.state !== "disputed") {
      throw new PartnersError(
        "expectation_state_conflict",
        `expectation ${input.expectationId} is ${row.state} and cannot be written off`,
        { expectationId: input.expectationId, state: row.state },
      );
    }
    await tx
      .update(receivableExpectations)
      .set({ state: "written_off", disputeReason: input.reason, writtenOffAt: at, updatedBy: actor.id, updatedAt: at })
      .where(eq(receivableExpectations.id, input.expectationId));
    await appendEvent(tx, expectationWrittenOff.make({
      actor,
      occurredAt: at,
      idempotencyKey: `partners.expectation_written_off:${input.expectationId}`,
      payload: {
        expectationId: input.expectationId, counterpartyId: row.counterpartyId,
        amountPaise: row.amountPaise, reason: input.reason,
      },
    }));
    return { expectationId: input.expectationId, state: "written_off" as const };
  });
}
