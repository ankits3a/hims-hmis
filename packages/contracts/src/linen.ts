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
  { code: "bedsheet", name: "Bedsheet", unitsPerSet: 1, sort: 1, stream: "ward" },
  { code: "draw_sheet", name: "Draw sheet", unitsPerSet: 1, sort: 2, stream: "ward" },
  { code: "pillow_cover", name: "Pillow cover", unitsPerSet: 1, sort: 3, stream: "ward" },
  { code: "blanket", name: "Blanket", unitsPerSet: 1, sort: 4, stream: "ward" },
  { code: "patient_gown", name: "Patient gown", unitsPerSet: 1, sort: 5, stream: "ward" },
  { code: "towel", name: "Towel", unitsPerSet: 1, sort: 6, stream: "ward" },
  // Theatre linen is not in a ward bed's set: a ward's computed par for these is 0 unless the supervisor sets one.
  { code: "ot_gown", name: "OT gown", unitsPerSet: 0, sort: 7, stream: "theatre" },
  { code: "ot_drape", name: "OT drape", unitsPerSet: 0, sort: 8, stream: "theatre" },
  // LD-1: baby linen washes in its own stream, never with adult linen (D7).
  { code: "baby_wrap", name: "Baby wrap", unitsPerSet: 0, sort: 9, stream: "baby" },
  // LD-2 (#979): a staff uniform set; held against a staff id, never on a ward's par.
  { code: "uniform_set", name: "Uniform set", unitsPerSet: 0, sort: 10, stream: "uniform" },
] as const;

/** LD-1 (#978) — the wash streams: each travels, batches and washes apart. */
export const LINEN_STREAMS = ["ward", "theatre", "baby", "mop", "kitchen", "uniform"] as const;
export type LinenStream = (typeof LINEN_STREAMS)[number];

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
  // LD-1: quality check sends pieces back to the soiled room or to mending; mending returns them to the store; theatre
  // sets go to CSSD; an MLC patient's linen goes to the police.
  "qc_rewash", "qc_mend", "mend_return", "issue_to_cssd", "hold_handed_over",
] as const;
export type LinenMovementKind = (typeof LINEN_MOVEMENT_KINDS)[number];

export const LINEN_SOURCES = ["person", "device", "copilot_draft", "agent", "import", "system"] as const;
export type LinenSource = (typeof LINEN_SOURCES)[number];

export const LINEN_BATCH_STATES = ["sent", "washing", "rewash", "qc", "received", "short"] as const;
export type LinenBatchState = (typeof LINEN_BATCH_STATES)[number];
export const LINEN_CONDEMN_STATES = ["requested", "approved", "rejected"] as const;
export type LinenCondemnState = (typeof LINEN_CONDEMN_STATES)[number];
export const LINEN_BATCH_MODES = ["in_house", "vendor"] as const;
export type LinenBatchMode = (typeof LINEN_BATCH_MODES)[number];
export const LINEN_ROUND_KINDS = ["pickup", "delivery"] as const;
export type LinenRoundKind = (typeof LINEN_ROUND_KINDS)[number];
export const LINEN_HOLD_KINDS = ["mlc", "chemo", "radioactive"] as const;
export type LinenHoldKind = (typeof LINEN_HOLD_KINDS)[number];
export const LINEN_MACHINE_KINDS = ["washer", "dryer", "calender", "boiler"] as const;
export type LinenMachineKind = (typeof LINEN_MACHINE_KINDS)[number];

/**
 * THERMAL DISINFECTION (DECIDED, standard healthcare-laundry practice): an infected load is released only when it held
 * 71 °C for 3 minutes or 65 °C for 10 minutes. Any reading meeting either pair passes.
 */
export const LINEN_DISINFECTION = [{ tempC: 71, holdMin: 3 }, { tempC: 65, holdMin: 10 }] as const;
export function linenDisinfected(tempC: number, holdMin: number): boolean {
  return LINEN_DISINFECTION.some((r) => tempC >= r.tempC && holdMin >= r.holdMin);
}

/** A chemotherapy patient's linen is held this long after the dose (spec #978). */
export const LINEN_CHEMO_HOLD_HOURS = 48;

