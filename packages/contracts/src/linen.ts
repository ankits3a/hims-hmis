import { z } from "zod";

/**
 * E2.4 LINEN (issue #728, decision 0072, spec SPEC-ipd-companions §5) — the shared shape of the linen module: the item
 * catalogue, par stock per ward, the append-only movement ledger (store → ward → soiled room → laundry → store),
 * infected linen as its own count and its own laundry batch, laundry short deliveries, condemnation with a second
 * person's approval, ward counts, and the weekly loss variance.
 *
 * No money anywhere in this module (vendor billing is out of scope) and no patient identity: linen belongs to a ward.
 * The server parses every intent's input with these schemas; the web reads only the TYPES and the refusal codes.
 */

/** The standard catalogue a new hospital starts with (DECIDED; editable rows in `linen_items`). */
export const LINEN_STANDARD_ITEMS = [
  { code: "bedsheet", name: "Bedsheet", unitsPerSet: 1, sort: 1 },
  { code: "draw_sheet", name: "Draw sheet", unitsPerSet: 1, sort: 2 },
  { code: "pillow_cover", name: "Pillow cover", unitsPerSet: 1, sort: 3 },
  { code: "blanket", name: "Blanket", unitsPerSet: 1, sort: 4 },
  { code: "patient_gown", name: "Patient gown", unitsPerSet: 1, sort: 5 },
  { code: "towel", name: "Towel", unitsPerSet: 1, sort: 6 },
  // Theatre linen is not in a ward bed's set: a ward's computed par for these is 0 unless the supervisor sets one.
  { code: "ot_gown", name: "OT gown", unitsPerSet: 0, sort: 7 },
  { code: "ot_drape", name: "OT drape", unitsPerSet: 0, sort: 8 },
] as const;

/**
 * Sets per bed, by bed class (DECIDED, standard Indian corporate-hospital / NABH practice: one set on the bed, one in
 * the laundry, one in the ward store; private rooms and critical care change more often and hold more).
 * Classes are the IPD bed classes (`attributes.class` on a bed resource); any class not named here is a general bed.
 */
export const LINEN_SETS_PER_BED: Readonly<Record<string, number>> = {
  general: 3, semi_private: 3, overflow: 3, ldr: 3, daycare: 3, emergency: 3,
  private: 4, deluxe: 4, suite: 4,
  hdu: 5, icu: 5, nicu: 5, picu: 5,
};
export const LINEN_DEFAULT_SETS_PER_BED = 3;

/** The sets per bed for a class, falling back to a general bed for a missing or unknown class. */
export function linenSetsPerBed(cls: unknown): number {
  return typeof cls === "string" && cls in LINEN_SETS_PER_BED ? LINEN_SETS_PER_BED[cls]! : LINEN_DEFAULT_SETS_PER_BED;
}

export const LINEN_MOVEMENT_KINDS = [
  "issue_to_ward", "return_soiled", "return_infected", "laundry_out", "laundry_in", "condemn", "transfer_between_wards",
] as const;
export type LinenMovementKind = (typeof LINEN_MOVEMENT_KINDS)[number];

export const LINEN_SOURCES = ["person", "device", "copilot_draft", "agent", "import", "system"] as const;
export type LinenSource = (typeof LINEN_SOURCES)[number];

export const LINEN_BATCH_STATES = ["sent", "received", "short"] as const;
export type LinenBatchState = (typeof LINEN_BATCH_STATES)[number];
export const LINEN_CONDEMN_STATES = ["requested", "approved", "rejected"] as const;
export type LinenCondemnState = (typeof LINEN_CONDEMN_STATES)[number];
export const LINEN_CHANGE_REASONS = ["admission", "discharge", "transfer", "soiled", "daily"] as const;
export type LinenChangeReason = (typeof LINEN_CHANGE_REASONS)[number];

