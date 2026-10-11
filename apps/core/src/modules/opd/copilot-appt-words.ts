import { addDays, istWeekday } from "./time";

/**
 * E2.1 — READING A BOOKING QUESTION'S WORDS: the doctor, the day, the time, tele-call or not, and what
 * is left as a patient's name. Pure (today is passed in), by rules, no model — so every rule is a unit
 * test (`copilot-appointments.test.ts`). The tools that use it are in `copilot-appointments.ts`.
 */

const WORD_RE = /[\p{L}\p{M}]+|\d+/gu;
const words = (s: string): string[] => [...s.toLowerCase().matchAll(WORD_RE)].map((m) => m[0]);

const DR_MARKERS = new Set(["dr", "doctor", "doc", "डॉ", "डॉक्टर", "डा", "डाक्टर"]);
const TITLE_WORDS = new Set(["dr", "doctor", "prof", "md", "ms"]);

export type DoctorLite = { id: string; displayName: string };

function nameTokens(displayName: string): string[] {
  return words(displayName).filter((w) => !TITLE_WORDS.has(w) && w.length >= 3);
}

/**
 * The doctor the question names. A doctor is named by a word right after "Dr"/"doctor" ("Dr Singh",
 * "doctor Anil Sharma"), or by two of their name words anywhere ("Anil Sharma"). A lone name word
 * WITHOUT a marker is not a doctor: "Anil Kumar ka appointment" names a patient called Anil, and
 * must never move him to Dr Anil Sharma.
 */
export function namedDoctors(typed: string, doctors: readonly DoctorLite[]): { doctors: DoctorLite[]; tokens: Set<string> } {
  const w = words(typed);
  const afterMarker = new Set<string>();
  w.forEach((x, i) => {
    if (!DR_MARKERS.has(x)) return;
    if (w[i + 1] !== undefined) afterMarker.add(w[i + 1]!);
    if (w[i + 2] !== undefined) afterMarker.add(w[i + 2]!);
  });
  const all = new Set(w);
  const scored = doctors.map((d) => {
    const toks = nameTokens(d.displayName);
    const marked = toks.filter((t) => afterMarker.has(t));
    const anywhere = toks.filter((t) => all.has(t));
    const score = anywhere.length >= 2 ? anywhere.length + 1 : marked.length;
    return { d, score, used: anywhere.length >= 2 ? anywhere : marked };
  }).filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best);
  return { doctors: top.map((x) => x.d), tokens: new Set(top.flatMap((x) => x.used)) };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const WEEKDAY_WORDS: [RegExp, number][] = [
  [/\b(sunday|sun|ravivar|raviwar|itwar|itvar)\b|रविवार|इतवार/u, 0],
  [/\b(monday|mon|somvar|somwar)\b|सोमवार/u, 1],
  [/\b(tuesday|tue|tues|mangalvar|mangalwar)\b|मंगलवार/u, 2],
  [/\b(wednesday|wed|budhvar|budhwar)\b|बुधवार/u, 3],
  [/\b(thursday|thu|thur|thurs|guruvar|guruwar|brihaspativar)\b|गुरुवार|बृहस्पतिवार/u, 4],
  [/\b(friday|fri|shukravar|shukrawar)\b|शुक्रवार/u, 5],
  [/\b(saturday|sat|shanivar|shaniwar)\b|शनिवार/u, 6],
];

function validDate(y: number, m: number, d: number): string | null {
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return at.toISOString().slice(0, 10);
}

/** A day and month with no year: this year, or next year if that day has already gone. */
function nextDayMonth(today: string, m: number, d: number): string | null {
  const y = Number(today.slice(0, 4));
  const thisYear = validDate(y, m, d);
  if (thisYear !== null && thisYear >= today) return thisYear;
  return validDate(y + 1, m, d);
}

export type When = { day: string | null; from: string | null };

/**
 * The day and the earliest time the question asks for, in IST. `day` null = "the next free", from
 * today; `from` null = any time that day. Dates are read first and blanked, so "12/10 ko 10 baje"
 * does not read "12" or "10" twice.
 */
