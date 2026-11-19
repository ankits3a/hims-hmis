/**
 * STORES S1 (#1111) — the module's public shapes, in one place so the controller, the contracts and the
 * screens read one definition.
 */

/** Decision 4: how a Stores item is kept at a department. `tagged` arrives with S4 (#1114). */
export type TrackMode = "expensed" | "shelf" | "durable";
export const TRACK_MODES: readonly TrackMode[] = ["expensed", "shelf", "durable"];

/**
 * Decision 2: the classes Stores registers. `drug` (pharmacy) and `implant` (patient-billable, ruling
 * 0099 Q1) are refused; linen, uniforms and kitchen dry stock are Stores items (Q5).
 */
export const STORES_ITEM_CLASSES = [
  "consumable", "consumable_dated", "stationery", "asset", "service", "reagent", "gas", "linen",
] as const;
export type StoresItemClass = (typeof STORES_ITEM_CLASSES)[number];

/** Decision 6: what a Stores store is. Every one carries `attributes.domain = 'stores'`. */
export type StoresStoreKind = "central" | "sub" | "night" | "shelf";

export type CategoryRow = { id: string; code: string; name: string; nameHi: string | null; parentId: string | null; active: boolean };

export type StoresItemView = {
  id: string; code: string; name: string; class: string; baseUom: string;
  categoryId: string | null; categoryName: string | null; trackMode: TrackMode;
  searchAliases: string[]; active: boolean;
  /** The issue pack (the unit marked `is_issue_uom` with the largest multiplier), for the reorder rounding. */
  issuePack: { uom: string; multiplier: number };
};

export type RegisterStoresItemInput = {
  code: string;
  name: string;
  class: string;
  baseUom: string;
  categoryId: string | null;
  trackMode: TrackMode | null;
  searchAliases?: string[];
  patientBillable?: boolean;
  /** One more unit the item is issued in (a box of 10), beyond the base. */
  issuePack?: { uom: string; multiplier: number } | null;
  hsnCode?: string | null;
  gstRateBps?: number | null;
};

export type StoresImportRow = {
  code: string; name: string; class: string; baseUom: string;
  /** The category's CODE, as a sheet carries it. */
  category: string;
  trackMode: string;
  /** Aliases separated by `;`. */
  aliases?: string | null;
};
export type ImportRefusal = { row: number; code: string; message: string };
export type ImportResult = { dryRun: boolean; created: number; wouldCreate: number; refusals: ImportRefusal[] };

export type ItemRequestView = {
  id: string; name: string; note: string | null; status: "open" | "created" | "use_existing";
  requestedBy: string; shelfId: string | null; departmentId: string | null;
  resolvedItemId: string | null; createdAt: string;
  /** The duplicate finder's guesses (decision 5): existing items whose name is close. */
  similar: { itemId: string; code: string; name: string }[];
};

export type StoresStoreView = {
  id: string; code: string; name: string; kind: StoresStoreKind; parentId: string | null;
  departmentId: string | null; suppliedBy: string | null; custodianRoles: string[];
};

export type ShelfSummary = StoresStoreView & { departmentCode: string | null; departmentName: string | null; floorName: string | null };

export type ShelfStatusWord = "ok" | "low" | "out";

export type ShelfItemView = {
  itemId: string; code: string; name: string; baseUom: string; trackMode: TrackMode;
  onHand: number; status: ShelfStatusWord;
  par: { minBase: number; reorderBase: number; maxBase: number } | null;
  lastCheckAt: string | null;
  /** Use per day over the last 30 days (decision 13). */
  usePerDay30: number;
  /** Use per OPD visit over the last 30 days; null for a department with no OPD clinic or no visits. */
  usePerOpdVisit: number | null;
  /** Use per occupied bed-day; null while IPD is off production (owner 2026-10-13). */
  usePerBedDay: number | null;
};

export type ArrivingTransfer = { transferId: string; fromName: string; issuedAt: string; lines: { lineId: string; itemId: string; name: string; qty: number }[] };