const id = z.string().min(1).max(64);
const itemCode = z.string().trim().min(2).max(40);
/** Pieces of one item in one act. A ward of 60 beds at five sets is 300; 5000 is a ceiling no act reaches. */
const pieces = z.number().int().positive().max(5000);
const count = z.number().int().min(0).max(5000);
const key = z.string().trim().min(8).max(64);
const line = z.object({ itemCode, qty: pieces }).strict();
const lines = z.array(line).min(1).max(20);
const countLines = z.array(z.object({ itemCode, qty: count }).strict()).min(1).max(20);

/** Store → ward, up to par. No lines: every item to its par. Lines: those pieces (refused above par). */
export const topUpWardInput = z.object({ wardId: id, lines: lines.optional(), idempotencyKey: key.optional() }).strict();
export type TopUpWardInput = z.infer<typeof topUpWardInput>;

/** Ward → soiled room: soiled linen in the ordinary bag, or infected linen in its own marked bag. */
export const recordSoiledInput = z.object({ wardId: id, lines, idempotencyKey: key.optional() }).strict();
export type RecordSoiledInput = z.infer<typeof recordSoiledInput>;

/** One laundry batch: ordinary or infected, never both (washed separately). */
export const sendToLaundryInput = z.object({
  infected: z.boolean(),
  lines,
  /** The laundry's own name as on its challan — free text, not a staff record. */
  vendorName: z.string().trim().max(80).optional(),
  idempotencyKey: key.optional(),
}).strict();
export type SendToLaundryInput = z.infer<typeof sendToLaundryInput>;

/** What came back for a batch, per item. An item of the batch left out came back as 0. */
export const receiveFromLaundryInput = z.object({ batchId: id, lines: countLines }).strict();
export type ReceiveFromLaundryInput = z.infer<typeof receiveFromLaundryInput>;

export const borrowBetweenWardsInput = z.object({
  fromWardId: id, toWardId: id, lines, idempotencyKey: key.optional(),
}).strict();
export type BorrowBetweenWardsInput = z.infer<typeof borrowBetweenWardsInput>;

/** Torn, stained beyond washing, burnt: written off only when a second person approves. `wardId` null = the store. */
export const requestCondemnInput = z.object({
  wardId: id.nullable().optional(),
  itemCode,
  qty: pieces,
  reason: z.string().trim().min(3).max(200),
}).strict();
export type RequestCondemnInput = z.infer<typeof requestCondemnInput>;

export const decideCondemnInput = z.object({ requestId: id, note: z.string().trim().max(200).optional() }).strict();
export type DecideCondemnInput = z.infer<typeof decideCondemnInput>;

/** The ward's own count of what is on its shelves, per item. */
export const recordWardCountInput = z.object({ wardId: id, lines: countLines, idempotencyKey: key.optional() }).strict();
export type RecordWardCountInput = z.infer<typeof recordWardCountInput>;

/** A par set by the supervisor; `par: null` goes back to the computed par. */
export const setParLevelInput = z.object({ wardId: id, itemCode, par: count.nullable() }).strict();
export type SetParLevelInput = z.infer<typeof setParLevelInput>;

export const linenVarianceQuery = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
}).strict().refine((v) => Date.parse(v.from) < Date.parse(v.to), { message: "from must be before to" });

