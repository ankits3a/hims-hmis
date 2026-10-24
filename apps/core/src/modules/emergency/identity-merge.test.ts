import { randomUUID } from "node:crypto";
import { withTx } from "../../kernel/db/client";
import { createMergeRequest } from "../patients";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { registerUnidentified } from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * ER review (2026-10-15) — the merge direction. An unidentified record (the ER's "Unknown-0412") is always the LOSER:
 * it is merged into the true record, never the other way. A request that keeps the unknown and freezes the identified
 * record would rename a known patient to the alias everywhere; the patients module refuses it, whichever screen files it.
 */
jest.setTimeout(120_000);

describe("patient_merge — an unidentified record is never the survivor of an identified one", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  const unknown = () => registerUnidentified(db, w.erDesk, {
    idempotencyKey: randomUUID(), sex: "male", ageBand: "adult", arrivalMode: "walk_in",
  });

  it("refuses unknown as winner over a named record; unknown into named, and unknown into unknown, are filed", async () => {
    const u = await unknown();
    const named = await w.patient("male", 40, "Ramesh Kumar");
    await expect(withTx(db, (tx) => createMergeRequest(tx, w.mrd, { winnerId: u.patientId, loserId: named, note: "wrong way" })))
      .rejects.toMatchObject({ code: "merge_into_unidentified" });
    // Two unknown registrations of one person may be merged either way (both carry an alias).
    const u2 = await unknown();
    await expect(withTx(db, (tx) => createMergeRequest(tx, w.mrd, { winnerId: u.patientId, loserId: u2.patientId, note: "same unknown" })))
      .resolves.toMatchObject({ mergeRequestId: expect.any(String) });
    // The right way round is untouched.
    const u3 = await unknown();
    await expect(withTx(db, (tx) => createMergeRequest(tx, w.mrd, { winnerId: named, loserId: u3.patientId, note: "identified by family" })))
      .resolves.toMatchObject({ mergeRequestId: expect.any(String) });
  });
});
