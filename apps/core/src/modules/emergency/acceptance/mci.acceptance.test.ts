import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { erEpisodes, erMciEvents } from "../../../kernel/db/schema";
import { mkUser } from "../../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErBillWorld } from "../../../../test/helpers/emergency";
import {
  composeErBill, declareMci, mciTag, mintMciPacks, readMciBoard, readMciCount, registerArrival, registerMciArrival, standDownMci,
  sweepErTriageClocks,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { ErBillWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 8 (#815, decision 0076) — "DONE MEANS" FOR er-mci (spec SPEC-emergency-2026-10-15 §7, §4.8): Code Yellow
 * registers 40 pack patients in under 7 minutes; the stand-down returns them to ESI; every patient tagged to the event
 * bills to the event's account (nothing payable at the point of care); the head count for the district carries counts
 * by tag and no names. Every check calls the INTENT functions.
 */

jest.setTimeout(420_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 8 er-mci — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErBillWorld;
  let dm: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErBillWorld(db);
    dm = (await mkUser(db, "er.mci.dm", ["duty_manager"])).actor;
  });

  it("(a) Code Yellow registers 40 pack patients in under 7 minutes; the stand-down returns them to ESI", async () => {
    const packs = await mintMciPacks(db, dm, { idempotencyKey: key(), count: 40 });
    expect(packs.packs).toHaveLength(40);
    expect(packs.packs[0]!.band.qr).toBe(`ERBAND1|${packs.packs[0]!.packNo}|${packs.packs[0]!.uhid}`);
    const declared = new Date(Date.now() - 30 * MIN);
    const mci = await declareMci(db, w.ms, { idempotencyKey: key(), name: "Bus collision NH-30", place: "Bypass km 12" }, { now: declared });

    const t0 = Date.now();
    const episodes: string[] = [];
    for (const [i, p] of packs.packs.entries()) {
      const r = await registerMciArrival(db, w.erDesk, {
        idempotencyKey: key(), packNo: p.packNo.toLowerCase(), ...(i % 4 === 0 ? { tag: "red" } : {}), arrivedAt: new Date(declared.getTime() + MIN).toISOString(),
      });
      expect(r).toMatchObject({ mciId: mci.mciId, alias: `Unknown-${p.packNo}`, uhid: p.uhid });
      episodes.push(r.episodeId);
    }
    expect(Date.now() - t0).toBeLessThan(7 * MIN);

    // While the event runs, its untriaged patients are tagged, not on the door-to-triage clock.
    const during = await sweepErTriageClocks(db, new Date());
    expect(during.tasks).toBe(0);
    const board = await readMciBoard(db, w.erNurse);
    expect(board.active).toMatchObject({ total: 40, byTag: { red: 10, untagged: 30 } });
    expect(board.packsReady).toBe(0);

    const down = await standDownMci(db, dm, { idempotencyKey: key(), mciId: mci.mciId });
    expect(down.backToEsi).toBe(40);
    const after = await sweepErTriageClocks(db, new Date());
    expect(after.tasks).toBe(40);
    await expect(registerMciArrival(db, w.erDesk, { idempotencyKey: key(), packNo: "MCI26-999" })).rejects.toMatchObject({ code: "mci_not_active" });
  });

  it("(b) every patient tagged to the event bills to its account — nothing payable at the point of care", async () => {
    const gate = new Date(Date.now() - 20 * MIN);
    const mci = await declareMci(db, dm, { idempotencyKey: key(), name: "Factory fire" }, { now: gate });
    const p = await w.patient("male", 34, "Mohan Lal Yadav");
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "private_vehicle", arrivedAt: gate.toISOString() }, { now: gate });
    const before = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, a.episodeId)))[0]!;
    expect((await composeErBill(db, before)).patientPaise).toBeGreaterThan(0);

    await mciTag(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, tag: "yellow" });
    const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, a.episodeId)))[0]!;
    const account = (await db.select().from(erMciEvents).where(eq(erMciEvents.id, mci.mciId)))[0]!.eventAccountId;
    expect(e).toMatchObject({ payer: "mci_event", eventAccountId: account, mciId: mci.mciId, mciTag: "yellow" });
    const bill = await composeErBill(db, e);
    expect(bill.totalPaise).toBeGreaterThan(0);
    expect(bill).toMatchObject({ patientPaise: 0, payerPaise: bill.totalPaise });
  });

  it("(c) the head count for the district: counts by tag and by where the patients are, never a name", async () => {
    const mci = await declareMci(db, w.ms, { idempotencyKey: key(), name: "Building collapse" });
    const named: string[] = [];
    for (const [tag, name] of [["red", "Sita Ram Mahto"], ["green", "Kamla Devi"], ["black", "Ramesh Paswan"]] as const) {
      const p = await w.patient("female", 40, name);
      const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in" });
      await mciTag(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, tag });
      named.push(name);
    }
    const count = await readMciCount(db, w.erDesk, mci.mciId);
    expect(count).toMatchObject({ total: 3, byTag: { red: 1, yellow: 0, green: 1, black: 1, untagged: 0 }, byOutcome: { inDepartment: 3 } });
    const words = JSON.stringify(count);
    for (const n of named) for (const part of n.split(" ")) expect(words).not.toContain(part);
    expect(words).not.toMatch(/HMS\d|UHID/i);
  });
});
