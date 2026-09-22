import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ALERT_ACK_KINDS, alerts } from "./alerts";
import { users } from "./auth";
import type { Db } from "../client";

const USER_A = "01HALERTSUSERA000000000AA";
const USER_B = "01HALERTSUSERB000000000BB";
const EVENT_ID = "01HESCALATIONTRIGGERED001";

const alertRow = (id: string, userId: string, sourceEventId: string = EVENT_ID) => ({
  id, userId, kind: "escalation", title: "opd_wait · waiting · rung 0", sourceEventId,
});

describe("alerts table", () => {
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(users).values([
      { id: USER_A, username: "asha", fullName: "Asha K", staffCode: "EMP-0001", passwordHash: "x" },
      { id: USER_B, username: "bala", fullName: "Bala R", staffCode: "EMP-0002", passwordHash: "x" },
    ]);
  });
  afterAll(async () => { await teardown(); });

  it("round-trips an alert with its optional columns empty", async () => {
    await db.insert(alerts).values(alertRow("01HALERT00000000000000001", USER_A));
    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBeNull();
    expect(rows[0]!.refType).toBeNull();
    expect(rows[0]!.refId).toBeNull();
    expect(rows[0]!.readAt).toBeNull();
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("is unique on the (source_event_id, user_id) PAIR — one event twice for one user is refused", async () => {
    await db.insert(alerts).values(alertRow("01HALERT00000000000000001", USER_A));
    await expect(
      db.insert(alerts).values(alertRow("01HALERT00000000000000002", USER_A)),
    ).rejects.toThrow();
  });

  it("still fans ONE event out to a SECOND recipient — the pair is the unit, not the event", async () => {
    // Not-over-broad: the roadmap's per-row `source_event_id UNIQUE` would cap one escalation
    // at ONE recipient, and no mutant on the pair-unique catches a uniqueness that is too wide.
    // D6 corrects the shorthand deliberately, so the adjacent allowed case is asserted here.
    await db.insert(alerts).values(alertRow("01HALERT00000000000000001", USER_A));
    await db.insert(alerts).values(alertRow("01HALERT00000000000000002", USER_B));
    expect(await db.select().from(alerts)).toHaveLength(2);
  });

  it("requires user_id to name a real user (the only FK this migration adds, pointing outward)", async () => {
    await expect(
      db.insert(alerts).values(alertRow("01HALERT00000000000000003", "01HNOSUCHUSER00000000000")),
    ).rejects.toThrow();
  });
});

/**
 * ═══ PHASE O T3 — THE ACKNOWLEDGEMENT COLUMNS, AND THE THREE HALVES POSTGRES REFUSES ═══
 *
 * `read_at` says a browser rendered the row; these six columns say a human answered it. The
 * obligation spine stops a respond clock on an answer and never on a render (T1), so the
 * difference has to survive being written by something other than `acknowledgeAlert` — a backfill,
 * a repair script, a future consumer. That is what a CHECK is for, and it is why these tests write
 * rows UNDERNEATH the domain code rather than through it.
 *
 * Each assertion issues the real statement (the `orders.test.ts` rule: "the constraint exists in
 * `pg_constraint`" proves nothing about what Postgres will do with a row). The one exception is
 * the vocabulary-drift assertion at the foot, which has no row that can ask it.
 */
