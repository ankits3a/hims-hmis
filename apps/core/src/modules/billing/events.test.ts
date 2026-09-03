import { BILLING_EVENTS } from "./events";

/**
 * The plan's twenty D-Events names, in the order the Global Constraints section lists them — plus
 * ONE the plan did not foresee.
 *
 * FD-11 adds `cashier_session.recounted`. The census is a catalog DISCIPLINE, not a freeze: its job
 * is that no event slips into the module without somebody writing it down here, and this is that
 * writing-down. It earns its place because it is the audit record for withdrawing a mistyped
 * closing count — the owner hit that dead end on the preview, and the whole safety of the re-count
 * is that the retracted figure is written to the log before the drawer reopens. An event that IS
 * the control cannot be an event nobody declared.
 *
 * It sits beside the other two `cashier_session.*` names rather than at the end, because the order
 * is the second assertion below and a lifecycle reads in lifecycle order: opened, closed, recounted.
 */
const EXPECTED_NAMES = [
  "invoice.issued", "invoice.credit_extended", "receipt.recorded", "payment.received", "advance.received",
  "allocation.reversed", "credit_note.issued", "refund_voucher.issued", "payment.refunded",
  "cashier_session.opened", "cashier_session.closed", "cashier_session.recounted", "variance.flagged",
  "cash_threshold.warned", "cash_threshold.blocked", "tender.reconciled", "tender.mismatched",
  "degraded_mode.changed", "document.entered_in_error", "charge.orphan_flagged", "day.closed",
];

describe("billing event catalog (D-Events, Global Constraints: catalog discipline)", () => {
  test("exactly twenty-one defineEvent exports, every one carrying module \"billing\"", () => {
    expect(BILLING_EVENTS).toHaveLength(21);
    for (const ev of BILLING_EVENTS) expect(ev.module).toBe("billing");
  });

  test("the name manifest matches the declared names exactly, in order (not a count)", () => {
    expect(BILLING_EVENTS.map((e) => e.name)).toEqual(EXPECTED_NAMES);
  });
});
