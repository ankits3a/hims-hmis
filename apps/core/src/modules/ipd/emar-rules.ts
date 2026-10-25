import { IPD_EMAR_CATCH_UP_WINDOWS, IPD_EMAR_TIME_CRITICAL_WINDOW_MINUTES, IPD_EMAR_WINDOW_MINUTES } from "@hmis/contracts";
import { istDayWindow } from "../../kernel/approvals/cumulative";

/**
 * E4.3 (#735) — THE eMAR's PURE RULES (spec §4.6). No database, no clock of their own: every function takes its instants.
 *
 * DUE TIMES (DECIDED — the standard Indian ward round of medicine times, IST): OD 09:00 · BD 09:00, 21:00 · TDS 08:00,
 * 14:00, 20:00 · QID 06:00, 12:00, 18:00, 00:00 · HS 21:00 · STAT one dose at the start · SOS none (PRN: the nurse gives on
 * need inside its limits). The first dose is the first slot at or after the order's start; the last before its stop (or
 * start + duration days). IST midnight comes from the kernel's `istDayWindow` (never a hand-written offset).
 *
 * WINDOW: ±60 min; time-critical ±30 min. TIME-CRITICAL (DECIDED, by moiety / class words, since the formulary has no
 * such flag): every antibiotic order, insulin, anti-epileptics, Parkinson's drugs. HIGH-ALERT (§4.6): the item master's
 * `high_alert` flag (the formulary's NABH flag), any NDPS narcotic (opioids), and — belt and braces, so an unflagged KCl
 * or insulin can never slip through — the ISMP core names (insulin, heparins, potassium chloride / concentrated
 * potassium, opioids by name). Chemotherapy rides on the item flag (no class data in the catalogue).
 */

const SLOT_HOURS: Record<string, readonly number[]> = {
  OD: [9], BD: [9, 21], TDS: [8, 14, 20], QID: [0, 6, 12, 18], HS: [21],
};

