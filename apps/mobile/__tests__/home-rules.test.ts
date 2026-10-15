import { readFileSync } from "fs";
import { join } from "path";
import {
  MAX_NEEDS, STEP_UP_WINDOW_MS, approvalDeadlineMinutes, approvalDueAtMs, bestDay, capNeeds, clockWords, isMoneyApproval,
  orderNeeds, percentAgainst, sparkPoints, toneOf, type Need,
} from "../src/home/rules";
import { buildHome, rupees, type Sources, type WireApproval } from "../src/home/model";

const MIN = 60_000, H = 60 * MIN;
const NOW = new Date("2026-10-07T05:28:00.000Z").getTime(); // 10:58 IST
const n = (id: string, tone: Need["tone"], sinceMin: number, dueMin: number | null): Need => ({ id, kind: "approval", sinceMs: NOW - sinceMin * MIN, dueMs: dueMin === null ? null : NOW + dueMin * MIN, tone });

describe("app home — the rules the server and the phone share", () => {
  it("is one file: the phone re-exports the server's rules and grows none of its own", () => {
    const src = readFileSync(join(__dirname, "../src/home/rules.ts"), "utf8");
    expect(src).toContain('export * from "../../../../packages/contracts/src/app-home"');
    expect(src).not.toMatch(/function |=>/);
  });

  it("deadlines by kind: refunds and discounts 2 h, price changes 24 h, an unknown kind none (owner 2026-10-07)", () => {
    expect(approvalDeadlineMinutes("billing_refund")).toBe(120);
    expect(approvalDeadlineMinutes("billing_refund_owner")).toBe(120);
    expect(approvalDeadlineMinutes("billing_discount")).toBe(120);
    expect(approvalDeadlineMinutes("pharmacy_discount_owner")).toBe(120);
    expect(approvalDeadlineMinutes("tariff_revision")).toBe(24 * 60);
    expect(approvalDeadlineMinutes("something_new")).toBeNull();
    expect(approvalDueAtMs("billing_refund", NOW)).toBe(NOW + 2 * H);
    expect(approvalDueAtMs("something_new", NOW)).toBeNull();
  });

  it("the clock: neutral, amber at half its time, red when over — and plain waiting has its own thresholds", () => {
    const since = NOW - 59 * MIN, due = since + 2 * H;
    expect(toneOf(NOW, since, due)).toBe("neutral");
    expect(toneOf(since + 60 * MIN, since, due)).toBe("amber");
    expect(toneOf(due - 1, since, due)).toBe("amber");
    expect(toneOf(due, since, due)).toBe("red");
    expect(toneOf(NOW, NOW - 19 * MIN, null, { amberAfterMin: 20, redAfterMin: 40 })).toBe("neutral");
    expect(toneOf(NOW, NOW - 20 * MIN, null, { amberAfterMin: 20, redAfterMin: 40 })).toBe("amber");
    expect(toneOf(NOW, NOW - 41 * MIN, null, { amberAfterMin: 20, redAfterMin: 40 })).toBe("red");
    expect(toneOf(NOW, NOW - 500 * MIN, null)).toBe("neutral");
  });

  it("the clock is said in words: waiting, due in, overdue, starts in", () => {
    expect(clockWords(NOW, NOW - 125 * MIN, null)).toEqual({ key: "home.clock.waiting", span: { hours: 2, minutes: 5 } });
    expect(clockWords(NOW, NOW - 30 * MIN, NOW + 90 * MIN)).toEqual({ key: "home.clock.waiting", span: { hours: 0, minutes: 30 } });
    expect(clockWords(NOW, NOW - 135 * MIN, NOW - 15 * MIN)).toEqual({ key: "home.clock.overdue", span: { hours: 0, minutes: 15 } });
    expect(clockWords(NOW, NOW - 30 * MIN, NOW + 3 * H, "due")).toEqual({ key: "home.clock.dueIn", span: { hours: 3, minutes: 0 } });
    expect(clockWords(NOW, NOW, NOW + 5 * H, "starts")).toEqual({ key: "home.clock.startsIn", span: { hours: 5, minutes: 0 } });
  });

  it(`five cards at most, red first, then amber, then neutral — and inside a tone the oldest clock leads`, () => {
    const needs = [n("a", "neutral", 5, null), n("b", "amber", 70, 50), n("c", "red", 130, -10), n("d", "red", 300, -180), n("e", "amber", 90, 30), n("f", "neutral", 40, null), n("g", "neutral", 2, null)];
    expect(orderNeeds(needs).map((x) => x.id)).toEqual(["d", "c", "e", "b", "f", "a", "g"]);
    const capped = capNeeds(needs);
    expect(MAX_NEEDS).toBe(5);
    expect(capped.shown.map((x) => x.id)).toEqual(["d", "c", "e", "b", "f"]);
    expect([capped.total, capped.hidden]).toEqual([7, 2]);
  });

  it("which approvals ask for the fingerprint: anything with an amount, a price change, credit — not a record merge", () => {
    expect(isMoneyApproval("billing_refund", 120_000)).toBe(true);
    expect(isMoneyApproval("patient_merge", 5)).toBe(true); // an amount is money, whatever the kind
    expect(isMoneyApproval("tariff_revision", null)).toBe(true);
    expect(isMoneyApproval("billing_credit_extension", null)).toBe(true);
    expect(isMoneyApproval("materials_po_approval", null)).toBe(true);
    expect(isMoneyApproval("patient_merge", null)).toBe(false);
    expect(isMoneyApproval("imaging_definition_publish", null)).toBe(false);
    expect(STEP_UP_WINDOW_MS).toBe(2 * MIN);
  });

  it("thirty days: the best day, one point per WORKING day, and a percent only when there is a usual", () => {
    const s = [{ day: "2026-09-26", value: 14 }, { day: "2026-09-27", value: 27 }, { day: "2026-09-28", value: 0 }, { day: "2026-09-29", value: 27 }];
    expect(bestDay(s)).toEqual({ day: "2026-09-29", value: 27 });
    expect(bestDay([{ day: "x", value: 0 }])).toBeNull();
    expect(sparkPoints(s, 300, 40)).toHaveLength(3);
    expect(sparkPoints(s, 300, 40)[2]!.x).toBe(300);
    expect(percentAgainst(118, 104)).toBe(13);
    expect(percentAgainst(118, null)).toBeNull();
  });
});

