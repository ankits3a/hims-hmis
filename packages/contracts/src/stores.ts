import { z } from "zod";

/**
 * STORES S1 (#1111, decision 0099) — the wire of `apps/core/src/modules/stores/stores.controller.ts`, read by
 * the controller (request bodies, parsed here) and by the web screens (`/stores`, the phone shelf).
 *
 * No shape a department screen reads carries money: the shelf view is quantities and status words.
 */

const id = z.string().min(1).max(64);
const qty = z.number().int().positive().max(10_000_000);
export const STORES_TRACK_MODES = ["expensed", "shelf", "durable", "tagged"] as const;
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
export const storesIssueBody = z.object({ lines: z.array(z.object({ lineIdx: z.number().int().min(0), qtyBase: z.number().int().min(0), unitIds: z.array(id).max(500).optional() })).max(100).optional() });
export const storesAuditQuery = z.object({
  ticketId: id.optional(), itemId: id.optional(), personId: id.optional(), storeId: id.optional(), unitId: id.optional(),
  from: instant, to: instant, format: z.enum(["json", "csv"]).optional(),
  afterSeq: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().positive().max(5000).optional(),
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
    /** S4 (#1114): the tagged units that arrived on this line (the receiver's scans); omitted when every unit arrived. */
    unitIds: z.array(id).max(500).optional(),
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
  lines: {
    lineIdx: number; itemId: string; itemCode: string; itemName: string; baseUom: string; qtyBase: number; qtyApproved: number | null; qtyIssued: number | null;
    /** S4b (#1114): the tagged units still on their way on this line (the receiver scans the ones that arrived). */
    units?: { id: string; tagNo: string }[];
  }[];
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
const gateLines = z.array(z.object({ itemId: id, qty: z.number().int().min(1).max(1_000_000), unitIds: z.array(id).max(200).optional() })).min(1).max(50);
export const storesGatePassBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("returnable"), storeId: id, purpose: z.enum(STORES_GATE_PASS_PURPOSES), party: z.string().max(200),
    dueBack: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"), lines: gateLines, note: z.string().max(200).nullish(),
  }),
  // The record is optional in the SHAPE so that its absence is the server's refusal ("Return or write-off needed"), not a 400.
  z.object({ kind: z.literal("non_returnable"), refType: z.enum(["supplier_return", "write_off", "scrap_sale"]).nullish(), refId: id.nullish(), note: z.string().max(200).nullish() }),
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
  ref: { type: "supplier_return" | "write_off" | "scrap_sale"; id: string; no: string } | null;
  note: string | null;
  lines: { itemId: string; itemCode: string; itemName: string; baseUom: string; qty: number; out: number; back: number }[];
  raisedBy: WireTicketPerson; raisedAt: string;
  scans: { kind: "exit" | "entry" | "close"; by: WireTicketPerson; at: string; recordedAt: string; flag: "late" | "future" | null; reason: string | null; lines: { itemId: string; qty: number }[] }[];
};
export type WireGatePassLookup = { pass: WireGatePass; act: "exit" | "entry" };
export type WireGatePassScanResult = { pass: WireGatePass; duplicate: boolean; flag: "late" | "future" | null };
export type WireGatePassSource = {
  type: "supplier_return" | "write_off" | "scrap_sale"; id: string; no: string; party: string; store: { id: string; code: string; name: string }; at: string;
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
/** S4 (#1114) adds four: calibration overdue, AMC lapsed, a missing asset, units ≠ ledger. */
export const STORES_RED_CARD_KINDS = ["stuck", "short", "out", "pass", "over_book", "calibration", "amc", "missing", "units_ledger"] as const;
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
  /** S4 (#1114): the tagged unit an asset card is about. */
  unitId?: string | null;
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
  /** S4 (#1114, decision 19): tagged units received by departments this month: "Equipment received", never in `chargePaise`. */
  equipment?: WireEquipmentReceived[];
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

// ── S4a (#1114): the asset passport ──
/** The status words of a tagged unit (spec #1114 "Passport"): each one a word on every screen, never a colour alone. */
export const STORES_ASSET_STATUSES = [
  "in_store", "in_use", "out_repair", "overdue", "under_repair", "withdrawn", "condemned", "disposed", "missing", "written_off", "on_its_way",
] as const;
export type StoresAssetStatus = (typeof STORES_ASSET_STATUSES)[number];
/** A due date's word: OK, Due soon (30 days for warranty and AMC, 15 for calibration), Overdue. */
export type StoresDueWord = "ok" | "due_soon" | "overdue";
export type WireAssetDue = { date: string; word: StoresDueWord };
export type WireAssetNext = { what: "warranty" | "amc" | "calibration"; date: string; word: StoresDueWord };
export type WireAssetEvent = { kind: string; at: string; by: WireTicketPerson; where: string | null; note: string | null };
export type WireAssetPlace = { id: string; code: string; name: string; kind: string };
export type WireAssetPassportFull = {
  access: "full"; tagReplaced: boolean;
  unit: { id: string; tagNo: string; last4: string; name: string; itemId: string; serial: string | null; make: string | null; model: string | null; liveTags: string[]; origin: "grn" | "opening" };
  status: StoresAssetStatus;
  /** On a returnable gate pass: which, why and when it is due back. */
  out: { passId: string; passNo: string; purpose: string; dueBack: string } | null;
  /** An open transfer to another department ("On its way to …"). */
  transfer: { toShelfId: string; toDepartmentName: string; proposedBy: WireTicketPerson } | null;
  place: WireAssetPlace;
  department: { id: string; name: string } | null;
  putToUse: string | null;
  dues: { warranty: WireAssetDue | null; amc: WireAssetDue | null; calibration: WireAssetDue | null };
  next: WireAssetNext | null;
  /** The last five events, newest first. */
  events: WireAssetEvent[];
  device: { id: string; code: string; name: string; status: string } | null;
  /** Three faults in 30 days: "Replace?". */
  replace: boolean;
  /** Only for a holder of `stores.assets.read` (the key is absent otherwise). Null: "Cost unknown". */
  costPaise?: number | null;
  can: {
    reportFault: boolean; addDetails: boolean; transfer: boolean; foundHere: boolean; acceptTransfer: boolean;
    /** S4b (#1114): the HOD or in-charge takes it out of use ("Withdrawn") or back; the HOD or biomedical proposes condemnation. */
    withdraw?: boolean; returnToUse?: boolean; condemn?: boolean;
  };
  /** S4b (#1114): the open (or last) condemnation or loss proposal, its number and its word. */
  condemnation?: { id: string; condNo: string; kind: "condemn" | "loss"; status: StoresCondemnationStatus } | null;
  /** S4b (#1114, decision 18): the regulator the item answers to, and whether its paper is on file. */
  regulatedBy?: "radiation" | "ultrasound" | null;
  regulatorPaper?: boolean;
  /** S4a UX (#1114): who to ask when an act is refused (the department's in-charges, else the materials head). */
  askWho?: string[];
};
/** Another department's unit (decision 18 of the flow): name, tag, whose it is, and Found here. Nothing else. */
export type WireAssetPassportForeign = {
  access: "foreign"; tagReplaced: boolean;
  unit: { id: string; tagNo: string; name: string };
  belongsTo: { departmentId: string | null; departmentName: string };
};
/** The typed last four matched two units: pick one (name · place). */
export type WireAssetChoice = { access: "choose"; matches: { unitId: string; tagNo: string; name: string; place: string }[] };
export type WireAssetPassport = WireAssetPassportFull | WireAssetPassportForeign;
export type WireAssetLookup = WireAssetPassport | WireAssetChoice;
export type WireAssetRegisterRow = {
  unitId: string; tagNo: string; last4: string; name: string; category: string; status: StoresAssetStatus; place: string; department: string | null;
  next: WireAssetNext | null;
};
export type WireAssetDueRow = {
  unitId: string; tagNo: string; name: string; place: string; what: "warranty" | "amc" | "calibration" | "replace"; word: StoresDueWord; date: string | null;
};
export type WireTagLine = {
  grnLineId: string; grnNo: string; itemId: string; itemName: string; qty: number; tagged: number; decision: "tagged" | "counted";
  units: { id: string; tagNo: string; serial: string | null }[];
};
export type WireVerificationRound = {
  roundId: string; department: { id: string; name: string }; startedAt: string; closedAt: string | null; seen: number; expected: number;
  notSeen: { unitId: string; tagNo: string; name: string; place: string }[]; wrongPlace: { unitId: string; tagNo: string; name: string; place: string; seenAt: string }[];
};
export type WireAssetAddition = {
  unitId: string; tagNo: string; name: string; category: string; department: string; putToUse: string; costPaise: number | null; gstPaise: number | null;
  inputCredit: null; grnNo: string; billNo: string | null; billDate: string | null; supplier: string | null;
};
export type WireEquipmentReceived = { unitId: string; tagNo: string; name: string; departmentId: string; departmentName: string; at: string };
export const storesTagUnitsBody = z.object({
  grnLineId: id,
  units: z.array(z.object({ serial: z.string().trim().max(80).nullish(), tagNo: z.string().regex(/^AST\d{10}$/).optional() })).min(1).max(200),
});
export const storesAssetFaultBody = z.object({ text: z.string().trim().min(1).max(200), photoId: id.nullish() });
export const storesAssetRepairBody = z.object({ note: z.string().max(300).nullish() });
export const storesAssetCloseRepairBody = z.object({ outcome: z.enum(["repaired", "not_repairable", "preventive"]), note: z.string().max(300).nullish() });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const storesAssetDetailsBody = z.object({
  warrantyEnd: day.nullish(),
  contract: z.object({ kind: z.enum(["amc", "cmc"]), supplierId: id.nullish(), start: day, end: day, poRef: z.string().max(60).nullish() }).nullish(),
  calibration: z.object({ doneOn: day, dueOn: day, agency: z.string().trim().min(1).max(120), documentId: id.nullish() }).nullish(),
  installedOn: day.nullish(),
});
export const storesAssetDeviceBody = z.object({ deviceId: id });
export const storesAssetFoundBody = z.object({ shelfId: id });
export const storesAssetTransferBody = z.object({ toShelfId: id });
export const storesAssetCodeBody = z.object({ code: z.string().min(4).max(20) });
export const storesAssetVoidBody = z.object({ tagNo: z.string().regex(/^AST\d{10}$/), reason: z.string().trim().min(1).max(200) });
export const storesAssetRetagBody = z.object({ reason: z.string().trim().min(1).max(200), tagNo: z.string().regex(/^AST\d{10}$/).optional() });
export const storesAssetOpenBody = z.object({
  storeId: id, itemId: id, serial: z.string().trim().max(80).nullish(), make: z.string().trim().max(80).nullish(), model: z.string().trim().max(80).nullish(),
  unitCostPaise: z.number().int().min(0).max(10_000_000_000).nullable(), putToUse: day.nullish(), tagNo: z.string().regex(/^AST\d{10}$/).optional(),
});
export const storesAssetCostBody = z.object({ unitCostPaise: z.number().int().min(0).max(10_000_000_000) });
export const storesVerificationStartBody = z.object({ departmentId: id });
export const storesVerificationScanBody = z.object({ code: z.string().min(4).max(20).optional(), unitId: id.optional(), shelfId: id });

// ── S4b (#1114): condemnation, loss, disposal ──
export const STORES_CONDEMNATION_REASONS = ["beyond_repair", "obsolete", "damaged", "lost"] as const;
export type StoresCondemnationReason = (typeof STORES_CONDEMNATION_REASONS)[number];
/** The words of a proposal (spec #1114 "Condemnation"): Pending, Objected, Approved; then Disposed or Written off. */
export type StoresCondemnationStatus = "pending" | "objected" | "approved" | "disposed" | "written_off";
export type StoresCommitteeSeat = "hod" | "accounts" | "materials" | "biomedical";
export type WireCondemnation = {
  id: string; condNo: string; kind: "condemn" | "loss"; reason: StoresCondemnationReason; note: string | null;
  unit: { id: string; tagNo: string; last4: string; name: string; place: string; department: string | null };
  status: StoresCondemnationStatus;
  /** Present only for a holder of `stores.assets.read` or `stores.assets.condemn`. Null: "Cost unknown". */
  costPaise?: number | null;
  /** Whole years since it was put to use (null: not known). */
  ageYears: number | null;
  repairs12m: number;
  holdsData: boolean;
  regulatedBy: "radiation" | "ultrasound" | null;
  regulatorPaper: boolean;
  /** Each seat: who may sign it (names), and the signature or objection once there. */
  seats: { seat: StoresCommitteeSeat; holders: string[]; signed: { by: string; at: string; kind: "sign" | "object"; reason: string | null } | null }[];
  needsOwner: boolean;
  approvals: { ms: { approvalId: string; status: string } | null; owner: { approvalId: string; status: string } | null };
  writeOffId: string | null;
  disposal: { method: "scrap_sale" | "buy_back" | "e_waste"; amountPaise: number; invoiceNo: string; buyer: string; passId: string | null } | null;
  proposedBy: { id: string; name: string }; proposedAt: string;
  can: { sign: boolean; object: boolean; dispose: boolean; writeOff: boolean };
};
export type WireAssetRemoval = {
  unitId: string; tagNo: string; name: string; category: string; condemnationNo: string; reason: StoresCondemnationReason; method: "scrap_sale" | "buy_back" | "e_waste" | "lost";
  amountPaise: number; invoiceNo: string | null; on: string; costPaise: number | null;
};
export const storesCondemnBody = z.object({
  unitId: id, reason: z.enum(STORES_CONDEMNATION_REASONS), note: z.string().trim().max(300).nullish(), holdsData: z.boolean().optional(), replacesId: id.nullish(),
});
export const storesCondemnObjectBody = z.object({ reason: z.string().trim().min(1).max(300) });
export const storesDisposeBody = z.object({
  method: z.enum(["scrap_sale", "buy_back", "e_waste"]), buyerId: id, amountPaise: z.number().int().min(0).max(10_000_000_000),
  invoiceNo: z.string().trim().min(1).max(60), receiptRef: z.string().trim().max(60).nullish(), poRef: z.string().trim().max(60).nullish(),
  certificateNo: z.string().trim().max(60).nullish(), wipeCertificateNo: z.string().trim().max(60).nullish(),
  bids: z.array(z.object({ vendorId: id, amountPaise: z.number().int().min(0).max(10_000_000_000) })).max(10).optional(),
});
export const storesWriteOffLossBody = z.object({ inquiryNo: z.string().trim().min(1).max(60) });
export const storesMarkFoundBody = z.object({ storeId: id });
export const storesRegulatorPaperBody = z.object({ kind: z.enum(["decommission", "transfer", "intimation"]), refNo: z.string().trim().min(1).max(80), documentId: id.nullish() });
export const storesRegulationBody = z.object({ regulatedBy: z.enum(["radiation", "ultrasound"]).nullable() });
export const storesWithdrawBody = z.object({ reason: z.string().trim().min(1).max(200) });


/* ═══════════════════════════════ STORES S5a (#1115): the front of the buying desk ═══════════════════════════════ */

/** Decision 2: One quote (A, ≤ ₹25,000), Three quotes (B, to ₹5 lakh), Committee (C, above, and any medical equipment). */
export type StoresBand = "A" | "B" | "C";
export const STORES_PR_PRIORITIES = ["routine", "urgent", "emergency"] as const;
/** Decision 1: the words S5a can reach. Grouped … Received come with S5b's desk. */
export type StoresPrStatus = "requested" | "approved" | "declined" | "cancelled";
export type StoresPerson = { id: string; name: string };
export type WirePurchaseRequestLine = {
  lineIdx: number; itemId: string; itemCode: string; itemName: string; baseUom: string; qtyBase: number;
  /** Per base unit, paise, before GST, frozen at raise. */
  unitEstimatePaise: number; estimateSource: "contract" | "last" | "requester"; onContract: boolean; equipment: boolean;
  answers: { why: string; replacesTag: string | null; usePerDay: string } | null;
};
export type WirePurchaseRequest = {
  id: string; prNo: string; source: "department" | "central" | "planner" | "copilot"; priority: (typeof STORES_PR_PRIORITIES)[number];
  note: string | null; status: StoresPrStatus;
  department: { id: string; code: string; name: string } | null; shelfId: string | null;
  raisedBy: StoresPerson; raisedAt: string;
  lines: WirePurchaseRequestLine[];
  estimatePaise: number;
  band: StoresBand;
  /** Decision 3: the sum over 30 days crossed a band edge — "Split? / टुकड़े?" and the requests it summed. */
  split: { prIds: string[]; prNos: string[] } | null;
  /** Decision 15, the department's month on the approval sheet; null for a central request. */
  budget: { month: string; pct: number | null; over: boolean; noBudget: boolean } | null;
  stamp: {
    decision: "approved" | "declined" | "cancelled"; by: StoresPerson; at: string; reason: string | null;
    forRole: "hod" | "ms" | "delegate" | "materials" | null; onBehalfOf: StoresPerson | null; overBudget: boolean;
  } | null;
};
export type WireDepartmentBudget = {
  departmentId: string; month: string; budgetPaise: number | null; spentPaise: number; pct: number | null;
  /** S5c (decision 15): the part of `spentPaise` that is Stores POs ordered for the department's requests and not yet delivered. */
  committedPaise: number;
  /** Equipment is budgeted apart (decision 15): band C equipment requests approved in the month. */
  equipment: { requests: { prId: string; prNo: string; estimatePaise: number }[] };
};
export type WireStoresDelegation = {
  id: string; from: StoresPerson; to: StoresPerson; scope: "hod_approval" | "committee_seat"; seat?: string | null; departmentId: string | null; departmentName: string | null;
  fromAt: string; toAt: string; reason: string | null; live: boolean;
};
export type StoresKycLevel = "none" | "can_quote" | "complete";
export type WireSupplierKyc = { level: StoresKycLevel; missing: string[] };
export type WireStoresSupplier = {
  id: string; code: string; name: string; status: string; kyc: WireSupplierKyc; msmeClass: string | null; msmeActivity: string | null;
  einvoiceApplicable: boolean | null; categories: { id: string; name: string }[];
};
export type WireStoresGrnForQc = {
  id: string; grnNo: string; status: string; vendorName: string; challanNo: string; capturedAt: string;
  lines: { itemId: string; itemName: string; qtyBase: number; baseUom: string; unitCostPaise: number; priceFlag: boolean }[];
};
const answersBody = z.object({ why: z.string().trim().min(1).max(200), replacesTag: z.string().trim().max(40).nullish(), usePerDay: z.string().trim().min(1).max(60) });
export const storesPurchaseRequestBody = z.object({
  source: z.enum(["department", "central"]), departmentId: id.nullish(), shelfId: id.nullish(),
  priority: z.enum(STORES_PR_PRIORITIES).default("routine"), note: z.string().trim().max(300).nullish(),
  lines: z.array(z.object({
    itemId: id.nullish(), qtyBase: z.number().int().positive().max(1_000_000), estimatePaise: z.number().int().min(0).max(10_000_000_000).nullish(),
    equipment: answersBody.nullish(),
  })).min(1).max(30),
});
export const storesPrDeclineBody = z.object({ reason: z.string().trim().min(1).max(300) });
export const storesPrBulkBody = z.object({ ids: z.array(id).min(1).max(50) });
export const storesPrBandBody = z.object({ band: z.enum(["A", "B", "C"]), reason: z.string().trim().min(1).max(300) });
export const storesBudgetBody = z.object({
  departmentId: id, month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), amountPaise: z.number().int().min(0).max(100_000_000_000),
  annual: z.boolean().optional(), note: z.string().trim().max(200).nullish(),
});
export const storesDelegationBody = z.object({
  toUserId: id, scope: z.string().min(1).max(40), departmentId: id.nullish(), seat: z.string().min(1).max(40).nullish(), from: z.string().datetime(), to: z.string().datetime(),
  reason: z.string().trim().max(200).nullish(),
});
export const storesSupplierFieldsBody = z.object({
  msmeActivity: z.enum(["maker", "service", "trader"]).nullish(), einvoiceApplicable: z.boolean().nullish(),
  gstUnregisteredReason: z.string().trim().max(200).nullish(), msmeUdyamNo: z.string().trim().max(32).nullish(),
  msmeClass: z.enum(["micro", "small", "medium"]).nullish(),
});
export const storesSupplierCategoryBody = z.object({ categoryId: id });

