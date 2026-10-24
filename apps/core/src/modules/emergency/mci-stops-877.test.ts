import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { alerts, tasks } from "../../kernel/db/schema";
import { mkUser } from "../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { decideMciStops, declareMci, readMciBoard, standDownMci } from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * #877 item 2 — during a Code Yellow the MS is PROPOSED a stop of OPD intake and elective OT: a task for the MS raised
 * with the declaration; the MS confirms or declines (only the MS); the decision is kept and shown on the MCI board; the
 * duty managers hear a confirmation. Nothing stops by itself: the proposal is a task, never a switch. The stand-down
 * withdraws an undecided proposal.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();

describe("#877 OPD and elective OT stops proposed to the MS", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;
  let dm: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErWorld(db);
    dm = (await mkUser(db, "er.mci.dm", ["duty_manager"])).actor;
  });

  const stopsTask = async (mciId: string) => (await db.select().from(tasks).where(eq(tasks.sourceRef, `er_mci_stops:${mciId}`)));

  it("the declaration raises the MS's task; only the MS decides, once; a confirmation tells the duty managers", async () => {
    const m = await declareMci(db, dm, { idempotencyKey: key(), name: "Bus collision" });
    const [t] = await stopsTask(m.mciId);
    expect(t).toMatchObject({ kind: "er_mci_stops", skill: "er_ms", state: "created" });
    expect((await readMciBoard(db, w.ms)).stops).toMatchObject({ state: "proposed", decidedAt: null });

    await expect(decideMciStops(db, dm, { idempotencyKey: key(), mciId: m.mciId, decision: "confirm" })).rejects.toMatchObject({ code: "mci_stops_not_ms" });
    const r = await decideMciStops(db, w.ms, { idempotencyKey: key(), mciId: m.mciId, decision: "confirm", note: "OPD registration closed till 18:00" });
    expect(r).toMatchObject({ mciId: m.mciId, decision: "confirm" });
    await expect(decideMciStops(db, w.ms, { idempotencyKey: key(), mciId: m.mciId, decision: "decline" })).rejects.toMatchObject({ code: "mci_stops_decided" });

    expect((await stopsTask(m.mciId))[0]!.state).not.toBe("created");
    expect((await readMciBoard(db, w.erNurse)).stops).toMatchObject({ state: "confirmed", note: "OPD registration closed till 18:00" });
    const told = await db.select().from(alerts).where(and(eq(alerts.kind, "er.mci_stops"), eq(alerts.refId, m.mciId)));
    expect(told.map((a) => a.userId)).toEqual([dm.id]);
  });

  it("a decline is kept; the stand-down withdraws an undecided proposal and refuses a late decision", async () => {
    const a = await declareMci(db, w.ms, { idempotencyKey: key(), name: "Fire" });
    await decideMciStops(db, w.ms, { idempotencyKey: key(), mciId: a.mciId, decision: "decline" });
    expect((await readMciBoard(db, w.ms)).stops).toMatchObject({ state: "declined" });
    expect(await db.select().from(alerts).where(eq(alerts.kind, "er.mci_stops"))).toEqual([]);
    await standDownMci(db, w.ms, { idempotencyKey: key(), mciId: a.mciId });

    const b = await declareMci(db, dm, { idempotencyKey: key(), name: "Collapse" });
    await standDownMci(db, dm, { idempotencyKey: key(), mciId: b.mciId });
    expect((await stopsTask(b.mciId))[0]!.state).toBe("cancelled");
    await expect(decideMciStops(db, w.ms, { idempotencyKey: key(), mciId: b.mciId, decision: "confirm" })).rejects.toMatchObject({ code: "mci_stood_down" });
    expect((await readMciBoard(db, w.ms)).stops).toBeNull();
  });
});