export type ShelfView = {
  shelf: ShelfSummary;
  /** Department staff see no money (decision 14). No figure on this view is a price. */
  items: ShelfItemView[];
  arriving: ArrivingTransfer[];
  /** What this viewer may do here: the screen hides what the server would refuse. */
  may: { work: boolean };
};

export type ReorderDraftLine = { itemId: string; code: string; name: string; onHand: number; proposed: number; packUom: string; packSize: number };

export type CheckResult = {
  checkId: string;
  used: { itemId: string; qty: number }[];
  overBook: { itemId: string; book: number; counted: number }[];
  /** `durable` items counted short: not posted as use (they leave only by return or condemnation, S4). */
  shortDurable: { itemId: string; book: number; counted: number }[];
};

export type OverBookCard = { cardId: string; shelfId: string; shelfName: string; checkId: string; at: string; lines: { itemId: string; name: string; book: number; counted: number }[] };

// ═══════════════════════════ S2a (#1112) — tickets, approval, picking, timeline, audit pack ═══════════════════════════

/** Decision 2: routine (within the shift), urgent (≤ 60 min after approval), emergency (≤ 20 min from raise, with a reason). */
export type TicketPriority = "routine" | "urgent" | "emergency";
export const TICKET_PRIORITIES: readonly TicketPriority[] = ["routine", "urgent", "emergency"];
/** Decision 1: how the ticket was raised. */
export type TicketChannel = "phone" | "web" | "copilot" | "agent";
export const TICKET_CHANNELS: readonly TicketChannel[] = ["phone", "web", "copilot", "agent"];

/**
 * Where a ticket is, DERIVED from rows (decision 13: nothing about a ticket's lane is stored).
 *   to_approve — raised, the HOD has not answered (an emergency is also on "To pick" meanwhile);
 *   to_pick    — approved (or an emergency), not yet issued;
 *   to_receive — issued, the transfer is still in transit;
 *   delivered  — the transfer was received (fully or with a discrepancy);
 *   declined   — the HOD said no; rejected — the store said no; cancelled — the requester withdrew.
 */
/** S2b adds `returning` (the porter is bringing it back undelivered) and `returned` ("Returned undelivered"). */
export type TicketStage = "to_approve" | "to_pick" | "to_receive" | "delivered" | "declined" | "rejected" | "cancelled" | "returning" | "returned";

export type RaiseTicketInput = {
  shelfId: string;
  /** `itemId` is typed loosely on purpose: a line with no item id is a refusal (`item_id_required`), not a crash. */
  lines: { itemId?: string | null; qtyBase: number }[];
  priority: TicketPriority;
  neededBy?: string | null;
  deliverTo?: string | null;
  channel?: TicketChannel;
  emergencyReason?: string | null;
  note?: string | null;
};

export type ApproveTicketInput = { lines?: { lineIdx: number; qtyBase: number }[] };

export type TicketPerson = { id: string; name: string };

export type TicketView = {
  id: string;
  indentNo: string;
  /** The materials indent's own status (`requested` | `issued` | `rejected` | `cancelled`). */
  status: string;
  stage: TicketStage;
  priority: TicketPriority;
  channel: TicketChannel;
  neededBy: string | null;
  deliverTo: string | null;
  emergencyReason: string | null;
  /** Raised outside the central store's hours and addressed to the night store (decision 5). */
  night: boolean;
  department: { id: string; code: string; name: string };
  shelf: { id: string; code: string; name: string };
  /** The supplying store. */
  source: { id: string; code: string; name: string; kind: StoresStoreKind };
  requestedBy: TicketPerson;
  requestedAt: string;
  /** The clock: the first raise of a re-raised or re-asked ticket, else this one's raise. */
  clockFrom: string;
  origin: { indentId: string; indentNo: string; kind: "re_raise" | "re_ask" } | null;
  approval: {
    state: "pending" | "approved" | "declined" | "not_needed";
    by: TicketPerson | null; at: string | null;
    /** The medical superintendent's stand-in approval (decision 3): the timeline reads "for HOD". */
    forHod: boolean;
    reason: string | null;
  };
  /** Decision 4: the HOD's look at an emergency issued before approval. */
  review: { decision: "agree" | "query"; by: TicketPerson; at: string; note: string | null } | null;
  /** Decision 6: the one picker, while the claim is live (30 idle minutes). */
  claim: { by: TicketPerson; at: string; lapsesAt: string } | null;
  transfer: { id: string; status: string } | null;
  lines: { lineIdx: number; itemId: string; itemCode: string; itemName: string; baseUom: string; qtyBase: number; qtyApproved: number | null; qtyIssued: number | null }[];
  /** S2b (decision 7): whose hands it is in, once issued. `holder` is null once the chain closed (delivered or returned). */
  custody: TicketCustody | null;
  /** S2b (decision 8): the receiver's per-line answer, once delivered. */
  delivery: TicketDelivery | null;
  /** S2b (decision 9): short quantities still in IN-TRANSIT, each against the last custodian, and their resolution. */
  shorts: TicketShort[];
};

