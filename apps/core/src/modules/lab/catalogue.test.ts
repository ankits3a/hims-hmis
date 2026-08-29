import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { labAnalytes, labOrderables, labReflexRules, registrationConfig } from "../../kernel/db/schema";
import { seedLabCatalogue, serviceIdForLabCode } from "../../../scripts/seed-lab-catalogue";
import { analytesFor, getOrderable, upsertAnalyte, upsertOrderable } from "./catalogue";
import { labManifest } from "./manifest";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17a T3 — THE CATALOGUE SERVICE AND THE GOLDEN FIXTURE, against a real database.
 *
 * The refusals are asserted by EXECUTION rather than by reading the guard, because a refusal that
 * has never fired is a refusal nobody has tested — and E33's is a criminal statute, not a
 * preference.
 */
describe("the lab catalogue (17a T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let curator: Actor;
  let clerk: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    const registry = new ModuleRegistry();
    registry.install(labManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "pathologist");
    await ensureRole(db, "lab_reception");
    await grantPermissionToRole(db, registry, "pathologist", "lab.catalogue.manage");
    ({ actor: curator } = await mkUser(db, "dr.pathology", ["pathologist"]));
    ({ actor: clerk } = await mkUser(db, "lab.desk", ["lab_reception"]));
  });

  /**
   * ═══ E33 / 02 E6 — PCPNDT, AND THE MESSAGE NAMES THE ACT ═══
   *
   * The refusal exists at three levels and each is asserted: the service (here), the database CHECK
   * (T1's `lab_orderables_no_foetal_sex_ck`), and the seed, which goes THROUGH the service rather
   * than around it. A curator reading "violates check constraint" would not know this is a criminal
   * statute rather than a configuration option.
   */
  it("E33: refuses an orderable that reports foetal sex, and names the law", async () => {
    await upsertAnalyte(db, curator, { code: "FSEX", nameEn: "Foetal sex", resultType: "text" });
    await expect(upsertOrderable(db, curator, {
      serviceId: "svc-fsex", code: "FSEX", nameEn: "Foetal sex determination",
      discipline: "clinical_pathology", specimenType: "serum", container: "sst",
      tatMinutesRoutine: 60, reportsFoetalSex: true, analyteCodes: ["FSEX"],
    })).rejects.toThrow(/PCPNDT/);
    expect(await db.select().from(labOrderables)).toEqual([]);
  });

  it("refuses a curator without the permission, and refuses a non-user actor by TYPE", async () => {
    await expect(upsertAnalyte(db, clerk, { code: "X", nameEn: "X", resultType: "numeric" }))
      .rejects.toThrow(/lab\.catalogue\.manage/);
    await expect(upsertAnalyte(db, { type: "system", id: "importer" },
      { code: "X", nameEn: "X", resultType: "numeric" })).rejects.toThrow(/a system actor may not curate/);
    expect(await db.select().from(labAnalytes)).toEqual([]);
  });

  it("refuses a formula that does not parse, and an orderable naming an unknown analyte BY NAME", async () => {
    await expect(upsertAnalyte(db, curator, {
      code: "BAD", nameEn: "Bad", resultType: "formula", formula: "process.exit(1)",
    })).rejects.toThrow();
    await expect(upsertOrderable(db, curator, {
      serviceId: "svc-x", code: "X", nameEn: "X", discipline: "biochemistry",
      specimenType: "serum", container: "sst", tatMinutesRoutine: 60, analyteCodes: ["NOPE", "ALSO_NOPE"],
    })).rejects.toThrow(/NOPE, ALSO_NOPE/);
  });

  it("an orderable with no analytes measures nothing and is refused", async () => {
    await expect(upsertOrderable(db, curator, {
      serviceId: "svc-x", code: "X", nameEn: "X", discipline: "biochemistry",
      specimenType: "serum", container: "sst", tatMinutesRoutine: 60, analyteCodes: [],
    })).rejects.toThrow(/measures nothing/);
  });

  describe("the golden fixture, seeded", () => {
    beforeEach(async () => { await seedLabCatalogue(db, curator); });

    /**
     * THE ROUND-TRIP THE PHASE DOCUMENT ASKS FOR: the fixture goes through the seed onto a private
     * database and the counts come back out of the tables, not out of the JSON.
     */
    it("round-trips: every orderable, analyte and range lands, and the services rows are created", async () => {
      const orderables = await db.select().from(labOrderables);
      const analytes = await db.select().from(labAnalytes);
      expect(orderables.length).toBe(64);
      expect(analytes.length).toBe(130);
      // Ground truth row 10: no other seed makes an `investigation` service, so these are ours.
      const cbc = await getOrderable(db, serviceIdForLabCode("CBC"));
      expect([cbc.code, cbc.discipline, cbc.specimenType, cbc.container]).toEqual(["CBC", "haematology", "whole_blood", "edta"]);
    });

    /** DD1 — the analytes come back IN REPORT ORDER, which is what a printed report reads down. */
    it("expands an orderable into its analytes, in report order", async () => {
      const cbcAnalytes = await analytesFor(db, serviceIdForLabCode("CBC"));
      expect(cbcAnalytes.map((a) => a.code).slice(0, 4)).toEqual(["HB", "RBC", "HCT", "MCV"]);
      expect(cbcAnalytes.map((a) => a.code)).toContain("PLT");
    });

    /**
     * ═══ ALL THREE REFLEX RULES SHIP INACTIVE, AND THIS IS THE ASSERTION THAT KEEPS THEM THAT WAY ═══
     *
     * A reflex is an order the system places and the patient pays for. A seed that shipped one
     * enabled would make a clinical and a commercial decision for every deployment, silently
     * (DD8). The count is asserted as ZERO rather than "not all", so a future fixture that flips
     * one fails here.
     */
    it("seeds three reflex rules and NONE of them is active", async () => {
      const rules = await db.select().from(labReflexRules);
      expect(rules).toHaveLength(3);
      expect(rules.filter((r) => r.active)).toEqual([]);
      const active = await db.select().from(labReflexRules).where(eq(labReflexRules.active, true));
      expect(active).toEqual([]);
    });

    it("is idempotent: a second run neither duplicates nor multiplies the range book", async () => {
      const first = { o: (await db.select().from(labOrderables)).length, a: (await db.select().from(labAnalytes)).length };
      const report = await seedLabCatalogue(db, curator);
      expect([report.orderables, report.analytes]).toEqual([first.o, first.a]);
      expect(report.activeReflexRules).toBe(0);
      // The version bumps on the second pass — that is the E41 signal that the catalogue moved,
      // and it is the one thing that SHOULD differ between two runs.
      const cbc = await getOrderable(db, serviceIdForLabCode("CBC"));
      expect(cbc.version).toBe(2);
    });

    /** The consent and sensitivity flags DD14 depends on are data, so they are asserted as data. */
    it("carries the consent and sensitivity flags the confidentiality rules read", async () => {
      const hiv = await getOrderable(db, serviceIdForLabCode("HIV"));
      expect([hiv.consentRequired, hiv.sensitive, hiv.notifiable]).toEqual([true, true, true]);
      const cbc = await getOrderable(db, serviceIdForLabCode("CBC"));
      expect([cbc.consentRequired, cbc.sensitive]).toEqual([false, false]);
      // A pregnancy test is `sensitive` and NOT consent-class: it is delivered in person (02 J3),
      // which is a different rule from the counselling HIV needs.
      const upt = await getOrderable(db, serviceIdForLabCode("UPT"));
      expect([upt.consentRequired, upt.sensitive]).toEqual([false, true]);
    });

    it("every formula analyte in the fixture parses, and every referenced sibling exists", async () => {
      const analytes = await db.select().from(labAnalytes);
      const codes = new Set(analytes.map((a) => a.code));
      const formulas = analytes.filter((a) => a.resultType === "formula");
      expect(formulas.length).toBeGreaterThan(10);
      for (const f of formulas) {
        for (const token of (f.formula ?? "").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
          expect([f.code, token, codes.has(token)]).toEqual([f.code, token, true]);
        }
      }
    });
  });
});
