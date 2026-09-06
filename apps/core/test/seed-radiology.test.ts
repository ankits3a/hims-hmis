import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser } from "./helpers/opd";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { getApprovalType } from "../src/kernel/approvals/types";
import { withTx } from "../src/kernel/db/client";
import { imagingDefinitions, resources } from "../src/kernel/db/schema";
import { IMAGING_DEFINITION_PUBLISH_APPROVAL_TYPE } from "../src/modules/radiology";
import { registrarFromEnv, seedRadiology } from "../scripts/seed-radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * `pnpm seed:radiology` is the ONLY way a deployment gets its study-type book, its five machines
 * and the approval type every later publish is requested against. It had no test, and it could not
 * succeed on a fresh database.
 *
 * ═══ WHAT THIS SUITE EXISTS TO CATCH ═══
 *
 * The script passed its system `SEEDER` to `registerRadiologyApprovalTypes`, whose own docstring
 * has required a "user" actor since 18a T4 and whose two kernel calls each refuse a system one
 * (`actor_not_user`, then `user_actor_required`). So the seed died on the FIRST approval type of
 * every fresh deployment — and the department could not be stood up at all on a new stack.
 *
 * **The reason it survived four phases is the reason it needs a test rather than a reading.** The
 * registration loop skips a typeKey that is already registered, so on any database whose types
 * already existed the broken line never executed and the seed exited 0. The bug was invisible
 * exactly where the seed had been run before, and fatal exactly where it had not — which is to say,
 * invisible in development and fatal at go-live. A suite that starts from `truncateAll` is the only
 * instrument that meets it.
 */
describe("seed:radiology — the department can be stood up on a fresh deployment", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let admin: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    ({ actor: admin } = await mkUser(db, "rad.registrar", []));
  });

  it("seeds the book, the machines and the approval type from empty", async () => {
    const result = await seedRadiology(db, admin);

    expect(result.services).toBe(20);
    expect(result.devicesCreated).toBe(5);
    expect(result.version).toBe(1);

    const type = await withTx(db, (tx) => getApprovalType(tx, IMAGING_DEFINITION_PUBLISH_APPROVAL_TYPE));
    expect(type).toBeTruthy();

    /** The five machines the scheduler books onto, each carrying the modality it matches by. */
    const devices = await db.select({ code: resources.code, attributes: resources.attributes })
      .from(resources);
    expect(devices.map((d) => d.code).sort()).toEqual(["CT-1", "MMG-1", "MRI-1", "USG-1", "XR-1"]);
    expect(devices.find((d) => d.code === "CT-1")?.attributes).toMatchObject({ modality: "ct" });

    /**
     * The seeded activation stays distinguishable from a governed one for ever — the owner's
     * 2026-08-31 ruling let the seed self-publish, and `approval_id` NULL is the whole provenance
     * argument that made that safe. A future "tidy-up" defaulting it would erase the distinction
     * silently, so it is pinned here beside the thing it qualifies.
     */
    const active = await db.select().from(imagingDefinitions);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ kind: "study_types", status: "active", approvalId: null });
  });

  it("is idempotent — a re-run after a partial failure completes and creates no second machine", async () => {
    await seedRadiology(db, admin);
    const again = await seedRadiology(db, admin);

    expect(again.devicesCreated).toBe(0);
    expect(again.services).toBe(20);

    const devices = await db.select({ code: resources.code }).from(resources);
    expect(devices).toHaveLength(5);
  });

  /**
   * A module-level `const REGISTRAR = process.env.SEED_ACTOR_ID ?? …` reads once at import and is
   * frozen before any caller can set the variable — the go-live would name the script in the audit
   * row while believing it had named the administrator. Reading at CALL time is the behaviour, so
   * it is what gets asserted.
   */
  it("reads SEED_ACTOR_ID when the registrar is built, not when the module is imported", () => {
    expect(registrarFromEnv({} as NodeJS.ProcessEnv)).toEqual({ type: "user", id: "seed:radiology" });
    expect(registrarFromEnv({ SEED_ACTOR_ID: "01ADMIN" } as NodeJS.ProcessEnv))
      .toEqual({ type: "user", id: "01ADMIN" });
  });
});
