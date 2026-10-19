import { sql } from "drizzle-orm";
import { EMPTY_TIMING, STATS, istRange, num, rowsOf, timing } from "../../kernel/report/metrics";
import { hasPermission } from "../../kernel/auth/permissions";
import { grnReceivedTotals } from "../materials";
import { REPORTS_MARGIN } from "./report-range";
import { pharmacySalesFigures } from "./sales-register";
import type { MetricsTiming } from "../../kernel/report/metrics";
import type { SalesFigures } from "./sales-register";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PHARMACY NUMBERS (owner request 2026-10-13, issue #777) — the pharmacy tab of Hospital numbers,
 * read-only, no new tables. Held by `pharmacy.metrics.read`. Money is paise.
 *
 *   · bills, sales, returns, net, top items, margin — the SALES REGISTER's own period and lines
 *     (`pharmacySalesFigures`): a bill by its service day, a return (credit note) by its issue day,
 *     so each figure equals the office register's for the same days. Margin (net taxable less GRN
 *     cost) only when the caller ALSO holds `pharmacy.reports.margin`; otherwise it is absent.
 *   · prescriptions received — a ticket reaching the counter's queue (`pharmacy_dispenses.created_at`)
 *     in the range. A queued ticket cancelled because a NEWER version of the prescription replaced it
 *     is not a second prescription and is not counted. Of those received: dispensed IN FULL (handed
 *     over, every prescribed line given with no short-pick note), IN PART (handed over with a line
 *     declined or picked short), NOT AT ALL (never handed over — still waiting, cancelled, refunded).
 *   · received → dispensed: minutes from the ticket to its hand-over, for those received in the range.
 *   · purchases received — GRNs posted in the range, at their accepted cost (`grnReceivedTotals`).
 */

export type PharmacyMetrics = {
  from: string;
  to: string;
  bills: number;
  salesPaise: number;
  returnsPaise: number;
  netPaise: number;
  prescriptions: { received: number; full: number; part: number; none: number };
  receivedToDispensed: MetricsTiming;
  topItems: SalesFigures["topItems"];
  purchases: { grns: number; valuePaise: number };
  /** Present only for a holder of `pharmacy.reports.margin`. */
  margin?: NonNullable<SalesFigures["margin"]>;
};

export async function pharmacyMetrics(db: Db, actor: Actor, range: { from: string; to: string }): Promise<PharmacyMetrics> {
  const withMargin = actor.type === "user" && await hasPermission(db, actor.id, REPORTS_MARGIN, "hospital");
  const { start, end } = istRange(range.from, range.to);
  const s = start.toISOString();
  const e = end.toISOString();

  const TICKETS = sql`
    with t as (
      select d.created_at as received, d.handed_over_at as handed,
             exists (select 1 from pharmacy_dispense_lines l
                      where l.dispense_id = d.id and l.split_from_line_idx is null
                        and (l.status = 'declined' or l.pick_note is not null)) as short
      from pharmacy_dispenses d
      where d.created_at >= ${s}::timestamptz and d.created_at < ${e}::timestamptz
        and not (d.status = 'cancelled' and d.handed_over_at is null
                 and exists (select 1 from pharmacy_dispenses n
                              where n.encounter_id = d.encounter_id and n.prescription_version > d.prescription_version))
    )`;
  const [rx] = await rowsOf(db, sql`${TICKETS}
    select count(*) as received,
           count(*) filter (where handed is not null and not short) as full,
           count(*) filter (where handed is not null and short) as part,
           count(*) filter (where handed is null) as none
    from t`);
  const [rxTime] = await rowsOf(db, sql`${TICKETS}
    select ${STATS} from (select handed - received as d from t where handed is not null) x having count(*) > 0`);

  const sales = await pharmacySalesFigures(db, range.from, range.to, withMargin);
  const purchases = await grnReceivedTotals(db, start, end);

  return {
    from: range.from,
    to: range.to,
    bills: sales.bills,
    salesPaise: sales.salesPaise,
    returnsPaise: sales.returnsPaise,
    netPaise: sales.netPaise,
    prescriptions: { received: num(rx?.["received"]), full: num(rx?.["full"]), part: num(rx?.["part"]), none: num(rx?.["none"]) },
    receivedToDispensed: rxTime === undefined ? EMPTY_TIMING : timing(rxTime),
    topItems: sales.topItems,
    purchases,
    ...(sales.margin === null ? {} : { margin: sales.margin }),
  };
}
