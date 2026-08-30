import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { opdEncounters } from "../../kernel/db/schema";
import { resolveEncounterByPrefix } from "../../kernel/episodes/encounter-resolvers";
import { EPISODE_SERIES } from "../../kernel/episodes/series";
import { openVisit } from "./encounters";
import { registerOpdEncounterResolver } from "./opd.module";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17a — THE OPD ENCOUNTER RESOLVER, AGAINST A **REAL** `V` NUMBER.
 *
 * ═══ WHY THIS FILE EXISTS, AND WHY NOTHING CAUGHT IT FOR SIX PHASES ═══
 *
 * `registerOpdEncounterResolver` is registered under the prefix `EPISODE_SERIES.visit` (`"V"`), so
 * `resolveEncounterByPrefix` hands it a visit NUMBER — `V2608290001`. It resolved that by calling
 * `getEncounter`, which reads `opd_encounters.id`, and that column is a `newId()` ULID. The visit
 * number lives in `visit_no`. So the resolver could not resolve a single real visit, and
 * `placeOrder` refused `unknown_encounter` for every lab order placed on a genuine OPD encounter.
 *
 * **Every suite that touches this seam registers its OWN fake `V` resolver** — phase 0's four order
 * suites, `duplicates.test.ts`, and `test/helpers/lab.ts`, which maps the literal `"V2608290001"` to
 * a patient. That is legitimate isolation for those tests and it is exactly why the production
 * registration was never exercised: the fixture supplied the answer the code got wrong.
 *
 * **This suite registers the REAL resolver and gives it a REAL visit number**, which is the one
 * arrangement in which the defect is visible. It was written RED, against the shipped code, before
 * the fix — the red is the fact, and this file is its regression test.
 *
 * Reported by Lane B's 18a kickoff spike (`reports/2026-08-30-lane-b-held-coordination.md` §5) and
 * verified here by execution rather than by reading, because a defect asserted from a code read is
 * a prediction. `modules/ot/ot.module.ts`'s resolver reads `daycare_encounters.encounter_no` and is
 * correct, which is what makes this a divergence between two implementations of one seam.
 */
describe("the OPD encounter resolver resolves a REAL visit number (17a)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    /** THE PRODUCTION REGISTRATION, not a fixture's copy. */
    unregister = registerOpdEncounterResolver();
  });
  afterEach(() => { unregister(); });

  /** A real visit, opened through the real service, carrying a real `V` number. */
  async function openARealVisit(): Promise<{ visitNo: string; encounterId: string; patientId: string }> {
    const { deptId, roomId } = await seedOpdMasters(db);
    const doctor = await mkDoctor(db, { username: "dr.real", departmentId: deptId, roomId });
    const clerk = await mkUser(db, "front.desk", ["front_office"]);
    const patient = await mkPatient(db, clerk.actor);
    const { encounter } = await openVisit(db, clerk.actor, {
      patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId,
    });
    return { visitNo: encounter.visitNo, encounterId: encounter.id, patientId: patient.id };
  }

  it("the fixture is honest: the V number and the row id are DIFFERENT strings", async () => {
    const { visitNo, encounterId } = await openARealVisit();
    expect(visitNo).toMatch(/^V\d{10}$/);
    expect(encounterId).not.toBe(visitNo);
    /** The prefix the resolver is registered under is the one a `V` number starts with. */
    expect(visitNo.startsWith(EPISODE_SERIES.visit)).toBe(true);
  });

  /**
   * ═══ THE ASSERTION THE DEFECT FAILED ═══
   *
   * Against the shipped code this returned `{matched: true, resolved: null}` — a prefix that matched
   * and resolved to nothing, which `billing`'s `resolveEncounter` turns into `unknown_encounter` and
   * `placeOrder` refuses outright. A lab order on a real OPD visit died at the counter.
   */
  it("resolves a real V number to its patient and intended payer", async () => {
    const { visitNo, patientId } = await openARealVisit();

    const byNumber = await resolveEncounterByPrefix(db, visitNo);
    expect(byNumber.matched).toBe(true);
    expect(byNumber.matched ? byNumber.resolved : null).not.toBeNull();
    expect(byNumber.matched ? byNumber.resolved?.patientId : null).toBe(patientId);
    expect(byNumber.matched ? byNumber.resolved?.intendedPayer : null).toBe("self");
  });

  it("a V number that names no visit resolves to null — matched, and legitimately empty", async () => {
    await openARealVisit();
    const missing = await resolveEncounterByPrefix(db, "V2601010099");
    expect(missing.matched).toBe(true);
    expect(missing.matched ? missing.resolved : "not-null").toBeNull();
  });

  /**
   * THE OTHER HALF OF THE FIX, AND IT IS THE ONE A CARELESS REPAIR BREAKS. Reading by `visit_no`
   * must not start resolving ROW IDS as well: `opd_encounters.id` is not an episode number, it
   * matches no prefix, and billing's own fallback — which passes bare row ids — depends on this
   * resolver never claiming them.
   */
  it("a raw encounter ROW ID is not a V number and is not matched by this resolver", async () => {
    const { encounterId } = await openARealVisit();
    const byRowId = await resolveEncounterByPrefix(db, encounterId);
    expect(byRowId.matched).toBe(false);
  });

  it("the intended payer is read from the row rather than defaulted", async () => {
    const { deptId, roomId } = await seedOpdMasters(db);
    const doctor = await mkDoctor(db, { username: "dr.tpa", departmentId: deptId, roomId });
    const clerk = await mkUser(db, "front.desk.tpa", ["front_office"]);
    const patient = await mkPatient(db, clerk.actor);
    const { encounter } = await openVisit(db, clerk.actor, {
      patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId, intendedPayer: "tpa",
    });
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, encounter.id));
    expect(row!.intendedPayer).toBe("tpa");

    const resolved = await resolveEncounterByPrefix(db, encounter.visitNo);
    expect(resolved.matched).toBe(true);
    expect(resolved.matched ? resolved.resolved?.intendedPayer : null).toBe("tpa");
  });
});
