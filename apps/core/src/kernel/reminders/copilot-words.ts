import { REMINDER_TEXT_MAX, istClock, istInstant } from "@hmis/contracts";
import type { ReminderRepeat } from "@hmis/contracts";

/**
 * ═══ E2.3 — READING A REMINDER FROM THE WORDS, BY RULES (no model) ═══
 * (spec /opt/hmis-context/SPEC-copilot-reminders-2026-10-12.md)
 *
 * "remind me at 4 to see bed 12", "kal subah 9 baje yaad dilana BP check", "roz 8 baje medicine round
 * yaad karana", "30 min baad yaad dilana call back". Pure: words and an instant in; the time, the
 * repeat and the reminder's own words out — what is left once the asking words and the time words are
 * taken away. Nothing here reads a database.
 *
 * A BARE HOUR (DECIDED, spec rule 3): 1–6 is afternoon, 7–11 morning, 12 noon. "subah / am", "dopahar",
 * "shaam / pm", "raat" say which half. A number is a time only when it is marked as one — "4 baje",
 * "4 pm", "at 4", "16:30", "subah 9" — so "bed 12" stays words. With no day named, a time already gone
 * today is tomorrow's; with a day named, it is refused (the person said that day).
 */

export type ReminderRead =
  | { ok: true; text: string; at: Date; repeat: ReminderRepeat }
  | { ok: false; why: "noTime" | "past" | "noText" | "tooLong" };

const DAY_MS = 86_400_000;
const MIN_LEAD_MS = 60_000;

