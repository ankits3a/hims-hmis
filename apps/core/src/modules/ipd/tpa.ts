import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { IPD_CLAIM_REQUIRED_DOCUMENTS, IPD_INTENTS, ipdIsInFuture, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  ipdAdmissionPackages, ipdClaimDeductions, ipdClaimEvents, ipdPayerClaims, ipdSchemePackages, ipdTpaDocuments, ipdTpaQueries,
  patientDocuments,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { lockAdmission, onceIpd, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { IpdRefusal } from "./errors";
import { IPD_PAYER_MANAGE, IPD_PAYER_TERMS } from "./permissions";
import { packageShares } from "./tpa-packages";
import {
  tpaClaimRejected, tpaClaimSettled, tpaClaimSubmitted, tpaDocumentAttached, tpaPackageRemoved, tpaPackageSelected, tpaQueryAnswered,
  tpaQueryRecorded,
} from "./tpa-events";
import type { Actor, IpdIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

/**
 * #604 (decision 0075) — THE TPA DESK'S ACTS (SPEC-tpa-desk-2026-10-15). The desk types what the payer's portal said;
 * nothing here files on a portal. Every act is one function with its zod contract (`IPD_INTENTS`), idempotent by key,
 * and the rule lives here, never only in a screen.
 *
 * Who (DECIDED, no new permission string): queries, documents, packages, claim submission and rejection need
 * `ipd.payer.manage` (front office, its supervisor, the duty manager, the billing manager — the TPA desk); a settlement
 * (money in, TDS, deductions) needs `ipd.payer.terms` (the billing manager). No doctor role holds either (decision 0058).
 */

/** The admission states a scheme package may be chosen or removed in (DECIDED: before the stay ends). */
const PACKAGE_STATES = new Set(["requested", "reserved", "admitted", "transferring", "fit_declared", "discharging"]);
const SCHEME_KINDS = new Set(["pmjay", "state_scheme"]);

// ═══════════════════════════════════════ queries and documents ═══════════════════════════════════════

async function claimOfAdmission(db: Db | Tx, claimId: string, admissionId: string) {
  const c = (await db.select().from(ipdPayerClaims).where(eq(ipdPayerClaims.id, claimId)))[0];
  if (c === undefined || c.admissionId !== admissionId) throw new IpdRefusal("claim_not_found");
  return c;
}

export async function recordTpaQuery(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_tpa_query">> {
  const input: Input<"record_tpa_query"> = IPD_INTENTS.record_tpa_query.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.raisedAt, at)) throw new IpdRefusal("time_in_future");
  return onceIpd(db, actor, "record_tpa_query", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await readAdmission(tx, input.admissionId);
    if (input.claimId !== undefined) await claimOfAdmission(tx, input.claimId, a.id);
    const queryId = newId();
    await tx.insert(ipdTpaQueries).values({
      id: queryId, admissionId: a.id, claimId: input.claimId ?? null, stage: input.stage, raisedAt: new Date(input.raisedAt),
      queryText: input.queryText, recordedBy: actor.id, recordedAt: at,
    });
    await appendEvent(tx, tpaQueryRecorded.make({
      payload: { admissionId: a.id, queryId, stage: input.stage, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { queryId };
  }), at);
}

export async function answerTpaQuery(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"answer_tpa_query">> {
  const input: Input<"answer_tpa_query"> = IPD_INTENTS.answer_tpa_query.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "answer_tpa_query", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const q = (await tx.select().from(ipdTpaQueries).where(eq(ipdTpaQueries.id, input.queryId)).for("update"))[0];
    if (q === undefined) throw new IpdRefusal("query_not_found");
    if (q.answeredAt !== null) throw new IpdRefusal("query_already_answered");
    const a = await readAdmission(tx, q.admissionId);
    await tx.update(ipdTpaQueries).set({ answeredAt: at, answeredBy: actor.id, responseText: input.responseText }).where(eq(ipdTpaQueries.id, q.id));
    await appendEvent(tx, tpaQueryAnswered.make({
      payload: { admissionId: a.id, queryId: q.id, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { queryId: q.id, answeredAt: at.toISOString() };
  }), at);
}

export async function attachTpaDocument(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"attach_tpa_document">> {
  const input: Input<"attach_tpa_document"> = IPD_INTENTS.attach_tpa_document.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "attach_tpa_document", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await readAdmission(tx, input.admissionId);
    const doc = (await tx.select({ patientId: patientDocuments.patientId, status: patientDocuments.status }).from(patientDocuments)
      .where(eq(patientDocuments.id, input.patientDocumentId)))[0];
    if (doc?.patientId !== a.patientId || doc.status !== "active") throw new IpdRefusal("tpa_document_invalid", undefined, { documentId: input.patientDocumentId });
    if (input.claimId !== undefined) await claimOfAdmission(tx, input.claimId, a.id);
    // The same document under the same stage and kind is attached once; a second attach answers the first.
    const existing = (await tx.select({ id: ipdTpaDocuments.id }).from(ipdTpaDocuments).where(and(
      eq(ipdTpaDocuments.admissionId, a.id), eq(ipdTpaDocuments.stage, input.stage), eq(ipdTpaDocuments.kind, input.kind),
      eq(ipdTpaDocuments.patientDocumentId, input.patientDocumentId), isNull(ipdTpaDocuments.detachedAt),
    )))[0];
    if (existing !== undefined) return { attachmentId: existing.id };
    const attachmentId = newId();
    await tx.insert(ipdTpaDocuments).values({
      id: attachmentId, admissionId: a.id, claimId: input.claimId ?? null, stage: input.stage, kind: input.kind,
      patientDocumentId: input.patientDocumentId, attachedBy: actor.id, attachedAt: at,
    });
    await appendEvent(tx, tpaDocumentAttached.make({
      payload: { admissionId: a.id, attachmentId, stage: input.stage, kind: input.kind, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { attachmentId };
  }), at);
}

// ═══════════════════════════════════════ scheme packages ═══════════════════════════════════════

/** Σ of an admission's live packages after the multiple-package rule (DECIDED $): the scheme's payer amount. */
export async function packageAmountOf(db: Db | Tx, admissionId: string): Promise<{ amountPaise: number; count: number }> {
  const live = await db.select({ code: ipdAdmissionPackages.code, ratePaise: ipdAdmissionPackages.ratePaise }).from(ipdAdmissionPackages)
    .where(and(eq(ipdAdmissionPackages.admissionId, admissionId), isNull(ipdAdmissionPackages.removedAt)));
  return { amountPaise: packageShares(live).reduce((s, p) => s + p.amountPaise, 0), count: live.length };
}

/**
 * #604 review: once any live claim of the stay has gone to the payer (filed, settled or rejected), the packages are what
 * was claimed — a later choice or removal would move the stay's payer amount under a claim already filed.
 */
async function refuseOnceClaimFiled(tx: Tx, admissionId: string): Promise<void> {
  const filed = (await tx.select({ id: ipdPayerClaims.id }).from(ipdPayerClaims).where(and(
    eq(ipdPayerClaims.admissionId, admissionId), inArray(ipdPayerClaims.status, ["filed", "settled", "rejected"]),
  )))[0];
  if (filed !== undefined) throw new IpdRefusal("package_claim_filed", undefined, { claimId: filed.id });
}

export async function selectSchemePackage(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"select_scheme_package">> {
  const input: Input<"select_scheme_package"> = IPD_INTENTS.select_scheme_package.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "select_scheme_package", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!PACKAGE_STATES.has(a.state)) throw new IpdRefusal("admission_wrong_state");
    if (a.payerKind === null || !SCHEME_KINDS.has(a.payerKind)) throw new IpdRefusal("package_needs_scheme");
    await refuseOnceClaimFiled(tx, a.id);
    const p = (await tx.select().from(ipdSchemePackages).where(eq(ipdSchemePackages.id, input.packageId)))[0];
    if (p === undefined || p.retiredAt !== null || p.scheme !== a.payerKind) throw new IpdRefusal("package_not_found");
    const dup = (await tx.select({ id: ipdAdmissionPackages.id }).from(ipdAdmissionPackages).where(and(
      eq(ipdAdmissionPackages.admissionId, a.id), eq(ipdAdmissionPackages.code, p.code), isNull(ipdAdmissionPackages.removedAt),
    )))[0];
    if (dup !== undefined) throw new IpdRefusal("package_already_selected", undefined, { selectionId: dup.id });
    const selectionId = newId();
    await tx.insert(ipdAdmissionPackages).values({
      id: selectionId, admissionId: a.id, packageId: p.id, code: p.code, name: p.name, ratePaise: p.ratePaise, selectedBy: actor.id, selectedAt: at,
    });
    await appendEvent(tx, tpaPackageSelected.make({
      payload: { admissionId: a.id, selectionId, packageCode: p.code, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { selectionId, packageAmountPaise: (await packageAmountOf(tx, a.id)).amountPaise };
  }), at);
}

export async function removeSchemePackage(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"remove_scheme_package">> {
  const input: Input<"remove_scheme_package"> = IPD_INTENTS.remove_scheme_package.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "remove_scheme_package", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!PACKAGE_STATES.has(a.state)) throw new IpdRefusal("admission_wrong_state");
    const sel = (await tx.select().from(ipdAdmissionPackages).where(eq(ipdAdmissionPackages.id, input.selectionId)))[0];
    if (sel === undefined || sel.admissionId !== a.id || sel.removedAt !== null) throw new IpdRefusal("package_selection_not_found");
    await refuseOnceClaimFiled(tx, a.id);
    await tx.update(ipdAdmissionPackages).set({ removedAt: at, removedBy: actor.id, removedReason: input.reason }).where(eq(ipdAdmissionPackages.id, sel.id));
    await appendEvent(tx, tpaPackageRemoved.make({
      payload: { admissionId: a.id, selectionId: sel.id, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { packageAmountPaise: (await packageAmountOf(tx, a.id)).amountPaise };
  }), at);
}

// ═══════════════════════════════════════ claims ═══════════════════════════════════════

/** The claim's events, newest first. */
export async function claimEventsOf(db: Db | Tx, claimIds: readonly string[]) {
  if (claimIds.length === 0) return [];
  return db.select().from(ipdClaimEvents).where(inArray(ipdClaimEvents.claimId, [...claimIds]))
    .orderBy(desc(ipdClaimEvents.at), desc(ipdClaimEvents.recordedAt), desc(ipdClaimEvents.id));
}

/**
 * Locks the claim's admission (the void takes the same lock — #763 reads the claim's status under it) and the claim row.
 * A withdrawn claim (its bill was voided) refuses every act.
 */
async function lockClaim(tx: Tx, claimId: string) {
  const first = (await tx.select().from(ipdPayerClaims).where(eq(ipdPayerClaims.id, claimId)))[0];
  if (first === undefined) throw new IpdRefusal("claim_not_found");
  const a = await lockAdmission(tx, first.admissionId);
  const c = (await tx.select().from(ipdPayerClaims).where(eq(ipdPayerClaims.id, claimId)).for("update"))[0]!;
  if (c.status === "withdrawn") throw new IpdRefusal("claim_wrong_state", undefined, { status: c.status });
  return { a, c };
}

/**
 * The most a submission may claim, and its default (DECIDED $, #604 review). A scheme stay with packages claims the
 * package amount ONCE across its bills (a final and supplementary bills each carry a claim row): Σ packages less what the
 * stay's other live claims already filed. Any other claim: the bill's payer portion.
 */
export async function defaultClaimPaise(db: Db | Tx, claim: { id: string; admissionId: string; payerKind: string; claimPaise: number }): Promise<number> {
  const pk = SCHEME_KINDS.has(claim.payerKind) ? await packageAmountOf(db, claim.admissionId) : { amountPaise: 0, count: 0 };
  if (pk.count === 0) return claim.claimPaise;
  const others = (await db.select({ id: ipdPayerClaims.id }).from(ipdPayerClaims).where(and(
    eq(ipdPayerClaims.admissionId, claim.admissionId), inArray(ipdPayerClaims.status, ["filed", "settled", "rejected"]),
  ))).map((c) => c.id).filter((id) => id !== claim.id);
  const events = await claimEventsOf(db, others);
  const filed = others.reduce((s, id) => s + (events.find((e) => e.claimId === id && e.kind === "submitted")?.claimedPaise ?? 0), 0);
  return Math.max(0, pk.amountPaise - filed);
}

/** The claim documents still missing (DECIDED checklist `IPD_CLAIM_REQUIRED_DOCUMENTS`). */
export async function missingClaimDocuments(db: Db | Tx, admissionId: string, claim: { id: string; createdAt: Date }): Promise<string[]> {
  const docs = await db.select({ kind: ipdTpaDocuments.kind, claimId: ipdTpaDocuments.claimId, attachedAt: ipdTpaDocuments.attachedAt })
    .from(ipdTpaDocuments)
    .where(and(eq(ipdTpaDocuments.admissionId, admissionId), eq(ipdTpaDocuments.stage, "claim"), isNull(ipdTpaDocuments.detachedAt)));
  // #604 review: the final bill is THIS claim's bill — named to the claim, or attached once its bill was settled (a copy
  // attached earlier is a draft, a voided bill's or another bill's of the stay).
  const counts = (d: (typeof docs)[number]): boolean => d.claimId === claim.id
    || (d.claimId === null && (d.kind !== "final_bill" || d.attachedAt.getTime() >= claim.createdAt.getTime()));
  const have = new Set(docs.filter(counts).map((d) => d.kind));
  return IPD_CLAIM_REQUIRED_DOCUMENTS.filter((k) => !have.has(k));
}

export async function submitClaim(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"submit_claim">> {
  const input: Input<"submit_claim"> = IPD_INTENTS.submit_claim.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.submittedAt, at)) throw new IpdRefusal("time_in_future");
  return onceIpd(db, actor, "submit_claim", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { a, c } = await lockClaim(tx, input.claimId);
    // DECIDED: a pending claim is filed; a rejected one may be filed again (the appeal / resubmission).
    if (c.status !== "pending" && c.status !== "rejected") throw new IpdRefusal("claim_wrong_state", undefined, { status: c.status });
    const missing = await missingClaimDocuments(tx, a.id, c);
    if (missing.length > 0) throw new IpdRefusal("claim_documents_missing", undefined, { missing });
    const capPaise = await defaultClaimPaise(tx, c);
    const claimedPaise = input.claimedPaise ?? capPaise;
    if (claimedPaise <= 0 || claimedPaise > capPaise) throw new IpdRefusal("claim_exceeds_claimable", undefined, { capPaise, claimedPaise });
    const eventId = newId();
    await tx.insert(ipdClaimEvents).values({
      id: eventId, claimId: c.id, admissionId: a.id, kind: "submitted", at: new Date(input.submittedAt), claimRef: input.claimRef ?? null,
      claimedPaise, recordedBy: actor.id, recordedAt: at,
    });
    await tx.update(ipdPayerClaims).set({ status: "filed" }).where(eq(ipdPayerClaims.id, c.id));
    await appendEvent(tx, tpaClaimSubmitted.make({
      payload: { admissionId: a.id, claimId: c.id, eventId, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { claimId: c.id, claimedPaise };
  }), at);
}

/**
 * The payer's settlement advice. Net paid + TDS + Σ deductions must equal the amount claimed to the paisa (DECIDED $):
 * the desk types the advice, the system refuses an advice that does not add up. No deduction → `settled`; any → `short_paid`.
 * Both mark the claim row `settled`, so the bill's void is then refused (#763 `payer_claim_settled`).
 */
export async function recordClaimSettlement(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_claim_settlement">> {
  const input: Input<"record_claim_settlement"> = IPD_INTENTS.record_claim_settlement.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_TERMS);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "record_claim_settlement", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { a, c } = await lockClaim(tx, input.claimId);
    if (c.status !== "filed") throw new IpdRefusal("claim_wrong_state", undefined, { status: c.status });
    const submitted = (await claimEventsOf(tx, [c.id])).find((e) => e.kind === "submitted");
    const claimed = submitted?.claimedPaise ?? 0;
    const deductionsPaise = input.deductions.reduce((s, d) => s + d.amountPaise, 0);
    const accounted = input.netPaidPaise + input.tdsPaise + deductionsPaise;
    if (accounted !== claimed) {
      throw new IpdRefusal("settlement_does_not_add_up", undefined, { claimedPaise: claimed, accountedPaise: accounted, gapPaise: claimed - accounted });
    }
    const outcome = input.deductions.length === 0 ? "settled" as const : "short_paid" as const;
    const eventId = newId();
    await tx.insert(ipdClaimEvents).values({
      id: eventId, claimId: c.id, admissionId: a.id, kind: outcome, at, netPaidPaise: input.netPaidPaise, tdsPaise: input.tdsPaise,
      utrRef: input.utrRef, settledOn: input.settledOn, recordedBy: actor.id, recordedAt: at,
    });
    if (input.deductions.length > 0) {
      await tx.insert(ipdClaimDeductions).values(input.deductions.map((d, i) => ({
        id: newId(), claimEventId: eventId, claimId: c.id, reason: d.reason, amountPaise: d.amountPaise, note: d.note ?? null, line: i + 1,
      })));
    }
    await tx.update(ipdPayerClaims).set({ status: "settled" }).where(eq(ipdPayerClaims.id, c.id));
    await appendEvent(tx, tpaClaimSettled.make({
      payload: { admissionId: a.id, claimId: c.id, eventId, outcome, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { claimId: c.id, outcome, deductionsPaise };
  }), at);
}

export async function recordClaimRejection(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_claim_rejection">> {
  const input: Input<"record_claim_rejection"> = IPD_INTENTS.record_claim_rejection.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.rejectedAt, at)) throw new IpdRefusal("time_in_future");
  return onceIpd(db, actor, "record_claim_rejection", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { a, c } = await lockClaim(tx, input.claimId);
    if (c.status !== "filed") throw new IpdRefusal("claim_wrong_state", undefined, { status: c.status });
    const eventId = newId();
    await tx.insert(ipdClaimEvents).values({
      id: eventId, claimId: c.id, admissionId: a.id, kind: "rejected", at: new Date(input.rejectedAt), reason: input.reason,
      recordedBy: actor.id, recordedAt: at,
    });
    await tx.update(ipdPayerClaims).set({ status: "rejected" }).where(eq(ipdPayerClaims.id, c.id));
    await appendEvent(tx, tpaClaimRejected.make({
      payload: { admissionId: a.id, claimId: c.id, eventId, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { claimId: c.id };
  }), at);
}
