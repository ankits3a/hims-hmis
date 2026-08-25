import { eq } from "drizzle-orm";
import { z } from "zod";
import { loadEnv } from "../../kernel/config";
import { refundVouchers } from "../../kernel/db/schema";
import {
  allocationReversed, creditNoteIssued, invoiceAccrualView, paymentReceived, paymentRefunded,
} from "../billing";
import { appendAccrualDelta, attributeInvoice } from "./accrual";
import { counterpartyFacts, resolveAgreementAt } from "./agreements";
import type { AppendAccrualResult } from "./accrual";
import type { Db, Tx } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

/**
 * DD7 — THE ACCRUAL CONSUMER. FOUR SUBSCRIPTIONS, ONE CODE PATH, AND A FLAG THAT DECIDES ONLY
 * WHETHER IT WRITES.
 *
 * ═══ IT REGISTERS ALWAYS AND IT ADVANCES ALWAYS — THE INVERSION IS THE POINT ═══
 *
 * The obvious implementation of "the lane is config-OFF" is to register the subscription only when
 * the flag is on. That is check-on-execute wearing a manifest's clothes, and it is silently LOSSY:
 * a subscription that was never registered has no `event_cursors` row, so flipping the flag later
 * starts from *now* and every event before the flip is gone for ever. So `partnersManifest`
 * declares all four names unconditionally, `workerConsumers(db)` carries this handler
 * unconditionally, and with the flag off the handler RETURNS NORMALLY — which is what lets the
 * dispatcher write its `event_deliveries` claim and move the cursor on. Turning the lane on is
 * then two steps that are both tested: flip the flag, run `replayAccruals`, and the ledger fills
 * in from event history. (Assertion Book F4 and F5.)
 *
 * ═══ THE FOUR NAMES, AND WHY FOUR RATHER THAN TWO ═══
 *
 * `payment.received` · `payment.refunded` · `allocation.reversed` · `credit_note.issued`.
 *
 * §3 Q4 MEASURED the two that a first reading would have missed. `reverseAllocation` and
 * `markEnteredInError` BOTH emit `allocation.reversed` and **neither emits a refund event** — so a
 * consumer subscribed to the first two names accrues on a payment and never gives it back when
 * that payment is reversed. And a credit note changes what is SETTLEABLE, which moves the ratio
 * DD12's base is built on. Under delta-to-target the handler does **not branch on which of the
 * four arrived**: every one re-reads the whole invoice through `invoiceAccrualView`, computes the
 * target, and appends the difference. Four subscriptions, one code path, no reversal arithmetic.
 *
 * ═══ WHAT `occurredAt` ACTUALLY IS ON THESE FOUR EVENTS, MEASURED ═══
 *
 * Plan 10 D5's contract is that the dispatcher hands a consumer the EVENT's own instant and never
 * the worker's clock, and it holds: `dispatcher.ts` projects `events.occurred_at` verbatim. But
 * **no billing emitter passes `occurredAt` to `defineEvent().make()`** — `allocateReceipt`,
 * `reverseAllocation`, `issueCreditNote` and `payRefundVoucher` all let it default to `new Date()`
 * — so for these four names `occurred_at` is the instant the row was APPENDED, and a billing
 * operation performed with an explicit back-dated `now` still produces an event stamped with the
 * wall clock. Measured here while building Assertion Book row F7(b), whose mutant is unkillable
 * through real billing calls for exactly that reason.
 *
 * That is a fact about `modules/billing`, which this phase freezes, and it is recorded rather than
 * worked around. It costs THIS lane nothing, and DD6 is why: the agreement version is pinned at
 * the INVOICE's `issued_at` — a stored column that a back-dated issue really does move — so the
 * accrual arithmetic never reads `occurredAt` at all. What `occurredAt` does is order the stream
 * and stamp the row. **A later lane that keys anything on an event's instant should know that for
 * these names it is the append instant.**
 *
 * ═══ WHY THIS FILE RESOLVES `payment.refunded` THROUGH `refund_vouchers` ═══
 *
 * That event's payload is `{voucherId, patientId, amountPaise, method}` and carries **no invoice**
 * (the plan's §2 ground truth says so in as many words). `refund_vouchers.invoice_id` is where the
 * link lives, and billing exports no reader for a voucher — `modules/billing/index.ts` exports
 * `requestRefund`, `issueRefundVoucher` and `payRefundVoucher` and no getter — so the one column is
 * read from the KERNEL schema, which every module shares and which the module-isolation rule
 * explicitly permits (it forbids reaching into another module's `src`, not into `kernel/db/schema`;
 * `schema/partners.ts` itself references `invoices` for the same reason). An ADVANCE refund carries
 * a null `invoice_id` and touches no invoice at all, so it is a fact this consumer skips.
 */

/** The consumer key `partnersManifest` declares and `workerConsumers` is keyed by. */
export const PARTNERS_ACCRUAL_CONSUMER = "partners.accrual";

/** DD7's declared set, in one place so the manifest and the replay job cannot disagree. */
export const ACCRUAL_EVENT_NAMES: readonly string[] = [
  paymentReceived.name,
  paymentRefunded.name,
  allocationReversed.name,
  creditNoteIssued.name,
];

