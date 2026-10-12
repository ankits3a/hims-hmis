import { z } from "zod";

/**
 * E1.7 BIO-MEDICAL WASTE (issue #724, decision 0072, spec SPEC-ipd-companions §4) — the shared shape of
 * a waste bag, its intents, its refusals and the two legal reports. Bio-Medical Waste Management Rules
 * 2016 (as amended 2018 and 2019): every bag is colour-coded by category, labelled with a bar code at
 * the point of generation, weighed at the department and again at the central store, and handed to
 * the common treatment facility (CBWTF) within 48 hours of generation.
 *
 * The server parses every intent's input with these schemas; the web reads the wire types and the
 * refusal table. No patient identity anywhere: a bag belongs to a place, never to a person.
 */

/** Schedule I colour categories. Cytotoxic waste is a YELLOW sub-category carried as a flag. */
export const BMW_CATEGORIES = ["yellow", "red", "white_translucent", "blue"] as const;
export type BmwCategory = (typeof BMW_CATEGORIES)[number];

export const BMW_BAG_STATES = ["generated", "collected", "stored", "handed_over", "treated", "disputed"] as const;
export type BmwBagState = (typeof BMW_BAG_STATES)[number];
/** Still on the hospital's premises: the 48-hour clock runs. */
export const BMW_ON_SITE_STATES = ["generated", "collected", "stored"] as const satisfies readonly BmwBagState[];

export const BMW_ACTS = [
  "generated", "dept_weighed", "collected", "stored", "handed_over", "cbwtf_weighed", "treated", "disputed", "resolved",
] as const;
export type BmwAct = (typeof BMW_ACTS)[number];

export const BMW_SOURCES = ["person", "device", "copilot_draft", "agent", "import", "system"] as const;
export type BmwSource = (typeof BMW_SOURCES)[number];

/** Storage clock, from generation (Rules 2016 r.8(3): untreated waste stored no longer than 48 hours). */
export const BMW_WARN_HOURS = 36;
export const BMW_LIMIT_HOURS = 48;
/**
 * DECIDED (brief 2026-10-12, spec §11): a weight gap is |other − department| / department ≥ 6 %. One rule for
 * the central store's weight and the CBWTF's; only the CBWTF's opens a dispute.
 */
export const BMW_GAP_PERCENT = 6;

/** True when `other` differs from `dept` by BMW_GAP_PERCENT or more. Integer arithmetic: 6.0 % is a gap, 5.9 % is not. */
export function bmwGapFlagged(deptGrams: number, otherGrams: number): boolean {
  if (deptGrams <= 0) return otherGrams > 0;
  return Math.abs(otherGrams - deptGrams) * 100 >= BMW_GAP_PERCENT * deptGrams;
}

/** The gap in basis points of the department weight (600 = 6.00 %), signed: positive when the other weighed more. */
export function bmwGapBasisPoints(deptGrams: number, otherGrams: number): number {
  if (deptGrams <= 0) return 0;
  return Math.round(((otherGrams - deptGrams) * 10_000) / deptGrams);
}

export type BmwClockLevel = "ok" | "warning" | "alert";
/** The storage clock's level for a bag generated at `generatedAt`, read at `now`. */
export function bmwClockLevel(generatedAt: string | Date, now: Date): BmwClockLevel {
  const at = typeof generatedAt === "string" ? Date.parse(generatedAt) : generatedAt.getTime();
  const hours = (now.getTime() - at) / 3_600_000;
  if (hours >= BMW_LIMIT_HOURS) return "alert";
  if (hours >= BMW_WARN_HOURS) return "warning";
  return "ok";
}

const id = z.string().min(1).max(64);
const barcode = z.string().trim().min(4).max(40);
/** A bag weighs grams to tens of kilograms; 100 kg is a ceiling no single bag reaches. */
const grams = z.number().int().positive().max(100_000);

export const generateBagInput = z.object({
  category: z.enum(BMW_CATEGORIES),
  cytotoxic: z.boolean().optional(),
  placeResourceId: id,
  /** Weighed at the point of generation already: saves the department weighing step. */
  deptWeightGrams: grams.optional(),
}).strict();
export type GenerateBagInput = z.infer<typeof generateBagInput>;

