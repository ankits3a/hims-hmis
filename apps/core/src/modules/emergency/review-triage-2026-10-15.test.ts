import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { erEpisodes } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { readErBoard, registerUnidentified, sweepErTriageClocks, triage } from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * ER review (2026-10-15) — the decided follow-ups on lane 2:
 * - S-b: the wall shows the early-warning number and band, never the score's name (MEOWS discloses a pregnancy);
 * - the clock sweep leaves alone an episode already climbed for its current due instant (no lock, no transaction).
 */
jest.setTimeout(120_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const HIGH_RISK = { lifeSaving: false, highRisk: true, resources: "many" as const, dangerVitals: false };

describe("ER lane 2 — review follow-ups", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  const unknown = (now: Date) => registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "female", ageBand: "adult", arrivalMode: "walk_in" }, { now });

  it("S-b: the wall carries the score's number and band, not its name; the full board keeps the name", async () => {
    const t0 = new Date();
    const u = await unknown(t0);
    await triage(db, w.erNurse, {
      idempotencyKey: key(), episodeId: u.episodeId, decision: HIGH_RISK, level: 2, obstetric: true, vitals: { pulse: 130, respRate: 28 },
    }, { now: t0 });
    const full = (await readErBoard(db, w.erDesk, { now: t0 })).inTreatment.find((t) => t.episodeId === u.episodeId)!;
    expect(full.ews).toMatchObject({ kind: "meows" });
    const wall = (await readErBoard(db, w.erDesk, { now: t0, wall: true })).inTreatment.find((t) => t.episodeId === u.episodeId)!;
    expect(wall.ews).toEqual({ kind: null, value: full.ews!.value, band: full.ews!.band });
  });

  it("the sweep does not touch an episode already climbed for its current due instant", async () => {
    const t0 = new Date(Date.now() - 60 * MIN);
    const u = await unknown(t0);
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, decision: HIGH_RISK, level: 2 }, { now: t0 });
    await sweepErTriageClocks(db, new Date(t0.getTime() + 30 * MIN)); // task and climb for the 15-minute due instant
    const row = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, u.episodeId)))[0]!;
    expect(row.retriageClimbedDueAt?.toISOString()).toBe(row.retriageDueAt?.toISOString());

    // Someone holds the episode row (a nurse mid-act). A sweep that re-reads it FOR UPDATE would wait.
    let letGo!: () => void;
    const held = new Promise<void>((r) => { letGo = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = db.transaction(async (t) => {
      await t.execute(sql`select id from er_episodes where id = ${u.episodeId} for update`);
      locked();
      await held;
    });
    await isLocked;
    const sweep = sweepErTriageClocks(db, new Date(t0.getTime() + 31 * MIN));
    const outcome = await Promise.race([sweep.then(() => "done"), new Promise((r) => setTimeout(() => r("waited"), 3000))]);
    letGo();
    await holder;
    await sweep;
    expect(outcome).toBe("done");
  });
});
