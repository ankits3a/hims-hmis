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
