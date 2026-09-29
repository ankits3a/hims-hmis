import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser } from "./helpers/opd";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { getApprovalType } from "../src/kernel/approvals/types";
import { withTx } from "../src/kernel/db/client";
import { aerbLicences, imagingDefinitions, resourceStatusHistory, resources, services, tariffItems } from "../src/kernel/db/schema";
import { eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
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

    expect(result.services).toBe(24); // 18-S RS12b: +4 IR procedures
    expect(result.devicesCreated).toBe(8); // 18-S RS12b: +IR-1
    expect(result.version).toBe(1);

    const type = await withTx(db, (tx) => getApprovalType(tx, IMAGING_DEFINITION_PUBLISH_APPROVAL_TYPE));
    expect(type).toBeTruthy();

    /** The eight machines (RS12b: +IR-1) the scheduler books onto, each carrying the modality it matches by. */
    const devices = await db.select({ code: resources.code, attributes: resources.attributes })
      .from(resources);
    expect(devices.map((d) => d.code).sort())
      .toEqual(["CT-1", "IR-1", "MMG-1", "MRI-1", "PX-1", "USG-1", "USG-P1", "XR-1"]);
    expect(devices.find((d) => d.code === "CT-1")?.attributes).toMatchObject({ modality: "ct" });

    /**
     * 18-S RS2b — the two machines that go to a bed. `attributes.portable` is the ONLY thing
     * `resolveBedside` reads; before this seed nothing wrote it, so the bedside study was unreachable
     * (18a-iii F2). A department machine must NOT carry it — the rule is one-directional, and a CT
     * marked portable would accept a ward and bed.
     */
    expect(devices.find((d) => d.code === "PX-1")?.attributes).toEqual({ modality: "xray", portable: true });
    expect(devices.find((d) => d.code === "USG-P1")?.attributes).toEqual({ modality: "usg", portable: true });
    for (const code of ["XR-1", "USG-1", "CT-1", "MRI-1", "MMG-1"]) {
      expect(devices.find((d) => d.code === code)?.attributes).not.toHaveProperty("portable");
    }

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

  /**
   * 18-S RS4 T3 — ruling 1's four services (film, CD, the two outside reads). The ROWS are seeded in
   * category `investigation` (ruling 2); the PRICE is not, because a price becomes chargeable only
   * through a tariff revision the owner approves — so no `tariff_items` row may name them.
   */
  it("ensures the four ruled services in the investigation category, unpriced, once", async () => {
    const codes = ["RAD-2ND-CT-MR", "RAD-2ND-XR-US", "RAD-CD", "RAD-FILM"];
    const first = await seedRadiology(db, admin);
    expect(first.ruledServices).toBe(4);
    await seedRadiology(db, admin);
    const rows = await db.select().from(services).where(inArray(services.code, codes));
    expect(rows.map((r) => [r.code, r.category]).sort()).toEqual(codes.map((c) => [c, "investigation"]));
    expect(await db.select().from(tariffItems).where(inArray(tariffItems.serviceId, rows.map((r) => r.id))))
      .toHaveLength(0);
  });

  it("is idempotent — a re-run after a partial failure completes and creates no second machine", async () => {
    await seedRadiology(db, admin);
    const again = await seedRadiology(db, admin);

    expect(again.devicesCreated).toBe(0);
    expect(again.services).toBe(24);

    const devices = await db.select({ code: resources.code }).from(resources);
    expect(devices).toHaveLength(8);

    /**
     * ═══ THE ASSERTION WHOSE ABSENCE LET THE DEFECT LIVE ═══
     *
     * This case was written to prove the re-run is safe and it counted devices and services and
     * **never counted the definitions** — so `draftDefinition` inserting `max(version)+1` on every
     * single run, unconditionally, went unmeasured by the one test whose subject was idempotence.
     */
    const defs = await db.select().from(imagingDefinitions);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ version: 1, status: "active" });
  });

  /**
   * ═══ A SEED MAY NOT REVERT THE MEDICAL SUPERINTENDENT ═══
   *
   * `radiology-go-live.md` §5 tells an administrator to add a machine to `MODALITY_MACHINES` and
   * re-run this script. A hospital months into service has a `study_types` book its superintendent
   * published through the governed route — v2, with an approval id. The re-run drafted v3 from the
   * twenty hardcoded seeds, SUPERSEDED the approved v2, and activated v3 with `approval_id` NULL.
   *
   * **Three things went at once:** every governed change to the book, the `ionising` flags the AERB
   * gate is keyed on, and the provenance the owner's 2026-08-31 ruling exists to preserve —
   * *"any row a reader finds active with no approval id was seeded, not approved."*
   *
   * Adding a machine does not need the book re-drafted at all: a machine is a `resources` row and
   * the book is study types. So the seed leaves an active book alone, whatever wrote it.
   */
  it("leaves a GOVERNED study-type book alone on a re-run, and says so", async () => {
    await seedRadiology(db, admin);
    const seeded = await db.select().from(imagingDefinitions);

    /** The superintendent publishes v2 through the governed route: an approval id, not a seed. */
    const governedId = newId();
    /** Supersede FIRST: `imaging_definitions_one_active_ux` allows exactly one active row per kind,
     *  which is the invariant the defect was violating from the other direction. */
    await db.update(imagingDefinitions).set({ status: "superseded" })
      .where(eq(imagingDefinitions.id, seeded[0]!.id));
    await db.insert(imagingDefinitions).values({
      id: governedId, kind: "study_types", version: 2,
      body: seeded[0]!.body as object, status: "active",
      draftedBy: admin.id, publishedBy: admin.id, publishedAt: new Date(),
      approvalId: "01APPROVALGOVERNED00000001",
    });

    await seedRadiology(db, admin);

    const after = await db.select().from(imagingDefinitions);
    const active = after.filter((d) => d.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: governedId, version: 2, approvalId: "01APPROVALGOVERNED00000001" });
    /** And no draft v3 left lying about either — the redundant version its own docstring warns of. */
    expect(after).toHaveLength(2);
  });

  /**
   * 18-S RS2b — the UPGRADE path, which is how production meets the portables: a deployment that
   * already has the five department machines and a GOVERNED book re-runs the seed. The two portables
   * arrive; the book, the five machines and nothing else move. No AERB licence is written — a seeded
   * licence would be the hospital claiming paper it does not hold — so PX-1 stays a licence gap until
   * the RSO files one.
   */
  it("adds the two portables to a running department without touching its governed book", async () => {
    await seedRadiology(db, admin);
    /** The pre-RS2b department: the two portables were never there. History first (its FK). */
    const portables = await db.select({ id: resources.id }).from(resources)
      .where(inArray(resources.code, ["PX-1", "USG-P1"]));
    await db.delete(resourceStatusHistory)
      .where(inArray(resourceStatusHistory.resourceId, portables.map((p) => p.id)));
    await db.delete(resources).where(inArray(resources.code, ["PX-1", "USG-P1"]));
    const seeded = await db.select().from(imagingDefinitions);
    await db.update(imagingDefinitions).set({ status: "superseded" })
      .where(eq(imagingDefinitions.id, seeded[0]!.id));
    const governedId = newId();
    await db.insert(imagingDefinitions).values({
      id: governedId, kind: "study_types", version: 2,
      body: seeded[0]!.body as object, status: "active",
      draftedBy: admin.id, publishedBy: admin.id, publishedAt: new Date(),
      approvalId: "01APPROVALGOVERNED00000002",
    });

    const result = await seedRadiology(db, admin);

    expect(result.devicesCreated).toBe(2);
    expect(result.definitionLeftAlone).toBe(true);
    const active = (await db.select().from(imagingDefinitions)).filter((d) => d.status === "active");
    expect(active).toEqual([expect.objectContaining({ id: governedId, approvalId: "01APPROVALGOVERNED00000002" })]);
    expect(await db.select().from(aerbLicences)).toHaveLength(0);
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