/* ═══════════════════════════ STORES S5b (#1115): the buying desk by hand ═══════════════════════════ */

/** Spec "Buying desk": the status words of a request on the desk, derived (never stored). */
export type StoresBuyStage = "requested" | "approved" | "grouped" | "quoting" | "compared" | "awarded" | "ordered" | "received" | "declined" | "cancelled";
export type WireBuyLine = { prId: string; lineIdx: number; itemId: string; itemName: string; qtyBase: number; baseUom: string; estimatePaise: number; groupId: string | null };
export type WireBuyRow = {
  prId: string; prNo: string; priority: (typeof STORES_PR_PRIORITIES)[number]; department: { id: string; code: string; name: string } | null;
  band: StoresBand; estimatePaise: number; status: StoresBuyStage; lines: WireBuyLine[];
};
export type WireBuyGroup = {
  id: string; label: string | null; band: StoresBand; estimatePaise: number; equipment: boolean;
  /** Decision 3: one of its requests was summed over 30 days across a band edge — "Split? / टुकड़े?". */
  split: boolean; status: StoresBuyStage; lines: WireBuyLine[]; rfqId: string | null; awardId: string | null; quotes: number; createdAt: string;
};
export type StoresRfqStatus = "drafted" | "sent" | "compared" | "awarded" | "closed";
export type StoresRfqChannel = "email" | "print" | "hand";
export type WireRfq = {
  id: string; rfqNo: string; groupId: string; band: StoresBand; equipment: boolean; status: StoresRfqStatus; replyBy: string; deliveryDate: string | null;
  invitees: { vendorId: string; name: string; kyc: StoresKycLevel; quoted: boolean }[];
  lines: { itemId: string; itemName: string; qtyBase: number; baseUom: string }[];
  sent: { by: StoresPerson; at: string; channel: StoresRfqChannel; vendorIds: string[] } | null;
  received: number;
};
export type StoresQuoteKind = "quote" | "revised" | "negotiated";
export type WireQuote = {
  id: string; groupId: string; rfqId: string | null; vendorId: string; version: number; kind: StoresQuoteKind; late: boolean; enteredAt: string;
  supplierRef: string | null; freightPaise: number; otherPaise: number;
  lines: { itemId: string; qtyBase: number; ratePaise: number; discountBps: number; gstRateBps: number }[];
};
export type WireCmpTotals = {
  grossPaise: number; discountPaise: number; taxablePaise: number; gstPaise: number; freightPaise: number; otherPaise: number; beforeGstPaise: number; landedPaise: number;
};
export type WireCmpSupplier = {
  vendorId: string; name: string; quoteId: string; version: number; kind: StoresQuoteKind; late: boolean; admitted: boolean;
  /** Equipment only: both marks yes, any no, or still waiting; null for anything else. */
  technical: "yes" | "no" | "pending" | null;
  /** L1 = 1 on the whole, among those ranked (quoted every line, compliant, not late unless admitted); null when out of the ranks. */
  wholeRank: number | null;
  paymentTermsDays: number | null; deliveryDays: number | null; warrantyMonths: number | null; totals: WireCmpTotals;
};
export type WireCmpLine = {
  itemId: string; itemName: string; baseUom: string; qtyBase: number;
  cells: { vendorId: string; ratePaise: number; discountPaise: number; taxablePaise: number; gstPaise: number; freightPaise: number; otherPaise: number; landedPaise: number; rank: number | null }[];
};
export type WireComparative = {
  rfqId: string; rfqNo: string; band: StoresBand; equipment: boolean;
  /** Decision 7: until the reply-by instant or every invitee has quoted, only "n of m received". */
  sealed: boolean; received: number; invited: number; replyBy: string;
  /** Bands B/C with fewer than three quotes in the ranks: "Re-invite / फिर बुलाएँ". */
  reinvite: boolean;
  suppliers: WireCmpSupplier[]; lines: WireCmpLine[];
};
export type StoresAwardStatus = "proposed" | "approved" | "sent_back";
export type StoresSeat = "buyer" | "materials_head" | "accounts_head" | "medical_superintendent" | "user_hod" | "biomedical" | "owner";
export type WireAward = {
  id: string; rfqId: string | null; rfqNo: string | null; groupId: string; band: StoresBand; equipment: boolean; status: StoresAwardStatus;
  reason: string | null; proposedBy: StoresPerson; proposedAt: string; totalPaise: number;
  lines: { itemId: string; itemName: string; qtyBase: number; vendorId: string; vendorName: string; ratePaise: number; landedPaise: number; rank: number | null }[];
  seats: { seat: StoresSeat; holders: StoresPerson[]; signedBy: StoresPerson | null; onBehalfOf: StoresPerson | null; at: string | null; kind: "approve" | "sign" | "object" | null }[];
  ownerSigned: boolean;
  /** The reader's own seat on this award, when they hold one (or act for one), and whether they may sign now. */
  mine: { seat: StoresSeat; canSign: boolean } | null;
  poIds: string[];
};
export type WireStoresPoRow = {
  id: string; poNo: string; status: string; vendorName: string; totalPaise: number; tier: "head" | "owner" | null; awardId: string | null; createdAt: string;
};
export type WireStoresPoSheet = {
  poId: string; poNo: string; status: string; tier: "head" | "owner" | null; totalPaise: number; vendorName: string; band: StoresBand | null; rank: number | null;
  reason: string | null; awardId: string | null; awardStatus: StoresAwardStatus | null;
  /** The reader holds this PO's tier; `canApproveBoth`: also the award's approval, so one tap writes both stamps. */
  canApprove: boolean; canApproveBoth: boolean;
  /** S5c (decision 11): "Pay after GRN", or the owner-approved advance on an equipment PO; the advance row when there is one. */
  payTerms: WirePayTerms; advance: WirePoAdvance | null;
};
export type WireBuyingDesk = {
  can: { buy: boolean; approveAward: boolean; owner: boolean };
  buyNow: WireBuyRow[]; groupable: WireBuyRow[]; groups: WireBuyGroup[]; rfqs: WireRfq[]; awards: WireAward[]; pos: WireStoresPoRow[];
  /** S5c: the agent's open drafts (night grouping, RFQ and PO drafts, quotes read from PDFs) and the single-source / emergency purchases. */
  proposals: WireAgentProposal[]; exceptions: WireBuyException[];
};
const lineRef = z.object({ prId: id, lineIdx: z.number().int().min(0).max(100) });
export const storesGroupBody = z.object({ lines: z.array(lineRef).min(1).max(100), label: z.string().trim().max(80).nullish() });
export const storesGroupMoveBody = lineRef.extend({ toGroupId: id.nullable() });
const quoteLineBody = z.object({
  itemId: id, qtyBase: z.number().int().positive().max(1_000_000).nullish(), ratePaise: z.number().int().min(0).max(1_000_000_000),
  discountBps: z.number().int().min(0).max(10_000).nullish(), gstRateBps: z.number().int().min(0).max(2_800).nullish(),
});
export const storesQuoteBody = z.object({
  groupId: id.nullish(), rfqId: id.nullish(), vendorId: id, supplierRef: z.string().trim().max(60).nullish(), lines: z.array(quoteLineBody).min(1).max(100),
  freightPaise: z.number().int().min(0).max(100_000_000).nullish(), otherPaise: z.number().int().min(0).max(100_000_000).nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).nullish(), deliveryDays: z.number().int().min(0).max(365).nullish(),
  warrantyMonths: z.number().int().min(0).max(240).nullish(),
});
export const storesRfqBody = z.object({
  groupId: id, replyBy: z.string().datetime(), deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), vendorIds: z.array(id).max(20).nullish(),
  note: z.string().trim().max(300).nullish(),
});
export const storesRfqInviteBody = z.object({ vendorIds: z.array(id).min(1).max(20) });
export const storesRfqSendBody = z.object({ channel: z.enum(["email", "print", "hand"]) });
export const storesReasonBody = z.object({ reason: z.string().trim().min(1).max(300) });
export const storesReplyByBody = z.object({ replyBy: z.string().datetime(), reason: z.string().trim().min(1).max(300) });
export const storesTechnicalBody = z.object({ vendorId: id, compliant: z.boolean(), reason: z.string().trim().max(300).nullish() });
export const storesAwardBody = z.object({
  rfqId: id, vendorId: id.nullish(), lines: z.array(z.object({ itemId: id, vendorId: id })).max(100).nullish(), reason: z.string().trim().max(300).nullish(),
});
export const storesMakePoBody = z.object({ reason: z.string().trim().max(300).nullish() });
export const storesSeatBody = z.object({
  seat: z.enum(["materials_head", "accounts_head", "medical_superintendent", "biomedical"]), userId: id, from: z.string().datetime(), to: z.string().datetime().nullish(),
});
export const storesBulkBody = z.object({ kind: z.enum(["po", "pr", "award"]), ids: z.array(id).min(1).max(50) });

