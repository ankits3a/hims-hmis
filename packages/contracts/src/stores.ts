import { z } from "zod";

/**
 * STORES S1 (#1111, decision 0099) — the wire of `apps/core/src/modules/stores/stores.controller.ts`, read by
 * the controller (request bodies, parsed here) and by the web screens (`/stores`, the phone shelf).
 *
 * No shape a department screen reads carries money: the shelf view is quantities and status words.
 */

const id = z.string().min(1).max(64);
const qty = z.number().int().positive().max(10_000_000);
export const STORES_TRACK_MODES = ["expensed", "shelf", "durable"] as const;
export const storesTrackModeSchema = z.enum(STORES_TRACK_MODES);

export const storesCategoryBody = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  nameHi: z.string().trim().max(120).nullish(),
  parentId: id.nullish(),
});

export const storesItemBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  class: z.string().min(1).max(40),
  baseUom: z.string().trim().min(1).max(20),
  categoryId: id.nullable(),
  trackMode: storesTrackModeSchema.nullable(),
  searchAliases: z.array(z.string().max(80)).max(20).optional(),
  patientBillable: z.boolean().optional(),
  issuePack: z.object({ uom: z.string().trim().min(1).max(20), multiplier: z.number().int().min(2).max(100_000) }).nullish(),
  hsnCode: z.string().max(12).nullish(),
  gstRateBps: z.number().int().min(0).max(2800).nullish(),
});

export const storesItemPatchBody = z.object({
  categoryId: id.optional(),
  trackMode: storesTrackModeSchema.optional(),
  searchAliases: z.array(z.string().max(80)).max(20).optional(),
  reason: z.string().max(200).nullish(),
});

export const storesImportBody = z.object({
  dryRun: z.boolean(),
  rows: z.array(z.object({
    code: z.string().max(40), name: z.string().max(160), class: z.string().max(40), baseUom: z.string().max(20),
    category: z.string().max(20), trackMode: z.string().max(20), aliases: z.string().max(400).nullish(),
  })).min(1).max(2000),
});

export const storesStoreBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["central", "sub", "night"]),
  parentId: id.nullish(),
  trade: z.string().max(40).nullish(),
  serviceHours: z.string().max(40).nullish(),
});

export const storesShelfBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  floorId: id,
  departmentId: id,
  suppliedBy: id,
});

export const storesParBody = z.object({
  shelfId: id, itemId: id,
  minBase: z.number().int().min(0), reorderBase: z.number().int().min(0), maxBase: z.number().int().min(1),
});

export const storesOpenBody = z.object({
  lines: z.array(z.object({ itemId: id, qty, unitCostPaise: z.number().int().min(0).nullish() })).min(1).max(2000),
});

export const storesUseBody = z.object({ itemId: id, qty });
export const storesUndoBody = z.object({ rowId: id, reason: z.string().trim().min(1).max(200) });
export const storesCheckBody = z.object({ lines: z.array(z.object({ itemId: id, counted: z.number().int().min(0).max(10_000_000) })).min(1).max(500) });
export const storesReorderBody = z.object({ lines: z.array(z.object({ itemId: id.nullish(), qty })).min(1).max(500) });
export const storesReceiveBody = z.object({ transferId: id });
export const storesRequestBody = z.object({ name: z.string().trim().min(1).max(160), note: z.string().max(400).nullish() });
export const storesResolveBody = z.object({ outcome: z.enum(["created", "use_existing"]), itemId: id });

/* ═══ wire shapes the screens read ═══ */

export type StoresTrackMode = (typeof STORES_TRACK_MODES)[number];
export type StoresStatusWord = "ok" | "low" | "out";

export type WireStoresCategory = { id: string; code: string; name: string; nameHi: string | null; parentId: string | null; active: boolean };
export type WireStoresItem = {
  id: string; code: string; name: string; class: string; baseUom: string; categoryId: string | null; categoryName: string | null;
  trackMode: StoresTrackMode; searchAliases: string[]; active: boolean; issuePack: { uom: string; multiplier: number };
};
export type WireStoresStore = {
  id: string; code: string; name: string; kind: "central" | "sub" | "night" | "shelf"; parentId: string | null;
  departmentId: string | null; suppliedBy: string | null; custodianRoles: string[];
};
export type WireStoresShelf = WireStoresStore & { departmentCode: string | null; departmentName: string | null; floorName: string | null };
export type WireShelfItem = {
  itemId: string; code: string; name: string; baseUom: string; trackMode: StoresTrackMode; onHand: number; status: StoresStatusWord;
  par: { minBase: number; reorderBase: number; maxBase: number } | null; lastCheckAt: string | null;
  usePerDay30: number; usePerOpdVisit: number | null; usePerBedDay: number | null;
};
export type WireShelfView = {
  shelf: WireStoresShelf;
  items: WireShelfItem[];
  arriving: { transferId: string; fromName: string; issuedAt: string; lines: { lineId: string; itemId: string; name: string; qty: number }[] }[];
  may: { work: boolean };
};
export type WireReorderLine = { itemId: string; code: string; name: string; onHand: number; proposed: number; packUom: string; packSize: number };
export type WireItemRequest = {
  id: string; name: string; note: string | null; status: "open" | "created" | "use_existing"; requestedBy: string;
  shelfId: string | null; departmentId: string | null; resolvedItemId: string | null; createdAt: string;
  similar: { itemId: string; code: string; name: string }[];
};
export type WireImportResult = { dryRun: boolean; created: number; wouldCreate: number; refusals: { row: number; code: string; message: string }[] };
export type WireOverBookCard = { cardId: string; shelfId: string; shelfName: string; checkId: string; at: string; lines: { itemId: string; name: string; book: number; counted: number }[] };
export type WireStoresPickers = {
  floors: { id: string; code: string; name: string }[];
  departments: { id: string; code: string; name: string }[];
};