/** Round times, IST "HH:MM" (DECIDED): pickups three times a day, deliveries twice, plus on call and rush. */
export const LINEN_ROUND_SLOTS = { pickup: ["07:30", "13:30", "19:30"], delivery: ["08:30", "15:30"] } as const;

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

const bagTag = z.string().trim().min(2).max(40);

/**
 * One laundry batch: ordinary or infected, never both (washed separately), and of one stream. Loose pieces by line,
 * sealed bags by tag (LD-1): a bag is never opened to be counted.
 */
export const sendToLaundryInput = z.object({
  infected: z.boolean(),
  lines: lines.optional(),
  bagTags: z.array(bagTag).min(1).max(40).optional(),
  /** LD-1: the hospital's plant or the vendor. Before LD-1 every batch went to the vendor. */
  mode: z.enum(LINEN_BATCH_MODES).default("vendor"),
  /** The laundry's own name as on its challan — free text, not a staff record. */
  vendorName: z.string().trim().max(80).optional(),
  idempotencyKey: key.optional(),
  /** LD-2: the vendor and the dock weight — the outward challan (required once vendor laundry is live). */
  linenVendorId: z.string().min(1).max(64).optional(),
  weightGrams: z.number().int().positive().max(2_000_000).optional(),
  /** LD-2: a rush batch is due back within the vendor's rush turnaround. */
  rush: z.boolean().optional(),
  /** LD-2: tagged pieces scanned at the soiled room; each moves as itself. */
  pieceTags: z.array(z.string().trim().min(3).max(64)).min(1).max(500).optional(),
}).strict().refine((v) => v.lines !== undefined || v.bagTags !== undefined || v.pieceTags !== undefined, { message: "lines, bagTags or pieceTags" });
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
  /** LD-2: a tagged piece condemned by its tag (qty 1). */
  tag: z.string().trim().min(3).max(64).optional(),
}).strict().refine((v) => v.tag === undefined || v.qty === 1, { message: "a tag is one piece" });
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

/* ═══ LD-1 (#978, decision 0087) — the laundry floor ═══ */

const pin = z.string().regex(/^\d{4,6}$/);
/**
 * A signature on the spot: the signer's PIN, with their user id (a desk that knows it) or the name they sign in with
 * (typed on the runner's phone), checked against the user record.
 */
const signature = z.union([z.object({ userId: id, pin }).strict(), z.object({ username: z.string().trim().min(2).max(80), pin }).strict()]);
const reason = z.string().trim().min(3).max(200);

/**
 * A delivery, signed like a pickup. No lines: every item to par. A ward already at par is recorded as skipped and
 * needs no signature.
 */
export const signDeliveryInput = z.object({
  roundId: id,
  lines: lines.optional(),
  wardSign: signature.optional(),
  runnerOnlyReason: reason.optional(),
}).strict();
export type SignDeliveryInput = z.infer<typeof signDeliveryInput>;

export const openRoundInput = z.object({ wardId: id, kind: z.enum(LINEN_ROUND_KINDS) }).strict();
export type OpenRoundInput = z.infer<typeof openRoundInput>;

/** The ward seals a bag at the bed and declares what is in it; nobody counts it by piece after that (D1). */
export const sealBagInput = z.object({
  wardId: id, bedId: id.optional(), tag: bagTag, infected: z.boolean(), lines,
}).strict();
export type SealBagInput = z.infer<typeof sealBagInput>;

/**
 * A pickup, signed: loose linen by piece, sealed bags by tag only, and EITHER the ward's signature OR runner-only with
 * a reason (D1). The runner is the caller.
 */
export const signPickupInput = z.object({
  roundId: id,
  lines: lines.optional(),
  bags: z.array(z.object({ tag: bagTag }).strict()).max(40).optional(),
  /** LD-2: tagged pieces scanned at the ward; each moves as itself (D6). */
  pieceTags: z.array(z.string().trim().min(3).max(64)).min(1).max(500).optional(),
  wardSign: signature.optional(),
  runnerOnlyReason: reason.optional(),
}).strict();
export type SignPickupInput = z.infer<typeof signPickupInput>;

