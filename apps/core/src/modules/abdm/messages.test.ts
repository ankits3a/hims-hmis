import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { abdmMessages, patients, phiAccessLog } from "../../kernel/db/schema";
import { listAbdmMessages } from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S0 — the message log is PHI-restricted. Once S1+ run, a callback body carries a patient's
 * profile or records, so a READ of the log is a disclosure and is written to `phi_access_log` under
 * its own surface, one row per distinct patient the read returned (the `billing.collection_worklist`
 * shape). S0 writes no patient-bearing rows; this pins the reader before the writers exist.
 */
describe("abdm message log — reads are PHI-audited", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const PATIENT = "01PATIENT0000000000000001";
  const reader: Actor = { type: "user", id: "01USER0000000000000000001" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi",
      sex: "female", administrativeGender: "female", createdBy: "u1", updatedBy: "u1",
    } as never);
  });

  const row = (id: string, over: Partial<typeof abdmMessages.$inferInsert> = {}): typeof abdmMessages.$inferInsert => ({
    id, direction: "in", kind: "callback.hip/patient/share", path: "/api/v3/hip/patient/share",
    requestId: `req-${id}`, headers: {}, body: { profile: "…" }, ...over,
  });

  it("records one abdm.messages access per distinct patient returned, and none for rows naming nobody", async () => {
    await db.insert(abdmMessages).values([
      row("01MSG0000000000000000001", { patientId: PATIENT }),
      row("01MSG0000000000000000002", { patientId: PATIENT }),
      row("01MSG0000000000000000003"),
    ]);
    const rows = await listAbdmMessages(db, reader, { kind: "callback.hip/patient/share" });
    expect(rows).toHaveLength(3);
    const logged = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "abdm.messages"));
    expect(logged.map((l) => [l.patientId, l.actorId])).toEqual([[PATIENT, reader.id]]);
  });

  it("a filtered read that returns nothing records nothing", async () => {
    await db.insert(abdmMessages).values(row("01MSG0000000000000000001", { patientId: PATIENT }));
    expect(await listAbdmMessages(db, reader, { kind: "callback.other" })).toHaveLength(0);
    expect(await db.select().from(phiAccessLog)).toHaveLength(0);
  });

  it("the database refuses a second INBOUND row for one REQUEST-ID — the de-duplication is structural", async () => {
    await db.insert(abdmMessages).values(row("01MSG0000000000000000001"));
    await expect(db.insert(abdmMessages).values(row("01MSG0000000000000000002", { requestId: "req-01MSG0000000000000000001" })))
      .rejects.toThrow();
    // Outbound rows are not de-duplicated: a 401 retry reuses its REQUEST-ID by design.
    await db.insert(abdmMessages).values([
      row("01MSG0000000000000000003", { direction: "out", requestId: "same" }),
      row("01MSG0000000000000000004", { direction: "out", requestId: "same" }),
    ]);
    await expect(db.insert(abdmMessages).values(row("01MSG0000000000000000005", { direction: "sideways" })))
      .rejects.toThrow();
  });
});
