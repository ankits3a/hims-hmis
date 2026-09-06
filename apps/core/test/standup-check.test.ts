import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { setupTestDb, truncateAll } from "./helpers/db";
import { ensureRole, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole } from "../src/kernel/auth/permissions";
import { withTx } from "../src/kernel/db/client";
import { billingConfig, labOrderables, opdDepartments, opdDoctors, resources, services } from "../src/kernel/db/schema";
import { registerBillingApprovalTypes } from "../src/modules/billing/approval-types";
import { registerPatientApprovalTypes } from "../src/modules/patients/approval-types";
import { registerTariffApprovalTypes } from "../src/modules/tariff/approval-types";
import { createService } from "../src/modules/tariff/services";
import { seedTariffConfig } from "../scripts/seed-tariff";
import { ensurePharmacyCounter } from "../scripts/seed-pharmacy";
import { ensureLabStandUp } from "../scripts/seed-lab";
import { STANDUP_ROWS, anyRed, censusLines, isNotModelled, runCensus } from "../scripts/standup-check";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";
import type { RowResult } from "../scripts/standup-check";

/**
 * PHASE 11i T2 — the readiness census.
 *
 * FOUR THINGS THIS SUITE PINS, and each of them is a mutant the phase document named:
 *
 *  1. A module with a go-live runbook and NO row set fails. A census that names four of five
 *     departments is not a census — the `deploy-parity` seed-list lesson, one artefact over.
 *  2. A NOT MODELLED row must name a runbook section that EXISTS. The verdict's whole value is
 *     that it hands a human the page they perform instead; a dangling citation is worse than RED.
 *  3. An unpriced orderable must read RED. The runbook's own §4.5 warning — "an unpriced orderable
 *     fails at the DESK with `tariff_item_missing` in front of a patient, not at seed time".
 *  4. A role held only at a NON-HOSPITAL scope must read RED. `hasPermission` grants a hospital
 *     holding everywhere and a department holding only in its department, so "the lab has a
 *     pathologist" is false when the only pathologist holds the role scoped to Cardiology.
 */
const ACTOR: Actor = { type: "user", id: "standup-test" };
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const RUNBOOK_DIR = resolve(REPO_ROOT, "docs", "runbooks");

/**
 * WHICH MODULE EACH RUNBOOK BELONGS TO. Declared rather than derived from the filename, because
 * two of the four runbooks are radiology's. A new runbook whose module is not named here fails the
 * first test below — which is the point: the map is the thing a new department has to edit.
 */
const RUNBOOK_MODULE: Record<string, string> = {
  "lab-go-live.md": "lab",
  "pharmacy-go-live.md": "pharmacy",
  "radiation-safety-go-live.md": "radiology",
  "radiology-go-live.md": "radiology",
  "radiology-pacs-go-live.md": "radiology",
};

/**
 * The state a DEPLOY leaves behind — the G2 half, built from the same functions `deploy.sh` runs
 * inside the image. It is deliberately not "the whole world": no department, no doctor, no
 * catalogue, no stock, no human holding a role. Those are G3 and G4 and no deploy can write them.
 */
async function deployG2State(db: Db): Promise<void> {
  await seedOpdBase(db); // registration_config + opd_config, the two rows seed:registration and seed:opd write
  await seedSodPairs(db);
  for (const key of ["owner", "billing_manager", "admin"]) await ensureRole(db, key);
  const consultNew = await withTx(db, (tx) =>
    createService(tx, { type: "system", id: "seed" }, { code: "OPD-CONSULT-NEW", name: "New", category: "consultation" }));
  const consultRenewal = await withTx(db, (tx) =>
    createService(tx, { type: "system", id: "seed" }, { code: "OPD-CONSULT-RENEWAL", name: "Renewal", category: "consultation" }));
  await db.insert(billingConfig).values({
    id: "main",
    cashWarnPaise: 15_000_000, cashBlockPaise: 20_000_000, panThresholdPaise: 5_000_000,
    refundBankAbovePaise: 1_000_000, creditCapPaise: 500_000, outstandingCapPaise: 2_000_000,
    outstandingCapMode: "warn", feeBps: { upi: 0, card: 150 }, reconTolerancePaise: 100,
    seriesPrefixes: { invoice: "INV", receipt: "RCP", credit_note: "CN", voucher: "RFV" },
    chargeRules: { opdConsult: { new: consultNew.serviceId, renewal: consultRenewal.serviceId } },
    degradedTender: false, caSigned: false, updatedAt: new Date(),
  }).onConflictDoNothing();
  await registerBillingApprovalTypes(db, ACTOR);
  await seedTariffConfig(db);
  await registerTariffApprovalTypes(db, ACTOR);
  await registerPatientApprovalTypes(db, ACTOR);
  await ensurePharmacyCounter(db, ACTOR);
  await ensureLabStandUp(db, ACTOR);
}

