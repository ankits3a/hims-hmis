import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { getApprovalType } from "../src/kernel/approvals/types";
import { getActiveDefinition } from "../src/kernel/workflow/definitions";
import { usersHoldingRoleAtScope } from "../src/kernel/workflow/roles";
import { loadBillingConfig } from "../src/modules/billing/config";
import { getGstSettings, listGstCategories } from "../src/modules/tariff/gst-config";
import { listPriceList, listServices } from "../src/modules/tariff/services";
import { LAB_DEPARTMENT_CODE, loadOpdConfig } from "../src/modules/opd";
import { listDepartments, listDoctors } from "../src/modules/opd/masters";
import { listResourcesOfKind } from "../src/kernel/resources/read";
import { registrationConfigured } from "../src/modules/patients";
import {
  LAB_DEF_KEYS, RELEASE_UNPAID_APPROVAL_TYPE, analytesFor, listOrderables, rangesFor,
} from "../src/modules/lab";
import { OPD_PHARMACY_STORE_CODE, PHARMACY_DEF_KEYS } from "../src/modules/pharmacy";
import { balances, findStoreByCode, listItems } from "../src/modules/materials";
import { IMAGING_GATE_DEF_KEY, IMAGING_STUDY_DEF_KEY, activeStudyTypes } from "../src/modules/radiology";
import { appointments, unlicensedDevices } from "../src/modules/aerb";
import type { Db } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core standup:check <module|all>` — PHASE 11i T2, THE READINESS CENSUS.
 *
 * ═══ WHAT IT IS, AND WHAT IT IS NOT ═══
 *
 * `check:config-present` asks whether the rows the MODULES THROW WITHOUT are present, and its exit
 * code aborts the deploy. `validate:config` asks whether the hospital may LEAVE COMMISSIONING, and
 * demands a CA signature. Neither answers the question a department head actually asks: **can we
 * open the laboratory on Monday?** That question is about staffing, master data and physical
 * benches — none of which a deploy can repair, and all of which somebody has to be told about in
 * the words of the runbook they will perform.
 *
 * So this is a CENSUS: a declared table of rows, one line of output each, three verdicts.
 *
 *   ok            the row is satisfied, read through the module's own loader
 *   RED           it is not, and `fix` is the runbook's own sentence for making it green
 *   NOT MODELLED  the schema does not hold this fact at all, and a human performs it — the row
 *                 names the runbook section they perform. It is NEVER printed green.
 *
 * ═══ WHY THE THIRD VERDICT EXISTS (§2b) ═══
 *
 * A census with two verdicts has to lie about the potassium of 6.8 at 02:00. `lab_critical_calls`
 * records the call; `opd_doctors` has no phone column, so the NUMBER THE BENCH RINGS IS NOT IN THE
 * SYSTEM. Reporting that green would be a readiness report that certifies a control nobody can
 * exercise; reporting it RED would be a permanent red row that trains its reader to ignore reds.
 * NOT MODELLED says the true thing: the artefact is a printed call list at the bench, refreshed
 * weekly, and here is the runbook section that describes it.
 *
 * ═══ IT READS THROUGH THE MODULES' OWN LOADERS — D3 ═══
 *
 * Every `check` below calls a module `index.ts` export, the module's own loader file where the
 * seam does not carry it (`opd/masters`, the shape `check-config-present.ts` already uses), or a
 * kernel loader. Not one selects from a table. `kernel/ops/validate.ts:20`'s recorded lesson is why: *a gate that builds its own view of
 * the configuration eventually validates something the engine will never see.* The side effect is
 * that a missing row produces THE ENGINE'S OWN error text, seed command included, and a loader
 * that throws is a RED row whose detail is the throw.
 *
 * ═══ IT REPORTS; IT ABORTS ONLY ON UAT — D3 ═══
 *
 * `deploy.sh` runs `standup:check all` after the configuration gate and prints it without obeying
 * it, exactly as it treats `seed-roles`' verdict: a statement about who has been hired is not a
 * reason to abort a deploy that has already migrated. As the UAT stand-up gate (T6) the exit code
 * IS the verdict, and it is read by a human standing at the bench.
 *
 * ═══ THE GATES ═══
 *
 * G1 the environment — facts about the box and the clock; no seed moves them.
 * G2 what the DEPLOY establishes — definitions, approval types, configuration rows, the stores.
 * G3 the hospital's master data — departments, the doctor of record, the catalogue, prices,
 *    licences. The owner's and the department head's acts.
 * G4 the people — who holds which role, at hospital scope.
 */
export type Gate = "G1" | "G2" | "G3" | "G4";
export type Verdict = "ok" | "RED" | "NOT MODELLED";

export type CheckRow = {
  gate: Gate;
  code: string;
  /** Answers the row through a module seam or a kernel loader. A throw is a RED whose detail is the throw. */
  check: (db: Db) => Promise<boolean>;
  /** The runbook's own sentence — the screen or command that turns this row green (D9). */
  fix: string;
};

export type NotModelledRow = {
  gate: Gate;
  code: string;
  /**
   * The runbook section a human performs instead. `section` is matched as TEXT and not as a
   * number: `lab-go-live.md` carries two sections numbered 11 and T6 renumbers one of them, so a
   * citation by number would go stale in the same phase that wrote it (D15).
   */
  runbook: { file: string; section: string };
  fix: string;
};

export type Row = CheckRow | NotModelledRow;
export const isNotModelled = (r: Row): r is NotModelledRow => "runbook" in r;

const LAB_ROLE_KEYS = ["lab_reception", "phlebotomist", "lab_technician", "pathologist"] as const;
const LAB_RUNBOOK = "docs/runbooks/lab-go-live.md";
const PHARMACY_RUNBOOK = "docs/runbooks/pharmacy-go-live.md";

/** Today in IST, as the AERB register's date functions want it. */
function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function labDepartmentId(db: Db): Promise<string | undefined> {
  const depts = await listDepartments(db, { activeOnly: true });
  return depts.find((d) => d.code.toUpperCase() === LAB_DEPARTMENT_CODE)?.id;
}

async function labDoctorsOfRecord(db: Db): Promise<{ registrationNo: string | null }[]> {
  const departmentId = await labDepartmentId(db);
  if (departmentId === undefined) return [];
  return listDoctors(db, { departmentId, activeOnly: true });
}

const heldAtHospitalScope = (roleKey: string) => async (db: Db): Promise<boolean> =>
  (await withTx(db, (tx) => usersHoldingRoleAtScope(tx, roleKey, "hospital"))).length > 0;

export const STANDUP_ROWS: Record<string, Row[]> = {
  /** Not a department: the rows every department's opening rests on. */
  hospital: [
    {
      gate: "G1", code: "ist_offset_is_0530",
      // §2b row 17. Six kernel and module files format in Asia/Kolkata; a container whose tz
      // database cannot resolve it does not fail — it silently formats in UTC, and the day
      // boundary of every report, every FY series and every night-mode window moves by 5h30.
      check: () => Promise.resolve(
        new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", timeZoneName: "longOffset" })
          .formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value === "GMT+05:30",
      ),
      fix: "the container has no Asia/Kolkata tz data — set TZ=Asia/Kolkata and rebuild the image",
    },
    {
      gate: "G2", code: "billing_config_present",
      check: async (db) => { await loadBillingConfig(db); return true; },
      fix: "run: pnpm --filter @hmis/core seed:billing",
    },
    {
      gate: "G2", code: "cash_law_thresholds_present",
      // §2b row 11 — a relative pays ₹2,10,000 in cash for a package. §269ST is enforced from
      // billing_config's thresholds; zeros are a counter that accepts any amount silently.
      check: async (db) => {
        const cfg = await loadBillingConfig(db);
        return cfg.cashBlockPaise > 0 && cfg.cashWarnPaise > 0 && cfg.panThresholdPaise > 0;
      },
      fix: "the §269ST thresholds are zero in billing_config — run: pnpm --filter @hmis/core seed:billing",
    },
    {
      gate: "G2", code: "gst_settings_present",
      check: async (db) => { await getGstSettings(db); return true; },
      fix: "run: pnpm --filter @hmis/core seed:tariff",
    },
    {
      gate: "G2", code: "patient_merge_registered",
      // §2b row 4 — duplicates minted during the paper-parallel pilot. Unregistered from Plan 05
      // until 2026-08-26, and every merge request threw `unknown_type` the whole time.
      check: async (db) => (await withTx(db, (tx) => getApprovalType(tx, "patient_merge"))) !== null,
      fix: "run: pnpm --filter @hmis/core seed:patients",
    },
    {
      gate: "G2", code: "registration_config_present",
      check: (db) => registrationConfigured(db),
      fix: "run: UHID_PREFIX=<PREFIX> pnpm --filter @hmis/core seed:registration",
    },
    {
      gate: "G4", code: "second_administrator",
      // lab-go-live.md §1.3, and it is a blocker there rather than a nicety: DD11's separation of
      // duties is the lab's central control, and one pair of hands holding every role satisfies none.
      check: async (db) => (await withTx(db, (tx) => usersHoldingRoleAtScope(tx, "admin", "hospital"))).length >= 2,
      fix: "§1.3: create a SECOND administrator at /admin/users — one pair of hands cannot hold DD11",
    },
  ],

  "front-desk": [
    {
      gate: "G2", code: "opd_config_present",
      check: async (db) => { await loadOpdConfig(db); return true; },
      fix: "run: pnpm --filter @hmis/core seed:opd",
    },
    {
      gate: "G3", code: "active_doctor_in_a_department",
      // `openVisitInTx` requires a department AND an active doctor in it; without the pair the
      // FIRST walk-in fails, not the seed.
      check: async (db) => {
        const depts = await listDepartments(db, { activeOnly: true });
        for (const d of depts) {
          if ((await listDoctors(db, { departmentId: d.id, activeOnly: true })).length > 0) return true;
        }
        return false;
      },
      fix: "create a department and an ACTIVE doctor in it at /opd/admin — openVisitInTx validates the pair",
    },
    {
      gate: "G4", code: "cashier_held",
      // §2b row 13 — the counter takes money and a drawer session must be open before it can.
      check: heldAtHospitalScope("cashier"),
      fix: "assign `cashier` at hospital scope at /admin/users — the drawer session cannot be opened without it",
    },
    { gate: "G4", code: "front_office_held", check: heldAtHospitalScope("front_office"),
      fix: "assign `front_office` at hospital scope at /admin/users" },
  ],

  lab: [
    {
      gate: "G3", code: "lab_department_active",
      check: async (db) => (await labDepartmentId(db)) !== undefined,
      fix: `§2: create the department code ${LAB_DEPARTMENT_CODE}, name Laboratory, active = true`,
    },
    {
      gate: "G3", code: "lab_doctor_of_record",
      check: async (db) => (await labDoctorsOfRecord(db)).length > 0,
      fix: "§2: create the pathologist of record as an opd_doctors row IN the LAB department",
    },
    {
      gate: "G3", code: "lab_doctor_registration_no",
      // §2b rows 5 and 20 — the NMC/state council number prints on every report's signatory block.
      // "It is what makes a laboratory report a document a court will read" (runbook §2).
      check: async (db) => (await labDoctorsOfRecord(db)).some((d) => (d.registrationNo ?? "").trim() !== ""),
      fix: "§2: set the pathologist's real registration_no — it prints on every report and a court reads it",
    },
    {
      gate: "G2", code: "lab_definitions_active",
      check: async (db) => {
        for (const key of LAB_DEF_KEYS) {
          if ((await withTx(db, (tx) => getActiveDefinition(tx, key))) === null) return false;
        }
        return true;
      },
      fix: "§5: done by seed:lab on every deploy — run: pnpm --filter @hmis/core seed:lab",
    },
    {
      gate: "G2", code: "lab_approval_type_registered",
      check: async (db) => (await withTx(db, (tx) => getApprovalType(tx, RELEASE_UNPAID_APPROVAL_TYPE))) !== null,
      fix: "§5: done by seed:lab on every deploy — run: pnpm --filter @hmis/core seed:lab",
    },
    {
      gate: "G3", code: "lab_orderable_present",
      check: async (db) => (await listOrderables(db)).length > 0,
      fix: "§4: load the owner's catalogue through POST /lab/catalogue/analytes then /orderables",
    },
    {
      gate: "G3", code: "lab_orderables_priced",
      // §4.5 — "an unpriced orderable fails at the DESK with `tariff_item_missing` in front of a
      // patient, not at seed time". The runbook's warning, made a check.
      check: async (db) => {
        const orderables = await listOrderables(db);
        if (orderables.length === 0) return false;
        const priced = new Set((await listPriceList(db)).map((r) => r.serviceId));
        return orderables.every((o) => priced.has(o.serviceId));
      },
      fix: "§4.5: every orderable needs a price in the ACTIVE tariff version, else the desk refuses tariff_item_missing",
    },
    {
      gate: "G3", code: "lab_range_sources_present",
      // §2b row 8 / §4.3 — NABL asks where every reference range came from.
      check: async (db) => {
        const orderables = await listOrderables(db);
        if (orderables.length === 0) return false;
        for (const o of orderables) {
          for (const a of await analytesFor(db, o.serviceId)) {
            const ranges = await rangesFor(db, a.id);
            if (ranges.length === 0 || ranges.some((r) => r.source.trim() === "")) return false;
          }
        }
        return true;
      },
      fix: "§4.3: every reference band needs a `source` naming where the range came from — NABL asks",
    },
    {
      gate: "G3", code: "lab_tariff_category_exempt",
      // §2b row 9 — lab services are GST-exempt. Whether the RATES are right is the CA's (O6) and
      // `validate:config`'s; whether the category is an exempt one is answerable here and now.
      check: async (db) => {
        const orderables = await listOrderables(db);
        if (orderables.length === 0) return false;
        const exempt = new Set((await listGstCategories(db)).filter((c) => c.exempt).map((c) => c.category));
        const byId = new Map((await listServices(db)).map((s) => [s.id, s]));
        return orderables.every((o) => {
          const category = byId.get(o.serviceId)?.category;
          return category !== undefined && exempt.has(category);
        });
      },
      fix: "§4: every lab orderable's tariff service must sit in a GST-EXEMPT category (healthcare services)",
    },
    {
      gate: "G3", code: "lab_bench_resource_present",
      check: async (db) => (await listResourcesOfKind(db, "bench")).length > 0,
      fix: "§6: create one `resources` row of kind `bench` per real bench and set each orderable's bench_key to match",
    },
    ...LAB_ROLE_KEYS.map((roleKey): CheckRow => ({
      gate: "G4", code: `lab_role_held_${roleKey}`,
      // §0 — THE ONE THING THAT WILL BITE YOU IF YOU SKIP IT. A login holding all fifteen lab.*
      // permissions and none of the four ROLE KEYS reaches every route and then cannot draw blood:
      // `kernel/workflow/instances.ts` checks the definition's declared ROLES against user_roles.
      check: heldAtHospitalScope(roleKey),
      fix: `§0/§3.5: assign the ROLE KEY \`${roleKey}\` at HOSPITAL scope at /admin/users — permissions are not consulted by a workflow transition`,
    })),
    {
      gate: "G3", code: "lab_critical_call_list",
      runbook: { file: LAB_RUNBOOK, section: "Drill A — a critical value at 02:00" },
      fix: "§10 drill A: `opd_doctors` has NO phone column — the number the bench rings at 02:00 is not in the system. The artefact is a printed call list at the bench, refreshed weekly.",
    } as NotModelledRow,
    {
      gate: "G3", code: "lab_report_ready_notice",
      runbook: { file: LAB_RUNBOOK, section: "## 11. What this build does NOT do" },
      fix: "kernel/notify has console adapters only: no provider, no TRAI DLT sender-id or template, no WABA template. NO PATIENT MESSAGE LEAVES THE BUILDING; the notice row is queued and not sent.",
    } as NotModelledRow,
    {
      gate: "G3", code: "lab_printer_destinations",
      runbook: { file: LAB_RUNBOOK, section: "## 6. Benches, resources and the physical laboratory" },
      fix: "§6: there is no printer destination registry — label, A4 and receipt printers are three devices at three seats. Record one test print per device per seat.",
    } as NotModelledRow,
  ],

  pharmacy: [
    {
      gate: "G2", code: "pharmacy_store_present",
      check: async (db) => (await findStoreByCode(db, OPD_PHARMACY_STORE_CODE)) !== undefined,
      fix: "§1.2: done by seed:pharmacy on every deploy — without it every claim refuses store_missing",
    },
    {
      gate: "G2", code: "pharmacy_definition_active",
      check: async (db) => {
        for (const key of PHARMACY_DEF_KEYS) {
          if ((await withTx(db, (tx) => getActiveDefinition(tx, key))) === null) return false;
        }
        return true;
      },
      fix: "§1.2: done by seed:pharmacy on every deploy — run: pnpm --filter @hmis/core seed:pharmacy",
    },
    { gate: "G4", code: "pharmacy_role_held", check: heldAtHospitalScope("pharmacy"),
      fix: "§1.4: assign `pharmacy` to the registered pharmacist(s) at /admin/users" },
    {
      gate: "G3", code: "pharmacy_item_present",
      check: async (db) => (await listItems(db, { class: "drug", active: true })).length > 0,
      fix: "§2.2: register each medicine as a drug ITEM at /materials/items, then for sale at /pharmacy/items",
    },
    {
      gate: "G3", code: "pharmacy_batch_in_stock",
      check: async (db) => {
        const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
        if (store === undefined) return false;
        return (await balances(db, { resourceId: store.id })).some((b) => b.qtyOnHand > 0);
      },
      fix: "§2.5: GRN stock into PHARM-OPD with batch, expiry and the printed MRP per pack",
    },
    {
      gate: "G4", code: "pharmacist_council_number",
      runbook: { file: PHARMACY_RUNBOOK, section: "## 1. Preconditions (owner / administrator)" },
      fix: "§1: the pharmacist's state council registration number is NOT modelled anywhere in the schema. Keep the certificate in the counter's file; the census cannot check it.",
    } as NotModelledRow,
  ],

  radiology: [
    {
      /**
       * **G3 and not G2, and the classification IS the finding.** G2 is what a deploy establishes;
       * the lab's and the pharmacy's equivalents sit there because a seed activates them. These
       * are change-class **A**, so activating one takes three distinct humans — no deploy can write
       * them, which is the definition of G3.
       */
      gate: "G3", code: "radiology_definitions_active",
      /**
       * MEASURED 2026-09-06 by standing the department up on an empty database: `imaging_study` and
       * `imaging_gate` are activated by **no seed and no script** — `RADIOLOGY_WORKFLOW_DEFINITIONS`
       * is referenced by the e2e test and the test helper and by nothing else. Without them a placed
       * order produces no study, and **there is no refusal to read**, because the failure is in
       * `handleOrderPlaced` inside the worker: the route returns 201 and the reception screen stays
       * empty. That silence is why this row is worth more than the others in the set.
       *
       * The `fix` is a runbook section rather than a command, and that is deliberate — these are
       * change-class **A**, so activating them needs three distinct humans (a drafter, two approvers,
       * and an activator who is not the drafter). A census can say the definitions are missing; it
       * must not pretend a script can supply them.
       */
      check: async (db) => {
        for (const key of [IMAGING_STUDY_DEF_KEY, IMAGING_GATE_DEF_KEY]) {
          if ((await withTx(db, (tx) => getActiveDefinition(tx, key))) === null) return false;
        }
        return true;
      },
      fix: "radiology-go-live.md §3: three named humans — a drafter, owner + medical superintendent approving, and an activator who is not the drafter",
    },
    {
      gate: "G2", code: "radiology_study_types_active",
      // MEASURED 2026-09-06 and REPORTED rather than fixed here: `seed-radiology.js` exists, is in
      // package.json, and `deploy.sh` DOES NOT RUN IT — so this Class-C definition is established
      // by no deploy, which is the same defect 11i T1 closed for the lab. Fixing it belongs to the
      // radiology lane's own stand-up, not inside the lab's phase; the census's job is to say so.
      check: async (db) => (await activeStudyTypes(db)).length > 0,
      fix: "run: pnpm --filter @hmis/core seed:radiology — NOTE deploy.sh does not run it (11i finding)",
    },
    {
      gate: "G3", code: "radiology_device_present",
      check: async (db) => (await listResourcesOfKind(db, "device")).length > 0,
      // CORRECTED 2026-09-06: this named an act with no door. There is no resources screen and no
      // create route; `seed:radiology` is the only writer of an imaging device.
      fix: "radiology-go-live.md §5: add the machine to MODALITY_MACHINES and re-run seed:radiology — there is no resources screen",
    },
    {
      gate: "G3", code: "radiology_devices_licensed",
      // 18c §0: ionising acquisition refuses `device_not_licensed` from the moment 0060-0065 land.
      //
      // MEASURED, AND IT CHANGED THIS ROW: `unlicensedDevices` returns [] on a database with no
      // devices at all, so "none unlicensed" read GREEN on an empty box — a row that certified a
      // control nobody could exercise, which is the exact failure the third verdict exists to
      // avoid one column over. The register holding no machine cannot be evidence that every
      // machine has its paper, so the row now requires a device to exist before it can be green.
      check: async (db) => {
        const devices = await listResourcesOfKind(db, "device");
        return devices.length > 0 && (await unlicensedDevices(db, istToday())).length === 0;
      },
      fix: "18c §2: file each ionising machine's AERB licence at /radiology/radiation-safety until GET /aerb/licences/gaps is empty",
    },
    {
      gate: "G4", code: "radiology_rso_appointed",
      // §2b row 20 — the RSO's AERB approval. A named human with a live appointment row.
      check: async (db) => (await appointments(db, { onDate: istToday() })).some((a) => a.personRole === "rso"),
      fix: "18c §3: record the Radiological Safety Officer's appointment at /radiology/radiation-safety",
    },
  ],
};

