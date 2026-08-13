import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerPatient } from "./registration";
import { addAllergy, listAllergies, markAllergyEnteredInError } from "./allergies";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

describe("allergies", () => {
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
      registerPatient(tx, clerk, { name: "Asha Devi", sex: "female" }),
    );
    return patient.id;
  }

  it("records an allergy with its event", async () => {
    const id = await newPatient();
    const { allergyId } = await withTx(db, (tx) =>
      addAllergy(tx, clerk, id, { substance: "penicillin", severity: "severe", source: "registration" }),
    );
    const list = await listAllergies(db, id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(allergyId);
    expect(list[0]!.status).toBe("active");

    const evs = await db.select().from(events).where(eq(events.name, "allergy.recorded"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.patientId).toBe(id);
    const payload = evs[0]!.payload as { substance: string; severity: string | null };
    expect(payload.substance).toBe("penicillin");
    expect(payload.severity).toBe("severe");
  });

  it("corrects via entered_in_error: mandatory reason, status flip, correction event, row retained", async () => {
    const id = await newPatient();
    const { allergyId } = await withTx(db, (tx) =>
      addAllergy(tx, clerk, id, { substance: "sulfa", source: "registration" }),
    );
    await expect(
      withTx(db, (tx) => markAllergyEnteredInError(tx, clerk, allergyId, "   ")),
    ).rejects.toMatchObject({ code: "reason_required" });

    await withTx(db, (tx) => markAllergyEnteredInError(tx, clerk, allergyId, "wrong patient selected"));
    const list = await listAllergies(db, id);
    expect(list).toHaveLength(1); // never deleted — the trail stays (E-8)
    expect(list[0]!.status).toBe("entered_in_error");
    expect(list[0]!.correctionReason).toBe("wrong patient selected");

    const evs = await db.select().from(events).where(eq(events.name, "correction.entered_in_error"));
    expect(evs).toHaveLength(1);
    const payload = evs[0]!.payload as { entity: string; entityId: string; reason: string };
    expect(payload.entity).toBe("allergy");
    expect(payload.entityId).toBe(allergyId);

    // double-correction loses the conditional UPDATE
    await expect(
      withTx(db, (tx) => markAllergyEnteredInError(tx, clerk, allergyId, "again")),
    ).rejects.toMatchObject({ code: "allergy_not_active" });
  });

  it("unknown ids and non-user actors are refused", async () => {
    const id = await newPatient();
    await expect(
      withTx(db, (tx) => addAllergy(tx, { type: "agent", id: "a" }, id, { substance: "x", source: "registration" })),
    ).rejects.toMatchObject({ code: "user_actor_required" });
    await expect(
      withTx(db, (tx) => markAllergyEnteredInError(tx, clerk, "01NOSUCH00000000000000000", "r")),
    ).rejects.toMatchObject({ code: "allergy_not_found" });
  });
});
