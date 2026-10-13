import { desc, eq } from "drizzle-orm";
import { IPD_INTENTS, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissions, ipdPayerAuths } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { lockAdmission, onceIpd, provenanceOf, requireIpdPermission } from "./admission-core";
import { payerAuthRecorded } from "./admission-events";
import { loadPriceBook, planOf, quoteOrRefuse } from "./deposit";
import { IpdRefusal } from "./errors";
import { IPD_PAYER_MANAGE } from "./manifest";
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
 * Order (DECIDED, insurer practice): `initial` first; `enhancement`, `final` and `denial` follow an initial; nothing
 * but a `payer_change` follows a final approval or a denial. A pre-auth approved after admission covers from the
 * admission date (`coversFrom`). Any payer change after admission is forward-only and needs signed counselling. The
 * payer split of the bill is E2.2's; this lane records the facts it will read.
 */
const LIVE = new Set(["requested", "reserved", "admitted", "transferring", "fit_declared", "discharging"]);

export async function recordPayerAuth(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_payer_auth">> {
  const input: Input<"record_payer_auth"> = IPD_INTENTS.record_payer_auth.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const at = opts.now ?? new Date();
  const prices = await loadPriceBook(db, at);
  return onceIpd(db, actor, "record_payer_auth", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!LIVE.has(a.state)) throw new IpdRefusal("admission_wrong_state");
    const prior = await tx.select().from(ipdPayerAuths).where(eq(ipdPayerAuths.admissionId, a.id)).orderBy(desc(ipdPayerAuths.recordedAt), desc(ipdPayerAuths.id));
    const last = prior[0];
    const closed = last !== undefined && (last.entry === "final" || last.entry === "denial");
    const admitted = a.admittedAt !== null;
    if (input.entry === "payer_change") {
      if (admitted && input.counsellingDocumentId === undefined) throw new IpdRefusal("payer_change_needs_counselling");
    } else if (input.entry === "initial") {
      if (prior.some((p) => p.entry === "initial") && !closed) throw new IpdRefusal("auth_out_of_order", "An initial entry exists");
      if (closed) throw new IpdRefusal("auth_out_of_order", "Authorisation closed");
    } else {
      if (!prior.some((p) => p.entry === "initial")) throw new IpdRefusal("auth_out_of_order", "No initial entry");
      if (closed) throw new IpdRefusal("auth_out_of_order", "Authorisation closed");
    }
    const previous = last?.approvedTotalPaise ?? 0;
    const amount = input.approvedAmountPaise ?? 0;
    const approvedTotalPaise = input.entry === "denial" || input.status === "denied" ? 0
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
      counsellingDocumentId: input.counsellingDocumentId ?? null, recordedBy: actor.id, recordedAt: at,
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
