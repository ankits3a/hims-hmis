import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { ipdRounds, ipdVitals } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkRoundsWorld } from "../../../../test/helpers/ipd";
import { signRound } from "../../ipd";
import { wardBeds, wardRound } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { RoundsWorld } from "../../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * ACCEPTANCE — issue #962, spec docs/specs/962-doctor-desk-ward.md (owner APPROVED 2026-10-26), the Desk's server half:
 *
 *   D5  the change mark on Beds is PER DOCTOR: a round signed by one doctor clears the mark for that doctor only.
 *   D6  (server side) five round notes signed offline and replayed on reconnect land exactly once each — a second replay
 *       of the same client ids is a no-op — and each keeps its signing time and its sync time.
 *
 * The Desk reads IPD only through `ipd/index.ts` and writes no clinical row: the note is IPD's `signRound`, called with
 * the phone's client id as its idempotency key. IPD is switched on for this suite (decision 0085). Explicit IST instants.
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);

describe("spec #962 — the Desk's ward reads", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: RoundsWorld;
  const before = process.env.HMIS_MODULES_ON;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); process.env.HMIS_MODULES_ON = "ipd"; });
  afterAll(async () => {
    if (before === undefined) delete process.env.HMIS_MODULES_ON; else process.env.HMIS_MODULES_ON = before;
    await teardown();
  });
  beforeEach(async () => { await truncateAll(db); w = await mkRoundsWorld(db); });

  const sign = (by: Actor, admissionId: string, seenAt: Date, now: Date, clientId: string = randomUUID()) =>
    signRound(db, by, { idempotencyKey: clientId, admissionId, seenAt: seenAt.toISOString(), mode: "bedside", soap: { assessment: "Synthetic: settling", plan: "Continue" } }, { now });
  const vitals = (admissionId: string, patientId: string, at: Date) => db.insert(ipdVitals).values({
    id: newId(), admissionId, patientId, observedAt: at, recordedAt: at, recordedBy: w.admitDesk.id, source: "person",
    clientKey: randomUUID(), lateEntry: false, pulse: 124, respRate: 26, systolic: 92, diastolic: 58, spo2: 93, temperatureC: 39.1,
    onOxygen: false, consciousness: "alert", scoreKind: "news2", scoreValue: 8, scoreBand: "high", scoreComplete: true,
  } as never);
  const markOf = async (by: Actor, admissionId: string, at: Date) => {
    const view = await wardBeds(db, by, at);
    const bed = [...view.beds, ...view.outliers].find((b) => b.occupant?.admissionId === admissionId);
    if (bed === undefined) throw new Error(`admission ${admissionId} is not on the beds of ${by.id}`);
    return bed.changed;
  };

  it("spec #962 D5: a round signed by one doctor clears the change mark for that doctor only", async () => {
    const p = await w.admitMed(ist("2026-03-10T09:00:00"));
    // Both doctors of Unit I have seen him this morning.
    await sign(w.head, p.admissionId, ist("2026-03-10T10:00:00"), ist("2026-03-10T10:00:00"));
    await sign(w.consultant, p.admissionId, ist("2026-03-10T10:30:00"), ist("2026-03-10T10:30:00"));
    expect(await markOf(w.consultant, p.admissionId, ist("2026-03-10T11:00:00"))).toBe(false);
    expect(await markOf(w.head, p.admissionId, ist("2026-03-10T11:00:00"))).toBe(true); // the consultant's round is news to the head

    // The nurse charts a deteriorating set at 14:00: it is news to both.
    await vitals(p.admissionId, p.patientId, ist("2026-03-10T14:00:00"));
    expect(await markOf(w.consultant, p.admissionId, ist("2026-03-10T15:00:00"))).toBe(true);
    expect(await markOf(w.head, p.admissionId, ist("2026-03-10T15:00:00"))).toBe(true);

    // The consultant signs a round at 15:10: HIS mark clears; the head's stays.
    await sign(w.consultant, p.admissionId, ist("2026-03-10T15:10:00"), ist("2026-03-10T15:10:00"));
    expect(await markOf(w.consultant, p.admissionId, ist("2026-03-10T15:20:00"))).toBe(false);
    expect(await markOf(w.head, p.admissionId, ist("2026-03-10T15:20:00"))).toBe(true);
  });

  it("spec #962 D6: five notes signed offline land exactly once on replay, each with its signing time and its sync time", async () => {
    const p = await w.admitMed(ist("2026-03-10T09:00:00"));
    const notes = [0, 1, 2, 3, 4].map((i) => ({ clientId: randomUUID(), signedAt: ist(`2026-03-10T15:0${String(i)}:00`) }));
    const synced = ist("2026-03-10T15:30:00");
    // Reconnect: the phone replays its queue; the network drops mid-way and it replays the whole queue again.
    for (const n of notes) await sign(w.consultant, p.admissionId, n.signedAt, synced, n.clientId);
    for (const n of notes) await sign(w.consultant, p.admissionId, n.signedAt, ist("2026-03-10T15:31:00"), n.clientId);

    const rows = await db.select().from(ipdRounds).where(and(eq(ipdRounds.admissionId, p.admissionId), eq(ipdRounds.authorId, w.consultant.id)));
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.seenAt.toISOString()).sort()).toEqual(notes.map((n) => n.signedAt.toISOString()).sort());
    expect(new Set(rows.map((r) => r.createdAt.toISOString()))).toEqual(new Set([synced.toISOString()]));

    // The Round screen shows each of my notes with both times.
    const view = await wardRound(db, w.consultant, p.admissionId, ist("2026-03-10T15:40:00"));
    expect(view.mine).toHaveLength(5);
    for (const m of view.mine) {
      expect(notes.map((n) => n.signedAt.toISOString())).toContain(m.signedAt);
      expect(m.syncedAt).toBe(synced.toISOString());
    }
  });
});