export type TicketCustody = {
  holder: TicketPerson | null;
  /** Carrier legs: takes, hand-offs and take-overs (zero for a counter collection). */
  legs: number;
  /** The last person on the chain before the receiver (the issuer when nobody carried it). */
  lastCustodian: TicketPerson;
};

export type DeliveryOutcome = { lineIdx: number; itemId: string; accepted: number; short: number; wrong: number; damaged: number };

export type TicketDelivery = {
  by: TicketPerson; at: string;
  /** No carrier leg: "Collected at store". */
  atCounter: boolean;
  lines: DeliveryOutcome[];
  /** Wrong + damaged quantities going back to the source, and whether the source keeper has taken them. */
  sentBack: number; sentBackAccepted: boolean;
};

export type ShortResolution = "found" | "returned" | "lost";

export type TicketShort = {
  lineIdx: number; itemId: string; qty: number;
  /** The last custodian on the chain: whose hands the short quantity was in. */
  with: TicketPerson;
  resolution: { kind: ShortResolution; by: TicketPerson; at: string; approvalId: string | null; posted: boolean } | null;
};

/** A scan from a phone: the label's ticket number (or its last four digits), a client idempotency key and the scan time. */
export type ScanInput = { code: string; clientKey?: string | null; scannedAt?: string | null };

export type DeliverLineInput = { lineIdx: number; accepted?: number; short?: number; wrong?: number; damaged?: number };
export type DeliverInput = { lines?: DeliverLineInput[]; clientKey?: string | null; scannedAt?: string | null };

/** Decision 14: a scan older than 12 h is accepted and flagged; one in the future is stored at server time and flagged. */
export type ScanFlag = "late" | "future";

export type CustodyLookup = { ticket: TicketView; act: "take" | "hand_over"; holder: TicketPerson };

export type CustodyResult = { ticket: TicketView; duplicate: boolean; flag: ScanFlag | null };

export type ReturnReason = "unused" | "wrong" | "defective";
export type RaiseReturnInput = { shelfId: string; lines: { itemId: string; qtyBase: number; reason: ReturnReason }[]; note?: string | null };
export type ReturnTicketView = {
  transferId: string; status: string; shelf: { id: string; code: string; name: string }; to: { id: string; code: string; name: string };
  quarantine: boolean; raisedBy: TicketPerson; raisedAt: string;
  lines: { itemId: string; itemName: string; qtyBase: number }[];
};

export type PorterCardRow = { ticket: TicketView; from: { id: string; code: string; name: string }; to: { id: string; code: string; name: string }; minutes: number };

export type LateScan = { handoffId: string; indentId: string; indentNo: string; kind: string; by: TicketPerson; phoneAt: string; recordedAt: string; flag: ScanFlag };

export type TimelineStepKind =
  | "raise" | "re_raise" | "re_ask" | "approve" | "decline" | "review" | "claim" | "issue" | "receive" | "reject" | "cancel"
  // S2b: the custody chain, the receipt (carried or collected), what went back and how each short ended.
  | "take" | "hand_over" | "take_over" | "deliver" | "collect" | "send_back" | "return_undelivered" | "return_accepted" | "found" | "returned" | "lost";

