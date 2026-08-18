import { BILLING_EVENTS } from "./events";

/** The plan's twenty D-Events names, in the order the Global Constraints section lists them. */
const EXPECTED_NAMES = [
  "invoice.issued", "invoice.credit_extended", "receipt.recorded", "payment.received", "advance.received",
  "allocation.reversed", "credit_note.issued", "refund_voucher.issued", "payment.refunded",
  "cashier_session.opened", "cashier_session.closed", "variance.flagged",
  "cash_threshold.warned", "cash_threshold.blocked", "tender.reconciled", "tender.mismatched",
  "degraded_mode.changed", "document.entered_in_error", "charge.orphan_flagged", "day.closed",
];

describe("billing event catalog (D-Events, Global Constraints: catalog discipline)", () => {
  test("exactly twenty defineEvent exports, every one carrying module \"billing\"", () => {
    expect(BILLING_EVENTS).toHaveLength(20);
    for (const ev of BILLING_EVENTS) expect(ev.module).toBe("billing");
  });

  test("the name manifest matches the plan's twenty D-Events names exactly (not a count)", () => {
    expect(BILLING_EVENTS.map((e) => e.name)).toEqual(EXPECTED_NAMES);
  });
});