/** The soiled room weighs a sealed bag; it never opens it. */
export const weighBagInput = z.object({ tag: bagTag, weightGrams: z.number().int().positive().max(100_000) }).strict();

export const placeHoldInput = z.object({
  kind: z.enum(LINEN_HOLD_KINDS),
  bedId: id,
  note: z.string().trim().max(200).optional(),
  /** Chemotherapy only: the dose's instant; the hold ends 48 hours after it. */
  doseAt: z.iso.datetime({ offset: true }).optional(),
}).strict().refine((v) => (v.kind === "chemo") === (v.doseAt !== undefined), { message: "doseAt is for chemotherapy, and required there" });
export type PlaceHoldInput = z.infer<typeof placeHoldInput>;

const policeReceiver = z.object({
  name: z.string().trim().min(2).max(80), rank: z.string().trim().min(2).max(40), station: z.string().trim().min(2).max(80),
}).strict();
export const releaseHoldInput = z.object({ holdId: id, police: policeReceiver.optional() }).strict();
export type ReleaseHoldInput = z.infer<typeof releaseHoldInput>;

export const addMachineInput = z.object({
  code: z.string().trim().min(1).max(20), kind: z.enum(LINEN_MACHINE_KINDS), name: z.string().trim().min(2).max(80),
  /** The laundry room it stands in: a breakdown raises a maintenance ticket there. */
  placeId: id.optional(),
}).strict();
export const machineDownInput = z.object({ machineId: id, reason }).strict();
export const machineUpInput = z.object({ machineId: id }).strict();

export const startCycleInput = z.object({
  machineId: id, batchIds: z.array(id).min(1).max(10), program: z.string().trim().min(2).max(40),
}).strict();
export const finishCycleInput = z.object({
  cycleId: id,
  tempC: z.number().int().min(0).max(120),
  holdMin: z.number().int().min(0).max(180),
  chemical: z.string().trim().min(2).max(120),
  /** LD-2: the dry weight loaded, in grams — the plant's kg washed (D7). */
  loadGrams: z.number().int().positive().max(1_000_000).optional(),
}).strict();
export const batchRefInput = z.object({ batchId: id }).strict();
/** LD-2: plant work sent to the vendor leaves on a challan too. */
export const routeToVendorInput = z.object({
  batchId: id, linenVendorId: id.optional(), weightGrams: z.number().int().positive().max(2_000_000).optional(), rush: z.boolean().optional(),
}).strict();

/** Quality check of one batch, per item: the four outcomes add up to the pieces washed. */
export const recordQcInput = z.object({
  batchId: id,
  lines: z.array(z.object({ itemCode, pass: count, rewash: count, mend: count, condemn: count }).strict()).min(1).max(20),
}).strict();
export type RecordQcInput = z.infer<typeof recordQcInput>;

/** Theatre sets from laundry to CSSD: the CSSD nurse signs on the spot. */
export const handToCssdInput = z.object({ batchId: id, cssdSign: signature }).strict();
/** Mended pieces back to the linen store. */
export const mendReturnInput = z.object({ lines }).strict();