/* ═══════════════════════════ STORES S5c (#1115): the buyer agent, the scorecard, exceptions, advances ═══════════════════════════ */

export type StoresAgentProposalKind = "grouping" | "rfq_draft" | "quote_read" | "po_draft";
export type StoresAgentProposalStatus = "open" | "confirmed" | "dismissed" | "superseded";
/**
 * One line of an agent's draft. A grouping or PO draft names request lines (`prId`, `lineIdx`); a quote read names the
 * RFQ's items, each number with the page and the line of the PDF it was read from (`source`; null = not found, typed by
 * the buyer). `state`: still a draft, or what the person did with it.
 */
export type WireAgentLine = {
  lineIdx: number; prId: string | null; itemId: string; itemName: string; qtyBase: number; baseUom: string; estimatePaise: number | null;
  vendorId: string | null; ratePaise: number | null; discountBps: number | null; gstRateBps: number | null;
  source: { page: number; text: string } | null; state: "draft" | "confirmed" | "dropped";
};
export type WireAgentSupplier = {
  vendorId: string; name: string; kyc: StoresKycLevel; missing: string[]; approvedForCategory: boolean; score: number | null; suppliedBefore: boolean; suggested: boolean;
};
export type WireAgentProposal = {
  id: string; kind: StoresAgentProposalKind; status: StoresAgentProposalStatus; madeAt: string; byAgent: boolean;
  label: string | null; band: StoresBand | null; estimatePaise: number | null;
  departments: { id: string | null; name: string }[];
  groupId: string | null; rfqId: string | null; vendorId: string | null; vendorName: string | null;
  lines: WireAgentLine[];
  /** RFQ draft: the suppliers it suggests, best first; reply-by and delivery date it proposes. */
  suppliers: WireAgentSupplier[]; replyBy: string | null; deliveryDate: string | null;
  /** Quote read: whether the PDF had readable text, and which reader read it (`model` or the rules when the model is off). */
  readable: boolean | null; reader: "model" | "rules" | null; hasDocument: boolean;
  closed: { kind: StoresAgentProposalStatus; by: StoresPerson; at: string; resultRowId: string | null } | null;
};
export type WireShare = { num: number; den: number };
export type WireSupplierScorecard = {
  vendorId: string; name: string; quarter: string; from: string; to: string;
  onTime: WireShare; fill: WireShare; rejected: WireShare; priceDriftBps: number | null; rfqResponse: WireShare;
  /** For ordering only (suggestions, ties); never a grade on screen. */
  score: number | null;
};
export type StoresBuyExceptionKind = "single_source" | "emergency";
export type StoresBuyExceptionStatus = "waiting_certificate" | "waiting_approval" | "approved" | "confirmed" | "overdue" | "refused";
export type WireBuyException = {
  id: string; kind: StoresBuyExceptionKind; groupId: string; vendorId: string; vendorName: string; reason: string; valuePaise: number;
  needsOwner: boolean; status: StoresBuyExceptionStatus; raisedBy: StoresPerson; raisedAt: string;
  steps: { kind: "certified" | "approved" | "confirmed" | "refused"; asRole: string; by: StoresPerson; at: string; reason: string | null }[];
  /** Emergency: the owner confirms by this instant (approval + 72 h). */
  confirmBy: string | null;
  /** What the reader may do now. */
  mine: "certify" | "approve" | "confirm" | null;
};
export type StoresAdvanceStatus = "requested" | "approved" | "refused";
export type WirePoAdvance = {
  id: string; poId: string; pctBps: number; amountPaise: number; guaranteeNo: string; guaranteeBank: string; guaranteeValidTo: string; guaranteePaise: number;
  status: StoresAdvanceStatus; requestedBy: StoresPerson; requestedAt: string; decidedBy: StoresPerson | null; decidedAt: string | null; reason: string | null;
};
/** Decision 11: derived, never stored. */
export type WirePayTerms = { kind: "after_grn" } | { kind: "advance"; pctBps: number; amountPaise: number; advanceId: string };
export type WireOverBudgetMonth = {
  month: string;
  departments: {
    departmentId: string; code: string; name: string; budgetPaise: number; spentPaise: number; committedPaise: number; pct: number;
    marks: { refType: "ticket" | "pr"; refId: string; no: string; at: string }[];
  }[];
};
export const storesRfqDraftConfirmBody = z.object({
  vendorIds: z.array(id).min(1).max(20), replyBy: z.string().datetime().nullish(), deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
export const storesQuoteReadBody = z.object({
  rfqId: id.nullish(), groupId: id.nullish(), vendorId: id, pdfBase64: z.string().min(8).max(990_000),
});
export const storesQuoteLineConfirmBody = z.object({
  lineIdx: z.number().int().min(0).max(100), drop: z.boolean().optional(), ratePaise: z.number().int().min(0).max(1_000_000_000).nullish(),
  discountBps: z.number().int().min(0).max(10_000).nullish(), gstRateBps: z.number().int().min(0).max(2_800).nullish(),
});
export const storesBuyExceptionBody = z.object({
  kind: z.enum(["single_source", "emergency"]), groupId: id, vendorId: id, reason: z.string().trim().min(1).max(300),
});
export const storesAdvanceBody = z.object({
  pctBps: z.number().int().min(1).max(3000), guaranteeNo: z.string().trim().min(1).max(60), guaranteeBank: z.string().trim().min(1).max(120),
  guaranteeValidTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), guaranteePaise: z.number().int().min(1).max(100_000_000_000),
});
export const storesDecideBody = z.object({ approve: z.boolean(), reason: z.string().trim().max(300).nullish() });