export const bagWeightInput = z.object({ barcode, grams }).strict();
export type BagWeightInput = z.infer<typeof bagWeightInput>;

/** `grams` is the department weight when the bag was not weighed before collection. */
export const collectBagInput = z.object({ barcode, grams: grams.optional() }).strict();
export type CollectBagInput = z.infer<typeof collectBagInput>;

/** The central store's weight, taken as the bag comes in. */
export const storeBagInput = z.object({ barcode, grams }).strict();
export type StoreBagInput = z.infer<typeof storeBagInput>;

export const handOverManifestInput = z.object({
  barcodes: z.array(barcode).min(1).max(2000),
  /** The treatment facility's own name, as on its authorisation — free text, never a member of staff. */
  cbwtfName: z.string().trim().min(2).max(120),
  vehicleNo: z.string().trim().min(4).max(20),
  /** The facility's driver or operator as they sign — free text of the facility, not a staff record. */
  operatorName: z.string().trim().max(80).optional(),
}).strict();
export type HandOverManifestInput = z.infer<typeof handOverManifestInput>;

/** The CBWTF's weights: per bag (their scan) or per category of the manifest (their weighbridge slip). */
export const recordCbwtfWeightInput = z.object({
  manifestId: id,
  byBag: z.array(z.object({ barcode, grams }).strict()).max(2000).optional(),
  byCategory: z.array(z.object({ category: z.enum(BMW_CATEGORIES), grams }).strict()).max(4).optional(),
}).strict().refine((v) => (v.byBag?.length ?? 0) + (v.byCategory?.length ?? 0) > 0, { message: "give per-bag or per-category weights" });
export type RecordCbwtfWeightInput = z.infer<typeof recordCbwtfWeightInput>;

export const resolveDisputeInput = z.object({ disputeId: id, note: z.string().trim().min(3).max(280) }).strict();
export type ResolveDisputeInput = z.infer<typeof resolveDisputeInput>;

export const bmwMonthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict();
export const bmwYearQuery = z.object({ year: z.string().regex(/^\d{4}$/) }).strict();

/** Every refusal: a code, a sentence a handler can read, and the fix (spec IPD core §0A.5 — no dead ends). */
export const BMW_REFUSALS = {
  bad_input: { sentence: "The request is not complete.", fix: "Check the fields and send again." },
  unknown_place: { sentence: "This place is not in the register.", fix: "Pick the ward or room from the list." },
  unknown_bag: { sentence: "No bag has this bar code.", fix: "Scan the label again or type the code." },
  cytotoxic_not_yellow: { sentence: "Cytotoxic waste goes in a yellow bag.", fix: "Pick yellow, then mark it cytotoxic." },
  already_weighed: { sentence: "This bag already has its department weight.", fix: "Collect the bag." },
  weight_needed: { sentence: "Weigh the bag before it leaves the ward.", fix: "Put it on the scale and enter the weight." },
  wrong_state: { sentence: "This step does not fit the bag's stage.", fix: "Scan again to see where the bag stands." },
  already_handed_over: { sentence: "This bag has already gone to the treatment facility.", fix: "Take it off the manifest." },
  not_stored: { sentence: "Only bags in the central store can be handed over.", fix: "Store the bag first." },
  duplicate_bag: { sentence: "The same bag is listed twice.", fix: "Scan each bag once." },
  unknown_manifest: { sentence: "This manifest does not exist.", fix: "Pick a manifest from the list." },
  not_on_manifest: { sentence: "This bag is not on the manifest.", fix: "Check the bar code against the manifest." },
  category_not_on_manifest: { sentence: "The manifest has no bags of this colour.", fix: "Check the colour on the facility's slip." },
  already_recorded: { sentence: "The facility's weight is already recorded.", fix: "Open a dispute if it is wrong." },
  unknown_dispute: { sentence: "This dispute does not exist.", fix: "Refresh the board." },
  dispute_closed: { sentence: "This dispute is already closed.", fix: "Refresh the board." },
  bad_period: { sentence: "This month or year is not valid.", fix: "Pick a month or year from the list." },
} as const satisfies Record<string, { sentence: string; fix: string }>;
export type BmwRefusalCode = keyof typeof BMW_REFUSALS;

