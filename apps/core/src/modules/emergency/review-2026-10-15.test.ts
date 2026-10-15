import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { authManifest } from "../../kernel/auth/manifest";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patients } from "../../kernel/db/schema";
import { patientsManifest } from "../patients";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { emergencyManifest, linkIdentity, readErBoard, registerArrival, registerUnidentified, reprintErBand } from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * ER review (2026-10-15) — the decided follow-ups on lane 1:
 * - a sealed patient's legal name never leaves on the band unless the reader holds `patients.confidential.read`;
 * - the wall view has its own permission (`er.board.wall`): a kiosk reads it and nothing else; no police (MLC) chip;
 * - `link_identity` refuses a deceased true record and one with its own open ER episode;
 * - `patients.identity_status` is one of two words, checked by the database.
 */
jest.setTimeout(120_000);

const key = (): string => randomUUID();

describe("ER lane 1 — review follow-ups", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  const registry = (): ModuleRegistry => {
    const r = new ModuleRegistry();
    r.install(authManifest);
    r.install(patientsManifest);
    r.install(emergencyManifest);
    return r;
  };
  const unknown = () => registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "walk_in" });

  it("S-a: a sealed patient's band carries the alias, unless the reader holds the grant", async () => {
    const p = await w.patient("female", 45, "Meera Sinha");
    const r = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in" });
    await db.update(patients).set({ isConfidential: true, alias: "Patient-77" }).where(eq(patients.id, p));
    const re = await reprintErBand(db, w.erDesk, { idempotencyKey: key(), episodeId: r.episodeId, reason: "details_changed" });
    expect(re.band.name).toBe("Patient-77");
    expect(JSON.stringify(re)).not.toContain("Meera");

    const reg = registry();
    await syncPermissions(db, reg);
    await ensureRole(db, "er_sealed_reader");
    for (const perm of ["er.arrival.register", "patients.confidential.read"]) await grantPermissionToRole(db, reg, "er_sealed_reader", perm);
    const reader = (await mkUser(db, "er.sealed", ["er_sealed_reader"])).actor;
    const re2 = await reprintErBand(db, reader, { idempotencyKey: key(), episodeId: r.episodeId, reason: "damaged" });
    expect(re2.band.name).toBe("Meera Sinha");
  });

  it("S-c: the wall view has its own permission, carries initials or the alias, and no police chip", async () => {
    const reg = registry();
    await syncPermissions(db, reg);
    await ensureRole(db, "display");
    await grantPermissionToRole(db, reg, "display", "er.board.wall");
    const kiosk = (await mkUser(db, "er.kiosk", ["display"])).actor;
    const p = await w.patient("male", 30, "Suresh Yadav");
    await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "police" });
    const u = await unknown();

    const wall = await readErBoard(db, kiosk, { wall: true });
    const labels = wall.waiting.map((t) => t.label).sort();
    expect(labels).toEqual(["S. Y.", u.alias].sort());
    expect(wall.waiting.flatMap((t) => t.chips)).not.toContain("police");
    expect(wall.waiting.map((t) => t.arrivalMode)).not.toContain("police");
    expect(wall.waiting.every((t) => t.uhid === null)).toBe(true);
    // The kiosk never reads the full board.
    await expect(readErBoard(db, kiosk)).rejects.toMatchObject({ code: "er_forbidden" });
    // The full board keeps the chip.
    expect((await readErBoard(db, w.erDesk)).waiting.flatMap((t) => t.chips)).toContain("police");
  });

  it("link_identity refuses a deceased true record, and a true record with its own open ER episode", async () => {
    const u = await unknown();
    const dead = await w.patient("male", 60, "Late Ram Prasad");
    await db.update(patients).set({ deceasedAt: new Date(Date.now() - 86_400_000) }).where(eq(patients.id, dead));
    await expect(linkIdentity(db, w.mrd, { idempotencyKey: key(), episodeId: u.episodeId, truePatientId: dead, how: "family", note: "son says so" }))
      .rejects.toMatchObject({ code: "patient_deceased" });

    const inEr = await w.patient("male", 35, "Mohan Lal");
    const open = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: inEr, arrivalMode: "walk_in" });
    await expect(linkIdentity(db, w.mrd, { idempotencyKey: key(), episodeId: u.episodeId, truePatientId: inEr, how: "family", note: "wife says so" }))
      .rejects.toMatchObject({ code: "episode_already_open", detail: { episodeId: open.episodeId } });
  });

  it("patients.identity_status is checked by the database", async () => {
    const p = await w.patient("female", 30, "Anita Kumari");
    await expect(db.update(patients).set({ identityStatus: "maybe" }).where(eq(patients.id, p))).rejects.toThrow(/patients_identity_status_ck/);
  });
});