/**
 * DD14's flag, read HERE and NOT through `loadConfig()` — the same scar, measured, that
 * `modules/billing/invoices.ts` carries in its own header (F1).
 *
 * `loadConfig()` parses the WHOLE environment through a zod schema in which `DATABASE_URL` and
 * `SECRET_KEY` are REQUIRED with no default. `apps/core/.env` exists on the build host and can
 * NEVER exist in CI, so a `loadConfig()` on this path would resolve on exactly one machine in the
 * world and throw on the machine that decides. The caller that would normally hand the value down
 * is `workerConsumers(db)`, whose signature is `(db: Db)` and is called by `worker.ts` — a file no
 * task in this phase may edit.
 *
 * `z.enum(["true","false"])`, never a coercing boolean: under coercion the string "false" is
 * non-empty and therefore TRUE, which would arm a commission ledger for an operator who wrote the
 * value that means off. The spelling is `kernel/config.ts`'s, duplicated deliberately rather than
 * approximated, and `consumer.test.ts` pins the two readers against each other BY EXECUTION on all
 * six inputs so the duplicate cannot drift.
 */
const accrualFlag = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

export function commissionAccrualEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env === process.env) loadEnv();
  return accrualFlag.parse(env.COMMISSION_ACCRUAL_ENABLED);
}

/**
 * Why one delivery did what it did. Every arm is a NORMAL return — the dispatcher advances its
 * cursor on all of them — and only a genuinely unreadable event throws, which is what parks it.
 */
export type AccrualOutcome =
  | { outcome: "not_subscribed" }
  | { outcome: "disabled" }
  | { outcome: "no_invoice" }
  | { outcome: "unknown_invoice" }
  | { outcome: "unattributed" }
  | { outcome: "unknown_counterparty" }
  | { outcome: "no_agreement" }
  | AppendAccrualResult;

/** The parsers, by name. A payload this consumer cannot read THROWS — see `accrualConsumer`. */
const invoiceIdParsers: Record<string, (payload: unknown) => string> = {
  [paymentReceived.name]: (p) => paymentReceived.payloadSchema.parse(p).invoiceId,
  [allocationReversed.name]: (p) => allocationReversed.payloadSchema.parse(p).invoiceId,
  [creditNoteIssued.name]: (p) => creditNoteIssued.payloadSchema.parse(p).invoiceId,
};

/** The invoice one event names, or `null` when it names none (an advance refund). */
async function invoiceIdOfEvent(exec: Db | Tx, e: DispatchedEvent): Promise<string | null> {
  const parser = invoiceIdParsers[e.name];
  if (parser !== undefined) return parser(e.payload);
  const { voucherId } = paymentRefunded.payloadSchema.parse(e.payload);
  const rows = await exec
    .select({ invoiceId: refundVouchers.invoiceId })
    .from(refundVouchers)
    .where(eq(refundVouchers.id, voucherId));
  return rows[0]?.invoiceId ?? null;
}

/**
 * ONE delivery, handled. Shared verbatim with `replayAccruals`, which is what makes the replay
 * FAITHFUL rather than approximately faithful: a backfill is not a second implementation of this
 * function, it is this function driven from the events table instead of from the dispatcher.
 *
 * THE PAYLOAD IS PARSED FIRST, BEFORE THE FLAG IS READ. An event whose payload this consumer
 * cannot read is malformed whether the lane is armed or not, and letting it park (A8) is how the
 * dispatcher was designed to handle it; deferring the parse behind the flag would hide a bad
 * producer until the day the hospital armed the ledger.
 */
export async function handleAccrualEvent(db: Db, e: DispatchedEvent): Promise<AccrualOutcome> {
  if (!ACCRUAL_EVENT_NAMES.includes(e.name)) return { outcome: "not_subscribed" };
  const invoiceId = await invoiceIdOfEvent(db, e);
  if (invoiceId === null) return { outcome: "no_invoice" };

  // DD7's inversion: everything above this line runs with the lane OFF, and everything below it
  // is the WRITE the flag gates. The cursor advances either way.
  if (!commissionAccrualEnabled()) return { outcome: "disabled" };

  const view = await invoiceAccrualView(db, invoiceId);
  // A replay walks an event cursor that can outlive the rows it names; a missing invoice is a fact
  // to skip, not an exception to park.
  if (view === null) return { outcome: "unknown_invoice" };

  const attribution = await attributeInvoice(db, invoiceId);
  // C-17 / O-1: no VERIFIED partner instrument was live when this invoice was billed, so there is
  // nothing to attribute the commission to. A grace-honored card lands here by design.
  if (attribution === null) return { outcome: "unattributed" };

  const counterparty = await counterpartyFacts(db, attribution.counterpartyId);
  if (counterparty === null) return { outcome: "unknown_counterparty" };

  // DD6 — the version is resolved at the INVOICE's issue instant, never at this event's. See
  // `agreements.ts`; Assertion Book F7's second leg is the mutant that reads `e.occurredAt` here.
  const agreement = await resolveAgreementAt(db, counterparty.counterpartyId, attribution.issuedAt);
  // O-7's `terminated` path: a termination closes the agreement version's `effective_to`, so an
  // invoice issued after the term date resolves no version and accrues nothing, while invoices
  // billed before it keep settling under the terms that priced them. Nothing here reads a status
  // for that — the window is the mechanism, and it is the same one an amendment uses.
  if (agreement === null) return { outcome: "no_agreement" };

  return appendAccrualDelta(db, {
    actor: { type: "system", id: PARTNERS_ACCRUAL_CONSUMER },
    attribution,
    counterparty,
    agreement,
    view,
    basisEventId: e.eventId,
    basisEventName: e.name,
    occurredAt: e.occurredAt,
  });
}

/**
 * The production handler `workerConsumers(db)` carries. It returns `void` because that is the
 * `Handler` contract, and it swallows nothing: `handleAccrualEvent` throws only on a payload it
 * cannot read or a database that refuses, and both of those must reach the dispatcher so the
 * delivery retries and finally PARKS (A8) instead of being lost.
 */
export function accrualConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    await handleAccrualEvent(db, e);
  };
}
