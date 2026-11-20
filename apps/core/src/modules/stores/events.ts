import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * STORES S1 (#1111) — ONE EVENT FOR EVERY STORES ACT, so the audit pack (S2a) reads one stream.
 *
 * The programme's rule (§0A): every stores act writes its domain event with the actor, the time, the
 * store(s), the item, the quantity before and after, and the reason. The actor and the time are the
 * event's own envelope; the rest is this payload, the same keys for every act:
 *
 *   act      — what was done (`register_item`, `create_shelf`, `receive`, `use`, `check`, `open`,
 *              `import`, `new_item_request`, `resolve_request`, `par`, `category`, `track_mode`,
 *              `aliases`, `reverse`, `reorder_draft`, `create_category`, `create_store`);
 *   storeId  — the store or shelf it happened at (null for a master edit);
 *   itemId   — the item, when the act is about one (null for a many-line act, whose `lines` carry it);
 *   before / after — the quantity on hand before and after at that store, or the value before and after
 *              for a master edit (a category id, a track mode, a par);
 *   reason   — the person's reason when one was given.
 *
 * Nothing in a payload is a patient, and no figure is money: a department's charge is read off the ledger.
 */
const MODULE = "stores";

export const STORES_ACTS = [
  "register_item", "create_category", "create_store", "create_shelf", "open", "receive", "use", "reverse", "check",
  "import", "new_item_request", "resolve_request", "par", "category", "track_mode", "aliases", "reorder_draft",
  // S2a (#1112): a ticket's acts (refId = the indent) and each audit-pack export (decision 16).
  "raise_ticket", "approve_ticket", "decline_ticket", "reraise_ticket", "review_emergency", "claim_picking", "issue_ticket", "audit_export",
  // S2b (#1112): the custody chain, the receipt, what went back, the shorts' resolutions, returns, late scans, adding to a ticket.
  "take_custody", "hand_over", "take_over", "deliver_ticket", "send_back", "return_undelivered", "accept_return", "resolve_short",
  "reask_ticket", "raise_return", "receive_return", "confirm_late_scan", "add_to_ticket",
  // S2c (#1119): a gate pass's raise, the guard's exit and entry scans, and the close of a pass that never left (refId = the pass).
  "raise_gate_pass", "gate_pass_out", "gate_pass_in", "close_gate_pass",
  // S3 (#1113): a reorder the copilot proposed and the person confirmed (refId = the ticket; after names the confirm).
  "copilot_reorder",
  // S4a (#1114): the asset passport (refId = the unit, the GRN line for tag_units, the round for a verification).
  "tag_units", "void_tag", "retag", "open_unit", "fill_cost", "asset_details", "link_device", "report_fault", "open_repair", "close_repair",
  "found_here", "propose_unit_transfer", "accept_unit_transfer", "asset_export", "start_round", "close_round",
  // S4b (#1114): withdrawal, regulation, the committee, the approvals read back, disposal, loss and a unit found again (refId = the unit).
  "withdraw_unit", "return_to_use", "regulated_by", "regulator_paper", "propose_condemnation", "propose_loss", "sign_condemnation",
  "object_condemnation", "dispose_unit", "write_off_loss", "mark_found",
  // S5a (#1115): the buying desk's front (refId = the request, the GRN, the vendor, the delegation or the department).
  "raise_purchase_request", "approve_purchase_request", "decline_purchase_request", "cancel_purchase_request", "set_band",
  "set_budget", "delegate_approvals", "grn_qc", "grn_post", "supplier_fields", "approve_supplier_category",
  // S5b (#1115): the buying desk by hand (refId = the group, RFQ, quote, award, PO or seat row; a request's chain is read by
  // the audit pack from the rows that link them).
  "group_requests", "move_group_line", "create_rfq", "invite_suppliers", "send_rfq", "move_reply_by", "close_rfq", "enter_quote",
  "open_quote", "admit_late_quote", "mark_technical", "propose_award", "approve_award", "sign_award", "object_award", "set_committee_seat",
  "po_from_award", "submit_po", "approve_po", "send_po",
  // S5c (#1115): the buyer agent's night (refId = the run's PR or null), a person's confirm or dismissal of an agent draft
  // (refId = the draft), a quote line confirmed from a PDF, single-source / emergency purchases (refId = the exception),
  // equipment advances (refId = the advance).
  "agent_night", "confirm_agent_draft", "dismiss_agent_draft", "confirm_quote_line", "read_quote_pdf", "request_exception", "certify_exception",
  "approve_exception", "confirm_exception", "refuse_exception", "request_advance", "decide_advance",
  // S6a (#1116): a service entry sheet confirmed (refId = the SES), a payment hold placed by a rule, released or kept
  // (refId = the hold), the paying desk's switches set (refId = the settings row), a run authorised from the phone.
  "ses_confirm", "hold_placed", "hold_release", "hold_keep", "paying_settings",
  // S6b (#1116): a tax table saved or signed (refId = the table), a lower-deduction certificate, a TDS changed from the
  // proposal (refId = the bill), an MSME objection raised or closed (refId = the objection), the Stores Tally ledger names.
  "tax_table_save", "tax_table_sign", "tds_certificate", "tds_change", "msme_objection", "msme_objection_close", "tally_ledgers",
  // S6c (#1116): the auditor's night (refId null; after.flags), a person's review of a flag (refId = the flag), a service entry
  // reversed (refId = the reversing sheet; after.reverses = the first).
  "auditor_night", "audit_flag_review", "ses_reverse",
  // S7 (#1117): the stock planner — a warning and its end (storeId + itemId), a draft line (refId = the draft), a person's
  // send / not now / return (refId = the draft), a withdrawal, a slow-stock card, a par suggestion accepted or kept (refId =
  // the suggestion), the settings and the owner's T3 approval (refId = the row), the night's marker.
  "planner_warning", "planner_recovered", "planner_draft", "planner_send", "planner_not_now", "planner_return", "planner_withdraw", "planner_slow",
  "planner_par_accept", "planner_par_keep", "planner_settings", "planner_t3_approve", "planner_night",
] as const;
export type StoresAct = (typeof STORES_ACTS)[number];

export const storesActRecorded = defineEvent("stores.act_recorded", MODULE, z.object({
  act: z.enum(STORES_ACTS),
  storeId: z.string().nullable(),
  itemId: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().nullable(),
  refId: z.string().nullable(),
  lines: z.array(z.record(z.string(), z.unknown())),
}));

export const STORES_ACT_EVENT = "stores.act_recorded";
export const STORES_EVENTS = [storesActRecorded] as const;
