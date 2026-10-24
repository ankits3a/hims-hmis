import { desc, eq } from "drizzle-orm";
import { IPD_INTENTS, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissions, ipdPayerAuths } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { lockAdmission, onceIpd, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { payerAuthRecorded } from "./admission-events";
import { loadPriceBook, planOf, quoteOrRefuse } from "./deposit";
import { IpdRefusal } from "./errors";
import { listPatientCoverages } from "../patients";
import { IPD_PAYER_MANAGE, IPD_PAYER_TERMS } from "./manifest";
import type { Actor, IpdBedClass, IpdIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db } from "../../kernel/db/client";

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

/**
 * E1.2 (#719) — THE MANUAL AUTHORISATION RECORD (§2 answer 5): the TPA desk types what the insurer or scheme portal
 * answered. Every entry is a new row; nothing is updated in place.
 *
 * Order (DECIDED, insurer practice): `initial` first (a REQUESTED initial may be answered by a second `initial` carrying
 * the insurer's status — E2.2); `enhancement`, `final` and `denial` follow an initial; nothing
 * but a `payer_change` follows a final approval or a denial. A pre-auth approved after admission covers from the
 * admission date (`coversFrom`). Any payer change after admission is forward-only and needs signed counselling. The
 * payer split of the bill is E2.2's (`payer-split.ts`): it reads this record's state, approved total and the letter's
 * money terms (room-rent cap, co-pay), which E2.2 added as optional fields of this intent.
 */
const APPROVED = new Set(["approved", "partially_approved", "final_approved"]);
const LIVE = new Set(["requested", "reserved", "admitted", "transferring", "fit_declared", "discharging"]);

export async function recordPayerAuth(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_payer_auth">> {
  const input: Input<"record_payer_auth"> = IPD_INTENTS.record_payer_auth.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  // Review 11: the letter's money terms are the billing manager's (`ipd.payer.terms`); status and number stay here.
  if (input.roomRentCapPaise !== undefined || input.roomRentCapSiBp !== undefined || input.coPayBp !== undefined) {
    await requireIpdPermission(db, actor, IPD_PAYER_TERMS);
  }
  const at = opts.now ?? new Date();
  if (input.coverageId !== undefined) {
    const first = await readAdmission(db, input.admissionId);
    const covers = await listPatientCoverages(db, actor, first.patientId, { reason: "ipd payer authorisation" });
    if (!covers.some((c) => c.id === input.coverageId)) throw new IpdRefusal("state_changed", "Coverage is not this patient's");
  }
  const prices = await loadPriceBook(db, at);
  return onceIpd(db, actor, "record_payer_auth", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!LIVE.has(a.state)) throw new IpdRefusal("admission_wrong_state");
    const prior = await tx.select().from(ipdPayerAuths).where(eq(ipdPayerAuths.admissionId, a.id)).orderBy(desc(ipdPayerAuths.recordedAt), desc(ipdPayerAuths.id));
    const last = prior[0];
    // Review $9: an APPROVED `initial` after a denial is the appeal's outcome — it reinstates insurance.
    const appeal = last?.entry === "denial" && input.entry === "initial" && APPROVED.has(input.status);
    const closed = !appeal && last !== undefined && (last.entry === "final" || last.entry === "denial");
    const admitted = a.admittedAt !== null;
    if (input.entry === "payer_change") {
      if (admitted && input.counsellingDocumentId === undefined) throw new IpdRefusal("payer_change_needs_counselling");
    } else if (input.entry === "initial") {
      // E2.2 (#726, DECIDED): the insurer's answer to a REQUESTED pre-auth is a second `initial` carrying its status
      // (approved / partially approved); only an answered initial refuses another.
      if (!appeal && prior.some((p) => p.entry === "initial" && p.status !== "requested") && !closed) throw new IpdRefusal("auth_out_of_order", "An initial entry exists");
      if (closed) throw new IpdRefusal("auth_out_of_order", "Authorisation closed");
    } else {
      if (!prior.some((p) => p.entry === "initial")) throw new IpdRefusal("auth_out_of_order", "No initial entry");
      if (closed) throw new IpdRefusal("auth_out_of_order", "Authorisation closed");
    }
    // E2.2 (#726, DECIDED $): the running total builds on the last APPROVED entry, and a REQUESTED entry approves
    // nothing — so a requested enhancement neither raises the total nor inflates the one approved after it.
    // `prior` is newest first; the current authorisation starts at the last payer change.
    const change = prior.findIndex((p) => p.entry === "payer_change");
    const lastApproved = (change < 0 ? prior : prior.slice(0, change + 1)).find((p) => APPROVED.has(p.status));
    const previous = lastApproved?.approvedTotalPaise ?? 0;
    const amount = input.approvedAmountPaise ?? 0;
    const approvedTotalPaise = input.entry === "denial" || input.status === "denied" ? 0
      : input.status === "requested" ? (input.entry === "payer_change" ? 0 : previous)
      : input.entry === "enhancement" ? previous + amount
      : input.entry === "final" ? amount
      : input.entry === "payer_change" ? amount
      : amount;
    const approved = input.status === "approved" || input.status === "partially_approved" || input.status === "final_approved";
    const coversFrom = approved && a.admittedAt !== null ? a.admittedAt : null;
    const authId = newId();
    await tx.insert(ipdPayerAuths).values({
      id: authId, admissionId: a.id, payerKind: input.payerKind, payerRef: input.payerRef ?? null, entry: input.entry,
      preAuthNumber: input.preAuthNumber ?? null, status: input.status, approvedAmountPaise: input.approvedAmountPaise ?? null,
      approvedTotalPaise, coversFrom, provisionalCashlessSigned: input.provisionalCashlessSigned,
      counsellingDocumentId: input.counsellingDocumentId ?? null,
      roomRentCapPaise: input.roomRentCapPaise ?? null, roomRentCapSiBp: input.roomRentCapSiBp ?? null, coPayBp: input.coPayBp ?? null,
      recordedBy: actor.id, recordedAt: at,
    });
    // The payer of record: set by the initial entry when the plan named none, and moved forward by a payer change.
    // Review #11: a new payer re-quotes the deposit from the tariff (a scheme drops it to ₹0, cash raises it to the
    // class days) — the deposit rule never runs on a stale basis. A missing rate refuses here, as at planning.
    if (input.entry === "payer_change" || (input.entry === "initial" && a.payerKind === null)) {
      const q = quoteOrRefuse(prices, {
        payerKind: input.payerKind, requestedClass: a.requestedClass as IpdBedClass, plan: planOf(a),
        emergencyUnstabilised: a.source === "er" && a.stabilisedAt === null,
      });
      await tx.update(ipdAdmissions).set({
        // Review 6: the coverage moves with the payer (a payer change without one clears it; an initial keeps the plan's).
        coverageId: input.entry === "payer_change" ? input.coverageId ?? null : input.coverageId ?? a.coverageId,
        payerKind: input.payerKind, estimatePaise: q.estimatePaise, depositRequiredPaise: q.depositPaise, depositBasis: q.basis, updatedAt: at,
      }).where(eq(ipdAdmissions.id, a.id));
    }
    await appendEvent(tx, payerAuthRecorded.make({
      payload: { admissionId: a.id, authId, entry: input.entry, status: input.status, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { authId, status: input.status, approvedTotalPaise, coversFrom: coversFrom?.toISOString() ?? null };
  }), at);
}
