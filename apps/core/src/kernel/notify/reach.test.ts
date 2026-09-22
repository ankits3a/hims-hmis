import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { alerts, notifications, userReachProfiles } from "../db/schema";
import { createUser } from "../auth/identity";
import { assignRole, createRole } from "../auth/permissions";
import {
  LANE_MINUTES, REACH_BUDGET_PER_HOUR, laneOf, reachDedupeKey, reachProfileFor, runReachLadder,
} from "./reach";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE O T4 — THE CHANNEL LADDER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * O3's second ladder: the SAME person, louder. Every test here is about one of three things —
 * what makes it climb, what stops it, and what stops it climbing too often.
 */
const NOW = new Date("2026-09-21T10:00:00.000Z");
const MIN = 60_000;

describe("runReachLadder", () => {
  let db: Db; let teardown: () => Promise<void>;
  let asha: string; let bala: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    asha = (await createUser(db, { username: "reachasha", fullName: "Asha K", password: "p1234567" })).id;
    bala = (await createUser(db, { username: "reachbala", fullName: "Bala R", password: "p1234567" })).id;
  });

  const seedAlert = async (
    userId: string,
    over: { kind?: string; minutesAgo?: number; ackKind?: string; refType?: string; refId?: string } = {},
  ): Promise<string> => {
    const id = newId();
    await db.insert(alerts).values({
      id, userId,
      kind: over.kind ?? "escalation",
      title: "opd_wait · waiting · rung 0",
      refType: over.refType ?? "workflow_instance",
      refId: over.refId ?? newId(),
      sourceEventId: newId(),
      createdAt: new Date(NOW.getTime() - (over.minutesAgo ?? 30) * MIN),
      // T3's CHECKs are real: an `owned` ack with no deadline is refused by the database, so
      // the fixture has to build a COMPLETE acknowledgement rather than half of one.
      ...(over.ackKind === undefined
        ? {}
        : {
            ackKind: over.ackKind,
            acknowledgedAt: NOW,
            ...(over.ackKind === "owned" ? { ownedUntil: new Date(NOW.getTime() + 30 * MIN) } : {}),
          }),
    });
    return id;
  };
  const outbox = async (userId?: string) =>
    db.select().from(notifications).where(userId === undefined ? undefined : eq(notifications.userId, userId));

  // ————————————————————————————— what makes it climb —————————————————————————————

  it("relays an unanswered alert onto the first ladder channel, once, with exactly four params", async () => {
    const alertId = await seedAlert(asha, { minutesAgo: 10, refType: "approval", refId: "ap-9" });

    expect(await runReachLadder(db, NOW)).toBe(1);

    const rows = await outbox(asha);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.templateKey).toBe("staff_alert_relay_now"); // `escalation` is the `now` lane
    expect(rows[0]!.dedupeKey).toBe(reachDedupeKey(alertId, "web_push"));
    expect(rows[0]!.audience).toBe("staff");
    // FOUR params and no fifth. A title is prose somebody wrote, and prose is where a patient's
    // name ends up (O10 / R10) — so the relay carries the alert's KIND word instead.
    expect(rows[0]!.params).toEqual({
      kind: "escalation", lane: "now", remainingMinutes: "0", link: "/approvals?focus=ap-9",
    });
  });

  it("a second pass at the same instant adds nothing — the dedupe unit is (alert, channel)", async () => {
    await seedAlert(asha, { minutesAgo: LANE_MINUTES.now });
    expect(await runReachLadder(db, NOW)).toBe(1);
    expect(await runReachLadder(db, NOW)).toBe(0);
    expect(await outbox(asha)).toHaveLength(1);
  });

  it("ONE rung per pass, so a worker that was down catches up without a burst", async () => {
    // Twenty minutes of silence on a five-minute lane: every rung of the ladder is overdue.
    // A pass that sent all three at once would put three messages on one phone in one second,
    // which is exactly the thing the ladder is spacing out.
    await seedAlert(asha, { minutesAgo: 20 });
    expect(await runReachLadder(db, NOW)).toBe(1);
    expect(await runReachLadder(db, NOW)).toBe(1);
    expect(await runReachLadder(db, NOW)).toBe(1);
    expect(await runReachLadder(db, NOW)).toBe(0);
    expect(await outbox(asha)).toHaveLength(3);
  });

  it("EACH rung waits the lane's minutes again — the ladder is not a burst", async () => {
    // The job's cadence is sixty seconds. Without this the browser, WhatsApp and the SMS would
    // all fire inside three minutes of a `now` alert, which is R9's failure arriving from
    // inside the mechanism that exists to prevent it.
    await seedAlert(asha, { minutesAgo: LANE_MINUTES.now }); // rung 0 is exactly due
    expect(await runReachLadder(db, NOW)).toBe(1);
    // One minute later: rung 1 is not due until TEN minutes of silence.
    expect(await runReachLadder(db, new Date(NOW.getTime() + MIN))).toBe(0);
    expect(await runReachLadder(db, new Date(NOW.getTime() + 4 * MIN))).toBe(0);
    expect(await runReachLadder(db, new Date(NOW.getTime() + 5 * MIN))).toBe(1);
    expect(await outbox(asha)).toHaveLength(2);
  });

  it("climbs to the NEXT channel on the next pass, and stops when the ladder is spent", async () => {
    const alertId = await seedAlert(asha, { minutesAgo: 5 });
    const at = (m: number): Date => new Date(NOW.getTime() + m * MIN);
    expect(await runReachLadder(db, NOW)).toBe(1);        // 5 min of silence -> web_push
    expect(await runReachLadder(db, at(5))).toBe(1);      // 10 -> whatsapp
    expect(await runReachLadder(db, at(10))).toBe(1);     // 15 -> sms
    // Every rung of the default ladder is spent; the ROLE ladder (T1) is what climbs next, and
    // this job has nothing further to say about this alert ever again.
    expect(await runReachLadder(db, at(60))).toBe(0);

    expect((await outbox(asha)).map((r) => r.dedupeKey).sort()).toEqual(
      (["sms", "web_push", "whatsapp"] as const).map((c) => reachDedupeKey(alertId, c)).sort(),
    );
  });

  it("waits out the lane's own minutes — a `can_wait` alert is not relayed at ten minutes", async () => {
    await seedAlert(asha, { kind: "ageing_review", minutesAgo: 10 }); // unknown kind -> can_wait
    expect(laneOf("ageing_review")).toBe("can_wait");
    expect(await runReachLadder(db, NOW)).toBe(0);
    // …and is, once its four hours are up.
    expect(await runReachLadder(db, new Date(NOW.getTime() + LANE_MINUTES.can_wait * MIN))).toBe(1);
  });

  // ————————————————————————————— what stops it —————————————————————————————

  it("an ACK stops it and a READ does not — that is why T3 made them different columns", async () => {
    await seedAlert(asha, { minutesAgo: 30, ackKind: "owned" });
    // Bala's is merely READ, which is the state this job exists to escalate past.
    const balaAlert = await seedAlert(bala, { minutesAgo: 30 });
    await db.update(alerts).set({ readAt: NOW }).where(eq(alerts.id, balaAlert));

    expect(await runReachLadder(db, NOW)).toBe(1);
    expect(await outbox(asha)).toHaveLength(0);
    expect(await outbox(bala)).toHaveLength(1);
  });

  it("an alert older than a week is the ageing sweep's, not the relay's", async () => {
    await seedAlert(asha, { minutesAgo: 8 * 24 * 60 });
    expect(await runReachLadder(db, NOW)).toBe(0);
  });

  it("a person whose ladder is only the browser climbs one rung and stops", async () => {
    await db.insert(userReachProfiles).values({
      userId: asha, ladder: ["web_push"], createdBy: "s", updatedBy: "s",
    });
    await seedAlert(asha, { minutesAgo: 10 });
    expect(await runReachLadder(db, NOW)).toBe(1);
    expect(await runReachLadder(db, new Date(NOW.getTime() + MIN))).toBe(0);
  });

  // ————————————————————————————— R9, the budget —————————————————————————————

  it("R9: the seventh interrupt in an hour becomes ONE digest carrying a count and no kinds", async () => {
    for (let i = 0; i < REACH_BUDGET_PER_HOUR + 3; i += 1) {
      await seedAlert(asha, { minutesAgo: 10 + i });
    }

    const enqueued = await runReachLadder(db, NOW);

    const rows = await outbox(asha);
    const relays = rows.filter((r) => r.templateKey !== "staff_alert_digest");
    const digests = rows.filter((r) => r.templateKey === "staff_alert_digest");
    expect(relays).toHaveLength(REACH_BUDGET_PER_HOUR);
    expect(digests).toHaveLength(1);
    expect(enqueued).toBe(REACH_BUDGET_PER_HOUR + 1);
    // A COUNT, not a list: five obligations named by kind is five leaks rather than one.
    expect(digests[0]!.params).toEqual({ kind: "3", lane: "digest", remainingMinutes: "0", link: "/" });

    // A second pass in the same hour adds no second digest.
    expect(await runReachLadder(db, new Date(NOW.getTime() + MIN))).toBe(0);
  });

  it("R9's two exempt seats are not budgeted — the duty manager is woken by all ten", async () => {
    await createRole(db, "duty_manager", "Duty Manager");
    await assignRole(db, { userId: asha, roleKey: "duty_manager", scopeType: "hospital" });
    for (let i = 0; i < REACH_BUDGET_PER_HOUR + 3; i += 1) await seedAlert(asha, { minutesAgo: 10 + i });

    const enqueued = await runReachLadder(db, NOW);

    expect(enqueued).toBe(REACH_BUDGET_PER_HOUR + 3);
    expect((await outbox(asha)).filter((r) => r.templateKey === "staff_alert_digest")).toHaveLength(0);
  });

  it("the budget is PER PERSON — one noisy seat does not silence a quiet one", async () => {
    for (let i = 0; i < REACH_BUDGET_PER_HOUR + 2; i += 1) await seedAlert(asha, { minutesAgo: 20 + i });
    await seedAlert(bala, { minutesAgo: 10 });

    await runReachLadder(db, NOW);

    expect((await outbox(bala)).filter((r) => r.templateKey !== "staff_alert_digest")).toHaveLength(1);
  });

  // ————————————————————————————— the profile —————————————————————————————

  it("a person's own row wins over their class, and a person with no row gets their class", async () => {
    // Asha holds a screen seat, so her class ladder is the browser alone.
    await createRole(db, "cashier", "Cashier");
    await assignRole(db, { userId: asha, roleKey: "cashier", scopeType: "hospital" });
    const classDefault = await withTx(db, (tx) => reachProfileFor(tx, asha));
    expect(classDefault.ladder).toEqual(["web_push"]);
    expect(classDefault.language).toBe("en");

    await db.insert(userReachProfiles).values({
      userId: asha, language: "hi", ladder: ["sms"], createdBy: "s", updatedBy: "s",
    });
    const own = await withTx(db, (tx) => reachProfileFor(tx, asha));
    expect(own.ladder).toEqual(["sms"]);
    expect(own.language).toBe("hi");
  });

  it("holding two roles takes the LOUDER class — a duty manager who also works a counter is on call", async () => {
    await createRole(db, "cashier", "Cashier");
    await createRole(db, "duty_manager", "Duty Manager");
    await assignRole(db, { userId: asha, roleKey: "cashier", scopeType: "hospital" });
    await assignRole(db, { userId: asha, roleKey: "duty_manager", scopeType: "hospital" });

    const profile = await withTx(db, (tx) => reachProfileFor(tx, asha));
    expect(profile.ladder).toEqual(["web_push", "whatsapp", "sms"]);
    expect(profile.quietExempt).toBe(true);
  });
});