// ═══════════════════════════ S2a (#1112) — tickets, approval, picking, timeline, audit pack ═══════════════════════════

export const STORES_TICKET_PRIORITIES = ["routine", "urgent", "emergency"] as const;
export const STORES_TICKET_CHANNELS = ["phone", "web", "copilot", "agent"] as const;
const instant = z.string().datetime({ offset: true });

/** A line with no item id is the server's refusal (`item_id_required`), so the body lets it through. */
export const storesTicketBody = z.object({
  lines: z.array(z.object({ itemId: z.string().max(64).nullish(), qtyBase: z.number().int() })).min(1).max(100),
  priority: z.enum(STORES_TICKET_PRIORITIES),
  neededBy: instant.nullish(),
  deliverTo: z.string().max(200).nullish(),
  channel: z.enum(STORES_TICKET_CHANNELS).optional(),
  emergencyReason: z.string().max(500).nullish(),
  note: z.string().max(500).nullish(),
});
export const storesApproveBody = z.object({ lines: z.array(z.object({ lineIdx: z.number().int().min(0), qtyBase: z.number().int().min(0) })).max(100).optional() });
export const storesDeclineBody = z.object({ reason: z.string().max(500) });
export const storesReviewBody = z.object({ decision: z.enum(["agree", "query"]), note: z.string().max(500).nullish() });
export const storesIssueBody = z.object({ lines: z.array(z.object({ lineIdx: z.number().int().min(0), qtyBase: z.number().int().min(0) })).max(100).optional() });
export const storesAuditQuery = z.object({
  ticketId: id.optional(), itemId: id.optional(), personId: id.optional(), storeId: id.optional(),
  from: instant, to: instant, format: z.enum(["json", "csv"]).optional(),
});

// ── S2b (#1112): the custody chain, the receipt, shorts, returns ──
const scanFields = { clientKey: z.string().min(1).max(80).nullish(), scannedAt: instant.nullish() };
export const storesScanBody = z.object({ code: z.string().min(4).max(40), ...scanFields });
export const storesHandOverBody = z.object({ code: z.string().min(4).max(40), fromUserId: id, ...scanFields });
export const storesTakeOverBody = z.object({ reason: z.string().max(500) });
export const storesDeliverBody = z.object({
  lines: z.array(z.object({
    lineIdx: z.number().int().min(0), accepted: z.number().int().min(0).optional(), short: z.number().int().min(0).optional(),
    wrong: z.number().int().min(0).optional(), damaged: z.number().int().min(0).optional(),
  })).max(100).optional(),
  ...scanFields,
});
export const storesUndeliveredBody = z.object({ ...scanFields });
export const storesResolveShortBody = z.object({ lineIdx: z.number().int().min(0), resolution: z.enum(["found", "returned", "lost"]), note: z.string().max(500).nullish() });
export const storesAddLinesBody = z.object({ lines: z.array(z.object({ itemId: id.nullish(), qtyBase: z.number().int().min(1) })).min(1).max(100) });
export const storesReturnBody = z.object({
  lines: z.array(z.object({ itemId: id, qtyBase: z.number().int().min(1), reason: z.enum(["unused", "wrong", "defective"]) })).min(1).max(100),
  note: z.string().max(500).nullish(),
});

