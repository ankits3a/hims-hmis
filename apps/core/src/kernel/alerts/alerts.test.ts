import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { alerts, events } from "../db/schema";
import { users } from "../db/schema/auth";
import { ALERT_OWN_EXTENSION_LIMIT, AlertsError, acknowledgeAlert, listAlerts } from "./alerts";
import { ALERTS_REALTIME_NAMES, alertsTopicsFor } from "./realtime";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * ═══ PHASE O T3 — `acknowledgeAlert`, THE ACT THAT MAY STOP A RESPOND CLOCK ═══
 *
 * `markAlertRead` is tested over HTTP in `test/alerts.e2e.test.ts`; this suite is about the
 * decision that route cannot make for itself — which acks are promotions, which are no-ops, and
 * which are refused. The `alerts` table's own CHECKs are `schema/alerts.test.ts`'s business and
 * are not re-asserted here: these tests go THROUGH the domain function, so a constraint dropped
 * from the migration would leave every one of them green. That is the division the two suites
 * are for.
 */
const USER_A = "01HACKUSERA00000000000AA";
const USER_B = "01HACKUSERB00000000000BB";
const NOW = new Date("2026-09-21T10:00:00.000Z");

const actorFor = (id: string): Actor => ({ type: "user", id });

describe("acknowledgeAlert", () => {
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(users).values([
      { id: USER_A, username: "acka", fullName: "Asha K", staffCode: "EMP-A001", passwordHash: "x" },
      { id: USER_B, username: "ackb", fullName: "Bala R", staffCode: "EMP-B001", passwordHash: "x" },
    ]);
  });
  afterAll(async () => { await teardown(); });

  const seed = async (id: string, over: Record<string, unknown> = {}): Promise<string> => {
    await db.insert(alerts).values({
      id, userId: USER_A, kind: "escalation", title: "opd_wait · waiting · rung 0",
      refType: "approval", refId: "01HAPPROVAL0000000000001", sourceEventId: `ev-${id}`,
      createdAt: NOW, ...over,
    });
    return id;
  };
  const rowOf = async (id: string) => (await db.select().from(alerts).where(eq(alerts.id, id)))[0]!;
  const ackEvents = async () =>
    db.select({ payload: events.payload }).from(events).where(eq(events.name, "alert.acknowledged"));

  // ————————————————————————————————— seen —————————————————————————————————

  it("`seen` answers an unanswered alert, and marks it read in the same act", async () => {
    const id = await seed("01HACKALERT0000000000SEE");
    const result = await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "seen" }, NOW);

    expect(result).toMatchObject({ kind: "seen", changed: true, ownedUntil: null, handedToUserId: null, ackExtensions: 0 });
    const row = await rowOf(id);
    expect(row.ackKind).toBe("seen");
    expect(row.acknowledgedAt).toEqual(NOW);
    // You cannot answer what you have not seen — and a badge that still counts an answered
    // alert is a badge nobody believes.
    expect(row.readAt).toEqual(NOW);
    expect((await ackEvents())).toHaveLength(1);
  });

  it("a second `seen` is a NO-OP: it reports the standing state, changes nothing and appends nothing (R8)", async () => {
    const id = await seed("01HACKALERT0000000000SE2");
    await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "seen" }, NOW);
    const later = new Date(NOW.getTime() + 5 * 60_000);

    const second = await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "seen" }, later);

    expect(second).toMatchObject({ kind: "seen", changed: false });
    // The FIRST instant stands. An ack that re-stamped itself would let a person keep an
    // obligation "freshly answered" for ever by tapping the same button.
    expect(second.acknowledgedAt).toEqual(NOW);
    expect((await rowOf(id)).acknowledgedAt).toEqual(NOW);
    expect(await ackEvents()).toHaveLength(1);
  });

  it("`seen` over an OWNED alert is a no-op — a glance never demotes somebody's promise", async () => {
    const id = await seed("01HACKALERT0000000000SE3");
    await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned", untilMinutes: 30 }, NOW);

    const glance = await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "seen" }, new Date(NOW.getTime() + 60_000));

    expect(glance).toMatchObject({ kind: "owned", changed: false });
    const row = await rowOf(id);
    expect(row.ackKind).toBe("owned");
    expect(row.ownedUntil).toEqual(new Date("2026-09-21T10:30:00.000Z"));
  });

  // ————————————————————————————————— owned, and G5's limit —————————————————————————————————

  it("`owned` stamps owned_until from the caller's minutes, on the DB's instant not the browser's", async () => {
    const id = await seed("01HACKALERT0000000000OWN");
    const result = await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned", untilMinutes: 30, note: "on the ward round" }, NOW);

    expect(result.ownedUntil).toEqual(new Date("2026-09-21T10:30:00.000Z"));
    const row = await rowOf(id);
    expect(row.ackNote).toBe("on the ward round");
    expect(row.ackExtensions).toBe(0); // the FIRST own is free; only re-owns are counted
  });

  it("refuses `owned` with no minutes — owning is a promise with a deadline on it", async () => {
    const id = await seed("01HACKALERT0000000000OW2");
    await expect(acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned" }, NOW))
      .rejects.toThrow(new AlertsError("own_requires_until"));
    expect((await rowOf(id)).ackKind).toBeNull();
  });

  it("G5 — two re-owns are recorded and the THIRD is refused, leaving the standing promise intact", async () => {
    const id = await seed("01HACKALERT0000000000OW3");
    await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned", untilMinutes: 30 }, NOW);

    const first = await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned", untilMinutes: 30 }, new Date(NOW.getTime() + 30 * 60_000));
    expect(first.ackExtensions).toBe(1);
    const second = await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned", untilMinutes: 30 }, new Date(NOW.getTime() + 60 * 60_000));
    expect(second.ackExtensions).toBe(ALERT_OWN_EXTENSION_LIMIT);

    await expect(
      acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned", untilMinutes: 30 }, new Date(NOW.getTime() + 90 * 60_000)),
    ).rejects.toThrow(new AlertsError("ack_limit"));

    // The refusal changes nothing: the second extension's deadline still stands, and it is the
    // one the respond timer runs out against.
    const row = await rowOf(id);
    expect(row.ackExtensions).toBe(2);
    expect(row.ownedUntil).toEqual(new Date("2026-09-21T11:30:00.000Z"));
    expect(await ackEvents()).toHaveLength(3); // the refused fourth appended nothing
  });

  it("`owned` over a `seen` is a free promotion, not a re-own", async () => {
    const id = await seed("01HACKALERT0000000000OW4");
    await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "seen" }, NOW);
    const owned = await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned", untilMinutes: 45 }, NOW);
    expect(owned).toMatchObject({ kind: "owned", ackExtensions: 0, changed: true });
  });

  // ————————————————————————————————— handed over —————————————————————————————————

  it("`handed_over` records who took it on, and refuses the three ways it can be meaningless", async () => {
    const id = await seed("01HACKALERT0000000000HND");

    await expect(acknowledgeAlert(db, actorFor(USER_A), id, { kind: "handed_over" }, NOW))
      .rejects.toThrow(new AlertsError("handover_requires_user"));
    await expect(acknowledgeAlert(db, actorFor(USER_A), id, { kind: "handed_over", handedToUserId: USER_A }, NOW))
      .rejects.toThrow(new AlertsError("handover_to_self"));
    await expect(acknowledgeAlert(db, actorFor(USER_A), id, { kind: "handed_over", handedToUserId: "01HNOSUCHUSER00000000000" }, NOW))
      .rejects.toThrow(new AlertsError("unknown_handover_user"));

    const handed = await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "handed_over", handedToUserId: USER_B }, NOW);
    expect(handed).toMatchObject({ kind: "handed_over", handedToUserId: USER_B, changed: true });
  });

  it("hands over by STAFF CODE too, and the self-handover refusal survives the second name", async () => {
    const id = await seed("01HACKALERT0000000000HN3");

    // Both names at once: the server does not guess which the caller meant.
    await expect(acknowledgeAlert(db, actorFor(USER_A), id, { kind: "handed_over", handedToUserId: USER_B, handedToStaffCode: "EMP-B001" }, NOW))
      .rejects.toThrow(new AlertsError("handover_requires_user"));
    // A badge number nobody holds.
    await expect(acknowledgeAlert(db, actorFor(USER_A), id, { kind: "handed_over", handedToStaffCode: "EMP-ZZZZ" }, NOW))
      .rejects.toThrow(new AlertsError("unknown_handover_user"));
    // YOUR OWN badge number: the same non-act as your own id, and the id check alone misses it.
    await expect(acknowledgeAlert(db, actorFor(USER_A), id, { kind: "handed_over", handedToStaffCode: "EMP-A001" }, NOW))
      .rejects.toThrow(new AlertsError("handover_to_self"));

    const handed = await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "handed_over", handedToStaffCode: "EMP-B001" }, NOW);
    expect(handed.handedToUserId).toBe(USER_B);
    expect((await rowOf(id)).handedToUserId).toBe(USER_B);
  });

  it("a handed-over alert cannot be re-owned or re-handed by the person who let it go", async () => {
    const id = await seed("01HACKALERT0000000000HN2");
    await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "handed_over", handedToUserId: USER_B }, NOW);

    await expect(acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned", untilMinutes: 30 }, NOW))
      .rejects.toThrow(new AlertsError("already_handed_over"));
    await expect(acknowledgeAlert(db, actorFor(USER_A), id, { kind: "handed_over", handedToUserId: USER_B }, NOW))
      .rejects.toThrow(new AlertsError("already_handed_over"));
  });

  // ————————————————————————————————— scope, the wire, the fan —————————————————————————————————

  it("another user's alert id is a 404-shaped refusal, not a 403 — the existence leak stays shut", async () => {
    const id = await seed("01HACKALERT0000000000OTH", { userId: USER_B, sourceEventId: "ev-oth" });
    await expect(acknowledgeAlert(db, actorFor(USER_A), id, { kind: "seen" }, NOW))
      .rejects.toThrow(new AlertsError("unknown_alert", `unknown_alert ${id}`));
    expect((await rowOf(id)).ackKind).toBeNull();
  });

  it("the six acknowledgement fields reach the wire through listAlerts", async () => {
    const id = await seed("01HACKALERT0000000000WIR");
    await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned", untilMinutes: 30, note: "mine" }, NOW);

    const { items } = await listAlerts(db, USER_A);
    expect(items[0]).toMatchObject({
      id, ackKind: "owned", acknowledgedAt: NOW, ownedUntil: new Date("2026-09-21T10:30:00.000Z"),
      ackNote: "mine", handedToUserId: null, ackExtensions: 0,
    });
  });

  it("the event is fanned on the acknowledger's own topic and carries no free text", async () => {
    const id = await seed("01HACKALERT0000000000FAN");
    await acknowledgeAlert(db, actorFor(USER_A), id, { kind: "owned", untilMinutes: 30, note: "on the ward round with Mr Rao" }, NOW);

    const [row] = await ackEvents();
    const payload = row!.payload as Record<string, unknown>;

    // The name is one the tail actually routes, and it routes to the acknowledger and nobody else.
    expect(ALERTS_REALTIME_NAMES).toContain("alert.acknowledged");
    expect(alertsTopicsFor({ name: "alert.acknowledged", payload })).toEqual([`alerts:${USER_A}`]);

    expect(payload).toEqual({
      alertId: id, userId: USER_A, kind: "owned",
      ownedUntil: "2026-09-21T10:30:00.000Z",
      refType: "approval", refId: "01HAPPROVAL0000000000001",
    });
    // V19 / GC6, asserted as an ABSENCE with the fixture that would have exposed it: the note
    // above names a patient, and the payload reaches a browser topic. `ack_note` is not carried,
    // and this is the fixture that proves the omission is real rather than incidental.
    expect(Object.keys(payload)).not.toContain("ackNote");
    expect(JSON.stringify(payload)).not.toContain("Rao");
  });
});
