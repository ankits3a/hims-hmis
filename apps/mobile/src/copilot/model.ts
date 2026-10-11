import { SEATS, type EffectivePermissions, type Seat } from "../seats";

/**
 * E1.3 — THE COPILOT ON THE PHONE (decision 0064; spec /opt/hmis-context/SPEC-copilot-phone-2026-10-11.md).
 *
 * The phone asks the SAME `POST /copilot/ask` as the web, sends no `terms` (the server masks the
 * day's patient names itself, E0.6), and says where the question came from: a chip or the keyboard.
 * Nothing here is stored: the conversation lives in the screen's memory and ends with it.
 */
export type CopilotAnswer = { key: string; params: Record<string, string | number>; payload?: unknown };
export type AskReply = { answer: CopilotAnswer; source: "phrasebook" | "model" | "none"; intent: string | null; askId?: string };
export type AskSource = "chip" | "typed";

/** The ledger's screen slug for every phone ask (the server's `screen` regex: lower-case, ≤40). */
export const PHONE_SCREEN = "phone";

export type ChipKey = "queue" | "myDuty" | "myNight" | "myDay";

/**
 * Each chip's question is its own label (`copilotPhone.chip.<key>`), in the reader's language: every
 * label is a phrasebook phrase for its intent, so a chip is answered without a model
 * (`apps/core/src/kernel/copilot/phone-chips.test.ts` routes each one). `permission` is what the
 * intent's tool needs — a chip the person could only be refused on is never offered.
 */
export const CHIPS: Record<ChipKey, { intent: string; permission: string | null }> = {
  queue: { intent: "queue_depth", permission: "opd.queue.read" },
  myDuty: { intent: "roster.my_duties", permission: "roster.read" },
  myNight: { intent: "roster.my_duties", permission: "roster.read" },
  myDay: { intent: "my_day_report", permission: null },
};

/** DECIDED (spec §7): each seat's top three questions, best first. */
export const SEAT_CHIPS: Record<Seat["key"], ChipKey[]> = {
  consult: ["queue", "myDuty", "myNight"],
  vitals: ["queue", "myDuty", "myNight"],
  counter: ["queue", "myDuty", "myDay"],
  slips: ["queue", "myDuty", "myDay"],
  onNow: ["myDuty", "myNight", "myDay"],
  myDuties: ["myDuty", "myNight", "myDay"],
};

function holds(p: EffectivePermissions, permission: string | null): boolean {
  if (permission === null) return true;
  if (p.hospital.includes(permission)) return true;
  return [...Object.values(p.scoped.department), ...Object.values(p.scoped.floor)].some((l) => l.includes(permission));
}

/**
 * The three chips for this person: their seats in the home screen's order, each seat's chips in its
 * own order, only those the person may ask, no repeats, at most three — and "My day report" (which
 * needs no permission) when fewer are left.
 */
export function chipsFor(p: EffectivePermissions): ChipKey[] {
  const out: ChipKey[] = [];
  const seats = SEATS.filter((s) => holds(p, s.permission));
  for (const seat of seats) {
    for (const c of SEAT_CHIPS[seat.key]) if (!out.includes(c) && holds(p, CHIPS[c].permission)) out.push(c);
  }
  if (!out.includes("myDay")) out.push("myDay");
  return out.slice(0, 3);
}

/* ═══ THE ROSTER'S ANSWERS IN THE BOARDS' VOICE — ported from apps/web/src/lib/use-copilot.tsx `sayParams` ═══
 * The roster tools send a day as its IST date and an instant as ISO; they are said as the web says them,
 * so the phone's sentence is the web's sentence. Every other key's params pass through untouched. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
type Tr = (key: string, vars?: Record<string, string | number>) => string;

export function dayWords(at: Date, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-IN", {
      weekday: "long", day: "numeric", month: "short", timeZone: "Asia/Kolkata",
    }).format(at).replace(",", "");
  } catch {
    return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  }
}
function clockWords(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
}

export function sayParams(key: string, params: Record<string, string | number>, t: Tr, lang: string): Record<string, string | number> {
  if (!key.startsWith("copilot.answer.roster")) return params;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string") { out[k] = v; continue; }
    if (v === "") out[k] = t("copilot.when.nobody");
    else if (k === "when" && v === "now") out[k] = t("copilot.when.now");
    else if (ISO_DAY.test(v)) out[k] = dayWords(new Date(`${v}T12:00:00+05:30`), lang);
    else if (ISO_INSTANT.test(v)) {
      const at = new Date(v);
      out[k] = t(k === "when" ? "copilot.when.at" : "copilot.when.stamp", { day: dayWords(at, lang), time: clockWords(at) });
    } else out[k] = v;
  }
  return out;
}

/** The answer's sentence, exactly as the web's dock says it. */
export function answerText(reply: AskReply, t: Tr, lang: string): string {
  return t(reply.answer.key, sayParams(reply.answer.key, reply.answer.params, t, lang));
}