export type WireCustodyResult = { ticket: WireTicket; duplicate: boolean; flag: "late" | "future" | null };
/** UX pass (#1112): the label names the ticket; the server names whose hands it is in, for the one confirm tap. */
export type WireCustodyLookup = { ticket: WireTicket; act: "take" | "hand_over"; holder: WireTicketPerson };
export type WirePorterRow = { ticket: WireTicket; from: { id: string; code: string; name: string }; to: { id: string; code: string; name: string }; minutes: number };
export type WireLateScan = { handoffId: string; indentId: string; indentNo: string; kind: string; by: WireTicketPerson; phoneAt: string; recordedAt: string; flag: "late" | "future" };
export type WireReturnTicket = {
  transferId: string; status: string; shelf: { id: string; code: string; name: string }; to: { id: string; code: string; name: string };
  quarantine: boolean; raisedBy: WireTicketPerson; raisedAt: string; lines: { itemId: string; itemName: string; qtyBase: number }[];
};

export type WireTicketPerson = { id: string; name: string };
export type WireTicket = {
  id: string; indentNo: string; status: string;
  stage: "to_approve" | "to_pick" | "to_receive" | "delivered" | "declined" | "rejected" | "cancelled" | "returning" | "returned";
  priority: (typeof STORES_TICKET_PRIORITIES)[number]; channel: (typeof STORES_TICKET_CHANNELS)[number];
  neededBy: string | null; deliverTo: string | null; emergencyReason: string | null; night: boolean;
  department: { id: string; code: string; name: string };
  shelf: { id: string; code: string; name: string };
  source: { id: string; code: string; name: string; kind: string };
  requestedBy: WireTicketPerson; requestedAt: string; clockFrom: string;
  origin: { indentId: string; indentNo: string; kind: "re_raise" | "re_ask" } | null;
  approval: { state: "pending" | "approved" | "declined" | "not_needed"; by: WireTicketPerson | null; at: string | null; forHod: boolean; reason: string | null };
  review: { decision: "agree" | "query"; by: WireTicketPerson; at: string; note: string | null } | null;
  claim: { by: WireTicketPerson; at: string; lapsesAt: string } | null;
  transfer: { id: string; status: string } | null;
  lines: { lineIdx: number; itemId: string; itemCode: string; itemName: string; baseUom: string; qtyBase: number; qtyApproved: number | null; qtyIssued: number | null }[];
  /** S2b (#1112): whose hands it is in, what the receiver said per line, and the shorts still in transit. */
  custody?: { holder: WireTicketPerson | null; legs: number; lastCustodian: WireTicketPerson } | null;
  delivery?: {
    by: WireTicketPerson; at: string; atCounter: boolean; sentBack: number; sentBackAccepted: boolean;
    lines: { lineIdx: number; itemId: string; accepted: number; short: number; wrong: number; damaged: number }[];
  } | null;
  shorts?: {
    lineIdx: number; itemId: string; qty: number; with: WireTicketPerson;
    resolution: { kind: "found" | "returned" | "lost"; by: WireTicketPerson; at: string; approvalId: string | null; posted: boolean } | null;
  }[];
};
export type WireTimelineStep = {
  step: "raise" | "re_raise" | "re_ask" | "approve" | "decline" | "review" | "claim" | "issue" | "receive" | "reject" | "cancel"
    | "take" | "hand_over" | "take_over" | "deliver" | "collect" | "send_back" | "return_undelivered" | "return_accepted" | "found" | "returned" | "lost";
  who: { id: string; name: string; roles: string[] } | null;
  from: { id: string; code: string; name: string } | null;
  to: { id: string; code: string; name: string } | null;
  at: string; minutes: number | null; forHod: boolean; note: string | null;
  lines: { itemId: string; itemName: string; asked: number; approved: number | null; issued: number | null }[];
  phoneAt?: string | null; recordedAt?: string | null;
};
export type WireTicketTimeline = { indentId: string; indentNo: string; steps: WireTimelineStep[] };

// ── S2c (#1119): gate passes and the guard's scan ──
export const STORES_GATE_PASS_PURPOSES = ["repair", "calibration", "refill", "loan"] as const;
const gateLines = z.array(z.object({ itemId: id, qty: z.number().int().min(1).max(1_000_000) })).min(1).max(50);
export const storesGatePassBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("returnable"), storeId: id, purpose: z.enum(STORES_GATE_PASS_PURPOSES), party: z.string().max(200),
    dueBack: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"), lines: gateLines, note: z.string().max(200).nullish(),
  }),
  // The record is optional in the SHAPE so that its absence is the server's refusal ("Return or write-off needed"), not a 400.
  z.object({ kind: z.literal("non_returnable"), refType: z.enum(["supplier_return", "write_off"]).nullish(), refId: id.nullish(), note: z.string().max(200).nullish() }),
]);
export const storesGatePassScanBody = z.object({
  code: z.string().min(4).max(40), act: z.enum(["exit", "entry"]), lines: gateLines.optional(), ...scanFields,
});
export const storesGatePassCloseBody = z.object({ reason: z.string().max(200) });

