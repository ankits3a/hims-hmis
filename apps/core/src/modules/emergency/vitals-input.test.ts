import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { recordErVitals, registerUnidentified } from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * ER review (2026-10-15) — `record_er_vitals` with an empty vital set has nothing to score. It is a malformed body
 * (400 through the controller's ZodError mapping), never a TypeError deep in the intent (a 500).
 */
jest.setTimeout(120_000);

describe("record_er_vitals — an empty set", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  it("is refused as invalid input; a set with one vital is scored", async () => {
    const u = await registerUnidentified(db, w.erDesk, { idempotencyKey: randomUUID(), sex: "female", ageBand: "adult", arrivalMode: "walk_in" });
    await expect(recordErVitals(db, w.erNurse, { idempotencyKey: randomUUID(), episodeId: u.episodeId, vitals: {} }))
      .rejects.toBeInstanceOf(ZodError);
    await expect(recordErVitals(db, w.erNurse, { idempotencyKey: randomUUID(), episodeId: u.episodeId, vitals: { pulse: 88 } }))
      .resolves.toMatchObject({ episodeId: u.episodeId, ews: { kind: "news2" } });
  });
});