/** Every refusal: a code, a sentence the handler reads, and the fix (spec IPD core §0A.5 — no dead ends). */
export const LINEN_REFUSALS = {
  bad_input: { sentence: "The request is not complete.", fix: "Check the counts and send again." },
  unknown_ward: { sentence: "This ward is not in the register.", fix: "Pick the ward from the list." },
  unknown_item: { sentence: "This linen item is not in the catalogue.", fix: "Pick the item from the list." },
  duplicate_item: { sentence: "The same item is listed twice.", fix: "Enter each item once." },
  above_par: { sentence: "This would put the ward above its par.", fix: "Issue up to par, or ask the supervisor to raise the par." },
  at_par: { sentence: "The ward is already at par.", fix: "Count the ward if the shelves look short." },
  exceeds_soiled: { sentence: "More pieces than are waiting in the soiled room.", fix: "Record the soiled linen first, then send it." },
  same_ward: { sentence: "A ward cannot borrow from itself.", fix: "Pick the other ward." },
  unknown_batch: { sentence: "This laundry batch does not exist.", fix: "Pick a batch from the list." },
  already_received: { sentence: "This batch has already been received.", fix: "Refresh the list." },
  not_in_batch: { sentence: "This item was not sent in the batch.", fix: "Check the item against the batch slip." },
  more_than_sent: { sentence: "More pieces came back than were sent.", fix: "Count again; extra pieces belong to another batch." },
  unknown_request: { sentence: "This condemn request does not exist.", fix: "Refresh the board." },
  request_closed: { sentence: "This condemn request is already decided.", fix: "Refresh the board." },
  approver_is_requester: { sentence: "You raised this request; someone else must approve it.", fix: "Ask another supervisor to approve." },
} as const satisfies Record<string, { sentence: string; fix: string }>;
export type LinenRefusalCode = keyof typeof LINEN_REFUSALS;

/* ═══ wire shapes ═══ */

export type LinenItem = { code: string; name: string; unitsPerSet: number };

export type LinenWardItemState = {
  itemCode: string;
  par: number;
  parSource: "computed" | "set";
  /** Book balance: the last count plus what moved since. */
  onHand: number;
  /** par − onHand when positive, else 0. */
  short: number;
};

export type LinenWardState = {
  wardId: string;
  wardName: string;
  floorName: string | null;
  beds: number;
  /** Beds per class, as read from the bed resources under the ward. */
  bedsByClass: Record<string, number>;
  items: LinenWardItemState[];
  belowPar: boolean;
  shortPieces: number;
  lastCountAt: string | null;
};

export type LinenBatchLine = { itemCode: string; sent: number; received: number | null };
export type LinenBatchCard = {
  id: string;
  batchNo: string;
  infected: boolean;
  state: LinenBatchState;
  vendorName: string | null;
  sentAt: string;
  receivedAt: string | null;
  piecesSent: number;
  piecesReceived: number | null;
  lines: LinenBatchLine[];
};

export type LinenVarianceRow = {
  wardId: string;
  wardName: string;
  itemCode: string;
  /** The last count before the window (0 when the ward was never counted before it). */
  opening: number;
  /** Issued from the store plus borrowed in. */
  issued: number;
  /** Soiled + infected returns, borrowed out and condemned. */
  returned: number;
  /** The last count inside the window. */
  counted: number;
  countedAt: string;
  /** opening + issued − returned − counted. Positive = lost. */
  missing: number;
};

export type LinenCondemnCard = {
  id: string;
  wardId: string | null;
  wardName: string | null;
  itemCode: string;
  qty: number;
  reason: string;
  state: LinenCondemnState;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
};

export type LinenShortRecord = { id: string; batchNo: string; itemCode: string; sent: number; received: number; short: number; recordedAt: string };

export type LinenBoardView = {
  serverNow: string;
  counts: { wards: number; belowPar: number; shortPieces: number };
  /** Below par first (most short first), then by name. */
  wards: LinenWardState[];
  laundryToday: { outPieces: number; inPieces: number; infectedOutPieces: number; shortPieces: number };
  inTransit: LinenBatchCard[];
  shorts: LinenShortRecord[];
  variance: { from: string; to: string; top: LinenVarianceRow[] };
  condemnPending: LinenCondemnCard[];
  items: LinenItem[];
};

export type LinenHandlerView = {
  serverNow: string;
  wards: LinenWardState[];
  items: LinenItem[];
  /** What waits in the soiled room, per item: ordinary and infected kept apart. */
  soiled: { general: Record<string, number>; infected: Record<string, number> };
  inTransit: LinenBatchCard[];
};

export type LinenActResult = { movements: number; wardId?: string; batchId?: string; batchNo?: string; varianceRecords?: number };
