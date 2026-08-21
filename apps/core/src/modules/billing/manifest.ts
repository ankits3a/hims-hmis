import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * The billing module's declared surface (spec §4): the fourteen `billing.*` permissions the
 * controller's routes guard on, and the four menu entries Plan 08's pipeline-C screens mount.
 * `syncPermissions` mirrors this at boot — no new boot-time DB call. Role grants (cashier vs
 * billing_manager) are a go-live data step (README runbook, T12).
 *
 * `billing.credit.extend` is the one permission NO route guards on: it is checked INSIDE
 * `issueInvoice` (D2 step 3, owner ruling 2), on the same `POST /billing/invoices` a plain issue
 * uses, so it can only be declared here and never mapped to a route of its own.
 */
export const billingManifest: ModuleManifest = {
  key: "billing",
  title: "Billing — invoices, receipts, cashier sessions, refunds",
  menu: [
    { label: "Billing counter", path: "/billing", permission: "billing.invoice.issue" },
    { label: "Dues & Advances", path: "/billing/dues", permission: "billing.invoice.read" },
    { label: "Cashier session", path: "/billing/session", permission: "billing.session.own" },
    { label: "Billing back office", path: "/billing/office", permission: "billing.reports.read" },
  ],
  permissions: [
    "billing.invoice.issue", "billing.invoice.read", "billing.credit.extend",
    "billing.receipt.record", "billing.allocation.reverse", "billing.credit_note.issue",
    "billing.refund.request", "billing.refund.pay",
    "billing.session.own", "billing.session.read",
    "billing.recon.upload", "billing.reports.read", "billing.config.write", "billing.eie.mark",
  ],
  // No subscriptions: billing stays check-on-execute BY DESIGN (Global Constraint 1) — Plan 08.5
  // puts the dispatcher on a clock, but no billing route consumes an event; screens poll instead.
  subscriptions: [],
};
