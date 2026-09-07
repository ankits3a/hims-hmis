import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { setupTestDb, truncateAll } from "./helpers/db";
import { activateOpdVisitDefinition, ensureRole, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
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
import { ensureOtUnit } from "../scripts/seed-ot";
import { seedOtBase } from "./helpers/ot";
import { registerOtApprovalTypes } from "../src/modules/ot";
import { STANDUP_ROWS, anyRed, censusLines, isNotModelled, runCensus } from "../scripts/standup-check";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
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
 * ═══ WHICH MANIFESTS ARE DEPARTMENTS — DECLARED, NEVER INFERRED ═══
 *
 * The completeness guards below walked the runbook files, and then (from §OPD-UNSEEDED) the census's
 * own modules. **Neither population is "the modules that exist."** The OT was missing from both at
 * once and was invisible to both walks until somebody added both halves by hand — so the guard could
 * not have found the next OT either.
 *
 * The population is now `ALL_MANIFESTS`, the tree's one answer to "which modules exist" (Plan 11d
 * D2). Every manifest must appear in exactly ONE of the two maps below, and the assertion that says
 * so is what makes a new module a deliberate decision instead of a silent omission.
 *
 * **THE CLASSIFICATION IS NOT DERIVED, AND THAT IS DELIBERATE.** It was measured for a signal first
 * and there is none: `billing` declares four menu entries and owes no runbook, `pcpndt` declares
 * none and is a statutory register; `orderKinds` and `resourceKinds` cut across both sides. A
 * convention over names or menu counts would silently reclassify a module the day it gained a
 * screen. So it is a table, one line each, in the `ist-clock-parity` idiom — the point is that
 * adding a module makes you write a line here and say which it is.
 */
const DEPARTMENTS: Record<string, string> = {
  /** manifest key -> the census module key. They differ once, and the census's name wins. */
  opd: "front-desk",
  lab: "lab",
  pharmacy: "pharmacy",
  radiology: "radiology",
  ot: "ot",
};

/**
 * NOT A DEPARTMENT — no go-live day of its own, so no runbook and no row set.
 *
 * ═══ FIVE OF THESE ARE AN OPEN QUESTION AND ARE RECORDED, NOT DECIDED (2026-09-07) ═══
 *
 * `billing`, `materials`, `membership`, `aerb` and `pcpndt` each hold master data or a statutory
 * obligation no deploy can supply, which is the property that made the other five departments.
 * **Whether they owe a go-live runbook is a scope call with real cost** — moving one to
 * `DEPARTMENTS` turns this suite red until somebody writes both halves — and it belongs to the
 * board, not to the lane that happened to be here. **This map records today's answer (they are
 * not), so nothing changes silently, and the question is written where the next person to touch
 * this file will read it.**
 */
const NOT_DEPARTMENTS: Record<string, string> = {
  // ── kernel machinery: no clinical day, nothing to commission ──
  auth: "kernel — identity and sessions",
  workflow: "kernel — the definition engine departments are commissioned THROUGH",
  approvals: "kernel — the approval engine",
  alerts: "kernel — alert routing",
  ops: "kernel — operating mode, interfaces, downtime kits",
  resources: "kernel — the registry the departments' theatres and benches live in",
  orders: "kernel — the order envelope; claimed by lab and radiology, owned by neither",
  desk: "cross-cutting — the front-desk shell; its commissioning IS `front-desk`'s",
  notify: "worker-only, and not in ALL_MANIFESTS at all — listed so its absence is not a puzzle",

  // ── cross-cutting hospital data, exercised by every department ──
  patients: "cross-cutting — `registration_config` is a `hospital` row and is checked there",
  tariff: "cross-cutting — priced per department; each department's rows check its own prices",
  formulary: "cross-cutting reference data — `seed:formulary` supplies it; nothing human is owed",
  partners: "cross-cutting — the partner book is the owner's file, not a department's stand-up",

  // ── OPEN QUESTION: master data no deploy can supply, but no runbook today ──
  billing: "OPEN — `billing_config` is checked under `hospital`; a cashier's go-live may still be one",
  materials: "OPEN — vendors, items and opening stock are master data no seed supplies",
  membership: "OPEN — the holder book is loaded from the owner's own files (Plan 09 DD3)",
  aerb: "OPEN — HAS a runbook (`radiation-safety-go-live.md`) mapped to `radiology`, and no rows of its own",
  pcpndt: "OPEN — a statutory register (Form F); its machines and persons are registered by a human",
};

