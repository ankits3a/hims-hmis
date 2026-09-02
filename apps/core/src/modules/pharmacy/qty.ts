import type { RxLine } from "../opd";

/**
 * PLAN 16c D5 — THE QUANTITY IS THE PHARMACIST'S; THIS ONLY PREFILLS IT. PURE.
 *
 * An Indian e-Rx says "1 tab · TDS · 5 days", never "15 tablets", so the counter derives a
 * starting number and the pharmacist confirms or edits it. Anything this parser cannot read with
 * confidence returns `null` and the field starts blank — a wrong prefill that looks right is worse
 * than no prefill. `SOS`/`PRN` (as needed) is always blank: "as needed × 5 days" is not a number.
 */
const FREQ_PER_DAY: Record<string, number> = {
  od: 1, "once daily": 1, daily: 1, hs: 1, "at night": 1, "at bedtime": 1, qd: 1, "1x": 1,
  bd: 2, bid: 2, "twice daily": 2, "twice a day": 2, "2x": 2,
  tds: 3, tid: 3, "thrice daily": 3, "three times a day": 3, "3x": 3,
  qid: 4, "four times a day": 4, "4x": 4,
};

/** `1-0-1` / `1-1-1` / `0-0-1` — the morning-noon-night notation, summed. */
function tripletPerDay(freq: string): number | null {
  const m = /^(\d+(?:\.\d+)?|½|1\/2)\s*-\s*(\d+(?:\.\d+)?|½|1\/2)\s*-\s*(\d+(?:\.\d+)?|½|1\/2)$/.exec(freq);
  if (m === null) return null;
  const parse = (s: string): number => (s === "½" || s === "1/2" ? 0.5 : Number(s));
  const total = parse(m[1]!) + parse(m[2]!) + parse(m[3]!);
  return total > 0 ? total : null;
}

export function dosesPerDay(frequency: string): number | null {
  const f = frequency.trim().toLowerCase().replace(/\s+/g, " ");
  if (f === "") return null;
  if (/\b(sos|prn|as needed|when required)\b/.test(f)) return null;
  const triplet = tripletPerDay(f);
  if (triplet !== null) return triplet;
  const known = FREQ_PER_DAY[f];
  if (known !== undefined) return known;
  const every = /^(?:q|every)\s*(\d+)\s*(?:h|hr|hrs|hours?|hourly)$/.exec(f);
  if (every !== null) {
    const hours = Number(every[1]);
    return hours > 0 && 24 % hours === 0 ? 24 / hours : null;
  }
  return null;
}

/** The leading number of a dose — "1 tab", "2 tabs", "½ tab", "5 ml", "10 mg" → 1, 2, 0.5, 5, 10. */
export function doseUnits(dose: string): number | null {
  const d = dose.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?|½|1\/2)(?=\s|$)/.exec(d);
  if (m === null) return null;
  const n = m[1] === "½" || m[1] === "1/2" ? 0.5 : Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * Base units to dispense, or `null`. Units follow the dose ("5 ml" × 2 × 5 = 50 ml; "1 tab" × 3 × 5
 * = 15 tablets); a half-tablet dose rounds UP because a strip cannot be cut at the counter.
 */
export function prefillQtyBase(line: Pick<RxLine, "dose" | "frequency" | "durationDays">): number | null {
  if (line.durationDays === null || !Number.isSafeInteger(line.durationDays) || line.durationDays <= 0) return null;
  const perDay = dosesPerDay(line.frequency);
  const units = doseUnits(line.dose);
  if (perDay === null || units === null) return null;
  // A triplet like 1-0-1 already carries the per-dose count when the dose is "1 tab"; "2 tab 1-0-1" means 2 each time.
  const qty = Math.ceil(units * perDay * line.durationDays);
  return qty > 0 ? qty : null;
}
