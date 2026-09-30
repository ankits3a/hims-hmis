import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { withTx } from "../../kernel/db/client";
import { imagingReports, imagingStudies } from "../../kernel/db/schema/radiology";
import { invoiceLines } from "../../kernel/db/schema/billing";
import { invoiceSettlement } from "../billing";
import { enqueueReportReady } from "./reports";
import type { Db, Tx } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

/**
 * ═══ PLAN 18-S RS9b T2 — "YOUR REPORT IS READY", WHEN THE BILL IS PAID AFTER RELEASE ═══
 *
 * `publishReport` queues `imaging_report_ready` only when the bill is settled at publish (or the
 * report is RED). A self-pay patient who pays after the report is released was never told — RS9's
 * money question 2. This consumer closes it on billing's own events, without touching a billing
 * signature:
 *
 *   · **`payment.received`** — an allocation to an invoice (a receipt at the counter, or the tender
 *     on issue); **`credit_note.issued`** — a correction or clearance that can settle what is left.
 *     Both carry `invoiceId`; everything else is re-read, because an event says money MOVED and
 *     only the ledger says the bill is SETTLED (a part-payment queues nothing).
 *   · For each study whose invoice line is on that invoice, the CURRENT released report (signed and
 *     published; `imaging_reports_one_signed_ux` makes it one per study) gets the message through
 *     `enqueueReportReady` — the publish path's own writer, with the same per-version dedupe key.
 *     So a redelivered event, a second part-payment, or a bill settled at publish AND paid again
 *     queue nothing more: **exactly once per report version.**
 *   · Consent is the pump's, as on the publish path (`transactional`: a STOP or a deceased patient
 *     suppresses at send). A failed enqueue is swallowed (A7) — this cursor must not stall on one
 *     patient with no phone.
 */
export const RADIOLOGY_READY_ON_PAYMENT_CONSUMER = "radiology.report_ready_on_payment";

/** The two billing events this consumer reads, by name (billing's catalogue; its signatures are untouched). */
export const READY_ON_PAYMENT_EVENTS = ["payment.received", "credit_note.issued"] as const;

const payloadSchema = z.object({ invoiceId: z.string().min(1) }).passthrough();

export async function handleSettlementEvent(
  tx: Tx,
  e: Pick<DispatchedEvent, "name" | "payload" | "occurredAt">,
): Promise<{ queued: string[] }> {
  if (!(READY_ON_PAYMENT_EVENTS as readonly string[]).includes(e.name)) return { queued: [] };
  const parsed = payloadSchema.safeParse(e.payload);
  if (!parsed.success) return { queued: [] };
  const { invoiceId } = parsed.data;

  const studies = await (tx as unknown as Db)
    .select({
      id: imagingStudies.id, orderId: imagingStudies.orderId, accessionNo: imagingStudies.accessionNo,
      patientId: imagingStudies.patientId,
    })
    .from(imagingStudies)
    .innerJoin(invoiceLines, eq(invoiceLines.id, imagingStudies.invoiceLineId))
    .where(eq(invoiceLines.invoiceId, invoiceId));
  if (studies.length === 0) return { queued: [] };

  const settlement = await invoiceSettlement(tx, invoiceId);
  if (settlement.state !== "settled") return { queued: [] };

  const queued: string[] = [];
  for (const study of studies) {
    const released = await (tx as unknown as Db).select({ id: imagingReports.id }).from(imagingReports)
      .where(and(eq(imagingReports.studyId, study.id), eq(imagingReports.status, "signed"), isNotNull(imagingReports.publishedAt)));
    for (const report of released) {
      if ((await enqueueReportReady(tx, study, report.id, e.occurredAt)) === "queued") queued.push(report.id);
    }
  }
  return { queued };
}

/** The `Handler` `workerConsumers` registers. Its own transaction — the `orderPlacedConsumer` shape. */
export function readyOnPaymentConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (!(READY_ON_PAYMENT_EVENTS as readonly string[]).includes(e.name)) {
      // The manifest routes exactly these two here; anything else means the two halves drifted.
      throw new Error(`radiology ready-on-payment consumer: no branch for event "${e.name}"`);
    }
    await withTx(db, (tx) => handleSettlementEvent(tx, e));
  };
}