/** The scheduled due instants of an order in [from, to). STAT: the start alone; SOS: none. */
export function dueTimesFor(o: { frequency: string; startAt: Date; stopAt: Date | null; durationDays: number | null }, from: Date, to: Date): Date[] {
  const end = o.stopAt ?? (o.durationDays === null ? null : new Date(o.startAt.getTime() + o.durationDays * 86_400_000));
  const inRange = (t: Date): boolean => t.getTime() >= from.getTime() && t.getTime() < to.getTime()
    && t.getTime() >= o.startAt.getTime() && (end === null || t.getTime() < end.getTime());
  if (o.frequency === "STAT") return inRange(o.startAt) ? [o.startAt] : [];
  const hours = SLOT_HOURS[o.frequency];
  if (hours === undefined) return [];
  const out: Date[] = [];
  let day = istDayWindow(new Date(Math.max(from.getTime(), o.startAt.getTime()))).start;
  while (day.getTime() < to.getTime()) {
    for (const h of hours) {
      const t = new Date(day.getTime() + h * 3_600_000);
      if (inRange(t)) out.push(t);
    }
    day = istDayWindow(new Date(day.getTime() + 36 * 3_600_000)).start;
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

const TIME_CRITICAL_WORDS = /insulin|levetiracetam|phenytoin|fosphenytoin|valpro|carbamazepine|oxcarbazepine|lacosamide|lamotrigine|clobazam|phenobarb|topiramate|brivaracetam|levodopa|carbidopa|pramipexole|ropinirole|rasagiline|selegiline|amantadine|entacapone/i;
const TIME_CRITICAL_CLASSES = /antiepilep|anticonvuls|antiparkinson|insulin|antibiotic|antibacterial|cephalospor|penicillin|carbapenem|aminoglycoside|macrolide|fluoroquinolone|glycopeptide/i;
/**
 * E4.3 review — the ISMP high-alert medicines (acute-care list) by name, so an unflagged one can never skip the second
 * nurse. Each word is pinned by `emar-rules.test.ts`.
 */
export const ISMP_HIGH_ALERT_NAMES = [
  // anticoagulants and thrombolytics
  "heparin", "enoxaparin", "dalteparin", "fondaparinux", "warfarin", "acenocoumarol", "dabigatran", "rivaroxaban", "apixaban",
  "alteplase", "tenecteplase", "streptokinase", "urokinase", "reteplase",
  // insulins and oral hypoglycaemics
  "insulin", "glibenclamide", "glimepiride", "gliclazide", "glipizide",
  // concentrated electrolytes
  "potassium chloride", "kcl", "potassium phosphate", "sodium chloride 3%", "hypertonic saline", "magnesium sulphate", "magnesium sulfate",
  "sodium bicarbonate", "calcium gluconate", "dextrose 25%", "dextrose 50%",
  // opioids
  "morphine", "fentanyl", "pethidine", "meperidine", "tramadol", "buprenorphine", "tapentadol", "methadone", "oxycodone", "hydromorphone",
  "remifentanil", "sufentanil",
  // sedation and anaesthesia
  "midazolam", "propofol", "ketamine", "dexmedetomidine", "thiopentone", "lorazepam injection",
  // neuromuscular blockers
  "vecuronium", "rocuronium", "atracurium", "cisatracurium", "succinylcholine", "suxamethonium", "pancuronium",
  // vasopressors, inotropes and IV antiarrhythmics
  "adrenaline", "epinephrine", "noradrenaline", "norepinephrine", "dopamine", "dobutamine", "vasopressin", "phenylephrine",
  "amiodarone", "lignocaine", "lidocaine", "digoxin", "esmolol", "nitroprusside", "nitroglycerin injection",
  // oxytocics
  "oxytocin", "carboprost", "methylergometrine",
  // cytotoxics
  "methotrexate", "vincristine", "vinblastine", "cyclophosphamide", "cisplatin", "carboplatin", "oxaliplatin", "doxorubicin",
  "paclitaxel", "docetaxel", "5-fluorouracil", "fluorouracil", "gemcitabine", "cytarabine", "etoposide", "bleomycin",
  // others on the list
  "colchicine", "nitroprusside sodium", "chloral hydrate", "promethazine injection",
] as const;
const escape = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HIGH_ALERT_WORDS = new RegExp(`(^|[^a-z])(${ISMP_HIGH_ALERT_NAMES.map(escape).join("|")})([^a-z]|$)`, "i");

export type DrugWords = { name: string; moieties: readonly string[]; classes: readonly (string | null)[] };

export function isTimeCritical(antibiotic: boolean, w: DrugWords): boolean {
  if (antibiotic) return true;
  return [w.name, ...w.moieties].some((x) => TIME_CRITICAL_WORDS.test(x)) || w.classes.some((c) => c !== null && TIME_CRITICAL_CLASSES.test(c));
}

export function isHighAlert(itemFlag: boolean, narcotic: boolean, w: DrugWords): boolean {
  return itemFlag || narcotic || [w.name, ...w.moieties].some((x) => HIGH_ALERT_WORDS.test(x));
}

export const windowMinutesFor = (timeCritical: boolean): number =>
  timeCritical ? IPD_EMAR_TIME_CRITICAL_WINDOW_MINUTES : IPD_EMAR_WINDOW_MINUTES;

/**
 * Where a give stands against a slot. `open` while inside the window (or a re-offered held dose inside its new window);
 * `early` before the window; `late` past it but inside the catch-up (a reason is needed); `closed` beyond that.
 */
export function giveTiming(slot: { dueAt: Date; windowMinutes: number; reofferedAt: Date | null }, at: Date): "early" | "open" | "late" | "closed" {
  const w = slot.windowMinutes * 60_000;
  const anchor = slot.reofferedAt !== null && slot.reofferedAt.getTime() > slot.dueAt.getTime() ? slot.reofferedAt : slot.dueAt;
  const start = slot.reofferedAt !== null ? Math.min(anchor.getTime(), slot.dueAt.getTime() - w) : slot.dueAt.getTime() - w;
  if (at.getTime() < start) return "early";
  if (at.getTime() <= anchor.getTime() + w) return "open";
  // E4.3 review: the catch-up is ONE more window (w) after the window closes.
  if (at.getTime() <= anchor.getTime() + w * (1 + IPD_EMAR_CATCH_UP_WINDOWS)) return "late";
  return "closed";
}

/** "500 mg · oral · TDS" — the dose a person reads. */
export function doseWordsOf(o: { doseValue: number | null; doseUnit: string | null; route: string | null; frequency: string | null }): string {
  const v = o.doseValue === null ? "" : Number.isInteger(o.doseValue) ? String(o.doseValue) : String(o.doseValue);
  return [`${v} ${o.doseUnit ?? ""}`.trim(), o.route?.toUpperCase() === "IV" ? "IV" : o.route, o.frequency].filter((x) => x !== null && x !== "").join(" · ");
}

/** PRN: the earliest next dose and whether the 24-hour cap is reached, from the given instants (newest first or any order). */
export function prnState(given: readonly Date[], prn: { minIntervalMinutes: number; max24h: number }, at: Date): { nextAt: Date | null; in24h: number; capped: boolean } {
  const recent = given.filter((g) => g.getTime() > at.getTime() - 86_400_000 && g.getTime() <= at.getTime() + 60_000);
  const last = given.reduce<Date | null>((m, g) => (m === null || g > m ? g : m), null);
  const byInterval = last === null ? null : new Date(last.getTime() + prn.minIntervalMinutes * 60_000);
  const capped = recent.length >= prn.max24h;
  let nextAt = byInterval !== null && byInterval.getTime() > at.getTime() ? byInterval : null;
  if (capped) {
    const oldest = recent.reduce((m, g) => (g < m ? g : m), recent[0]!);
    const freeAt = new Date(oldest.getTime() + 86_400_000);
    if (nextAt === null || freeAt > nextAt) nextAt = freeAt;
  }
  return { nextAt, in24h: recent.length, capped };
}

const COUNT_DOSE_UNITS = new Set(["tab", "cap", "amp", "vial", "sachet", "respule"]);
const MASS_IN_MG: Record<string, number> = { mg: 1, g: 1000, mcg: 0.001, "µg": 0.001 };
const UNIT_WORDS = new Set(["iu", "unit", "units"]);
const SINGLE_DOSE_CONTAINERS = /amp|ampoule|ampule|vial|syringe|pfs/i;

/**
 * E4.3 review — one dose in the LABEL's units (the issue's base unit: a tablet, a capsule, an ampoule). A count dose is its
 * own number (2 tab = 2); a mass or IU dose divides by the strength per unit ("500 mg" tablet: 250 mg = 0.5); a
 * concentration ("10 mg/ml", "100 mcg/2 ml") counts one container of that volume when the base unit is single-dose
 * (ampoule, vial), and a volume dose divides by it. NULL = a multi-dose container (a syrup bottle, an insulin vial or pen,
 * an inhaler): not counted per dose — its label stands until returned or superseded (DECIDED).
 */
export function unitsPerDose(o: { doseValue: number; doseUnit: string }, strengthLabel: string | null, baseUom: string | null): number | null {
  if (COUNT_DOSE_UNITS.has(o.doseUnit)) return o.doseValue;
  const m = (strengthLabel ?? "").toLowerCase().match(/(\d+(?:\.\d+)?)\s*(mg|g|mcg|µg|iu|units?)\b(\s*\/\s*(\d+(?:\.\d+)?)?\s*ml)?/);
  if (m === null) return null;
  const amount = Number(m[1]);
  const sUnit = m[2]!;
  const concentration = m[3] !== undefined;
  if (concentration && !SINGLE_DOSE_CONTAINERS.test(baseUom ?? "")) return null;
  const volume = m[4] === undefined ? 1 : Number(m[4]);
  if (o.doseUnit === "ml") return concentration ? o.doseValue / volume : null;
  if (MASS_IN_MG[o.doseUnit] !== undefined && MASS_IN_MG[sUnit] !== undefined) return (o.doseValue * MASS_IN_MG[o.doseUnit]!) / (amount * MASS_IN_MG[sUnit]!);
  if (UNIT_WORDS.has(o.doseUnit) && UNIT_WORDS.has(sUnit)) return o.doseValue / amount;
  return null;
}