export type WireGatePassStatus = "raised" | "out" | "overdue" | "back" | "closed";
export type WireGatePass = {
  id: string; passNo: string; kind: "returnable" | "non_returnable"; purpose: (typeof STORES_GATE_PASS_PURPOSES)[number] | null;
  party: string; dueBack: string | null; status: WireGatePassStatus;
  store: { id: string; code: string; name: string };
  ref: { type: "supplier_return" | "write_off"; id: string; no: string } | null;
  note: string | null;
  lines: { itemId: string; itemCode: string; itemName: string; baseUom: string; qty: number; out: number; back: number }[];
  raisedBy: WireTicketPerson; raisedAt: string;
  scans: { kind: "exit" | "entry" | "close"; by: WireTicketPerson; at: string; recordedAt: string; flag: "late" | "future" | null; reason: string | null; lines: { itemId: string; qty: number }[] }[];
};
export type WireGatePassLookup = { pass: WireGatePass; act: "exit" | "entry" };
export type WireGatePassScanResult = { pass: WireGatePass; duplicate: boolean; flag: "late" | "future" | null };
export type WireGatePassSource = {
  type: "supplier_return" | "write_off"; id: string; no: string; party: string; store: { id: string; code: string; name: string }; at: string;
  lines: { itemId: string; itemName: string; qty: number }[];
};
/** The store's "New pass" sheet: where a returnable pass may start, and what a non-returnable pass may stand on. */
export type WireGatePassForm = { stores: { id: string; code: string; name: string }[]; sources: WireGatePassSource[] };

// ── S3 (#1113): the control tower, the owner's one line, the Stuck Now card ──
/** The six lanes, in board order. A card sits in exactly one; Stuck wins (spec #1113 decision 1). */
export const STORES_TOWER_LANES = ["requested", "approved", "picking", "in_transit", "delivered", "stuck"] as const;
export type StoresTowerLane = (typeof STORES_TOWER_LANES)[number];
/** The clock that broke (decision 2): approval 60 min, pick by priority, a 30-min leg, a porter's 2 h, an open short, an emergency review. */
export const STORES_TOWER_CLOCKS = ["approval", "pick", "leg", "custody", "short", "review"] as const;
export type StoresTowerClock = (typeof STORES_TOWER_CLOCKS)[number];
/** The red-card strip's kinds (decision 4). */
export const STORES_RED_CARD_KINDS = ["stuck", "short", "out", "pass", "over_book"] as const;
export type StoresRedCardKind = (typeof STORES_RED_CARD_KINDS)[number];

/** One ticket on the board. No patient field and no money: the key set is pinned by spec #1113 D6. */
export type WireTowerCard = {
  id: string; indentNo: string; lane: StoresTowerLane; priority: (typeof STORES_TICKET_PRIORITIES)[number];
  department: { id: string; code: string; name: string };
  floor: { id: string; code: string; name: string } | null;
  /** Whose hands it is in, once issued. */
  holder: WireTicketPerson | null;
  /** Minutes on the lane's own clock (in transit: since the last hand-off). */
  minutes: number;
  /** Only on a Stuck card: which clock broke, and its minutes. */
  clock: { kind: StoresTowerClock; minutes: number } | null;
};
export type WireRedCard = {
  id: string; kind: StoresRedCardKind;
  /** What (a ticket, shelf or pass number) and where (a department, floor or party), as data; the screen says the words. */
  what: string; where: string;
  /** When its clock started: the strip is oldest first. */
  since: string; minutes: number;
  clock: StoresTowerClock | null;
  indentId: string | null; shelfId: string | null; passId: string | null;
};
export type WireTowerFloor = {
  id: string | null; code: string; name: string;
  departments: { id: string; code: string; name: string; status: StoresStatusWord }[];
};
export type WireTowerNumbers = {
  ticketsToday: number; medianApprovalMin: number | null; medianDeliverMin: number | null;
  /** Transfers received today whose issuer is not the receiver, in per cent; null when none was received. */
  doubleSignedPct: number | null; openShorts: number;
};
export type WireTowerSpend = {
  /** The IST month, `YYYY-MM`. */
  month: string;
  departments: { id: string; code: string; name: string; chargePaise: number; perOpdVisitPaise: number | null; perBedDayPaise: number | null }[];
};
export type WireTowerView = {
  at: string;
  lanes: Record<StoresTowerLane, WireTowerCard[]>;
  redCards: WireRedCard[];
  floors: WireTowerFloor[];
  numbers: WireTowerNumbers;
  /** Present only for a holder of `stores.spend.read` (decision 5): the key is absent for everybody else. */
  spend?: WireTowerSpend;
};
/** The owner's one line at 390 px (decision 16): "3 stuck · 4B, OT". `places` are floor codes, most stuck first. */
export type WireTowerSummary = { stuck: number; places: string[] };