/**
 * WHICH MODULE EACH RUNBOOK BELONGS TO. Declared rather than derived from the filename, because
 * two of the four runbooks are radiology's. A new runbook whose module is not named here fails the
 * first test below — which is the point: the map is the thing a new department has to edit.
 */
const RUNBOOK_MODULE: Record<string, string> = {
  "lab-go-live.md": "lab",
  /**
   * 11i / §OPD-UNSEEDED — the sixth runbook, and the FIRST one written for a module that was
   * already live. Its module key is `front-desk` and not `opd`: that is the census's own name for
   * the row set (`STANDUP_ROWS["front-desk"]`), and inventing a second key here would give the
   * counter two identities in one census.
   */
  "opd-go-live.md": "front-desk",
  /**
   * 2026-09-07 — the page `seed-ot.ts` has printed a pointer to since Plan 15. The OT had no runbook
   * AND no row set, so it was invisible to both directions of the completeness guard at once.
   */
  "ot-go-live.md": "ot",
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
  /**
   * `deploy.sh` runs `seed-ot.js`, so the OT's approval types and its theatre ARE deploy facts and
   * their rows are G2. This helper is a hand-built mirror of that script — the assertion below that
   * "exactly the G2 rows are green" measures the gap between the two, so anything the real deploy
   * establishes has to be established here or the measurement reports a defect that is the mirror's.
   *
   * It deliberately does NOT publish or activate anything: `seed-ot.ts` does not either, which is
   * what keeps the two G3 rows RED here and is the whole point of `ot-go-live.md`.
   */
  await registerOtApprovalTypes(db, ACTOR);
  await ensureOtUnit(db, ACTOR);
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

  /**
   * ═══ THE OTHER DIRECTION, AND IT IS THE ONE THAT LET §OPD-UNSEEDED THROUGH ═══
   *
   * The test above walks the RUNBOOK FILES and asks each for a row set. Its population is therefore
   * whatever is on disk in `docs/runbooks/` — so **a census module with no runbook is not in the
   * population at all**, and nothing above can notice that it is short a row. `front-desk` had no
   * runbook and no `opd_visit` check for the entire life of the census, while `lab`, `pharmacy` and
   * `radiology` each had their definition checked.
   *
   * That is this file's own header lesson turned on the file: *"a census that names four of five
   * departments is not a census."* The guard counted the four it could see. **Fixing only the OPD
   * row would leave the next department in exactly the same hole** (#161 — a sweep is itself an
   * instance: define the class by its property, not by a string), so the population is now the
   * CENSUS's modules and the runbooks are checked against them.
   *
   * `hospital` is the one exemption and it is declared, not inferred: its own comment says it is
   * *"not a department: the rows every department's opening rests on"*, so it has no go-live day of
   * its own to write a runbook for.
   */
  it("and EVERY census module has a runbook — the direction that would have caught the missing OPD rows", () => {
    const runbooks = readdirSync(RUNBOOK_DIR).filter((f) => f.endsWith("-go-live.md"));
    const modulesWithRunbook = new Set(runbooks.map((f) => RUNBOOK_MODULE[f]).filter((m) => m !== undefined));
    /** `hospital` has no manifest: it is the census's own name for the rows every department rests on. */
    const NOT_A_DEPARTMENT = ["hospital"];
    const censusModules = Object.keys(STANDUP_ROWS).filter((m) => !NOT_A_DEPARTMENT.includes(m));
    expect(censusModules.length).toBeGreaterThan(0); // non-vacuous
    const withoutRunbook = censusModules.filter((m) => !modulesWithRunbook.has(m));
    expect(withoutRunbook).toEqual([]);
  });

  /**
   * ═══ THE POPULATION IS NOW `ALL_MANIFESTS`, THE ONLY ONE THAT CANNOT MISS A MODULE ═══
   *
   * The two guards above walk the runbook FILES and the census's own MODULES. **Neither is "the
   * modules that exist"**, so a department shipping with neither half is invisible to both: the OT
   * was exactly that, and became findable only because somebody added a runbook and a row set by
   * hand. **A guard that can only find what has already been half-found cannot find the next one.**
   *
   * `ALL_MANIFESTS` is the tree's one answer to which modules exist (Plan 11d D2), and a manifest
   * installed by `app.module.ts` and missing from it already fails the build — so it is the one
   * population that cannot silently omit a module.
   *
   * **THIS TEST MAKES CLASSIFICATION COMPULSORY AND MAKES NO CLASSIFICATION ITSELF.** A new manifest
   * fails here until somebody writes it into `DEPARTMENTS` or `NOT_DEPARTMENTS`; which one is a
   * judgement, and the maps carry it in prose, one line per module. Five are marked OPEN there —
   * recorded as today's answer rather than settled by this lane.
   */
  it("every manifest is classified as a department or not — the population is ALL_MANIFESTS, not what the census already knows", () => {
    const manifestKeys = ALL_MANIFESTS.map((m) => m.key).sort();
    expect(manifestKeys.length).toBeGreaterThanOrEqual(20); // non-vacuous: the list was really read

    const classified: Record<string, string> = { ...DEPARTMENTS, ...NOT_DEPARTMENTS };
    /** Unclassified = a module nobody decided about. This is the assertion the OT needed. */
    expect(manifestKeys.filter((k) => classified[k] === undefined)).toEqual([]);

    /** Nothing on BOTH sides, which would make the question look answered twice. */
    expect(Object.keys(DEPARTMENTS).filter((k) => NOT_DEPARTMENTS[k] !== undefined)).toEqual([]);

    /**
     * Every classified key is a real manifest — except `notify`, which is worker-only and
     * deliberately absent from `ALL_MANIFESTS`. It is listed in the map so its absence reads as a
     * decision rather than an oversight, the same reason `manifests.ts` names it.
     */
    const WORKER_ONLY = ["notify"];
    expect(Object.keys(classified).filter((k) => !manifestKeys.includes(k) && !WORKER_ONLY.includes(k)))
      .toEqual([]);
  });

  /**
   * The payoff: a module the maps call a DEPARTMENT owes both halves, and the failure names which.
   * This is what would have caught the OT the day its manifest landed rather than a phase later.
   */
  it("every declared DEPARTMENT has both halves — a row set and a runbook", () => {
    const runbooks = readdirSync(RUNBOOK_DIR).filter((f) => f.endsWith("-go-live.md"));
    const withRunbook = new Set(runbooks.map((f) => RUNBOOK_MODULE[f]).filter((m) => m !== undefined));
    const missing = Object.entries(DEPARTMENTS).flatMap(([manifestKey, censusKey]) => {
      const out: string[] = [];
      if ((STANDUP_ROWS[censusKey] ?? []).length === 0) out.push(`${manifestKey}: no row set "${censusKey}"`);
      if (!withRunbook.has(censusKey)) out.push(`${manifestKey}: no go-live runbook`);
      return out;
    });
    expect(missing).toEqual([]);
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

  /**
   * ═══ §OPD-UNSEEDED — THE ROW WITHOUT WHICH NOT ONE PATIENT CAN BE REGISTERED ═══
   *
   * `encounters.ts` calls `startInstance(tx, OPD_VISIT_DEF_KEY, …)` on EVERY encounter open, and
   * `startInstance` throws `no_active_definition` for a key with no active row. So a deployment
   * whose `opd_visit` was never activated cannot open a visit at all — and **nothing outside the
   * test tree had ever activated one**: `activateOpdVisitDefinition` lives in `test/helpers/opd.ts`
   * and is called by forty test files and by no line of `src/` or `scripts/`.
   *
   * IT IS G3 AND NOT G2, AND THE GATE FOLLOWS THE CHANGE CLASS. `opd_visit` is **Class A** —
   * `CHANGE_CLASS_POLICY.A` demands `owner` + `medical_superintendent` approvals, a drafter who is
   * not the activator (the `workflow_drafter_activator` SoD pair), and therefore FOUR humans. A
   * deploy cannot establish that and must not try: `lab` and `pharmacy` are Class C and their seeds
   * activate them (G2), `radiology` is Class A and is G3, and this row joins radiology's side.
   * **A seed that activated a Class A definition would collapse a two-key clinical-safety approval
   * into an automated call** — which is why the answer here is a runbook and a check, not a line in
   * `seed-opd.ts`.
   */
  it("§OPD-UNSEEDED: opd_visit is RED after every deploy seed, and green only after the Class A ceremony", async () => {
    await deployG2State(db);

    /** No deploy, and no seed, activates it. THIS is the state a fresh environment stands up in. */
    expect(verdictOf(await runCensus(db, "front-desk"), "front-desk", "opd_visit_definition_active")).toBe("RED");

    /** The ceremony the runbook describes: drafter, owner + MS approvals, a distinct activator. */
    await activateOpdVisitDefinition(db);

    expect(verdictOf(await runCensus(db, "front-desk"), "front-desk", "opd_visit_definition_active")).toBe("ok");
  });

  /**
   * ═══ THE OT — AND THIS ASSERTION IS WHAT `test/helpers/ot.ts` WAS ALWAYS FOR ═══
   *
   * That helper's own comment says why it performs the real two-key ceremony instead of inserting
   * rows: *"A fixture that activated these by inserting a row would prove nothing about whether the
   * runbook is performable."* **It was written to prove a runbook performable and the runbook did not
   * exist.** `ot-go-live.md` is now that page, and this test closes the loop by measuring the
   * fixture's ceremony against the census rows the runbook cites.
   *
   * TWO GOVERNANCES, TWO ROWS, AND THEY ARE NOT THE SAME ACT.
   *   · `ot_workflow_definitions_active` — `daycare_case` and `ot_gate`, KERNEL definitions,
   *     change-class A, three people. Nothing in the tree drafts them (§2).
   *   · `ot_definitions_published` — the module's OWN `ot_definitions` table, published by the MS
   *     under `ot_definition_publish`. `seed:ot` drafts three of the four kinds and publishes none;
   *     **`privileges` it does not even draft** (§3-§4), because which surgeon may perform which
   *     procedure is a credentialling record no seed can guess.
   */
  it("the OT: both governances are RED after the deploy, and green only after the ceremony the runbook describes", async () => {
    await deployG2State(db);

    /** `seed:ot` runs in `deploy.sh`, so the approval types and the theatre ARE deploy facts. */
    expect(verdictOf(await runCensus(db, "ot"), "ot", "ot_approval_types_registered")).toBe("ok");
    expect(verdictOf(await runCensus(db, "ot"), "ot", "ot_theatre_present")).toBe("ok");
    /** And it deliberately activates and publishes nothing — the state every deployment sits in. */
    const afterDeploy = await runCensus(db, "ot");
    expect(verdictOf(afterDeploy, "ot", "ot_workflow_definitions_active")).toBe("RED");
    expect(verdictOf(afterDeploy, "ot", "ot_definitions_published")).toBe("RED");

    /** `seedOtBase` performs BOTH ceremonies for real — the two-key activation and all four publishes. */
    await truncateAll(db);
    await seedOtBase(db);

    const afterCeremony = await runCensus(db, "ot");
    expect(verdictOf(afterCeremony, "ot", "ot_workflow_definitions_active")).toBe("ok");
    expect(verdictOf(afterCeremony, "ot", "ot_definitions_published")).toBe("ok");
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
