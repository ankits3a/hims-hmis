import { desc, inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { invoices } from "../../kernel/db/schema";
import { getPatient, getPatientSummaries, listMergedLoserIds } from "../patients";
import { moneyByInvoice } from "./patient-bills";
import { settlementState } from "./settlement";
import { istDay } from "./time";
import type { SettlementState } from "./settlement";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ #852 — A SEALED RECORD'S BILLS, AS THE BOARD DRAWS THEM AND NOTHING MORE ═══
 *
 * Board `docs/design/2026-09-29-patient-profile/` §4: on a restricted record the profile shows each
 * bill as a row — its date, its number and where it stands. This read answers exactly that and only
 * for the reader the alias view is for: a SEALED record the reader may NOT open (no
 * `patients.confidential.read`, no live break-glass — `getPatient` is that decision and is asked
 * first). A record the reader CAN open answers null (404): the full bill reads already serve it.
 * An absent id, an ordinary record and an agent credential answer null too.
 *
 * NO AMOUNT, NO LINE, NO PAYER, NO INVOICE ID. The status is computed from the money on the server
 * (`settlementState`) and only its name crosses the wire.
 *
 * `unsettledOnly` is the front desk's narrow `billing.dues.patient.read` (owner ruling 2026-09-30):
 * on any other record that string reads the unsettled bills and nothing of the history, so here too.
 */
export type BillAliasRow = { date: string; invoiceNo: string; status: SettlementState };

const BILLS_ALIAS_CAP = 100;

export async function billsAliasRows(
  db: Db, actor: Actor, patientId: string, opts: { unsettledOnly: boolean },
): Promise<BillAliasRow[] | null> {
  if (actor.type !== "user") return null;
  if (await getPatient(db, actor, patientId)) return null;
  const [summary] = await getPatientSummaries(db, actor, [patientId]);
  if (summary === undefined || !summary.restricted) return null;
  const chain = [summary.id, ...await listMergedLoserIds(db, summary.id)];
  const heads = await db
    .select({ id: invoices.id, invoiceNo: invoices.invoiceNo, issuedAt: invoices.issuedAt, netPayablePaise: invoices.netPayablePaise })
    .from(invoices)
    .where(inArray(invoices.patientId, chain))
    .orderBy(desc(invoices.issuedAt))
    .limit(BILLS_ALIAS_CAP);
  const money = await moneyByInvoice(db, heads.map((h) => h.id));
  const rows = heads.map((h): BillAliasRow => ({
    date: istDay(h.issuedAt),
    invoiceNo: h.invoiceNo,
    status: settlementState(h.netPayablePaise, money.credited.get(h.id) ?? 0, money.paid.get(h.id) ?? 0).state,
  }));
  return opts.unsettledOnly ? rows.filter((r) => r.status !== "settled") : rows;
}