describe("alerts — the acknowledgement columns (phase O T3)", () => {
  const USER_C = "01HALERTSUSERC000000000CC";
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(users).values([
      { id: USER_A, username: "asha", fullName: "Asha K", staffCode: "EMP-0001", passwordHash: "x" },
      { id: USER_B, username: "bala", fullName: "Bala R", staffCode: "EMP-0002", passwordHash: "x" },
      { id: USER_C, username: "chandra", fullName: "Chandra M", staffCode: "EMP-0003", passwordHash: "x" },
    ]);
  });
  afterAll(async () => { await teardown(); });

  const ack = (over: Record<string, unknown>) => ({
    ...alertRow("01HALERT0000000000000ACK1", USER_A),
    ...over,
  });

  it("defaults every acknowledgement column to unanswered, and ack_extensions to 0", async () => {
    await db.insert(alerts).values(alertRow("01HALERT0000000000000ACK1", USER_A));
    const [row] = await db.select().from(alerts);
    expect(row!.ackKind).toBeNull();
    expect(row!.acknowledgedAt).toBeNull();
    expect(row!.ownedUntil).toBeNull();
    expect(row!.ackNote).toBeNull();
    expect(row!.handedToUserId).toBeNull();
    // NOT NULL DEFAULT 0 — a null here would make "how many times has this been re-dated"
    // unanswerable for every row that shipped before T3, and G5's limit uncountable.
    expect(row!.ackExtensions).toBe(0);
  });

  it("refuses a kind outside the vocabulary — the answer is one of three words", async () => {
    await expect(
      db.insert(alerts).values(ack({ ackKind: "maybe", acknowledgedAt: new Date() })),
    ).rejects.toThrow();
  });

  it("refuses HALF an acknowledgement in either direction — a kind without an instant, an instant without a kind", async () => {
    // The radiology precedent (`imaging_critical_findings_ack_ck`): an acknowledgement is a
    // statement AND the moment it was made. Half of one is not an acknowledgement, and a row
    // carrying only `acknowledged_at` would stop a respond clock with nobody having said anything.
    await expect(
      db.insert(alerts).values(ack({ ackKind: "seen", acknowledgedAt: null })),
    ).rejects.toThrow();
    await expect(
      db.insert(alerts).values(ack({ ackKind: null, acknowledgedAt: new Date() })),
    ).rejects.toThrow();
  });

  it("refuses `owned` with no owned_until — owning is a promise with a deadline on it", async () => {
    await expect(
      db.insert(alerts).values(ack({ ackKind: "owned", acknowledgedAt: new Date(), ownedUntil: null })),
    ).rejects.toThrow();
  });

  it("refuses `handed_over` with nobody to hand to", async () => {
    await expect(
      db.insert(alerts).values(ack({ ackKind: "handed_over", acknowledgedAt: new Date(), handedToUserId: null })),
    ).rejects.toThrow();
  });

  it("ACCEPTS each of the three answers in its complete form — the permitted direction, not only the forbidden one (5A.1)", async () => {
    const now = new Date("2026-09-21T10:00:00.000Z");
    await db.insert(alerts).values([
      { ...alertRow("01HALERT0000000000000SEE1", USER_A, "01HEVENT0000000000000SEE1"), ackKind: "seen", acknowledgedAt: now },
      { ...alertRow("01HALERT0000000000000OWN1", USER_A, "01HEVENT0000000000000OWN1"), ackKind: "owned", acknowledgedAt: now, ownedUntil: new Date("2026-09-21T10:30:00.000Z"), ackExtensions: 2 },
      { ...alertRow("01HALERT0000000000000HND1", USER_A, "01HEVENT0000000000000HND1"), ackKind: "handed_over", acknowledgedAt: now, handedToUserId: USER_B, ackNote: "on the ward round until 12" },
    ]);
    expect(await db.select().from(alerts)).toHaveLength(3);
  });

  it("requires handed_to_user_id to name a real user — the second FK, and it points outward like the first", async () => {
    await expect(
      db.insert(alerts).values(ack({ ackKind: "handed_over", acknowledgedAt: new Date(), handedToUserId: "01HNOSUCHUSER00000000000" })),
    ).rejects.toThrow();
  });

  /**
   * DRIFT, not behaviour: the SQL copy of the vocabulary against the TypeScript copy the domain
   * code branches on. No row can ask this question — a row can only ask whether one particular
   * word is refused, and a CHECK that had silently lost a word would still refuse every word it
   * never had.
   */
  it("the CHECK's vocabulary is exactly ALERT_ACK_KINDS — the SQL copy and the TS copy have not parted company", async () => {
    const [{ def }] = (await db.execute(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'alerts_ack_kind_ck'`,
    )).rows as [{ def: string }];
    const quoted = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...quoted].sort()).toEqual([...ALERT_ACK_KINDS].sort());
  });
});
