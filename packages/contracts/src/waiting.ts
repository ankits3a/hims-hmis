/**
 * ═══ "WAITING FOR ME" — OPEN LOOPS (E1.4) AND THE MORNING CARD (E1.5), decision 0064 ═══
 *
 * `GET /me/waiting` answers, for the person asking and nobody else, one line per KIND of thing that
 * is waiting on them: reports back on their patients, unread imaging, critical calls, bell rows
 * nobody answered, reminders and duties still to come today. The phone's home card, the phone's
 * "Open loops" screen and the web's My day all draw THIS file's `waitingLines()` over the same
 * answer, so the three lists cannot disagree (spec: /opt/hmis-context/SPEC-morning-card-2026-10-11.md).
 *
 * COUNTS ONLY. An item carries a kind, a number, the oldest instant and a web link — never a patient
 * name, a UHID, a test name or an id — because the home card is read over a shoulder and a phone's
 * lock screen shows whatever the app hands it. Nothing here is money: no kind is a payment, so a
 * doctor's screen can never be handed one.
 *
 * Pure TypeScript with NO imports: the phone app (not in the pnpm workspace) imports this file by
 * relative path and must not pull zod.
 */

/** Every kind, in the order the lines are drawn: a patient at risk first, then results, then the person's own day. */
export const WAITING_KINDS = [
  "lab.criticalsMine",
  "radiology.criticalsMine",
  "lab.callsOpen",
  "radiology.readsOverdue",
  "lab.reportsBack",
  "radiology.unreadMine",
  "alerts.unanswered",
  "reminders.today",
  "roster.dutiesToday",
] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

export type WaitingTone = "hot" | "warn" | "calm";

/** One line on the wire. `href` is the WEB screen; the phone maps the kind itself (`appTargetOf`). */
export type WaitingItem = {
  kind: WaitingKind;
  count: number;
  /** ISO instant of the oldest thing behind the count, or null when age means nothing (reminders, duties). */
  oldestAt: string | null;
  tone: WaitingTone;
  href: string | null;
};

export type WireWaiting = { items: WaitingItem[] };

/** The web screen behind each kind. Null: the thing lives only on the phone (reminders) or in the bell. */
export const WAITING_WEB_HREF: Record<WaitingKind, string | null> = {
  "lab.criticalsMine": "/opd/consult",
  "radiology.criticalsMine": "/opd/consult",
  "lab.callsOpen": "/lab/bench",
  "radiology.readsOverdue": "/radiology/read",
  "lab.reportsBack": "/opd/consult",
  "radiology.unreadMine": "/opd/consult",
  "alerts.unanswered": null,
  "reminders.today": null,
  "roster.dutiesToday": "/roster/my-duties",
};

export const WAITING_TONE: Record<WaitingKind, WaitingTone> = {
  "lab.criticalsMine": "hot",
  "radiology.criticalsMine": "hot",
  "lab.callsOpen": "hot",
  "radiology.readsOverdue": "warn",
  "lab.reportsBack": "calm",
  "radiology.unreadMine": "warn",
  "alerts.unanswered": "warn",
  "reminders.today": "calm",
  "roster.dutiesToday": "calm",
};

/**
 * Where a phone line goes. A phone screen exists for the bell, reminders and my duties; the rest is
 * worked on the computer today, so the phone opens the Open loops screen on that kind and says where.
 */
export type WaitingAppTarget =
  | { type: "route"; path: "/alerts" | "/reminders" }
  | { type: "seat"; key: "myDuties" }
  | { type: "loops"; kind: WaitingKind };

export function appTargetOf(kind: WaitingKind): WaitingAppTarget {
  if (kind === "alerts.unanswered") return { type: "route", path: "/alerts" };
  if (kind === "reminders.today") return { type: "route", path: "/reminders" };
  if (kind === "roster.dutiesToday") return { type: "seat", key: "myDuties" };
  return { type: "loops", kind };
}

/** A drawn line: what both clients render, in the same order, from the same answer. */
export type WaitingLine = { kind: WaitingKind; count: number; tone: WaitingTone; oldestAt: string | null; href: string | null };

const RANK = new Map<string, number>(WAITING_KINDS.map((k, i) => [k, i] as const));

/**
 * The list both clients draw. Unknown kinds (a newer server) and zero counts are dropped; the order
 * is `WAITING_KINDS`, never the server's array order, so a client cannot be reordered by accident.
 */
export function waitingLines(answer: WireWaiting | null | undefined): WaitingLine[] {
  if (answer == null || !Array.isArray(answer.items)) return [];
  return answer.items
    .filter((i) => RANK.has(i.kind) && Number.isInteger(i.count) && i.count > 0)
    .sort((a, b) => (RANK.get(a.kind) ?? 0) - (RANK.get(b.kind) ?? 0))
    .map((i) => ({ kind: i.kind, count: i.count, tone: i.tone, oldestAt: i.oldestAt, href: i.href }));
}

/** How long the oldest has waited, as the short words both clients print: "12 m", "3 h", "2 d". */
export function waitingAge(oldestAt: string | null, nowMs: number): string | null {
  if (oldestAt === null) return null;
  const t = new Date(oldestAt).getTime();
  if (Number.isNaN(t)) return null;
  const min = Math.max(0, Math.floor((nowMs - t) / 60_000));
  if (min < 60) return `${String(min)} m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${String(h)} h`;
  return `${String(Math.floor(h / 24))} d`;
}
