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