export type TimelineStep = {
  step: TimelineStepKind;
  who: { id: string; name: string; roles: string[] } | null;
  from: { id: string; code: string; name: string } | null;
  to: { id: string; code: string; name: string } | null;
  at: string;
  /** Minutes since the step before (the leg); null on the first step. */
  minutes: number | null;
  /** The medical superintendent approved as the HOD's stand-in: the row reads "for HOD". */
  forHod: boolean;
  note: string | null;
  /** Per line, where the step changed a quantity: asked → approved, approved → issued. */
  lines: { itemId: string; itemName: string; asked: number; approved: number | null; issued: number | null }[];
  /** S2b (D22): a scan whose phone time and server time differ by more than 5 minutes shows both ("Synced late"). */
  phoneAt?: string | null;
  recordedAt?: string | null;
};

export type TicketTimeline = { indentId: string; indentNo: string; steps: TimelineStep[] };

export type AuditPackFilter = {
  ticketId?: string; itemId?: string; personId?: string; storeId?: string; from: Date; to: Date;
  /** The next page: rows with `seq` above this (the previous pack's `nextAfterSeq`). */
  afterSeq?: number;
  /** Rows per pack, at most `AUDIT_PACK_MAX_ROWS`. */
  limit?: number;
};

export type AuditPackRow = {
  seq: number;
  at: string;
  /** `stores.act_recorded`'s act, or the materials event's name (`material.issued`, `material.indent_raised`, …). */
  what: string;
  actor: { id: string; name: string; roles: string[] };
  storeId: string | null;
  itemId: string | null;
  ref: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
};

export type AuditPack = { filter: { ticketId: string | null; itemId: string | null; personId: string | null; storeId: string | null; from: string; to: string }; rows: AuditPackRow[]; csv: string;
  /** More rows matched than one pack holds: ask again with `afterSeq = nextAfterSeq`. The CSV says so on its last line. */
  truncated: boolean; nextAfterSeq: number | null };

// ── S2c (#1119): gate passes ──
export type GatePassKind = "returnable" | "non_returnable";
export type GatePassPurpose = "repair" | "calibration" | "refill" | "loan";
export type GatePassRefType = "supplier_return" | "write_off";
/** Derived from the gate log, never stored: not out yet, out, out past its due-back day, all back, or closed. */
export type GatePassStatus = "raised" | "out" | "overdue" | "back" | "closed";

export type RaiseGatePassInput =
  | { kind: "returnable"; storeId: string; purpose: GatePassPurpose; party: string; dueBack: string; lines: { itemId: string; qty: number }[]; note?: string | null }
  | { kind: "non_returnable"; refType?: GatePassRefType | null; refId?: string | null; note?: string | null };

export type GatePassScanInput = {
  code: string; act: "exit" | "entry"; lines?: { itemId: string; qty: number }[]; clientKey?: string | null; scannedAt?: string | null;
};

export type GatePassView = {
  id: string; passNo: string; kind: GatePassKind; purpose: GatePassPurpose | null; party: string; dueBack: string | null;
  status: GatePassStatus;
  store: { id: string; code: string; name: string };
  ref: { type: GatePassRefType; id: string; no: string } | null;
  note: string | null;
  /** `qty` on the pass; `out` still outside (read off the ledger at OUT-ON-PASS); `back` returned. */
  lines: { itemId: string; itemCode: string; itemName: string; baseUom: string; qty: number; out: number; back: number }[];
  raisedBy: TicketPerson; raisedAt: string;
  scans: { kind: "exit" | "entry" | "close"; by: TicketPerson; at: string; recordedAt: string; phoneAt: string | null; flag: ScanFlag | null; reason: string | null; lines: { itemId: string; qty: number }[] }[];
};

export type GatePassLookup = { pass: GatePassView; act: "exit" | "entry" };
export type GatePassScanResult = { pass: GatePassView; duplicate: boolean; flag: ScanFlag | null };

/** A dispatched supplier return or a posted write-off with no live pass yet: what a non-returnable pass may stand on. */
export type GatePassSource = {
  type: GatePassRefType; id: string; no: string; party: string; store: { id: string; code: string; name: string }; at: string;
  lines: { itemId: string; itemName: string; qty: number }[];
};