describe("app home — the model: what the first screen says", () => {
  const base: Sources = { nowMs: NOW, permissions: [], seats: [] };
  const approval = (id: string, typeKey: string, minutesAgo: number, amountPaise: number | null): WireApproval => {
    const requestedAt = NOW - minutesAgo * MIN, due = approvalDueAtMs(typeKey, requestedAt);
    return { id, typeKey, amountPaise, requestedAt: new Date(requestedAt).toISOString(), dueAt: due === null ? null : new Date(due).toISOString(), requesterName: "Asha Devi", requestNote: "visit cancelled", patient: null };
  };

  it("nothing pending is the calm state: no cards, no clock", () => {
    const m = buildHome(base);
    expect([m.needs, m.needsTotal, m.tiles, m.analytics]).toEqual([[], 0, [], null]);
  });

  it("an approval card carries its kind's clock; without the decide permission it has no button", () => {
    const src = { ...base, approvals: [approval("r1", "billing_refund", 130, 120_000), approval("p1", "tariff_revision", 125, null)] };
    const reader = buildHome(src);
    expect(reader.needs.map((c) => [c.id, c.tone, c.clock?.key])).toEqual([
      ["approval:r1", "red", "home.clock.overdue"],
      ["approval:p1", "neutral", "home.clock.waiting"],
    ]);
    expect(reader.needs[0]!.titleVars).toEqual({ amount: "₹1,200" });
    expect(reader.needs.every((c) => c.actions.length === 0)).toBe(true);
    const decider = buildHome({ ...src, permissions: ["approvals.requests.decide"] });
    expect(decider.needs[0]!.actions).toEqual([{ labelKey: "home.act.review", primary: true, action: { type: "approval", id: "r1", decide: "open" } }]);
  });

  it("blind count: a cashier's collected tile is LOCKED and carries no amount until the drawer is counted", () => {
    const m = buildHome({ ...base, seats: ["counter"], blind: true, receiptsToday: 14, day: { totals: { "opd.visitsOpened": 12, "billing.receipts": 14 }, clauses: [] } });
    expect(m.tiles).toHaveLength(3);
    const tile = m.tiles.find((t) => t.key === "collected")!;
    expect(tile).toEqual({ key: "collected", labelKey: "home.tile.collected", value: null, lockKey: "home.tile.afterCount", lockVars: { n: 14 } });
    expect(JSON.stringify(m)).not.toContain("₹");
    const counted = buildHome({ ...base, seats: ["counter"], blind: false, day: { totals: { "opd.visitsOpened": 12, "billing.collectedPaise": 705_000 }, clauses: [] } });
    expect(counted.tiles.find((t) => t.key === "collected")!.value).toBe("₹7,050");
  });

  it("the vitals bench: a recall that has passed is red and overdue; a long bench is amber", () => {
    const row = (i: number, over: { recallAt?: string | null; vitalsDone?: boolean }) => ({
      encounterId: `e${String(i)}`, entryId: `q${String(i)}`, tokenNo: i, seq: i, doctorId: "d", doctorName: "Dr", serviceDate: "2026-10-07", patient: null,
      benchState: over.recallAt === undefined || over.recallAt === null ? null : ("resting" as const), recallAt: over.recallAt ?? null, vitalsDone: over.vitalsDone ?? false, vitalsId: null, escalation: "none" as const,
    });
    const m = buildHome({ ...base, seats: ["vitals"], bench: [row(1, { recallAt: new Date(NOW - 6 * MIN).toISOString() }), row(2, {}), row(3, {}), row(4, { vitalsDone: true })] as never });
    expect(m.needs.map((c) => [c.kind, c.count, c.tone, c.clock?.key ?? null])).toEqual([["vitals_recheck", 1, "red", "home.clock.overdue"], ["vitals_bench", 2, "neutral", null]]);
    expect(m.work).toEqual([{ key: "vitals", badgeKey: "home.workBadge.bench", badgeVars: { n: 3 }, live: true }]);
  });

  it("the owner: hospital collections lead the tiles and the 30-day line; a supervisor's bar is today against that person's own usual day", () => {
    const collections = Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, value: i % 7 === 3 ? 0 : 1_000_000 + i * 10_000 }));
    const m = buildHome({ ...base, hospital: { byDepartment: [{ name: "General Medicine", value: 28 }], collectedTodayPaise: 1_430_000, collections },
      team: { members: [{ userId: "u1", name: "Asha Devi", today: { "opd.visitsOpened": 12 }, month: { "opd.visitsOpened": 240 }, daysWithActivity: 20 }] } });
    expect(m.tiles).toEqual([
      { key: "opdToday", labelKey: "home.tile.opdToday", value: "28" },
      { key: "collected", labelKey: "home.tile.collected", value: "₹14,300" },
      { key: "approvals", labelKey: "home.tile.approvals", value: "0" },
    ]);
    expect(m.analytics).toMatchObject({ titleKey: "home.d30.collections", money: true });
    expect(m.team).toEqual([{ name: "Asha Devi", userId: "u1", fact: "opd.visitsOpened", primary: 12, month: 240, ratio: 1 }]);
    expect(rupees(3_200_000, true)).toBe("₹32,000.00");
  });
});