export function parseWhen(typed: string, today: string): When {
  let s = ` ${typed.toLowerCase()} `;
  let day: string | null = null;

  const named = /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(s)
    ?? null;
  const namedRev = named === null ? /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/.exec(s) : null;
  const slash = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(s);
  const tarikh = /\b(\d{1,2})\s*(?:tarikh|tareekh|tarik|तारीख)/u.exec(s);
  if (named !== null) {
    day = nextDayMonth(today, MONTHS.indexOf(named[2]!) + 1, Number(named[1]));
    s = s.replace(named[0], " ");
  } else if (namedRev !== null) {
    day = nextDayMonth(today, MONTHS.indexOf(namedRev[1]!) + 1, Number(namedRev[2]));
    s = s.replace(namedRev[0], " ");
  } else if (slash !== null) {
    const y = slash[3] === undefined ? null : Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    day = y === null ? nextDayMonth(today, Number(slash[2]), Number(slash[1])) : validDate(y, Number(slash[2]), Number(slash[1]));
    s = s.replace(slash[0], " ");
  } else if (tarikh !== null) {
    const d = Number(tarikh[1]);
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const thisMonth = validDate(y, m, d);
    day = thisMonth !== null && thisMonth >= today ? thisMonth : m === 12 ? validDate(y + 1, 1, d) : validDate(y, m + 1, d);
    s = s.replace(tarikh[0], " ");
  } else if (/\b(parso|parson|parsoon)\b|day after tomorrow|परसों/u.test(s)) {
    day = addDays(today, 2);
  } else if (/\b(kal|kl|tomorrow|tmrw)\b|कल/u.test(s)) {
    day = addDays(today, 1);
  } else if (/\b(aaj|aj|today)\b|आज/u.test(s)) {
    day = today;
  } else {
    for (const [re, wd] of WEEKDAY_WORDS) {
      if (!re.test(s)) continue;
      day = addDays(today, (wd - istWeekday(today) + 7) % 7);
      break;
    }
  }

  let from: string | null = null;
  const clock = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/.exec(s);
  const hour = clock === null ? /\b(\d{1,2})\s*(am|pm|baje|bje|बजे)/u.exec(s) : null;
  const hh = (h: number, ampm: string | undefined): number | null => {
    if (h > 23) return null;
    if (ampm === "am") return h === 12 ? 0 : h;
    if (ampm === "pm") return h < 12 ? h + 12 : h;
    /* "4 baje" at an OPD is four in the afternoon: no clinic runs at 4 a.m. */
    return h >= 1 && h <= 7 ? h + 12 : h;
  };
  if (clock !== null) {
    const h = hh(Number(clock[1]), clock[3]);
    if (h !== null && Number(clock[2]) < 60) from = `${String(h).padStart(2, "0")}:${clock[2]}`;
  } else if (hour !== null) {
    const h = hh(Number(hour[1]), hour[2] === "am" || hour[2] === "pm" ? hour[2] : undefined);
    if (h !== null) from = `${String(h).padStart(2, "0")}:00`;
  } else if (/\b(shaam|sham|evening)\b|शाम/u.test(s)) {
    from = "16:00";
  } else if (/\b(dopahar|dophar|afternoon)\b|दोपहर/u.test(s)) {
    from = "12:00";
  }
  return { day, from };
}

/** A tele-call ("phone-icon" appointment, owner 2026-10-09): "tele", "phone pe", "call par", "video". */
export function asksTele(typed: string): boolean {
  const s = typed.toLowerCase();
  return /\btele|\bvideo\b/.test(s) || /\b(phone|call|fone)\s*(pe|par|pr|se|on)\b/.test(s) || /(फ़ोन|फोन|कॉल)\s*(पे|पर|से)/u.test(s);
}

/**
 * Words that are never a patient's name in a booking question: the cues, the days, the times, the
 * glue of Hinglish. What is left after these and the doctor's name is searched as a name.
 */
const NOT_A_NAME = new Set([
  "ka", "ki", "ke", "ko", "kaa", "se", "pe", "par", "pr", "me", "mein", "main", "liye", "lie", "wala", "wali", "wale",
  "hai", "hain", "ho", "karo", "kar", "kardo", "karna", "karde", "do", "de", "dena", "dijiye", "please", "pls", "plz",
  "ji", "sir", "madam", "sahab", "saheb", "for", "the", "a", "an", "to", "with", "on", "at", "of", "and", "is", "my",
  "appointment", "appointments", "appt", "apointment", "appoinment", "book", "booking", "laga", "lagao", "lagado", "lagana",
  "move", "shift", "reschedule", "badal", "badlo", "badal", "change", "postpone", "prepone", "aage", "peeche", "piche",
  "time", "slot", "date", "new", "naya", "nayi", "patient", "mareez", "marij", "mariz",
  "aaj", "aj", "kal", "kl", "parso", "parson", "today", "tomorrow", "tmrw", "day", "after", "next", "agle", "agla",
  "baje", "bje", "am", "pm", "subah", "shaam", "sham", "dopahar", "morning", "evening", "afternoon", "tarikh", "tareekh",
  "tele", "telecall", "teleconsult", "video", "phone", "fone", "call", "consult", "consultation", "opd",
  "dr", "doctor", "doc", "prof",
  "का", "की", "के", "को", "से", "पर", "पे", "में", "लिए", "है", "करो", "कर", "दो", "दें", "जी", "अपॉइंटमेंट", "बुक", "लगा",
  "लगाओ", "बदल", "बदलो", "शिफ्ट", "आज", "कल", "परसों", "बजे", "सुबह", "शाम", "दोपहर", "फ़ोन", "फोन", "डॉ", "डॉक्टर", "मरीज़",
  "मरीज", "तारीख",
  ...MONTHS, "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sun", "mon", "tue", "wed", "thu", "fri", "sat",
  "somvar", "somwar", "mangalvar", "mangalwar", "budhvar", "budhwar", "guruvar", "guruwar", "shukravar", "shukrawar",
  "shanivar", "shaniwar", "ravivar", "raviwar", "itwar",
]);

/** The words left to search as a patient's name, or "" when the question names nobody by name. */
export function nameQuery(typed: string, doctorTokens: ReadonlySet<string>): string {
  return words(typed)
    .filter((w) => !/^\d+$/.test(w) && w.length >= 2 && !NOT_A_NAME.has(w) && !doctorTokens.has(w))
    .filter((w) => !/^(appoint|apoint|reschedul|book)/.test(w))
    .slice(0, 4)
    .join(" ");
}