/* ═══ wire shapes ═══ */

export type BmwBagCard = {
  id: string;
  barcode: string;
  category: BmwCategory;
  cytotoxic: boolean;
  state: BmwBagState;
  placeResourceId: string;
  placeName: string;
  floorName: string | null;
  generatedAt: string;
  deptWeightGrams: number | null;
  centralWeightGrams: number | null;
  /** The central weight differs from the department's by BMW_GAP_PERCENT or more. */
  centralGap: boolean;
  storageInAt: string | null;
  handedOverAt: string | null;
  manifestId: string | null;
  cbwtfWeightGrams: number | null;
  version: number;
};

/** The label went to the label printer (relay) or comes back for this browser to print. */
export type BmwLabelDelivery =
  | { via: "relay"; jobId: string | null }
  | { via: "browser"; document: { html: string; title: string; page: { widthMm: number; heightMm: number | null } } };

export type GenerateBagResult = { bag: BmwBagCard; label: BmwLabelDelivery };

export type BmwPlace = { id: string; kind: string; code: string; name: string; floorName: string | null };

export type BmwWardGeneration = { placeResourceId: string; placeName: string; bags: number; grams: number; byCategory: Record<BmwCategory, number> };

export type BmwDisputeCard = {
  id: string;
  manifestId: string;
  manifestNo: string;
  category: BmwCategory;
  deptGrams: number;
  cbwtfGrams: number;
  /** Signed, basis points of the department weight. */
  gapBasisPoints: number;
  state: "open" | "resolved";
  openedAt: string;
};

export type BmwManifestCard = {
  id: string;
  manifestNo: string;
  cbwtfName: string;
  vehicleNo: string;
  handedOverAt: string;
  bags: number;
  deptGrams: number;
  cbwtfRecorded: boolean;
};

export type BmwBoardView = {
  serverNow: string;
  /** Every bag still on the premises, oldest first, with its storage clock. */
  onSite: BmwBagCard[];
  counts: { onSite: number; warning: number; alert: number; stored: number; generatedToday: number; gramsToday: number };
  today: BmwWardGeneration[];
  disputes: BmwDisputeCard[];
  /** Next CBWTF pickup, ISO; the contract's daily slot. */
  nextPickupAt: string;
  lastManifest: BmwManifestCard | null;
};

export type BmwHandlerView = { serverNow: string; places: BmwPlace[]; recent: BmwBagCard[] };

/** One row of the monthly report or of a Form IV month. `subsetOf` rows are inside their parent and not in totals. */
export type BmwReportLine = {
  line: "yellow" | "yellow_cytotoxic" | "red" | "white_translucent" | "blue";
  subsetOf: BmwCategory | null;
  generatedBags: number;
  generatedGrams: number;
  handedOverBags: number;
  handedOverGrams: number;
  treatedBags: number;
  treatedGrams: number;
};

export type BmwMonthlyReport = {
  month: string;
  lines: BmwReportLine[];
  totals: Omit<BmwReportLine, "line" | "subsetOf">;
  /** Bags generated in the month with no department weight yet: counted, not weighed. */
  unweighedBags: number;
  openDisputes: number;
};

export type BmwFormIvReport = {
  year: string;
  /** kg-precision grams generated, per report line, per month (index 0 = January). */
  months: { month: string; grams: Record<BmwReportLine["line"], number> }[];
  annualGrams: Record<BmwReportLine["line"], number>;
  annualTotalGrams: number;
  /** Average per day over the days of the year so far (or the whole year once it has ended). */
  averageGramsPerDay: number;
  days: number;
};

export const BMW_REPORT_LINES = ["yellow", "yellow_cytotoxic", "red", "white_translucent", "blue"] as const satisfies readonly BmwReportLine["line"][];
