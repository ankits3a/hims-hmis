import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, registrationConfig } from "../../kernel/db/schema";
import { eq } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { registerPatient } from "./registration";
import { PHOTO_MAX_BYTES, getPatientPhoto, storePatientPhoto } from "./photos";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

describe("patient photos", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
  });

  async function newPatient(): Promise<string> {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210" }),
    );
    return patient.id;
  }

  it("stores, replaces (upsert), and reads back a photo; each store events a photo change", async () => {
    const id = await newPatient();
    const v1 = Buffer.from([0xff, 0xd8, 1]);
    const v2 = Buffer.from([0xff, 0xd8, 2]);
    await withTx(db, (tx) => storePatientPhoto(tx, clerk, id, { mimeType: "image/jpeg", bytes: v1 }));
    await withTx(db, (tx) => storePatientPhoto(tx, clerk, id, { mimeType: "image/jpeg", bytes: v2 }));
    const read = await getPatientPhoto(db, clerk, id);
    expect(Buffer.compare(read!.bytes, v2)).toBe(0);

    const evs = await db.select().from(events).where(eq(events.name, "patient.updated"));
    expect(evs).toHaveLength(2);
    const payload = evs[0]!.payload as { changes: { field: string; from: null; to: null }[] };
    expect(payload.changes).toEqual([{ field: "photo", from: null, to: null }]);
  });

  it("enforces the byte cap and the jpeg-only rule", async () => {
    const id = await newPatient();
    await expect(
      withTx(db, (tx) =>
        storePatientPhoto(tx, clerk, id, { mimeType: "image/jpeg", bytes: Buffer.alloc(PHOTO_MAX_BYTES + 1) }),
      ),
    ).rejects.toMatchObject({ code: "photo_too_large" });
    await expect(
      withTx(db, (tx) =>
        storePatientPhoto(tx, clerk, id, { mimeType: "image/png", bytes: Buffer.from([1]) }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_photo_type" });
    expect(await getPatientPhoto(db, clerk, id)).toBeNull();
  });

  it("agent actors resolve non-confidential photos (the gate itself is getPatient's, tested in T3)", async () => {
    const id = await newPatient();
    await withTx(db, (tx) => storePatientPhoto(tx, clerk, id, { mimeType: "image/jpeg", bytes: Buffer.from([7]) }));
    // agent actors are gated exactly like getPatient (null, not bytes)
    expect(await getPatientPhoto(db, { type: "agent", id: "a1" }, id)).not.toBeNull(); // non-confidential: agents may resolve
  });

  it("refuses unknown and non-user callers", async () => {
    await expect(
      withTx(db, (tx) =>
        storePatientPhoto(tx, clerk, "01NOSUCH00000000000000000", { mimeType: "image/jpeg", bytes: Buffer.from([1]) }),
      ),
    ).rejects.toMatchObject({ code: "patient_not_found" });
    const id = await newPatient();
    await expect(
      withTx(db, (tx) =>
        storePatientPhoto(tx, { type: "system", id: "s" }, id, { mimeType: "image/jpeg", bytes: Buffer.from([1]) }),
      ),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });
});
