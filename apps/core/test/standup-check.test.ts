import { inArray } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { setupTestDb, truncateAll } from "./helpers/db";
import { activateOpdVisitDefinition, ensureRole, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, grantPermissionToRole } from "../src/kernel/auth/permissions";
import { withTx } from "../src/kernel/db/client";
import {
  billingConfig, formularyInteractions, labOrderables, opdDepartments, opdDoctors, permissions,
  resources, rolePermissions, services, pharmacySaleItems,
} from "../src/kernel/db/schema";
import { registerBillingApprovalTypes } from "../src/modules/billing/approval-types";
import { registerPatientApprovalTypes } from "../src/modules/patients/approval-types";
import { registerTariffApprovalTypes } from "../src/modules/tariff/approval-types";
import { createService } from "../src/modules/tariff/services";
import { seedTariffConfig } from "../scripts/seed-tariff";
import { ensurePharmacyCounter } from "../scripts/seed-pharmacy";
import {
  currentRegistration, endPharmacistRegistration, recordPharmacistRegistration, recordRetailLicence,
} from "../src/modules/pharmacy";
import { istDayString } from "../src/kernel/approvals/cumulative";
import { seedPharmacyBase } from "./helpers/pharmacy";
import { ensureLabStandUp } from "../scripts/seed-lab";
import { seedFormularyInteractions } from "../scripts/seed-formulary-interactions";
import { ensureOtUnit } from "../scripts/seed-ot";
import { seedOtBase } from "./helpers/ot";
import { setupPcpndtFixture } from "./helpers/pcpndt";
import { registerOtApprovalTypes } from "../src/modules/ot";
import { registerMaterialsApprovalTypes } from "../src/modules/materials";
import {
  ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_RESOLVER_FLAG, assign, draftPeriod, listTeams,
  publishPeriod, seedOrgDepartments, seedRosterPositions, seedUnits,
} from "../src/modules/roster";
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
  /**
   * RULED A DEPARTMENT 2026-09-07. It meets every test the other five did — master data no deploy
   * supplies, human acts no seed may perform — and it was the only one where **nothing anywhere
   * checked that any of it existed**: a hospital could scan patients holding no register at all.
   * `aerb` was ruled the other way in the same pass and stays below: its acts (`radiology_devices_licensed`,
   * `radiology_rso_appointed`) are already checked under `radiology`, because AERB is a statutory
   * layer over one department rather than a department with its own seats.
   */
  pcpndt: "pcpndt",
};