/** Every refusal: a code, a sentence the handler reads, and the fix (spec IPD core §0A.5 — no dead ends). */
export const LINEN_REFUSALS = {
  bad_input: { sentence: "The request is not complete.", fix: "Check the counts and send again." },
  unknown_ward: { sentence: "This ward is not in the register.", fix: "Pick the ward from the list." },
  unknown_item: { sentence: "This linen item is not in the catalogue.", fix: "Pick the item from the list." },
  duplicate_item: { sentence: "The same item is listed twice.", fix: "Enter each item once." },
  above_par: { sentence: "This would put the ward above its par.", fix: "Issue up to par, or ask the supervisor to raise the par." },
  at_par: { sentence: "The ward is already at par.", fix: "Count the ward if the shelves look short." },
  exceeds_on_hand: { sentence: "More pieces than the ward holds by its book.", fix: "Count the ward first, then record the rest." },
  key_reused: { sentence: "This count was already saved with other numbers.", fix: "Open the count again and save it as a new count." },
  exceeds_soiled: { sentence: "More pieces than are waiting in the soiled room.", fix: "Record the soiled linen first, then send it." },
  same_ward: { sentence: "A ward cannot borrow from itself.", fix: "Pick the other ward." },
  unknown_batch: { sentence: "This laundry batch does not exist.", fix: "Pick a batch from the list." },
  already_received: { sentence: "This batch has already been received.", fix: "Refresh the list." },
  not_in_batch: { sentence: "This item was not sent in the batch.", fix: "Check the item against the batch slip." },
  more_than_sent: { sentence: "More pieces came back than were sent.", fix: "Count again; extra pieces belong to another batch." },
  unknown_request: { sentence: "This condemn request does not exist.", fix: "Refresh the board." },
  request_closed: { sentence: "This condemn request is already decided.", fix: "Refresh the board." },
  approver_is_requester: { sentence: "You raised this request; someone else must approve it.", fix: "Ask another supervisor to approve." },
  // LD-1 — rounds and bags
  unknown_round: { sentence: "This round does not exist.", fix: "Pick the round from the list." },
  round_closed: { sentence: "This round is already signed.", fix: "Open a new round for more linen." },
  ward_signature_missing: { sentence: "The ward has not signed this pickup.", fix: "Ask the ward nurse to sign, or record it as runner only with a reason." },
  bad_pin: { sentence: "The PIN does not match.", fix: "Ask the signer to enter their PIN again." },
  signer_is_runner: { sentence: "The runner cannot sign for the ward.", fix: "Ask the ward nurse to sign." },
  unknown_bag: { sentence: "No sealed bag has this tag.", fix: "Check the tag, or ask the ward to seal the bag." },
  bag_gone: { sentence: "This bag has already left the ward.", fix: "Check the tag against the round sheet." },
  bag_not_here: { sentence: "This bag is not waiting in the soiled room.", fix: "Pick the bag up on a round first." },
  bag_wrong_batch: { sentence: "An infected bag goes only in an infected batch, and an ordinary bag only in an ordinary one.", fix: "Send it in the other batch." },
  tag_in_use: { sentence: "This tag is already in use (a bag still on the floor, or a registered piece).", fix: "Use another tag." },
  unknown_bed: { sentence: "This bed is not in the register.", fix: "Pick the bed from the list." },
  // LD-1 — holds
  on_hold: { sentence: "This linen is on hold and cannot go to the laundry.", fix: "Wait for the hold's owner to release it." },
  unknown_hold: { sentence: "This hold does not exist.", fix: "Refresh the list." },
  hold_closed: { sentence: "This hold is already released.", fix: "Refresh the list." },
  police_receiver_missing: { sentence: "An MLC hold is released only to the police.", fix: "Record the receiving officer's name, rank and station." },
  released_by_clock: { sentence: "A chemotherapy hold ends by itself 48 hours after the dose.", fix: "Wait for the hold to end." },
  not_rso: { sentence: "Only the radiation safety officer releases this hold.", fix: "Ask the RSO to release it." },
  // LD-1 — the plant
  code_taken: { sentence: "Another machine has this code.", fix: "Use another code." },
  unknown_place: { sentence: "This place is not in the register.", fix: "Pick the laundry room from the list." },
  not_a_delivery: { sentence: "This round is not a delivery.", fix: "Pick a delivery round." },
  not_a_pickup: { sentence: "This round is not a pickup.", fix: "Pick a pickup round." },
  unknown_machine: { sentence: "This machine is not in the plant list.", fix: "Pick the machine from the list." },
  machine_down: { sentence: "This machine is marked down.", fix: "Use another machine, or send the work to the vendor." },
  machine_busy: { sentence: "This machine is running a cycle.", fix: "Finish the running cycle first." },
  mixed_cycle: { sentence: "Infected and ordinary linen never wash together.", fix: "Run them in separate cycles." },
  mixed_stream: { sentence: "These items belong to different wash streams.", fix: "Make one batch per stream." },
  not_in_plant: { sentence: "This batch is not waiting in the plant.", fix: "Pick a batch from the plant queue." },
  unknown_cycle: { sentence: "This wash cycle does not exist.", fix: "Pick the cycle from the list." },
  cycle_finished: { sentence: "This cycle is already finished.", fix: "Refresh the list." },
  disinfection_missed: { sentence: "This infected batch did not reach the disinfection temperature and time.", fix: "Rewash it." },
  not_at_qc: { sentence: "This batch is not waiting at quality check.", fix: "Release it from the machine first." },
  qc_mismatch: { sentence: "The quality check does not add up to the pieces washed.", fix: "Count again: pass, rewash, mend and condemn." },
  not_theatre: { sentence: "Only theatre sets go to CSSD.", fix: "Send this batch to the linen store." },
  qc_missing: { sentence: "This batch has not been through quality check.", fix: "Record the quality check first." },
  not_cssd: { sentence: "The signer is not a CSSD receiver.", fix: "Ask the CSSD nurse to sign." },
  exceeds_mending: { sentence: "More pieces than are at mending.", fix: "Check the count." },
  // LD-2 (#979)
  challan_required: { sentence: "A vendor batch leaves only on a challan with the vendor and the weight.", fix: "Pick the vendor and weigh the batch." },
  unknown_vendor: { sentence: "This laundry vendor is not set up.", fix: "Pick the vendor from the list." },
  vendor_taken: { sentence: "A vendor of this name exists.", fix: "Use the existing vendor." },
  use_challan: { sentence: "This batch went on a challan.", fix: "Record the return against its challan." },
  unknown_challan: { sentence: "This challan does not exist.", fix: "Pick the challan from the list." },
  challan_closed: { sentence: "Everything on this challan is back.", fix: "Pick an open challan." },
  month_open: { sentence: "The month is not over yet.", fix: "Raise the recovery after the month ends." },
  within_par: { sentence: "The vendor is within par this month: nothing to recover.", fix: "Read the report; no recovery is due." },
  recovery_exists: { sentence: "A recovery for this vendor and month is already raised.", fix: "Decide the one that is open." },
  unknown_recovery: { sentence: "This recovery does not exist.", fix: "Pick it from the list." },
  not_approver: { sentence: "You cannot approve this.", fix: "Ask the owner, finance or stores, as the case needs." },
  no_rate: { sentence: "No rate card for this item on that date.", fix: "Set the vendor's rate for the item." },
  bill_exists: { sentence: "This bill number is already checked.", fix: "Open the checked bill." },
  unknown_bill: { sentence: "This bill does not exist.", fix: "Pick it from the list." },
  bill_closed: { sentence: "This bill holds nothing for approval.", fix: "Refresh the list." },
  not_entitled: { sentence: "This person's role is not issued uniforms.", fix: "Add the role in uniform setup, if it should be." },
  above_entitlement: { sentence: "This would give more than three uniform sets.", fix: "Exchange a dirty set instead." },
  one_for_one: { sentence: "A clean set is given only for a dirty set.", fix: "Take the same number of dirty sets." },
  exchange_unmatched: { sentence: "This person holds fewer sets than are being exchanged.", fix: "Issue sets first, or count again." },
  exceeds_held: { sentence: "More sets than this person holds.", fix: "Check the count." },
  unknown_user: { sentence: "This staff member is not in the register.", fix: "Pick the staff member from the list." },
  piece_condemned: { sentence: "This tag is on a condemned piece.", fix: "Take the piece out; do not count it." },
  unknown_piece: { sentence: "This tag is not registered.", fix: "Register the tag on its piece first." },
  piece_wrong_item: { sentence: "This tag is on another item.", fix: "Check the piece." },
  licence_dates: { sentence: "The licence ends before it starts.", fix: "Check the dates." },
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

/* ═══ LD-1 wire shapes ═══ */

export type LinenRoundCard = {
  id: string; wardId: string; kind: LinenRoundKind; state: "open" | "signed" | "skipped"; slotAt: string | null;
  runnerId: string | null; runnerOnly: boolean; wardSignedBy: string | null; pieces: number; bags: number; signedAt: string | null;
};
/** A sealed bag as the soiled room sees it: a tag and a weight, never a piece count (D1). */
export type LinenBagCard = { tag: string; wardId: string; weightGrams: number | null };
export type LinenHoldCard = {
  id: string; kind: LinenHoldKind; bedId: string; bedName: string; wardId: string; state: "active" | "released" | "handed_over";
  placedAt: string; releaseAfter: string | null;
};
export type LinenMachineCard = { id: string; code: string; kind: LinenMachineKind; name: string; state: "up" | "down"; downReason: string | null; running: boolean };
export type LinenPlantBatch = { batchId: string; batchNo: string; infected: boolean; stream: LinenStream; state: LinenBatchState; pieces: number; sentAt: string };
export type LinenPlantView = {
  serverNow: string;
  machines: LinenMachineCard[];
  /** In-house batches waiting, washing, back for rewash, or at quality check. */
  queue: LinenPlantBatch[];
  /** Waiting work no machine can take while every washer is down: send it to the vendor (D5). */
  vendorQueue: LinenPlantBatch[];
  /** LD-2: the laundry vendors set up; with any, work sent to a vendor leaves on a challan (vendor + weight). */
  vendors?: { id: string; name: string }[];
};
export type LinenBedWait = { bedId: string; bedName: string; wardId: string; short: Record<string, number>; rush: boolean; raisedAt: string };
export type LinenSoiledRoomView = { general: Record<string, number>; infectedBags: LinenBagCard[] };

/** The day's rush demand (spec #978): sets the planned discharges will need, and the shelf's shortfall for them. */
export type LinenRushWard = { wardId: string; wardName: string; discharges: number; short: Record<string, number> };
export type LinenRushDemand = { day: string; wards: LinenRushWard[]; theatreCases: number };

/** The supervisor's laundry tab: beds waiting for linen, holds, rush demand, machines down and the vendor queue. */
export type LinenLaundryView = {
  serverNow: string;
  bedsWaiting: LinenBedWait[];
  holds: LinenHoldCard[];
  rush: LinenRushDemand;
  plant: LinenPlantView;
};

/** The phone's floor tab: rounds, active holds, the soiled room, beds waiting for linen, and MLC beds (hold suggested). */
export type LinenFloorView = {
  rounds: LinenRoundCard[];
  holds: LinenHoldCard[];
  soiledRoom: LinenSoiledRoomView;
  bedsWaiting: LinenBedWait[];
  /** Occupied beds whose admission is an MLC: the round sheet suggests a hold there. */
  mlcBeds: string[];
  /** Bags sealed on the wards, not yet picked up (held ones say so). */
  sealedBags: LinenSealedBag[];
  /** Every bed under a ward, for sealing a bag at a bed or placing a hold. */
  beds: { bedId: string; bedName: string; wardId: string }[];
};
export type LinenSealedBag = { tag: string; wardId: string; bedId: string | null; bedName: string | null; infected: boolean; held: boolean };

/* ═══ LD-2 (#979, decisions 0087 and 0092) — vendor laundry, uniforms, piece tags, chemicals, licences ═══ */

const paise = z.number().int().min(0).max(1_000_000_000);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** The standard turnaround (DECIDED): 24 hours routine, 12 hours theatre and rush; editable per vendor. */
export const LINEN_TURNAROUND_HOURS = { routine: 24, rush: 12 } as const;
/** A piece still out this many days after its batch was due is lost (DECIDED). */
export const LINEN_LOST_AFTER_DAYS = 7;
/** Below par (decision 0087, small-month floor decision 0092). */
export const LINEN_PAR = { lossRate: 0.005, lateRate: 0.1, smallMonthPieces: 1000, smallMonthMaxLoss: 5 } as const;
/** Uniform sets per person: one worn, one in the wash, one spare (DECIDED). */
export const LINEN_UNIFORM_ENTITLEMENT = 3;
/** A licence is red this many days before it expires (spec #979 D8). */
export const LINEN_LICENCE_RED_DAYS = 60;
export const LINEN_LICENCE_KINDS = ["etp_consent", "boiler"] as const;
export type LinenLicenceKind = (typeof LINEN_LICENCE_KINDS)[number];
/** The stores cost centre a laundry issue is charged to (stock_ledger.cost_center). */
export const LAUNDRY_COST_CENTRE = "laundry";

/** Below par this month? Pure: the report and the screen use the same rule. */
export function linenBelowPar(m: { piecesSent: number; lost: number; damaged: number; batches: number; lateBatches: number }): { belowPar: boolean; loss: boolean; late: boolean } {
  const bad = m.lost + m.damaged;
  const loss = m.piecesSent < LINEN_PAR.smallMonthPieces ? bad > LINEN_PAR.smallMonthMaxLoss : bad > m.piecesSent * LINEN_PAR.lossRate;
  const late = m.batches > 0 && m.lateBatches > m.batches * LINEN_PAR.lateRate;
  return { belowPar: loss || late, loss, late };
}

export const addLinenVendorInput = z.object({
  name: z.string().trim().min(2).max(80),
  vendorId: id.optional(),
  turnaroundHours: z.number().int().min(1).max(240).optional(),
  rushTurnaroundHours: z.number().int().min(1).max(240).optional(),
  gstRateBps: z.number().int().min(0).max(2800).optional(),
}).strict();
/** Turnaround and GST changed after the vendor was added (spec #979: editable per vendor). Rush never above routine. */
export const updateLinenVendorInput = z.object({
  linenVendorId: id,
  turnaroundHours: z.number().int().min(1).max(240).optional(),
  rushTurnaroundHours: z.number().int().min(1).max(240).optional(),
  gstRateBps: z.number().int().min(0).max(2800).optional(),
}).strict();
export const setVendorRateInput = z.object({ linenVendorId: id, itemCode, ratePaise: paise, effectiveFrom: isoDay }).strict();
/** The item master for linen: its stores item (last goods-receipt price) and its own price per piece. */
export const setLinenItemCostInput = z.object({
  itemCode, materialsItemId: id.nullable().optional(), pricePaise: paise.nullable().optional(),
}).strict();
/** At the dock, per item: accepted, refused damaged, refused stained (back to the vendor for a free rewash). */
export const recordChallanReturnInput = z.object({
  challanId: id,
  lines: z.array(z.object({ itemCode, accepted: count, damaged: count, stained: count }).strict()).min(1).max(20),
}).strict();
export const raiseRecoveryInput = z.object({ linenVendorId: id, month }).strict();
export const decideRecoveryInput = z.object({ recoveryId: id, amountPaise: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(), note: z.string().trim().max(200).optional() }).strict();
export const checkVendorBillInput = z.object({
  linenVendorId: id,
  month,
  vendorBillNo: z.string().trim().min(1).max(40),
  lines: z.array(z.object({ itemCode, pieces: count, amountPaise: paise }).strict()).min(1).max(20),
  /** The bill's total as the vendor wrote it, GST included. */
  billedPaise: paise,
}).strict();
export const decideBillInput = z.object({ billId: id, note: z.string().trim().max(200).optional() }).strict();
export const setUniformRoleInput = z.object({ roleKey: z.string().trim().min(2).max(60), entitled: z.boolean() }).strict();
/** The staff member by user id (a desk that knows it) or by the name they sign in with (typed at the counter). */
const staffRef = { userId: id.optional(), username: z.string().trim().min(2).max(80).optional() };
const oneStaff = (v: { userId?: string | undefined; username?: string | undefined }): boolean => (v.userId === undefined) !== (v.username === undefined);
export const issueUniformInput = z.object({ ...staffRef, sets: z.number().int().min(1).max(3), size: z.string().trim().min(1).max(10).optional(), itemCode: itemCode.optional() }).strict()
  .refine(oneStaff, { message: "userId or username" });
export const exchangeUniformInput = z.object({ ...staffRef, dirty: z.number().int().min(1).max(3), clean: z.number().int().min(1).max(3), itemCode: itemCode.optional() }).strict()
  .refine(oneStaff, { message: "userId or username" });
export const returnUniformInput = z.object({ ...staffRef, sets: z.number().int().min(1).max(3), itemCode: itemCode.optional() }).strict()
  .refine(oneStaff, { message: "userId or username" });
export const registerPieceInput = z.object({ itemCode, tagUid: z.string().trim().min(3).max(64) }).strict();
export const fileLicenceInput = z.object({
  kind: z.enum(LINEN_LICENCE_KINDS), licenceNo: z.string().trim().min(2).max(60), authority: z.string().trim().min(2).max(120),
  validFrom: isoDay, validTo: isoDay,
}).strict();
export const linenMonthQuery = z.object({ month }).strict();

export type LinenVendorCard = { id: string; name: string; turnaroundHours: number; rushTurnaroundHours: number; gstRateBps: number };
export type LinenChallanLine = { itemCode: string; sent: number; accepted: number; damaged: number; stained: number; missing: number };
export type LinenChallanCard = {
  id: string; challanNo: string; batchId: string; linenVendorId: string; vendorName: string; pieces: number; weightGrams: number;
  rush: boolean; sentAt: string; dueAt: string; late: boolean; open: boolean; lines: LinenChallanLine[];
};
export type LinenRecoveryLineView = {
  kind: "lost" | "damaged" | "reversal"; challanId: string; itemCode: string; qty: number; unitPaise: number; amountPaise: number;
  priced: boolean; reversesRecoveryId?: string;
};
export type LinenReversal = { recoveryId: string; challanId: string; itemCode: string; qty: number; amountPaise: number };
export type LinenVendorMonthReport = {
  linenVendorId: string; vendorName: string; month: string; piecesSent: number; lost: number; damaged: number; batches: number;
  lateBatches: number; belowPar: boolean; lossBelowPar: boolean; lateBelowPar: boolean; monthOver: boolean;
  proposed: { lines: LinenRecoveryLineView[]; totalPaise: number } | null;
  reversals: LinenReversal[];
  recovery: { id: string; state: string; proposedPaise: number; approvedPaise: number | null; proposedBy: string } | null;
};
export type LinenBillCard = {
  id: string; linenVendorId: string; month: string; vendorBillNo: string;
  lines: { itemCode: string; billed: number; accepted: number; flagged: boolean; billedPaise: number; acceptedPaise: number }[];
  billedPaise: number; acceptedValuePaise: number; gstPaise: number; recoveryPaise: number; payablePaise: number; heldPaise: number;
  state: "checked" | "held" | "approved" | "refused"; checkedBy: string;
};
export type LinenUniformHolding = { userId: string; name: string; staffCode: string; sets: number; size: string | null };
export type LinenUniformDue = LinenUniformHolding & { firstIssuedAt: string; monthsUsed: number; replacementPaise: number; deductionPaise: number };
export type LinenChemicalLine = { itemId: string; name: string; uom: string; qty: number; costPaise: number; perKg: number; costPerKgPaise: number };
export type LinenChemicalUse = {
  month: string; kgWashed: number; items: LinenChemicalLine[]; inHouseCostPerKgPaise: number | null;
  vendorKgSent: number; vendorCostPerKgPaise: number | null;
};
export type LinenLicenceRow = { id: string; kind: LinenLicenceKind; licenceNo: string; authority: string; validTo: string; daysLeft: number; state: "ok" | "red" | "expired" };
export type LinenVendorDeskView = {
  serverNow: string; month: string; vendors: LinenVendorCard[]; openChallans: LinenChallanCard[]; reports: LinenVendorMonthReport[];
  bills: LinenBillCard[]; recoveries: { id: string; vendorName: string; month: string; state: string; proposedPaise: number; approvedPaise: number | null; proposedBy: string }[];
  licences: LinenLicenceRow[]; chemicals: LinenChemicalUse;
};
export type LinenUniformView = { serverNow: string; roles: string[]; holdings: LinenUniformHolding[]; dues: LinenUniformDue[] };

/** The laundry setup screen (#1014): vendors with rates and turnaround, item costs, the plant licences, uniform roles. */
export type LinenSetupView = {
  serverNow: string;
  vendors: (LinenVendorCard & { rates: { itemCode: string; ratePaise: number; effectiveFrom: string }[] })[];
  items: { code: string; name: string; stream: LinenStream; pricePaise: number | null; materialsItemId: string | null }[];
  licences: LinenLicenceRow[];
  uniformRoles: string[];
};