export type RowResult = { module: string; gate: Gate; code: string; verdict: Verdict; fix: string; detail?: string };

export async function runCensus(db: Db, moduleName: string): Promise<RowResult[]> {
  const names = moduleName === "all" ? Object.keys(STANDUP_ROWS) : [moduleName];
  const out: RowResult[] = [];
  for (const name of names) {
    const rows = STANDUP_ROWS[name];
    if (rows === undefined) throw new Error(`standup:check: unknown module "${name}" — declared: ${Object.keys(STANDUP_ROWS).join(", ")}, all`);
    for (const row of rows) {
      if (isNotModelled(row)) {
        out.push({ module: name, gate: row.gate, code: row.code, verdict: "NOT MODELLED", fix: `${row.runbook.file} — ${row.runbook.section}: ${row.fix}` });
        continue;
      }
      try {
        const ok = await row.check(db);
        out.push({ module: name, gate: row.gate, code: row.code, verdict: ok ? "ok" : "RED", fix: row.fix });
      } catch (e) {
        // A loader that THROWS is the engine's own refusal, seed command and all. That text is
        // more useful than any sentence this file could write about it.
        out.push({
          module: name, gate: row.gate, code: row.code, verdict: "RED", fix: row.fix,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return out;
}

export function censusLines(results: RowResult[]): string[] {
  return results.map((r) =>
    `${r.verdict.padEnd(12)} ${r.gate} ${r.module}.${r.code} — ${r.fix}${r.detail === undefined ? "" : ` [${r.detail}]`}`,
  );
}

/** RED is the only verdict that fails. NOT MODELLED is a fact about the schema, not a failure. */
export const anyRed = (results: RowResult[]): boolean => results.some((r) => r.verdict === "RED");

async function main(): Promise<void> {
  const moduleName = process.argv[2] ?? "all";
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const results = await runCensus(db, moduleName);
    for (const line of censusLines(results)) console.log(line);
    const red = results.filter((r) => r.verdict === "RED").length;
    const notModelled = results.filter((r) => r.verdict === "NOT MODELLED").length;
    console.log(`standup:check ${moduleName}: rows=${results.length} red=${red} not_modelled=${notModelled}`);
    if (anyRed(results)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e); process.exit(1); });
}
