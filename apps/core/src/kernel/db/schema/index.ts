export * from "./events";
export * from "./eventCursors";
export * from "./eventIdempotency";
export * from "./auth";
export * from "./workflow";
export * from "./approvals";
export * from "./patients";
export * from "./tariff";
export * from "./opd";
export * from "./billing";
export * from "./worker";
export * from "./alerts";
export * from "./notifications";
export * from "./retention";
export * from "./ops";
export * from "./search";
// The V/A/L/S/R/P daily counters — kernel-level because opd, lab, radiology and pharmacy all
// draw from them; see episodes.ts for why they are not `document_series`.
export * from "./episodes";
// PLAN 09 — the counterparty side first: `membership.ts` points at `counterparties`, never the
// reverse (DD1), and reading them in dependency order is the cheapest way to keep it that way.
export * from "./partners";
export * from "./membership";
// PLAN 16a — the formulary: brand → active moiety → drug class, and the moiety-level interaction
// pairs the OPD check suite reads. `modules/opd` reaches it only through read helpers (the
// `listAllergies` precedent), never by importing these tables.
export * from "./formulary";
// PLAN 13 T1 — the resource registry, LAST because of dependency order. `opd.ts` above declares
// BOTH its `room_id` foreign keys into `resources.id` (T6 repointed them; T7's `0033` dropped
// `opd_rooms` entirely), so `opd.ts` depends on THIS file and not the other way round, and the
// registry must be readable before the module tables that point into it.
export * from "./resources";
// PLAN 14 T1 — materials, LAST because it is the only file that depends on TWO of the files above:
// `items.formulary_medicine_id` references `formulary_medicines` (DD3) and six of its tables
// reference `resources` (every stock location is a registry resource of kind `store`, DD2). It is
// therefore downstream of both `formulary` and `resources` and neither is downstream of it.
export * from "./materials";
// PLAN 15 T1 — the mini-OT, LAST because it is downstream of both `patients` (every clinical
// document carries a real patient FK, billing's owner ruling R5) and `resources` (the theatre and
// the two recovery bays ARE registry rows, DD3). Nothing above depends on it: materials learns
// about a day-care case only through the `consignment.deployed` event payload, never by import.
export * from "./ot";
// PLAN 07a T2 — the PHI access log. It references NOTHING: `actor_id` and `patient_id` are plain
// text on purpose (its own header carries the reasoning), so it sits downstream of no table and
// nothing is downstream of it. That independence is the point — an audit log must outlive the
// record it describes, and an FK would couple it to that record's truncate group and lifecycle.
export * from "./phi-access";
// PLAN 07c T8 — the desk's per-user daily rollup. Like `phi-access` it references NOTHING: it is a
// CACHE derived from the primary tables, so an FK would couple a rebuildable projection to the
// lifecycle of the rows it summarises and would put it in their truncate group for no benefit.
export * from "./desk";
// PLAN 17 PHASE 0 T1 — the P2 order envelope, LAST because it is downstream of both `patients`
// (every clinical document carries a real patient FK, billing's owner ruling R5) and `tariff`
// (`order_items.service_id` references `services.id`, the only tariff link the envelope has, DD10).
// Nothing above depends on it: a module that claims an order kind hangs its OWN tables off
// `order_item_id` and never adds a column here.
export * from "./orders";
// PLAN 17 T1 — the central lab, LAST because it is downstream of FOUR of the files above:
// `lab_orderables.service_id` → `tariff.services`, `lab_specimens.patient_id` → `patients`,
// `lab_items` / `lab_results` / `lab_sla_breaches` → `orders.order_items`, and
// `lab_items.invoice_id` / `invoice_line_id` → `billing.invoices` / `invoice_lines` (DD6 — the lab
// posts its own money and the envelope holds none). Nothing above depends on it: these thirteen
// tables are the lab's EXTENSION of the order envelope, keyed `order_item_id`, and phase 0 §8.1
// forbids them adding a column to it.
export * from "./lab";
// PLAN 18a T1 — radiology & imaging, and the PCPNDT register. LAST, because between them they are
// downstream of SIX of the files above: `imaging_studies` references `patients`, `orders` /
// `order_items` (it is an EXTENSION of the envelope, keyed `order_item_id`, phase 0 §8.1),
// `tariff.services`, `resources` (a modality is a `device` registry row, DD6) and
// `billing.invoice_lines` (DD12 — the study LINKS to a line the counter raised and composes no
// invoice of its own). `pcpndt.ts` reads `resources`, `patients` and `auth.users`.
//
// `pcpndt` is exported BESIDE radiology rather than inside it because it is its own MANIFEST (DD1):
// 15b and 62 install the statutory register without installing radiology, and
// `pcpndt_form_f.study_id` is deliberately plain text for exactly that reason (§6.5).
export * from "./radiology";
export * from "./pcpndt";
