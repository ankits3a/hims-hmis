import { and, asc, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { imagingBillDecisions, imagingStudies } from "../../kernel/db/schema/radiology";
import { daycareEncounters } from "../../kernel/db/schema/ot";
import { invoiceLines } from "../../kernel/db/schema/billing";
import { EPISODE_SERIES } from "../../kernel/episodes/series";
import { getEncounter } from "../opd";
import { RadiologyError } from "./errors";
import { imagingBillDecisionRaised } from "./events";
import type { ImagingAuthorisation, ImagingBillDecisionKind } from "../../kernel/db/schema/radiology";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18a T7 / DD12 — **WHY THIS SCAN WAS ALLOWED TO START, AND WHAT THE COUNTER MUST DECIDE
 * AFTERWARDS.**
 *
 * ═══ DD12a — THE FOUR AUTHORISATIONS ARE NOT INTERCHANGEABLE ═══
 *
 * A radiology department that starts a scan has been authorised by exactly one of four facts, and
 * the row records WHICH rather than a boolean, because the four are answerable to different people:
 *
 *   · **`invoice`** — money was actually taken. A line exists.
 *   · **`daycare`** — a `D…` encounter, whose discharge bill composes this scan (Plan 15).
 *   · **`payer_branch`** — a TPA / PMJAY / corporate patient whose pre-authorisation object is
 *     Plan 46's and does not exist yet. The department proceeds and the payer is billed later.
 *   · **`stat`** — D3, and it is the one that matters most: **an emergency never waits on the
 *     cashier**, and the fact that it did not is RECORDED rather than inferred. A month later,
 *     "why was this CT never paid for" has an answer that is not a shrug.
 *
 * A4's mutant treats a NULL payer as authorised, and I1 is what it costs: the study is done, no
 * line exists, nobody is ever billed, and no queue can see it because nothing was raised.
 *
 * ═══ IT IS PURE, AND THE CALLER BRINGS THE ENCOUNTER ═══
 *
 * The rule is four comparisons and no I/O, for `applicability.ts`'s reason: a rule that decides
 * whether a hospital gets paid should be walkable at every boundary without a database, so no
 * branch is left to whichever payer the e2e fixture happened to use.
 */

/** The facts the rule reads from the STUDY. Three fields, so a caller cannot pass a whole row. */
export type AuthorisationStudyFacts = {
  invoiceLineId: string | null;
  priority: string;
  encounterNo: string;
};

/** The facts it reads from the ENCOUNTER. `intendedPayer` is `self | tpa | pmjay | corporate`. */
export type AuthorisationEncounterFacts = { intendedPayer: string };

/**
 * DD12a's rule. Returns `null` when NOTHING authorises the scan — the caller turns that into
 * `payment_required` (402), which is the one refusal a receptionist resolves by taking money.
 *
 * **The order is a precedence and not a preference.** A `D…` encounter with an invoice line is
 * `invoice`, because money actually taken is a stronger fact than a bill that will be composed at
 * discharge; and a `stat` scan on a TPA patient is `payer_branch`, because the payer is who gets
 * billed and the urgency did not change that. `stat` is LAST for exactly that reason: it is the
 * authorisation of last resort, and reading it earlier would hide every other answer behind it.
 */
export function authorisationOf(
  study: AuthorisationStudyFacts,
  encounter: AuthorisationEncounterFacts,
): ImagingAuthorisation | null {
  if (study.invoiceLineId !== null) return "invoice";
  if (study.encounterNo.startsWith(EPISODE_SERIES.daycare)) return "daycare";
  if (encounter.intendedPayer !== "self") return "payer_branch";
  if (study.priority === "stat") return "stat";
  return null;
}

/**
 * Reads the encounter's payer, whichever kind of episode it is.
 *
 * The day-care leg goes to the KERNEL SCHEMA table rather than to an OT export, exactly as T3's
 * `assertEncounterOpen` does and for the reason F12 records: OT exports no reader, the table is
 * `kernel/db/schema/ot.ts` rather than a module internal, and a later phase adding one to
 * `modules/ot/index.ts` should collapse both call sites at once.
 *
 * **An encounter that cannot be found is `self`**, which is the strict direction: an unknown payer
 * must not authorise a scan, and `self` is the only value that can leave `authorisationOf` null.
 */
export async function encounterPayer(exec: Db | Tx, encounterNo: string): Promise<{ intendedPayer: string }> {
  if (encounterNo.startsWith(EPISODE_SERIES.daycare)) {
    const rows = await (exec as Db)
      .select({ payerClass: daycareEncounters.payerClass })
      .from(daycareEncounters)
      .where(eq(daycareEncounters.encounterNo, encounterNo));
    return { intendedPayer: rows[0]?.payerClass ?? "self" };
  }
  const encounter = await getEncounter(exec as Db, encounterNo);
  return { intendedPayer: encounter?.intendedPayer ?? "self" };
}

/**
 * DD12a — the counter raised a line and it is attached to the study.
 *
 * **This module composes NO invoice.** It records the LINK, so that `authorisationOf` can answer
 * `invoice` and so 18a-iii's reconciliation has a join. The line itself belongs to billing, and a
 * radiology module that could price a scan would be a second tariff.
 */
export async function linkInvoiceLine(
  tx: Tx, studyId: string, invoiceLineId: string,
): Promise<{ studyId: string; invoiceLineId: string }> {
  const line = await (tx as unknown as Db).select({ id: invoiceLines.id })
    .from(invoiceLines).where(eq(invoiceLines.id, invoiceLineId));
  if (!line[0]) {
    throw new RadiologyError("unknown_study", `no invoice line ${invoiceLineId}`, { invoiceLineId });
  }
  await tx.update(imagingStudies).set({ invoiceLineId }).where(eq(imagingStudies.id, studyId));
  return { studyId, invoiceLineId };
}

/**
 * ═══ DD12b — THE COUNTER'S QUEUE, AND A5's MUTANT IS RAISING ON EVERY ACQUISITION ═══
 *
 * Four facts can diverge from what was billed, and each is a decision a human takes with money:
 * contrast that was charged and not given, a repeat that should not be charged twice, a study
 * performed and then cancelled, and a scan acquired with nothing billed at all.
 *
 * **A decision is raised only when one of those four is TRUE.** A5's mutant raises on every
 * acquisition, and the harm it names is precise: *"the counter's queue is the whole worklist and
 * stops being read"* — which turns a control that recovers money into a list somebody clears in
 * bulk every Friday.
 */
export async function raiseBillDecision(
  tx: Tx,
  actor: Actor,
  input: { studyId: string; kind: ImagingBillDecisionKind; detail?: Record<string, unknown> | null },
): Promise<{ billDecisionId: string }> {
  const billDecisionId = newId();
  await tx.insert(imagingBillDecisions).values({
    id: billDecisionId, studyId: input.studyId, kind: input.kind, detail: input.detail ?? null,
  });
  await appendEvent(tx, imagingBillDecisionRaised.make({
    actor,
    payload: { studyId: input.studyId, kind: input.kind, detail: input.detail ?? null },
  }));
  return { billDecisionId };
}

const BILL_DECISIONS_MANAGE = "radiology.bill_decisions.manage";

/** What the counter DID. A resolution is an actor, an instant and a word — the CHECK insists. */
export async function resolveBillDecision(
  tx: Tx,
  actor: Actor,
  input: { billDecisionId: string; resolution: string },
): Promise<{ billDecisionId: string; resolvedAt: Date }> {
  if (actor.type !== "user"
    || !(await hasPermission(tx as unknown as Db, actor.id, BILL_DECISIONS_MANAGE, "hospital"))) {
    throw new RadiologyError(
      "payment_required",
      `resolving a bill decision needs ${BILL_DECISIONS_MANAGE}`,
      { permission: BILL_DECISIONS_MANAGE },
    );
  }
  if (input.resolution.trim() === "") {
    throw new RadiologyError("reason_required", "a bill decision is resolved with a word, not a click");
  }
  const rows = await (tx as unknown as Db).select().from(imagingBillDecisions)
    .where(eq(imagingBillDecisions.id, input.billDecisionId));
  const decision = rows[0];
  if (!decision) {
    throw new RadiologyError("unknown_study", `no bill decision ${input.billDecisionId}`);
  }
  if (decision.resolvedAt !== null) {
    throw new RadiologyError(
      "already_acquired",
      `bill decision ${input.billDecisionId} was resolved on ${decision.resolvedAt.toISOString()}`,
    );
  }
  const resolvedAt = new Date();
  await tx.update(imagingBillDecisions)
    .set({ resolvedBy: actor.id, resolvedAt, resolution: input.resolution.trim() })
    .where(eq(imagingBillDecisions.id, input.billDecisionId));
  return { billDecisionId: input.billDecisionId, resolvedAt };
}

/** The queue the counter reads: everything unresolved, oldest first (the table's own index). */
export async function openBillDecisions(
  exec: Db | Tx,
): Promise<{ id: string; studyId: string; kind: string; detail: unknown; raisedAt: Date }[]> {
  return await (exec as Db)
    .select({
      id: imagingBillDecisions.id, studyId: imagingBillDecisions.studyId,
      kind: imagingBillDecisions.kind, detail: imagingBillDecisions.detail,
      raisedAt: imagingBillDecisions.raisedAt,
    })
    .from(imagingBillDecisions)
    .where(isNull(imagingBillDecisions.resolvedAt))
    .orderBy(asc(imagingBillDecisions.raisedAt));
}

/** Whether a study already carries a decision of a kind — so redelivery cannot raise a second. */
export async function hasBillDecision(
  exec: Db | Tx, studyId: string, kind: ImagingBillDecisionKind,
): Promise<boolean> {
  const rows = await (exec as Db).select({ id: imagingBillDecisions.id })
    .from(imagingBillDecisions)
    .where(and(eq(imagingBillDecisions.studyId, studyId), eq(imagingBillDecisions.kind, kind)));
  return rows.length > 0;
}