const WEEKDAYS: [RegExp, number][] = [
  [/\b(sunday|sun|ravivar|itwar)\b|रविवार|इतवार/u, 0],
  [/\b(monday|mon|somvar|somwar)\b|सोमवार/u, 1],
  [/\b(tuesday|tue|tues|mangalvar|mangalwar)\b|मंगलवार/u, 2],
  [/\b(wednesday|wed|budhvar|budhwar)\b|बुधवार/u, 3],
  [/\b(thursday|thu|thurs|guruvar|guruwar)\b|गुरुवार/u, 4],
  [/\b(friday|fri|shukravar|shukrawar)\b|शुक्रवार/u, 5],
  [/\b(saturday|sat|shanivar|shaniwar)\b|शनिवार/u, 6],
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The words that ask for a reminder; taken out of the text. Longest first. */
const ASKING = [
  /\bset\s+(?:a\s+)?reminder\s*(?:for|to|that|about)?/giu,
  /\breminder\s*(?:set\s*kar(?:o|na|do|\s*do|\s*dena)?|laga(?:o|na|do|\s*do|\s*dena)?|daal(?:o|na|do)?|set)?/giu,
  /\bremind\s+me\s*(?:to|that|about|of)?/giu,
  /\bremind\b/giu,
  /\byaad\s*(?:dila|kara)\w*(?:\s*(?:dena|do|dijiye|dijiyega))?/giu,
  /याद\s*(?:दिला|करा)\S*(?:\s*(?:देना|दो|दीजिए|दीजियेगा))?/gu,
];
/** Left over at either end once the rest is gone: "to see bed 12" → "see bed 12". */
const EDGE_WORDS = new Set([
  "to", "that", "about", "for", "of", "at", "on", "me", "mujhe", "please", "pls", "plz", "ko", "ki", "ke", "ka", "liye", "se",
  "and", "hai", "mein", "main", "mai", "zara", "jara", "मुझे", "को", "की", "के", "का", "लिए", "से", "है", "में", "ज़रा",
]);

const pad = (n: number): string => String(n).padStart(2, "0");
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

function validDay(y: number, m: number, d: number): string | null {
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? at.toISOString().slice(0, 10) : null;
}
/** A day and month with no year: this year's, or next year's when this year's has gone. */
function nextDayMonth(today: string, m: number, d: number): string | null {
  const y = Number(today.slice(0, 4));
  const now = validDay(y, m, d);
  return now !== null && now >= today ? now : validDay(y + 1, m, d);
}

type Half = "am" | "pm" | "noon" | "night" | null;

/** An hour on the 24-hour clock, from the hour said and the half of the day said (rule 3). */
function hour24(h: number, half: Half): number | null {
  if (h > 23) return null;
  if (h > 12 || h === 0) return h;
  if (half === "am") return h === 12 ? 0 : h;
  if (half === "pm" || half === "noon") return h === 12 ? 12 : h + 12;
  if (half === "night") return h === 12 ? 0 : h >= 6 ? h + 12 : h;
  return h <= 6 ? h + 12 : h;
}

export function readReminder(typed: string, now: Date): ReminderRead {
  let s = ` ${typed.normalize("NFC")} `;
  const cut = (m: RegExpExecArray | null): void => { if (m !== null) s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length); };
  const today = istClock(now).day;

  for (const re of ASKING) s = s.replace(re, " ");

  /* ── repeat ── */
  let repeat: ReminderRepeat = "none";
  let weeklyOn: number | null = null;
  const monSat = /\b(?:mon(?:day)?\s*(?:-|–|to|se|till)\s*sat(?:urday)?|opd\s+days?|working\s+days?)\b/iu.exec(s);
  if (monSat !== null) { repeat = "mon_sat"; cut(monSat); }
  if (repeat === "none") {
    for (const [re, wd] of WEEKDAYS) {
      const every = new RegExp(`(?:\\b(?:har|every|each)\\s+|हर\\s+)(?:${re.source})`, "iu").exec(s);
      if (every === null) continue;
      repeat = "weekly"; weeklyOn = wd; cut(every);
      break;
    }
  }
  if (repeat === "none") {
    const daily = /\b(?:roz(?:ana)?|rozaana|daily|every\s*day|everyday|har\s*(?:din|roz))\b|हर\s*(?:दिन|रोज़?)|रोज़ाना|रोज़|रोज/iu.exec(s);
    if (daily !== null) { repeat = "daily"; cut(daily); }
  }

  /* ── "in 30 minutes", "2 ghante baad": a time from now, with no day and no clock ── */
  const n = (w: string): number => (/^(?:an?|one|ek|एक)$/iu.test(w) ? 1 : /^(?:aadh[ae]|half)$/iu.test(w) ? 0.5 : Number(w));
  const relAfter = /\b(\d{1,3}|ek|aadh[ae])\s*(min(?:ute)?s?|mint|ghan?te?|ghanta|hours?|hrs?)\s*(?:baad|bad|later|mein|me)\b|(\d{1,3}|एक)\s*(मिनट|घंटे|घंटा)\s*(?:बाद|में)/iu.exec(s);
  const relIn = relAfter === null ? /\bin\s+(\d{1,3}|an?|one|half\s+an?)\s*(min(?:ute)?s?|hours?|hrs?)\b/iu.exec(s) : null;
  let at: Date | null = null;
  let dayNamed = false;
  if (relAfter !== null || relIn !== null) {
    const m = (relAfter ?? relIn)!;
    const count = n((m[1] ?? m[4] ?? "").replace(/\s+an?$/iu, ""));
    const unit = (m[2] ?? m[5] ?? "").toLowerCase();
    const minutes = /^(min|mint|मिनट)/u.test(unit) ? count : count * 60;
    if (Number.isFinite(minutes) && minutes > 0) at = new Date(now.getTime() + Math.round(minutes) * 60_000);
    cut(m);
  } else {
    /* ── the day ── */
    let day: string | null = null;
    const named = /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/iu.exec(s);
    const namedRev = named === null ? /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/iu.exec(s) : null;
    const slash = named === null && namedRev === null ? /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/u.exec(s) : null;
    if (named !== null) { day = nextDayMonth(today, MONTHS.indexOf(named[2]!.toLowerCase()) + 1, Number(named[1])); cut(named); }
    else if (namedRev !== null) { day = nextDayMonth(today, MONTHS.indexOf(namedRev[1]!.toLowerCase()) + 1, Number(namedRev[2])); cut(namedRev); }
    else if (slash !== null) {
      const y = slash[3] === undefined ? null : Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
      day = y === null ? nextDayMonth(today, Number(slash[2]), Number(slash[1])) : validDay(y, Number(slash[2]), Number(slash[1]));
      cut(slash);
    } else {
      const rel: [RegExp, number][] = [
        [/\b(?:parso|parson|parsoon|day\s+after\s+tomorrow)\b|परसों/iu, 2],
        [/\b(?:kal|tomorrow|tmrw)\b|कल/iu, 1],
        [/\b(?:aaj|today)\b|आज/iu, 0],
      ];
      for (const [re, plus] of rel) {
        const m = re.exec(s);
        if (m === null) continue;
        day = addDays(today, plus); cut(m);
        break;
      }
      if (day === null && weeklyOn === null) {
        for (const [re, wd] of WEEKDAYS) {
          const m = re.exec(s);
          if (m === null) continue;
          day = addDays(today, (wd - weekdayOf(today) + 7) % 7); cut(m);
          break;
        }
      }
    }
    dayNamed = day !== null;

    /* ── the half of the day, wherever it was said ── */
    let half: Half = null;
    const halves: [RegExp, Half][] = [
      [/\b(?:subah|subha|savere|morning)\b|सुबह/iu, "am"],
      [/\b(?:dopahar|dophar|afternoon|noon)\b|दोपहर/iu, "noon"],
      [/\b(?:shaam|sham|evening)\b|शाम/iu, "pm"],
      [/\b(?:raat|rat|night|tonight)\b|रात/iu, "night"],
    ];
    for (const [re, h] of halves) {
      const m = re.exec(s);
      if (m === null) continue;
      half = h; cut(m);
      break;
    }

    /* ── the clock: only a number marked as a time ── */
    let hhmm: string | null = null;
    const clock = /(?:\b(?:at|@)\s*)?\b(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?(?:\s*(?:baje|bje|बजे))?/iu.exec(s);
    const marked = clock === null
      ? /(?:\b(?:at|@)\s*)?\b(\d{1,2})\s*(a\.?m\.?\b|p\.?m\.?\b|baje\b|bje\b|बजे|o'?\s*clock\b)/iu.exec(s)
        ?? /(?:\b(?:at|@)\s*)\b(\d{1,2})\b(?!\s*[:./-]?\d)/iu.exec(s)
      : null;
    const halfOf = (w: string | undefined): Half => (w === undefined ? half : /^a/iu.test(w) ? "am" : /^p/iu.test(w) ? "pm" : half);
    if (clock !== null && Number(clock[2]) < 60) {
      const h = hour24(Number(clock[1]), halfOf(clock[3]));
      if (h !== null) hhmm = `${pad(h)}:${clock[2]}`;
      cut(clock);
    } else if (marked !== null) {
      const h = hour24(Number(marked[1]), halfOf(marked[2]));
      if (h !== null) hhmm = `${pad(h)}:00`;
      cut(marked);
    }

    if (hhmm !== null) {
      let onDay = day ?? (weeklyOn !== null ? addDays(today, (weeklyOn - weekdayOf(today) + 7) % 7) : today);
      at = istInstant(onDay, hhmm);
      if (at !== null && at.getTime() < now.getTime() + MIN_LEAD_MS && !dayNamed) {
        onDay = addDays(onDay, weeklyOn !== null ? 7 : 1);
        at = istInstant(onDay, hhmm);
      }
    }
  }

  const text = wordsLeft(s);
  if (at === null) return { ok: false, why: "noTime" };
  if (at.getTime() < now.getTime() + MIN_LEAD_MS) return { ok: false, why: "past" };
  if (text === "") return { ok: false, why: "noText" };
  if (text.length > REMINDER_TEXT_MAX) return { ok: false, why: "tooLong" };
  return { ok: true, text, at, repeat };
}

/** What is left, without the joining words at its ends: "to see bed 12 ke liye" → "see bed 12". */
function wordsLeft(s: string): string {
  const words = s.replace(/[,;:!?।]+/gu, " ").split(/\s+/u).filter((w) => w !== "" && !/^[.\-–]+$/u.test(w));
  while (words.length > 0 && EDGE_WORDS.has(words[0]!.toLowerCase())) words.shift();
  while (words.length > 0 && EDGE_WORDS.has(words[words.length - 1]!.toLowerCase().replace(/\.$/u, ""))) words.pop();
  return words.join(" ").replace(/\.$/u, "").trim();
}
