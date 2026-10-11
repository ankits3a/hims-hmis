/**
 * ═══ E2.2 — READING A LEAVE FROM THE WORDS, BY RULES (no model) ═══
 *
 * "kal CL chahiye", "20 se 22 oct EL", "Monday ko chhutti", "parso se 3 din ki leave". Pure: words
 * and today's IST day in, a kind and the days out. Nothing here reads a database or a clock.
 *
 * What is NOT read: a reason. The chat card has no reason field (decision 0069), so whatever else the
 * person typed is left where it was typed and never travels further.
 */

export type LeaveKindWord = "CL" | "EL" | "ML" | "comp_off";
export type LeaveDays = { from: string; to: string } | null;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  जनवरी: 1, फरवरी: 2, मार्च: 3, अप्रैल: 4, मई: 5, जून: 6, जुलाई: 7, अगस्त: 8, सितंबर: 9, अक्टूबर: 10, नवंबर: 11, दिसंबर: 12,
};
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, ravivar: 0, itwar: 0, इतवार: 0, रविवार: 0,
  monday: 1, mon: 1, somvar: 1, सोमवार: 1,
  tuesday: 2, tue: 2, mangalvar: 2, मंगलवार: 2,
  wednesday: 3, wed: 3, budhvar: 3, बुधवार: 3,
  thursday: 4, thu: 4, guruvar: 4, brihaspativar: 4, गुरुवार: 4, बृहस्पतिवार: 4,
  friday: 5, fri: 5, shukravar: 5, शुक्रवार: 5,
  saturday: 6, sat: 6, shanivar: 6, शनिवार: 6,
};
const RELATIVE: Record<string, number> = { aaj: 0, today: 0, आज: 0, kal: 1, tomorrow: 1, कल: 1, parso: 2, parson: 2, परसों: 2 };
const RANGE_WORDS = new Set(["se", "to", "till", "until", "tak", "-", "से", "तक", "–"]);
const DAY_WORDS = new Set(["din", "days", "day", "दिन"]);

const tokensOf = (typed: string): string[] =>
  typed.normalize("NFC").toLowerCase().replace(/<<p\d+>>/g, " ")
    .replace(/(\d)\s*[-–]\s*(\d)/g, "$1 - $2")
    .split(/[^\p{L}\p{M}\p{N}/\-–]+/u).filter((w) => w !== "");

const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay();
const pad = (n: number): string => String(n).padStart(2, "0");

/** The kind named, if one is: CL, EL, ML (sick / medical / bimar) or comp off. */
export function leaveKindOf(typed: string): LeaveKindWord | null {
  const t = ` ${typed.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")} `;
  if (/ comp ?off | compoff | comp off /.test(t)) return "comp_off";
  if (/ ml | medical | sick | bimar | beemar | बीमार | मेडिकल /.test(t)) return "ML";
  if (/ el | earned | privilege | pl | अर्जित /.test(t)) return "EL";
  if (/ cl | casual | आकस्मिक /.test(t)) return "CL";
  return null;
}

/** A day of the month with a month → the next such day on or after `today`. Null for 31 Feb. */
function dated(day: number, month: number, today: string, year?: number): string | null {
  const years = year !== undefined ? [year] : [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1];
  for (const y of years) {
    const d = `${String(y)}-${pad(month)}-${pad(day)}`;
    const parsed = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) return null;
    if (year !== undefined || d >= today) return d;
  }
  return null;
}

/** "20/10", "20-10-2026" → a day. */
function slashDate(w: string, today: string): string | null {
  const m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(w);
  if (m === null) return null;
  const year = m[3] === undefined ? undefined : Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
  return dated(Number(m[1]), Number(m[2]), today, year);
}

/**
 * The days a leave covers, both inclusive, or null when none was named. Reads, in order: a range of
 * two days ("20 se 22 oct", "kal se parso", "20/10 to 22/10"); one day and a count ("parso se 3 din");
 * one day. A bare number is a day of the month only next to a month name.
 */
export function leaveDaysOf(typed: string, today: string): LeaveDays {
  const w = tokensOf(typed);
  const days: { at: number; day: string }[] = [];
  let count: number | null = null;
  const monthAt = (i: number): number | undefined => (w[i] === undefined ? undefined : MONTHS[w[i]!]);
  for (let i = 0; i < w.length; i += 1) {
    const word = w[i]!;
    if (RELATIVE[word] !== undefined) { days.push({ at: i, day: addDays(today, RELATIVE[word]!) }); continue; }
    if (WEEKDAYS[word] !== undefined) {
      const ahead = (WEEKDAYS[word]! - weekday(today) + 7) % 7;
      days.push({ at: i, day: addDays(today, ahead === 0 ? 7 : ahead) });
      continue;
    }
    const slash = slashDate(word, today);
    if (slash !== null) { days.push({ at: i, day: slash }); continue; }
    if (!/^\d{1,2}$/.test(word)) continue;
    const n = Number(word);
    if (DAY_WORDS.has(w[i + 1] ?? "")) { count = n; continue; }
    // "20 oct", "oct 20", or "20 se 22 oct" (the first number borrows the month after the range).
    const month = monthAt(i + 1) ?? monthAt(i - 1)
      ?? (RANGE_WORDS.has(w[i + 1] ?? "") && /^\d{1,2}$/.test(w[i + 2] ?? "") ? monthAt(i + 3) : undefined);
    if (month === undefined) continue;
    const d = dated(n, month, today);
    if (d !== null) days.push({ at: i, day: d });
  }
  if (days.length === 0) return null;
  const first = days[0]!.day;
  if (days.length >= 2) {
    const second = days[1]!.day;
    // "20 dec se 2 jan": the end rolls into the next year when it would fall before the start.
    const to = second >= first ? second : dated(Number(second.slice(8, 10)), Number(second.slice(5, 7)), first) ?? second;
    return { from: first, to };
  }
  if (count !== null && count >= 1) return { from: first, to: addDays(first, count - 1) };
  return { from: first, to: first };
}