/**
 * NOT A DEPARTMENT — no go-live day of its own, so no runbook and no row set.
 *
 * ═══ THREE ARE AN OPEN QUESTION AND ARE RECORDED, NOT DECIDED ═══
 *
 * Five were open on 2026-09-07 and two were ruled the same day: **`pcpndt` IS a department** (it is
 * in `DEPARTMENTS` above) and **`aerb` is not** (see its line below). The remaining three —
 * `billing`, `materials`, `membership` — each hold master data no deploy can supply, which is the
 * property that made the departments.
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
  roster: "PHASE R (R1) — not a department: a layer OVER every one of them, the way `aerb` is a layer over radiology. It has no clinical day of its own, nothing to commission and no patient; what it HAS is one G1 row, because a hospital whose masters are unseeded cannot draft any department's rota",
  aerb: "RULED not a department 2026-09-07 — a statutory layer OVER radiology; `radiology_devices_licensed` and `radiology_rso_appointed` already check its acts, and a row set of its own would demand a second check of the same certificates",
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
  "pcpndt-go-live.md": "pcpndt",
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
  /**
   * `deploy.sh:588` runs `seed-formulary-interactions.js`, so the interaction book is a deploy fact
   * and `formulary_interactions_loaded` is G2. Same reason as the OT calls below: this helper is a
   * hand-built mirror of that script, and a mirror that drifts reports ITS OWN gap as the deploy's.
   */
  await seedFormularyInteractions(db);
  await registerOtApprovalTypes(db, ACTOR);
  await ensureOtUnit(db, ACTOR);
  // `deploy.sh` runs `seed-materials.js`: the purchase order's two approval types are deploy facts
  // (parity P2's `pharmacy_po_approval_registered`), and so are the three older materials types.
  await registerMaterialsApprovalTypes(db, ACTOR);
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

  it("no go-live runbook numbers two sections the same — 11i T6 / D10", () => {
    /**
     * `lab-go-live.md` carried TWO sections numbered 11 — "What this build does NOT do" and "The
     * five seats" — and 11i §2b row 7 cited "§11" without being able to say which. A citation that
     * can mean two things is worse than none: the reader who follows it lands somewhere plausible
     * and stops looking.
     *
     * D10 renumbered the walk-through to 13. This leg is why it stays renumbered, and it reads
     * every go-live runbook rather than the one that had the defect — the deploy-parity lesson
     * about pinning the property instead of the instance, applied here.
     */
    const runbooks = readdirSync(RUNBOOK_DIR).filter((f) => f.endsWith("-go-live.md"));
    for (const file of runbooks) {
      const numbers = [...readFileSync(resolve(RUNBOOK_DIR, file), "utf8").matchAll(/^## (\d+)\. /gm)]
        .map((m) => m[1]!);
      const duplicated = numbers.filter((n, i) => numbers.indexOf(n) !== i);
      expect({ file, duplicated }).toEqual({ file, duplicated: [] });
      expect(numbers.length).toBeGreaterThan(3); // non-vacuous: the headings were actually read
    }
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

  /**
   * ═══ RULE 3 HAD NO ENFORCEMENT, AND SIX OF EIGHT RUNBOOKS DO NOT SATISFY IT ═══
   *
   * A go-live runbook's whole purpose is a department head performing its acts — and six of the
   * eight have **nowhere to record that they did**. `lab-go-live.md` and `pharmacy-go-live.md`
   * carry an `## Executed` section with a numbered row per act and a defects log; the other six
   * carry none, so a walk-through leaves no artefact and the phase gate has nothing to read.
   *
   * THIS TEST IS A RATCHET, NOT A WISH. Writing the six missing sections means authoring six
   * departments' walk-throughs, which belongs to the lanes that own those modules — inventing
   * radiology's acts from outside is how a runbook acquires steps nobody performs. So the gap is
   * pinned at its CURRENT size: a new runbook without an Executed section fails immediately, and a
   * runbook that gains one fails until it is removed from this list. **The list may only shrink,
   * and shrinking it is a deliberate act rather than a silent one.**
   */
  it("no go-live runbook loses its Executed section, and no new one arrives without it", () => {
    const KNOWN_MISSING = [
      "opd-go-live.md", "ot-go-live.md", "pcpndt-go-live.md",
      "radiation-safety-go-live.md", "radiology-go-live.md", "radiology-pacs-go-live.md",
    ];
    const dir = resolve(__dirname, "..", "..", "..", "docs", "runbooks");
    const runbooks = readdirSync(dir).filter((f) => f.endsWith("-go-live.md")).sort();
    const withExecuted = runbooks.filter((f) => /^## .*Executed/m.test(readFileSync(resolve(dir, f), "utf8")));
    const without = runbooks.filter((f) => !withExecuted.includes(f));

    /* The guard on the guard: a glob that matched nothing would pass both assertions forever. */
    expect(runbooks.length).toBeGreaterThanOrEqual(8);
    expect(without.sort()).toEqual(KNOWN_MISSING.sort());
    expect(withExecuted).toContain("pharmacy-go-live.md");
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

  /**
   * PHASE R (R10) — **THE STATE IN WHICH `take_is_continuous` USED TO LIE.**
   *
   * The row's own comment has always claimed *"Green only when a published cycle EXISTS and has no
   * hole — the emptiness lesson this file learned twice"*. Its code asked `listTeams(...)`, bound
   * the answer to a variable called `cycles`, and refused only when there were no TEAMS. Since
   * `seed:roster` seeds the units, that guard was satisfied on day one, and
   * `departmentsWithTakeGaps` — which reads only PUBLISHED cycles — returned an empty list. Empty
   * gaps, green row, every department admitting nobody.
   *
   * `deployG2State` never reached this state because it seeds no roster masters at all, so the
   * blanket "no G3 row is green" assertion above stepped straight over it. **A census can only be
   * caught lying in the state it lies about**, and this test builds exactly that state: masters
   * seeded, units seeded, no cycle published.
   */
  it("take_is_continuous is RED when the units exist and NO cycle is published", async () => {
    await deployG2State(db);
    // `seedRosterPositions` refuses if a position names a role that does not exist — the R1 guard
    // that stops a position's `eligible_role_key` being tied to nothing.
    for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) {
      await ensureRole(db, key);
    }
    await seedOrgDepartments(db, "t");
    await seedRosterPositions(db, "t");
    await seedUnits(db, "t");

    const results = await runCensus(db, "all");
    const take = results.find((r) => r.code === "take_is_continuous");
    expect(take).toBeDefined();

    /**
     * THE POPULATION THE OLD CODE LOOKED AT, asserted directly. The first version of this guard
     * asserted `roster_masters_seeded` — departments and positions — which is NOT what the buggy
     * check counted. It counted clinical-unit TEAMS, so if `seedUnits` ever stopped producing rows
     * this test would have gone on passing while quietly ceasing to be a regression test at all.
     */
    expect((await listTeams(db, { kind: "clinical_unit" })).length).toBeGreaterThan(0);

    // …and with nothing published, "no gaps" is not evidence of cover.
    expect(`${take!.code}: ${take!.verdict}`).toBe("take_is_continuous: RED");
  });

  /**
   * A roster that COVERS NOW — the act `resolver_has_a_roster` waits for. Small on purpose: one
   * department, one unit, one slot, a window around this instant.
   */
  const publishARosterCoveringNow = async (db: Db): Promise<void> => {
    // Both roles: one to be allowed to publish, one because `ward_jr` answers as `doctor`
    // and R2 refuses a slot whose holder does not hold the position's eligible role.
    const { actor: ms } = await mkUser(db, "standup.ms", ["medical_superintendent", "doctor"]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH].map((permission) => ({ permission, module: "roster" })),
    ).onConflictDoNothing();
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    ).onConflictDoNothing();

    // Pick the UNIT first and take its department from it. Choosing a department first and then
    // hunting for one of its units assumes every department runs units, and `seedUnits` seeds them
    // only for the ones that do.
    const unit = (await listTeams(db, { kind: "clinical_unit" }))[0];
    if (unit === undefined) throw new Error("fixture: seedUnits produced no clinical unit");
    const dept = { id: unit.departmentId };
    const from = new Date(Date.now() - 86_400_000);
    const to = new Date(Date.now() + 86_400_000);

    const p = await withTx(db, (tx) => draftPeriod(tx, ms, {
      scopeType: "team", scopeId: unit.id, departmentId: dept.id, teamId: unit.id,
      title: "standup fixture", startsAt: from, endsAt: to, coversPositions: ["ward_jr"],
    }));
    await withTx(db, (tx) => assign(tx, ms, p.periodId, {
      userId: ms.id, positionKey: "ward_jr", departmentId: dept.id, teamId: unit.id,
      startsAt: from, endsAt: new Date(from.getTime() + 8 * 3_600_000),
    }));
    await withTx(db, (tx) => publishPeriod(tx, ms, p.periodId));
  };

  /**
   * PLAN 20 T7 / PHASE R (R10). The row is RED until a roster is published — this census's grammar,
   * which the first draft of the row broke by being green while the resolver flag was off. The
   * state T7 actually names (flag ON, nothing published) is the worst case of the same red: every
   * on-call question falls back to role holders, correctly and silently, and nothing says so.
   */
  it("resolver_has_a_roster is RED until a roster is published, flag or no flag", async () => {
    await deployG2State(db);
    for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) {
      await ensureRole(db, key);
    }
    await seedOrgDepartments(db, "t");
    await seedRosterPositions(db, "t");
    await seedUnits(db, "t");
    const flagWas = process.env[ROSTER_RESOLVER_FLAG];
    try {
      delete process.env[ROSTER_RESOLVER_FLAG];
      const off = (await runCensus(db, "all")).find((r) => r.code === "resolver_has_a_roster");
      expect(`flag off, nothing published: ${off!.verdict}`).toBe("flag off, nothing published: RED");

      process.env[ROSTER_RESOLVER_FLAG] = "true";
      const on = (await runCensus(db, "all")).find((r) => r.code === "resolver_has_a_roster");
      expect(`flag on, nothing published: ${on!.verdict}`).toBe("flag on, nothing published: RED");

      /**
       * AND IT TURNS GREEN ON THE ACT — without this leg, `check: () => false` would satisfy every
       * assertion above and the whole repo besides, because the blanket test only ever asserts that
       * no G3 row IS green. A census row with no green leg is a row nobody has proved can pass.
       *
       * The roster published here COVERS NOW, which is the other half: a period keeps
       * `status = 'published'` for ever once published, so a rota from last year would turn this
       * green while every question today still falls back.
       */
      await publishARosterCoveringNow(db);
      const after = (await runCensus(db, "all")).find((r) => r.code === "resolver_has_a_roster");
      expect(`after publishing: ${after!.verdict}`).toBe("after publishing: ok");
    } finally {
      if (flagWas === undefined) delete process.env[ROSTER_RESOLVER_FLAG];
      else process.env[ROSTER_RESOLVER_FLAG] = flagWas;
    }
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

  /**
   * ═══ §PCPNDT — THE REGISTER NOTHING CHECKED, AND THE STATUTE BEHIND IT ═══
   *
   * `pcpndt` has NO seed and therefore NO G2 row: every act is a person's, with a legal obligation.
   * Before this row set, a hospital could deploy, scan patients and hold **no register at all** with
   * nothing going red — the module was in nobody's population, which is exactly what the
   * `ALL_MANIFESTS` guard above now prevents.
   *
   * The fixture performs the real ceremony §2-§4 of the runbook describes — premises, machine,
   * person — so this measures the runbook rather than restating the check.
   */
  it("§PCPNDT: the register is RED after every deploy seed, and green only after the premises, machine and person are registered", async () => {
    await deployG2State(db);

    /** No seed exists, so the deploy leaves the whole register empty. */
    const afterDeploy = await runCensus(db, "pcpndt");
    expect(verdictOf(afterDeploy, "pcpndt", "pcpndt_registration_active")).toBe("RED");
    expect(verdictOf(afterDeploy, "pcpndt", "pcpndt_machine_registered")).toBe("RED");
    expect(verdictOf(afterDeploy, "pcpndt", "pcpndt_person_registered")).toBe("RED");
    /** And the wall is never green: no column holds it (§6). */
    expect(verdictOf(afterDeploy, "pcpndt", "pcpndt_certificate_displayed")).toBe("NOT MODELLED");

    await truncateAll(db);
    await setupPcpndtFixture(db);

    const afterRegistering = await runCensus(db, "pcpndt");
    expect(verdictOf(afterRegistering, "pcpndt", "pcpndt_registration_active")).toBe("ok");
    expect(verdictOf(afterRegistering, "pcpndt", "pcpndt_machine_registered")).toBe("ok");
    expect(verdictOf(afterRegistering, "pcpndt", "pcpndt_person_registered")).toBe("ok");
    expect(verdictOf(afterRegistering, "pcpndt", "pcpndt_incharge_held")).toBe("ok");
    /** Still not green, and it never can be — that is what the third verdict is for. */
    expect(verdictOf(afterRegistering, "pcpndt", "pcpndt_certificate_displayed")).toBe("NOT MODELLED");
  });

  /**
   * ═══ THE INTERACTION BOOK, AND WHY THE PREDICATE IS THE SEED'S CENSUS RATHER THAN `> 0` ═══
   *
   * The fresh-database assertion above already proves this row is RED on an empty table — if it were
   * green there, that test's `expect(green).toEqual(["hospital.ist_offset_is_0530"])` would fail.
   * **That covers "never green when it should be red"; it does NOT cover the predicate.**
   *
   * A `> 0` row passes the fresh-database test too, and then goes green on ONE pair — certifying
   * "somebody ran the seed" while reporting "the interaction book is loaded" (#175: a census row
   * must measure what it certifies). This case is the only thing that tells the two apart, and it is
   * why it exists: a PARTIAL book must read RED.
   *
   * The failure it guards is silent and reassuring, which is what makes it worth the test:
   * `opd/rx-checks.ts` runs on every prescription, and with an empty book `listInteractionsAmong`
   * returns `[]` — on screen, indistinguishable from a checker that ran and found nothing.
   */
  it("the interaction book: a PARTIAL seed reads RED, not just an empty one", async () => {
    await deployG2State(db);
    expect(verdictOf(await runCensus(db, "hospital"), "hospital", "formulary_interactions_loaded"))
      .toBe("ok");

    /** Leave exactly one pair — the state a `> 0` predicate would call green. */
    const all = await db.select({ id: formularyInteractions.id }).from(formularyInteractions);
    expect(all.length).toBeGreaterThan(1); // non-vacuous: the seed really loaded a book
    await db.delete(formularyInteractions)
      .where(inArray(formularyInteractions.id, all.slice(1).map((r) => r.id)));

    expect(verdictOf(await runCensus(db, "hospital"), "hospital", "formulary_interactions_loaded"))
      .toBe("RED");
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
      id: "doc-record", userId, displayName: "Dr Record", code: "DR-9001", registrationNo: null,
      departmentId: deptId, createdBy: "t", updatedBy: "t",
    });
    results = await runCensus(db, "lab");
    expect(verdictOf(results, "lab", "lab_doctor_of_record")).toBe("ok");
    // The number is a legal fact and a separate row: it prints on every report's signatory block.
    expect(verdictOf(results, "lab", "lab_doctor_registration_no")).toBe("RED");
    expect(roomId).toBeDefined();
  });

  /**
   * THE TWO PHARMACY ROWS THAT CERTIFIED MORE THAN THEY MEASURED.
   *
   * `pharmacy_item_present`'s fix text named TWO acts — create the drug item (§2.2, materials_head)
   * and register it FOR SALE (§2.3, pharmacy) — and its check tested only the first. An item that
   * exists and was never registered has no `RX-<code>` service, so the counter refuses every line
   * with `unknown_sale_item` while the row reads green. **One row cannot certify two roles' work.**
   *
   * `pharmacy_batch_in_stock` asked `qtyOnHand > 0` over raw balances: no expiry filter, no recall
   * filter, no reserved deduction, and no check the item was sellable at all. **An expired batch
   * has `qtyOnHand > 0`** — so it read green on a shelf the counter refuses every line from.
   */
  it("a drug item that was never registered FOR SALE leaves the sale-item row RED", async () => {
    await seedPharmacyBase(db);
    await ensurePharmacyCounter(db, ACTOR);
    /* The fixture registers its three items FOR SALE as well as creating them, so the two rows
       agree out of the box and prove nothing. Removing only the sale registrations builds the
       state the old single row could not describe: §2.2 done, §2.3 not. */
    await db.delete(pharmacySaleItems);
    const rows = await runCensus(db, "pharmacy");
    expect(rows.find((r) => r.code === "pharmacy_item_present")?.verdict).toBe("ok");
    expect(rows.find((r) => r.code === "pharmacy_sale_item_registered")?.verdict).toBe("RED");
  });

  it("the stock row asks what the PICK will honour, not what the shelf holds", async () => {
    await seedPharmacyBase(db);
    await ensurePharmacyCounter(db, ACTOR);
    const rows = await runCensus(db, "pharmacy");
    expect(rows.find((r) => r.code === "pharmacy_batch_in_stock")?.verdict).toBe("RED");
  });

  /**
   * PHARMACY P2 — the row that used to be NOT MODELLED. A role holder is not a registered
   * pharmacist; the counter's verify refuses anyone without a registration on file.
   */
  it("the pharmacist row is green only while someone holding pharmacy has a current registration", async () => {
    const fx = await seedPharmacyBase(db);
    await ensurePharmacyCounter(db, ACTOR);
    let rows = await runCensus(db, "pharmacy");
    expect(rows.find((r) => r.code === "pharmacist_council_number")?.verdict).toBe("ok");
    const reg = await currentRegistration(db, fx.pharmacist.id, istDayString(new Date()));
    if (reg === null) throw new Error("fixture registration missing");
    await withTx(db, (tx) => endPharmacistRegistration(tx, fx.incharge.actor, reg.id, "left the hospital"));
    rows = await runCensus(db, "pharmacy");
    expect(rows.find((r) => r.code === "pharmacist_council_number")?.verdict).toBe("RED");
    fx.unregister();
  });

  it("the walk-in counter's licence row is red after the deploy, and green only once a current licence is recorded (P19)", async () => {
    const fx = await seedPharmacyBase(db);
    try {
      await ensurePharmacyCounter(db, ACTOR);
      let rows = await runCensus(db, "pharmacy");
      expect(rows.find((r) => r.code === "pharmacy_retail_store_present")?.verdict).toBe("ok");
      expect(rows.find((r) => r.code === "pharmacy_retail_licence")?.verdict).toBe("RED");
      await ensureRole(db, "pharmacy_incharge");
      await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
      const licensee = await mkUser(db, "ph.licensee", ["pharmacy_incharge"]);
      const today = istDayString(new Date());
      await recordRetailLicence(db, licensee.actor, {
        form20No: "F20-1", form21No: "F21-1", validFrom: "2020-01-01", validTo: "2020-12-31", pharmacistInCharge: "A. Kulkarni",
      }, new Date());
      rows = await runCensus(db, "pharmacy");
      expect(rows.find((r) => r.code === "pharmacy_retail_licence")?.verdict).toBe("RED"); // lapsed
      await recordRetailLicence(db, licensee.actor, {
        form20No: "F20-2", form21No: "F21-2", validFrom: today, validTo: "2099-12-31", pharmacistInCharge: "A. Kulkarni",
      }, new Date());
      rows = await runCensus(db, "pharmacy");
      expect(rows.find((r) => r.code === "pharmacy_retail_licence")?.verdict).toBe("ok");
    } finally {
      fx.unregister();
    }
  });

  /**
   * PHARMACY P15 — a registration about to lapse is a row, because the day it lapses verify refuses
   * that pharmacist at the counter. Sixty days' notice; filing the renewal turns it green.
   */
  it("the renewal row is red while a pharmacist's registration lapses within sixty days, and green once it is renewed", async () => {
    const fx = await seedPharmacyBase(db);
    await ensurePharmacyCounter(db, ACTOR);
    const DAY = 24 * 60 * 60 * 1000;
    const inDays = (n: number): string => istDayString(new Date(Date.now() + n * DAY));
    let rows = await runCensus(db, "pharmacy");
    expect(rows.find((r) => r.code === "pharmacist_registration_not_lapsing")?.verdict).toBe("ok");
    await withTx(db, (tx) => recordPharmacistRegistration(tx, fx.pharmacist.actor, {
      userId: fx.incharge.id, council: "Maharashtra State Pharmacy Council", registrationNo: "MSPC-555", validUntil: inDays(20),
    }, new Date()));
    rows = await runCensus(db, "pharmacy");
    expect(rows.find((r) => r.code === "pharmacist_registration_not_lapsing")?.verdict).toBe("RED");
    await withTx(db, (tx) => recordPharmacistRegistration(tx, fx.pharmacist.actor, {
      userId: fx.incharge.id, council: "Maharashtra State Pharmacy Council", registrationNo: "MSPC-555", validUntil: inDays(61),
    }, new Date()));
    rows = await runCensus(db, "pharmacy");
    expect(rows.find((r) => r.code === "pharmacist_registration_not_lapsing")?.verdict).toBe("ok");
    fx.unregister();
  });

  /**
   * The OT's day-care orphan report "is reported HERE or by nobody", so the role that reads it is a
   * must-not-open-without condition rather than a nicety. G4: no deploy can write it.
   */
  it("the OT does not open for day-care work until someone holds ot_incharge", async () => {
    const rows = await runCensus(db, "ot");
    expect(rows.find((r) => r.code === "ot_incharge_held")?.verdict).toBe("RED");
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
