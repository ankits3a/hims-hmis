import type { WireWaiting } from "./waiting";

/**
 * E1.4 — ONE answer both clients' tests render (done-means 3: "the phone list equals the web list
 * for the same user and fixture"). Deliberately out of order, with a zero count and a kind no client
 * knows, so a client that drew the server's array as-is would disagree with `WAITING_EXPECTED`.
 * Test data only; nothing in an app imports it.
 */
export const WAITING_FIXTURE: WireWaiting = {
  items: [
    { kind: "roster.dutiesToday", count: 2, oldestAt: null, tone: "calm", href: "/roster/my-duties" },
    { kind: "radiology.unreadMine", count: 1, oldestAt: "2026-10-10T20:00:00.000Z", tone: "warn", href: "/opd/consult" },
    { kind: "alerts.unanswered", count: 3, oldestAt: "2026-10-10T18:00:00.000Z", tone: "warn", href: null },
    { kind: "lab.reportsBack", count: 2, oldestAt: "2026-10-10T19:00:00.000Z", tone: "calm", href: "/opd/consult" },
    { kind: "lab.callsOpen", count: 0, oldestAt: null, tone: "hot", href: "/lab/bench" },
    { kind: "reminders.today", count: 1, oldestAt: null, tone: "calm", href: null },
    { kind: "billing.notAKind" as never, count: 9, oldestAt: null, tone: "calm", href: "/billing" },
    { kind: "lab.criticalsMine", count: 1, oldestAt: "2026-10-10T21:00:00.000Z", tone: "hot", href: "/opd/consult" },
  ],
};

/** What every client must draw from `WAITING_FIXTURE`: kind and count, top to bottom. */
export const WAITING_EXPECTED: readonly (readonly [string, number])[] = [
  ["lab.criticalsMine", 1],
  ["lab.reportsBack", 2],
  ["radiology.unreadMine", 1],
  ["alerts.unanswered", 3],
  ["reminders.today", 1],
  ["roster.dutiesToday", 2],
];