const verdictOf = (rows: RowResult[], module: string, code: string): string | undefined =>
  rows.find((r) => r.module === module && r.code === code)?.verdict;

describe("standup:check — the readiness census (11i T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("gives EVERY module with a go-live runbook a row set — a census that names four of five is not one", () => {
    const runbooks = readdirSync(RUNBOOK_DIR).filter((f) => f.endsWith("-go-live.md"));
    expect(runbooks.length).toBeGreaterThanOrEqual(4); // non-vacuous: the files exist and were read
    const unmapped = runbooks.filter((f) => RUNBOOK_MODULE[f] === undefined);
    expect(unmapped).toEqual([]);
    const withoutRows = runbooks.filter((f) => (STANDUP_ROWS[RUNBOOK_MODULE[f]!] ?? []).length === 0);
    expect(withoutRows).toEqual([]);
  });

  it("every NOT MODELLED row names a runbook SECTION THAT EXISTS", () => {
    const notModelled = Object.values(STANDUP_ROWS).flat().filter(isNotModelled);
    expect(notModelled.length).toBeGreaterThan(0); // the third verdict is used, not merely declared
    for (const row of notModelled) {
      const text = readFileSync(resolve(REPO_ROOT, row.runbook.file), "utf8");
      expect({ code: row.code, sectionFound: text.includes(row.runbook.section) })
        .toEqual({ code: row.code, sectionFound: true });
      expect(row.fix.length).toBeGreaterThan(20);
    }
  });

  it("every row of every module carries a non-empty `fix` — a RED with no sentence is a riddle (D9)", () => {
    for (const [module, rows] of Object.entries(STANDUP_ROWS)) {
      for (const row of rows) {
        expect({ module, code: row.code, hasFix: row.fix.trim().length > 0 })
          .toEqual({ module, code: row.code, hasFix: true });
      }
    }
  });

  it("on a FRESH database every checkable row is RED, and the loaders' own refusals come with it", async () => {
    const results = await runCensus(db, "all");
    const green = results.filter((r) => r.verdict === "ok").map((r) => `${r.module}.${r.code}`);
    // The ONE exception, and it is not a database fact: the clock. No seed moves a time zone.
    expect(green).toEqual(["hospital.ist_offset_is_0530"]);
    expect(results.some((r) => r.verdict === "NOT MODELLED")).toBe(true);
    expect(anyRed(results)).toBe(true);

    // A loader that throws is a RED whose detail is the engine's own text, seed command included.
    const billing = results.find((r) => r.code === "billing_config_present");
    expect(billing?.verdict).toBe("RED");
    expect(billing?.detail).toContain("seed:billing");
    // and the printed line carries both the fix and the detail
    expect(censusLines([billing!])[0]).toContain("RED");
  });

  it("after the DEPLOY'S seeds, exactly the G2 rows are green — and no G3 or G4 row is", async () => {
    await deployG2State(db);
    const results = await runCensus(db, "all");

    const greenNonG1 = results.filter((r) => r.verdict === "ok" && r.gate !== "G1");
    expect(greenNonG1.every((r) => r.gate === "G2")).toBe(true);
    expect(results.filter((r) => r.verdict === "ok" && (r.gate === "G3" || r.gate === "G4"))).toEqual([]);

    /**
     * EVERY G2 row green EXCEPT the ones the deploy does not actually establish. This list is a
     * MEASUREMENT and not a convenience: `seed-radiology.js` exists, is in `package.json`, and
     * `deploy.sh` does not run it — so `study_types` is established by no deploy, which is exactly
     * the defect 11i T1 closed for the lab. The day somebody adds that seed to `deploy.sh`, this
     * assertion fails and tells them to empty this list.
     */
    const g2Red = results.filter((r) => r.gate === "G2" && r.verdict !== "ok").map((r) => `${r.module}.${r.code}`);
    expect(g2Red).toEqual(["radiology.radiology_study_types_active"]);
  });

  it("an UNPRICED orderable reads RED — the runbook's §4.5 warning, made a check", async () => {
    await deployG2State(db);
    const { serviceId } = await withTx(db, (tx) =>
      createService(tx, ACTOR, { code: "LAB-CBC", name: "Complete blood count", category: "laboratory" }));
    await db.insert(labOrderables).values({
      serviceId, code: "CBC", nameEn: "Complete blood count", discipline: "haematology",
      specimenType: "blood", container: "EDTA", tatMinutesRoutine: 120, createdBy: "t", updatedBy: "t",
    });

    const results = await runCensus(db, "lab");
    expect(verdictOf(results, "lab", "lab_orderable_present")).toBe("ok");
    // There IS an orderable and there is NO active tariff version carrying its price.
    expect(verdictOf(results, "lab", "lab_orderables_priced")).toBe("RED");
    expect(results.find((r) => r.code === "lab_orderables_priced")?.fix).toContain("tariff_item_missing");
  });

  it("a role held only at a NON-HOSPITAL scope reads RED", async () => {
    await deployG2State(db);
    const { deptId } = await seedOpdMasters(db);
    await ensureRole(db, "pathologist");
    const { id } = await createUser(db, { username: "dept.pathologist", fullName: "Dept Pathologist", password: "p1234567" });
    await assignRole(db, { userId: id, roleKey: "pathologist", scopeType: "department", scopeId: deptId });

    let results = await runCensus(db, "lab");
    expect(verdictOf(results, "lab", "lab_role_held_pathologist")).toBe("RED");

    // The same person, granted at HOSPITAL scope, turns the row green — so the row is about the
    // SCOPE and not about the role key being absent from the table.
    await assignRole(db, { userId: id, roleKey: "pathologist", scopeType: "hospital" });
    results = await runCensus(db, "lab");
    expect(verdictOf(results, "lab", "lab_role_held_pathologist")).toBe("ok");
  });

  it("the second administrator is a row, and one administrator does not satisfy it (§1.3)", async () => {
    await deployG2State(db);
    await mkUser(db, "admin.one", ["admin"]);
    expect(verdictOf(await runCensus(db, "hospital"), "hospital", "second_administrator")).toBe("RED");
    await mkUser(db, "admin.two", ["admin"]);
    expect(verdictOf(await runCensus(db, "hospital"), "hospital", "second_administrator")).toBe("ok");
  });

  it("the LAB department alone is not a lab: the doctor of record and their registration number are rows", async () => {
    await deployG2State(db);
    const { roomId } = await seedOpdMasters(db);
    const deptId = "lab-dept";
    await db.insert(opdDepartments)
      .values({ id: deptId, code: "LAB", name: "Laboratory", createdBy: "t", updatedBy: "t" });

    let results = await runCensus(db, "lab");
    expect(verdictOf(results, "lab", "lab_department_active")).toBe("ok");
    expect(verdictOf(results, "lab", "lab_doctor_of_record")).toBe("RED");

    const { id: userId } = await createUser(db, { username: "path.record", fullName: "Dr Record", password: "p1234567" });
    await db.insert(opdDoctors).values({
      id: "doc-record", userId, displayName: "Dr Record", registrationNo: null,
      departmentId: deptId, createdBy: "t", updatedBy: "t",
    });
    results = await runCensus(db, "lab");
    expect(verdictOf(results, "lab", "lab_doctor_of_record")).toBe("ok");
    // The number is a legal fact and a separate row: it prints on every report's signatory block.
    expect(verdictOf(results, "lab", "lab_doctor_registration_no")).toBe("RED");
    expect(roomId).toBeDefined();
  });

  it("a NOT MODELLED row is never ok and never RED, and does not fail the exit code by itself", async () => {
    const notModelled = Object.values(STANDUP_ROWS).flat().filter(isNotModelled).map((r) => r.code);
    const results = await runCensus(db, "all");
    for (const code of notModelled) {
      expect(results.find((r) => r.code === code)?.verdict).toBe("NOT MODELLED");
    }
    expect(anyRed(results.filter((r) => r.verdict === "NOT MODELLED"))).toBe(false);
  });

  it("refuses a module name it does not declare, rather than reporting an empty green census", async () => {
    await expect(runCensus(db, "cardiology")).rejects.toThrow(/unknown module/);
  });

  it("counts a bench WHEREVER it sits in the registry, not only at the top level", async () => {
    await deployG2State(db);
    expect(verdictOf(await runCensus(db, "lab"), "lab", "lab_bench_resource_present")).toBe("RED");
    await db.insert(resources).values({
      id: "floor-1", kind: "floor", code: "F1", name: "First floor", status: "available", createdBy: "t", updatedBy: "t",
    });
    await db.insert(resources).values({
      id: "bench-haem", kind: "bench", code: "HAEM", name: "Haematology bench", status: "available",
      parentId: "floor-1", createdBy: "t", updatedBy: "t",
    });
    expect(verdictOf(await runCensus(db, "lab"), "lab", "lab_bench_resource_present")).toBe("ok");
    expect(await db.select().from(services).limit(1)).toBeDefined();
  });
});
