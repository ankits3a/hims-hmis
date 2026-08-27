import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setupTestDb, truncateAll } from "./helpers/db";
import type { Db } from "../src/kernel/db/client";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { OPD_ROLE_KEYS } from "../src/modules/opd/config";
import {
  GRANTED_BY_OTHER_SEEDS,
  LOCAL_ROLE_TITLES,
  NOT_YET_MODELLED,
  ROLE_MODEL,
  heldInDatabase,
  heldPermissions,
  modelPermissions,
  formatReport,
  roleTitle,
  seedRoles,
} from "../scripts/seed-roles";
import { assignRole, createRole, grantPermissionToRole } from "../src/kernel/auth/permissions";
import { createUser } from "../src/kernel/auth/identity";
import { authManifest } from "../src/kernel/auth/manifest";
import { rolePermissions } from "../src/kernel/db/schema";

/**
 * Plan 11d / D1 + D3, Book rows V1, V2, V3 and V5 — the role model is CODE, the README is pinned
 * to it, and every declared permission is reachable by somebody.
 *
 * WHAT EACH LEG BUYS, because a parity test that has never been watched to fail is §2.22's "not a
 * pre-flight":
 *   V1  every string the model grants is DECLARED by an installed manifest — catches a typo
 *       (`billing.invoice.isue`) and an orphan grant.
 *   V2  every DECLARED permission is held by at least one role or named in `NOT_YET_MODELLED`
 *       WITH ITS REASON — the reachability invariant, which is the assertion that fails the build
 *       the day a module adds a permission and forgets the role model. That failure mode produced
 *       MAJOR 4 twice.
 *   V3  the README's two markdown tables and the model agree cell for cell, BOTH DIRECTIONS, over
 *       the TABLE-DERIVED subset — plus a leg of its own for the eight `patients.*` pairs owner
 *       ruling 7 added, which appear in NEITHER table. A model row that is neither table-derived
 *       nor one of those eight FAILS: that is what stops the subset scoping becoming a hole.
 *   V5  the seed is idempotent, proven by running it twice against one database.
 *
 * §2.49 / GC15 — THIS TEST CAN PASS VACUOUSLY AND MUST NOT. Two parsers that both return `[]`
 * agree with each other forever. Three things prevent it here, copied from
 * `caddyfile-parity.test.ts`'s discipline: both README parsers THROW rather than return empty on
 * a shape they do not recognise (a missing header, a mismatched column count, a cell that is
 * neither a tick nor blank, a permission cell that is not a backticked dotted name); the CENSUS
 * BLOCK below pins every count — manifests, roles, pairs, table shapes — BEFORE anything is
 * compared; and one test drives the parsers against deliberately garbled input to watch them
 * throw.
 *
 * THE BILLING TABLE'S LAST ROW IS `approvals.requests.read` / `.decide` IN ONE CELL — two
 * permissions from a DIFFERENT manifest written as a shorthand. The parser EXPANDS it. It must
 * never silently skip it: skipping is how a parity test passes vacuously, and the pair count in
 * the census is what proves the expansion happened.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const README = resolve(REPO_ROOT, "README.md");

/** The README prose line that authorises owner ruling 7's `patients.*` grants. Quoted, not paraphrased. */
const RULING_7_README_PROSE =
  "Plan 05's `patients.register` / `patients.read` (and `patients.update` for quick allergies) stay";

/** The eight (role, permission) pairs owner ruling 7 added, which appear in NEITHER README table. */
const RULING_7_PAIRS: readonly string[] = [
  "front_office/patients.read",
  "front_office/patients.register",
  "front_office/patients.update",
  "front_office_supervisor/patients.read",
  "front_office_supervisor/patients.register",
  "front_office_supervisor/patients.update",
  "vitals_desk/patients.read",
  "vitals_desk/patients.update",
];

/** The README prose line that authorises the 2026-08-23 workflow ruling. Quoted, not paraphrased. */
const WORKFLOW_RULING_README_PROSE =
  "Owner ruling of 2026-08-23 assigns the four `workflow.definitions.*` strings, which appear in no";

/**
 * The seven (role, permission) pairs the 2026-08-23 workflow ruling added, which appear in NEITHER
 * README table. The SECOND set of non-table rows, and the reason V3's last leg compares against a
 * union rather than a single constant: `workflow.*` is declared by the workflow manifest and has no
 * permission column anywhere, exactly as ruling 7's `patients.*` pairs do not.
 */
const WORKFLOW_RULING_PAIRS: readonly string[] = [
  "medical_superintendent/workflow.definitions.approve",
  "medical_superintendent/workflow.definitions.read",
  "opd_admin/workflow.definitions.draft",
  "opd_admin/workflow.definitions.read",
  "owner/workflow.definitions.activate",
  "owner/workflow.definitions.approve",
  "owner/workflow.definitions.read",
];

/** The README prose line that authorises Plan 09's DD18 grants. Quoted, not paraphrased. */
const PLAN_09_README_PROSE =
  "Plan 09's four `membership.*` strings appear in neither table above";

/**
 * The ten (role, permission) pairs Plan 09's DD18 added, which appear in NEITHER README table.
 *
 * THE THIRD set of non-table rows, landed the same way the two above did — a named constant here
 * plus a README prose line this test quotes verbatim — because `membership.*` is declared by a new
 * manifest and has no permission column anywhere, exactly as `patients.*` and `workflow.*` do not.
 * The alternative was restructuring the two shipped tables to carry a third module, which would
 * have made a role-model ruling look like a documentation refactor in the diff.
 *
 * The SHAPE of the ruling is visible in the list: three roles get the counter's three, ONE role
 * gets the approval, and nothing else is granted at all. Every partner-facing string is in
 * `NOT_YET_MODELLED` with its reason instead.
 */
const PLAN_09_PAIRS: readonly string[] = [
  "billing_manager/membership.grace_honor.approve",
  "cashier/membership.grace_honor.request",
  "cashier/membership.instrument.read",
  "cashier/membership.instrument.recognise",
  "front_office/membership.grace_honor.request",
  "front_office/membership.instrument.read",
  "front_office/membership.instrument.recognise",
  "front_office_supervisor/membership.grace_honor.request",
  "front_office_supervisor/membership.instrument.read",
  "front_office_supervisor/membership.instrument.recognise",
];

/** The README prose line that authorises the 2026-08-26 Group C grants. Quoted, not paraphrased. */
const GROUP_C_README_PROSE =
  "Owner ruling of 2026-08-26 moves three `auth.*` strings off `admin`, which appear in no table";

/**
 * The three (role, permission) pairs the 2026-08-26 Group C ruling added, which appear in NEITHER
 * README table. The FOURTH set of non-table rows, landed exactly as the three above were.
 *
 * `auth.*` is declared by `authManifest` and has no permission column anywhere — and until this
 * ruling it had no MODEL row anywhere either, because `seed:admin` grants the whole manifest to
 * `admin` and that made every `auth.*` string look "held" to the reachability census while being
 * reachable by exactly one account. Held is not the same as held BY THE RIGHT ROLE, and the census
 * was never designed to notice the difference; this constant is where that difference is written
 * down.
 *
 * THE SHAPE IS THE RULING: two review desks to the Medical Superintendent, one lending mechanism
 * to the Duty Manager, and NOTHING that creates an account or changes what a role means. The
 * fourth Group C candidate, `auth.break_glass.use`, is absent on purpose — `seed-roles.ts` carries
 * the measurement that explains why, and it is a wiring gap rather than a grant gap.
 */
const GROUP_C_PAIRS: readonly string[] = [
  "duty_manager/auth.temp_role.grant",
  "medical_superintendent/auth.break_glass.review",
  "medical_superintendent/auth.elevation.review",
];

/** The README prose line that authorises the 2026-08-26 Group A grants. Quoted, not paraphrased. */
const GROUP_A_README_PROSE =
  "Owner ruling of 2026-08-26 assigns ten pairs that appear in no table above";

/**
 * The ten (role, permission) pairs the 2026-08-26 Group A ruling added. The FIFTH non-table set.
 *
 * These are different in kind from the four sets above, and the difference is the point: every one
 * of these strings was in `NOT_YET_MODELLED` — declared, guarding a LIVE route, and held by nobody,
 * so the route answered 403 to every account on the deployment. Eight entries left that list in the
 * same commit, which is the mechanism its header promises ("the day any of them gains a holder this
 * list shrinks by one, the census fails, and the commit that grants it has to say so").
 *
 * TWO OMISSIONS ARE LOAD-BEARING and both are measurements rather than caution:
 *   - `membership.catalog.manage` guards NO route in the tree, so a holder could reach nothing;
 *   - `patients.merge` stays because `patient_merge` is registered by no seed, so `requestApproval`
 *     throws `unknown_type` and the merge lane is dead at step one for everybody.
 */
const GROUP_A_PAIRS: readonly string[] = [
  "biomedical_engineer/ops.interface.manage",
  "membership_admin/membership.import.run",
  "membership_admin/membership.reconcile.operate",
  "owner/approvals.types.manage",
  "owner/tariff.config.manage",
  "owner/tariff.read",
  "owner/tariff.versions.activate",
  "tariff_editor/tariff.read",
  "tariff_editor/tariff.services.manage",
  "tariff_editor/tariff.versions.draft",
];

/** The README prose line that authorises the merge-lane grants. Quoted, not paraphrased. */
const MERGE_LANE_README_PROSE =
  "Owner ruling of 2026-08-26 opens the patient-merge lane, which had never worked";

/**
 * The six (role, permission) pairs that opened the patient-merge lane. The SIXTH non-table set.
 *
 * It is the smallest of the six and the only one whose blocker was MACHINERY rather than a ruling:
 * `patient_merge` was named by `merge.ts` from Plan 05 and registered by no seed, so every merge
 * request threw `unknown_type` regardless of who held what. `seed:patients` and these grants land
 * together, which is why `patients.merge` left `NOT_YET_MODELLED` in the same commit that made it
 * mean something.
 *
 * `medical_superintendent/patients.read` is here rather than in a Group B commit because an
 * approver who cannot open the two records is not an approver.
 */
const MERGE_LANE_PAIRS: readonly string[] = [
  "medical_superintendent/approvals.requests.decide",
  "medical_superintendent/approvals.requests.read",
  "medical_superintendent/patients.read",
  "mrd_officer/patients.merge",
  "mrd_officer/patients.read",
  "mrd_officer/patients.update",
];

/** The README prose line that authorises the 2026-08-26 Group B grants. Quoted, not paraphrased. */
const GROUP_B_README_PROSE =
  "Owner ruling of 2026-08-26 widens three roles that could not do their own jobs";

/**
 * The six (role, permission) pairs Group B added. The SEVENTH non-table set, and the only one that
 * closed a CLINICAL SAFETY gap rather than an administrative one.
 *
 * `doctor/patients.read` is the row that matters: `opd-consult.tsx` fetches `GET /patients/:id` and
 * `GET /patients/:id/allergies` — both `patients.read` — and the `doctor` role held seven `opd.*`
 * strings and no `patients.*` at all, so a doctor in consultation was refused the allergy register.
 * Measured against production 2026-08-26: all three active doctors, `has patients.read: false`.
 *
 * The shape of owner ruling 7 is where the omission is visible: every role that touches the patient
 * BEFORE the doctor got `patients.read`, and the doctor did not.
 *
 * `owner/patients.read` is NOT here, and the absence is a ruling too — see the README sentence.
 */
const GROUP_B_PAIRS: readonly string[] = [
  "doctor/patients.read",
  "doctor/patients.update",
  "owner/billing.invoice.read",
  "owner/billing.reports.read",
  "owner/billing.session.read",
  "pharmacy/patients.read",
];

/** The README prose line that authorises Plan 16a's DD10 grants. Quoted, not paraphrased. */
const FORMULARY_README_PROSE =
  "the formulary is curated at the pharmacy and read by every prescriber";

/**
 * The four (role, permission) pairs Plan 16a / DD10 added. The EIGHTH non-table set, and the first
 * whose permissions are declared by a module with no README table of its own — `formulary.*` has
 * three strings and two holders, which is a table with more explanation than cells.
 */
const FORMULARY_PAIRS: readonly string[] = [
  "doctor/formulary.read",
  "pharmacy/formulary.manage",
  "pharmacy/formulary.read",
  "pharmacy/formulary.staging.review",
];

/** The README prose line that authorises Plan 13's DD14 grant. Quoted, not paraphrased. */
const RESOURCES_README_PROSE =
  "the registry is read by the role that already reads the room book";

/**
 * The ONE (role, permission) pair Plan 13 / DD14 added. The NINTH non-table set, and the smallest
 * any of them will ever be.
 *
 * `resources.*` has exactly one string and one holder, which is a table with more explanation than
 * cells — the `formulary.*` reasoning one phase later, and the same conclusion. It is a non-table
 * set for the structural reason all nine are: the permission is declared by a manifest that has no
 * column in either README table, and restructuring the two shipped tables to carry a third module
 * would make a role-model ruling look like a documentation refactor in the diff.
 *
 * **NO NEW AUTHORITY IS CREATED BY IT**, and that is what makes it a DD14 decision rather than an
 * owner ruling: `opd_admin` already holds `opd.masters.read` and `opd.masters.manage` over the room
 * book, and after T6 those rooms ARE the registry rows this permission reads.
 */
const RESOURCES_PAIRS: readonly string[] = [
  "opd_admin/resources.read",
];

/** All nine non-table sets. A model row outside this union fails V3's last leg. */
const NON_TABLE_PAIRS: readonly string[] = [
  ...RULING_7_PAIRS, ...WORKFLOW_RULING_PAIRS, ...PLAN_09_PAIRS, ...GROUP_C_PAIRS, ...GROUP_A_PAIRS,
  ...MERGE_LANE_PAIRS, ...GROUP_B_PAIRS, ...FORMULARY_PAIRS, ...RESOURCES_PAIRS,
];

type GrantTable = {
  roles: string[];
  /** permission -> the roles ticked for it */
  cells: Map<string, string[]>;
  /** how many markdown ROWS the table had, before the shorthand cell was expanded */
  rowCount: number;
};

const PERMISSION_RE = /^`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`$/;
const SHORTHAND_RE = /^`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`\s*\/\s*`(\.[a-z][a-z0-9_]*)`$/;
const SEPARATOR_RE = /^\|(?:\s*:?-{2,}:?\s*\|)+$/;

/** `| a | b |` -> `["a", "b"]`. Throws on a line that is not a table row. */
function splitRow(line: string, label: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    throw new Error(`${label}: "${trimmed}" is not a markdown table row — this parser is stale`);
  }
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

/**
 * The permission(s) a first cell names. Expands the `\`a.b.c\` / \`.d\`` shorthand into two
 * permissions and THROWS on anything else — never returns `[]`, which is the shape that would let
 * a row be silently dropped.
 */
function expandPermissionCell(cell: string, label: string): string[] {
  const single = PERMISSION_RE.exec(cell);
  if (single?.[1] !== undefined) return [single[1]];
  const shorthand = SHORTHAND_RE.exec(cell);
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) {
    const full = shorthand[1];
    const base = full.slice(0, full.lastIndexOf("."));
    return [full, `${base}${shorthand[2]}`];
  }
  throw new Error(
    `${label}: permission cell ${JSON.stringify(cell)} is neither a backticked dotted permission ` +
      `nor the \`a.b.c\` / \`.d\` shorthand — this parser is stale, and skipping the row is how a ` +
      `parity test passes vacuously`,
  );
}

/**
 * Every `| Permission | <role> | … |` table in a markdown document. Throws on any shape it does
 * not recognise and on a document that carries none.
 */
function permissionTables(source: string, label: string): GrantTable[] {
  const lines = source.split("\n");
  const tables: GrantTable[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!/^\|\s*Permission\s*\|/.test(line.trim())) continue;
    const header = splitRow(line, label);
    const roleColumns = header.slice(1);
    if (roleColumns.length === 0) {
      throw new Error(`${label}: a Permission table declares no role columns — this parser is stale`);
    }
    const separator = lines[i + 1] ?? "";
    if (!SEPARATOR_RE.test(separator.trim())) {
      throw new Error(
        `${label}: the row after a Permission header is ${JSON.stringify(separator)} rather than a ` +
          `markdown separator — this parser is stale`,
      );
    }
    if (splitRow(separator, label).length !== header.length) {
      throw new Error(`${label}: separator column count disagrees with the header — this parser is stale`);
    }
    const cells = new Map<string, string[]>();
    let rowCount = 0;
    let j = i + 2;
    for (; j < lines.length; j += 1) {
      const row = (lines[j] ?? "").trim();
      if (!row.startsWith("|")) break;
      const columns = splitRow(row, label);
      if (columns.length !== header.length) {
        throw new Error(
          `${label}: row ${JSON.stringify(row)} has ${columns.length} columns against the header's ` +
            `${header.length} — this parser is stale`,
        );
      }
      rowCount += 1;
      const permissions = expandPermissionCell(columns[0] ?? "", label);
      const ticked: string[] = [];
      for (let c = 1; c < columns.length; c += 1) {
        const value = columns[c] ?? "";
        if (value === "") continue;
        if (value !== "✓") {
          throw new Error(
            `${label}: cell ${JSON.stringify(value)} in row ${JSON.stringify(columns[0] ?? "")} is ` +
              `neither a tick nor blank — this parser is stale`,
          );
        }
        const role = roleColumns[c - 1];
        if (role === undefined) throw new Error(`${label}: no role column at index ${c}`);
        ticked.push(role);
      }
      for (const permission of permissions) {
        cells.set(permission, [...(cells.get(permission) ?? []), ...ticked]);
      }
    }
    if (rowCount === 0) {
      throw new Error(`${label}: a Permission table has no rows — this parser is stale`);
    }
    tables.push({ roles: roleColumns, cells, rowCount });
    i = j - 1;
  }
  if (tables.length === 0) {
    throw new Error(`${label}: no \`| Permission | … |\` table found at all — this parser is stale`);
  }
  return tables;
}

/** `role/permission` for every ticked cell of a table, sorted. */
function tablePairs(table: GrantTable): string[] {
  const pairs: string[] = [];
  for (const [permission, roleList] of table.cells) {
    for (const role of roleList) pairs.push(`${role}/${permission}`);
  }
  return pairs.sort();
}

/** `role/permission` for every grant in the seed's model, sorted. */
function modelPairs(): string[] {
  return ROLE_MODEL.flatMap((r) => r.permissions.map((p) => `${r.roleKey}/${p}`)).sort();
}

function installedRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const manifest of ALL_MANIFESTS) registry.install(manifest);
  return registry;
}

const readme = readFileSync(README, "utf8");
const tables = permissionTables(readme, "README.md");
const opdTable = tables.find((t) => t.roles[0] === "front_office");
const billingTable = tables.find((t) => t.roles[0] === "cashier");
/**
 * PLAN 14 T2 / DD11 — THE THIRD TABLE, and the first new one since Plan 11d wrote this parser.
 *
 * `formulary.*` (three strings, two holders) and `resources.*` (one string, one holder) both
 * declined a table and became NON-TABLE PAIRS instead, each with a quoted README prose line — the
 * reasoning being that a table with more explanation than cells is worse than a sentence. Materials
 * is the other side of that line: **eleven strings across three roles is twenty ticks**, and the
 * SHAPE of the grants is the decision (who may sign a QC verdict, who may not register a vendor).
 * A grid shows that at a glance and a paragraph does not, which is why DD11 rules the table IN and
 * why `NON_TABLE_PAIRS` does not grow by twenty.
 */
const materialsTable = tables.find((t) => t.roles[0] === "materials_head");
if (opdTable === undefined || billingTable === undefined || materialsTable === undefined) {
  throw new Error(
    "README.md: could not identify all three permission tables by their first role column " +
      `(found: ${tables.map((t) => t.roles.join("+")).join(" | ")}) — this parser is stale`,
  );
}

describe("seed:roles — the census pins, stated before anything is compared (§2.49)", () => {
  it("ALL_MANIFESTS declares eighty-nine permissions, by module", () => {
    const byKey = new Map(ALL_MANIFESTS.map((m) => [m.key, m.permissions.length]));
    expect(Object.fromEntries(byKey)).toEqual({
      auth: 7, // 11e's six + `auth.elevation.review` (the elevation-review queue)
      workflow: 8,
      approvals: 4,
      patients: 5,
      tariff: 5,
      opd: 14,
      billing: 14,
      alerts: 0,
      ops: 3,
      // PLAN 09 T1. BOTH modules declare their whole phase's permissions HERE, ahead of the routes
      // that guard on them, because `seed-roles.ts` and this file are named in T1's Files list and
      // in no later task's (§6.0 S9): a permission declared by T5 would fail this build for a task
      // that is not allowed to fix it.
      membership: 7,
      partners: 7,
      // PLAN 16a T2 / DD10. Declared here ahead of the routes that guard on them, for exactly the
      // reason the paragraph above gives: `seed-roles.ts` and this file are named in T2's Files
      // list and in no later task's, so a string first declared by T7 or T8 would fail this build
      // for a task that is not allowed to fix it.
      formulary: 3,
      // PLAN 13 T2 / DD14. ONE string, and the only one this phase can declare: `resources.read`
      // guards T5's three read routes. There is deliberately no `resources.manage` — registry
      // master writes keep going through OPD's `opd.masters.manage` routes, which delegate into the
      // registry from T6 (DD9), and a `manage` string declared here would be a permission held by
      // somebody and reaching nothing.
      resources: 1,
      // PLAN 14 T2 / DD11. ELEVEN strings, all declared here ahead of the routes that guard on
      // them, for the reason the `membership`/`partners` paragraph above gives: `seed-roles.ts`,
      // this file and `README.md` are named in T2's Files list and in NO later task's, so a string
      // first declared by T6 or T8 would fail this build for a task that is not allowed to fix it.
      //
      // The split across the eleven is the phase's one RBAC decision (DD11): `materials_head` holds
      // all of them, `storekeeper` holds six, and `pharmacy` gains the three that make a QC verdict
      // informed. `grn.capture` and `grn.qc` are DELIBERATELY two strings for what is one desk
      // today — DD8's two-stage gate — so that the day a PO-approver/receiver SoD pair is ruled
      // (14b, and O1), it is a `sod_pairs` row rather than a refactor.
      materials: 11,
    });
    expect(installedRegistry().allPermissions()).toHaveLength(89);
  });

  it("the role model is eighteen roles, one hundred and twenty-one grants, sixty-nine distinct permissions", () => {
    expect(ROLE_MODEL.map((r) => r.roleKey)).toEqual([
      "front_office",
      "front_office_supervisor",
      "vitals_desk",
      "doctor",
      "opd_admin",
      "display",
      "pharmacy",
      "cashier",
      "billing_manager",
      // The two governance roles, added by the 2026-08-23 workflow ruling.
      "owner",
      "medical_superintendent",
      // Group C, 2026-08-26: `duty_manager` had existed since `seed:ops` with three `ops.*` and no
      // model row at all. It joins for ONE string — the temp-role mechanism built for the night
      // shift — and that row was unsafe to write before the elevation ceiling landed.
      "duty_manager",
      // Group A, 2026-08-26: three roles for permissions that previously had NO holder, so their
      // live routes answered 403 to every account on the deployment.
      "tariff_editor",
      "membership_admin",
      // The merge lane, 2026-08-26: blocked on machinery rather than on a ruling until
      // `seed:patients` registered `patient_merge`.
      "mrd_officer",
      "biomedical_engineer",
      // PLAN 14 / DD11, 2026-08-27 — the two stores roles, APPENDED so the sixteen above keep the
      // order they were added in. Both are created with grants and no holders, the `pharmacy`
      // precedent: production held 33 users and no storekeeper at kickoff.
      "materials_head",
      "storekeeper",
    ]);
    expect(Object.fromEntries(ROLE_MODEL.map((r) => [r.roleKey, r.permissions.length]))).toEqual({
      // Plan 09 / DD18 moved four of these: +3 each to the two desk roles and the cashier (read,
      // recognise, request), +1 to billing_manager (approve). No other role gained anything, and
      // `vitals_desk` deliberately gained nothing — vitals are recorded against a patient who is
      // already at the counter, and recognition happens where the invoice is.
      front_office: 12,
      front_office_supervisor: 13,
      vitals_desk: 5,
      // Group B, 2026-08-26: +2, the patient record and the allergy register.
      // Plan 16a / DD10: +1, the formulary read the consult autocomplete needs.
      doctor: 10,
      // Plan 13 / DD14: +1, the registry read — the same room book this role already administers,
      // now behind a kernel permission. No new authority (see RESOURCES_PAIRS).
      opd_admin: 7,
      display: 1,
      // Group B, 2026-08-26: +1, the allergy register at the dispensing counter.
      // Plan 16a / DD10: +3, the whole formulary — read, manage, and staging review. The module is
      // curated at the pharmacy and nowhere else.
      // PLAN 14 / DD11: +3, the materials READ halves and the drug QC verdict. The pharmacist is
      // the QC signatory for drugs (doc 09 §7), and an item is the shelf side of a medicine this
      // same role already curates — a curator who cannot see that `Crocin 500mg tablet` is stocked
      // as `CROC500` in three stores is curating half a fact.
      pharmacy: 8,
      cashier: 11,
      billing_manager: 10,
      // Group A, 2026-08-26: +4 — tariff.read, the activator key, tariff config, and approval-type
      // governance. `owner` is now the activator for BOTH ceremonies, workflow and price list.
      // Group B then added +3: the invoice, the daybook and the cashier sessions. NOT patients.read.
      owner: 10,
      // Group C, 2026-08-26: +2, the break-glass and elevation review desks. The merge lane then
      // added +3 — the approvals pair it is the approverRole for, and the records it decides about.
      medical_superintendent: 7,
      duty_manager: 1,
      tariff_editor: 3,
      membership_admin: 2,
      mrd_officer: 3,
      biomedical_engineer: 1,
      // PLAN 14 T2 / DD11 — the two stores roles. `pharmacy` moved 5 → 8 in the same commit (the
      // three read/QC strings), which is why the grant total moves by twenty and not by seventeen.
      materials_head: 11,
      storekeeper: 6,
    });
    expect(modelPairs()).toHaveLength(121);
    expect(modelPermissions()).toHaveLength(69);
    // No role lists the same permission twice — a duplicate would inflate the counts above
    // without changing a single row of `role_permissions`.
    for (const role of ROLE_MODEL) {
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });

  it("the reachability census closes: 89 declared = 75 held + 14 not yet modelled", () => {
    expect(installedRegistry().allPermissions()).toHaveLength(89);
    // 42 + 13 until the 2026-08-23 ruling moved the four `workflow.definitions.*` strings across;
    // 46 + 13 until Plan 09 declared fourteen and DD18 granted four of them.
    // 50 until `auth.elevation.review` was declared; it is held from the first deploy because
    // `seed:admin` grants every `authManifest` string to `admin` (GRANTED_BY_OTHER_SEEDS), so it
    // never passes through NOT_YET_MODELLED.
    // 51 + 23 until Group A (2026-08-26) granted eight strings that had guarded live routes with
    // no holder at all; they moved from one side of this sum to the other, which is exactly what
    // NOT_YET_MODELLED's header promises happens the day a gap is closed.
    // 60 + 14 until Plan 16a declared three `formulary.*` strings and DD10 granted ALL THREE —
    // the first phase in a while whose new permissions pass NOT_YET_MODELLED by entirely, because
    // the role that holds them (`pharmacy`) already existed and the spec already said who curates.
    // 63 + 14 until Plan 13 declared ONE `resources.*` string and DD14 granted it in the same
    // commit — so, like the formulary before it, it passes NOT_YET_MODELLED by entirely. The list
    // of fourteen is UNCHANGED by this phase, which is the number worth reading here: a phase that
    // declares a permission and cannot grant it in the same task is a phase that has to add a row
    // to that list with a reason, and this one did not have to.
    // PLAN 14 T2 — 78 → 89 declared and 64 → 75 held, and **NOT_YET_MODELLED IS UNCHANGED AT
    // FOURTEEN**, which is the number worth reading here. All eleven new strings are granted in the
    // same commit that declares them, so this phase adds nothing to the list of permissions held by
    // nobody — the property the paragraph above says a phase "has to add a row with a reason" for.
    expect(heldPermissions()).toHaveLength(75);
    expect(NOT_YET_MODELLED).toHaveLength(14);
    expect(heldPermissions().length + NOT_YET_MODELLED.length).toBe(89);
  });

  it("the README carries exactly three permission tables, of the measured shapes", () => {
    // THREE since Plan 14 T2 / DD11 — see the `materialsTable` docstring above for why materials
    // takes a table where `formulary` and `resources` took non-table pairs.
    expect(tables).toHaveLength(3);
    expect(opdTable.roles).toEqual([
      "front_office",
      "front_office_supervisor",
      "vitals_desk",
      "doctor",
      "opd_admin",
      "display",
      "pharmacy",
    ]);
    expect(opdTable.rowCount).toBe(14);
    expect(opdTable.cells.size).toBe(14);
    expect(tablePairs(opdTable)).toHaveLength(29);

    expect(billingTable.roles).toEqual(["cashier", "billing_manager"]);
    // FIFTEEN rows yielding SIXTEEN permissions is the proof that the `/ .decide` shorthand was
    // EXPANDED rather than skipped. A parser that dropped it would report 15 and 15.
    expect(billingTable.rowCount).toBe(15);
    expect(billingTable.cells.size).toBe(16);
    expect(billingTable.cells.get("approvals.requests.read")).toEqual(["billing_manager"]);
    expect(billingTable.cells.get("approvals.requests.decide")).toEqual(["billing_manager"]);
    expect(tablePairs(billingTable)).toHaveLength(17);

    // PLAN 14 T2 / DD11 — the third table. ELEVEN rows, eleven permissions (no shorthand cell) and
    // TWENTY ticks: 11 for `materials_head`, 6 for `storekeeper`, 3 for `pharmacy`. The three
    // counts are pinned separately from the total because the total alone would survive a diff that
    // moved a tick from one role to another — and "who may sign the QC verdict" is exactly the cell
    // a well-meaning edit would move.
    expect(materialsTable.roles).toEqual(["materials_head", "storekeeper", "pharmacy"]);
    expect(materialsTable.rowCount).toBe(11);
    expect(materialsTable.cells.size).toBe(11);
    expect(tablePairs(materialsTable)).toHaveLength(20);
    expect(tablePairs(materialsTable).filter((p) => p.startsWith("materials_head/"))).toHaveLength(11);
    expect(tablePairs(materialsTable).filter((p) => p.startsWith("storekeeper/"))).toHaveLength(6);
    expect(tablePairs(materialsTable).filter((p) => p.startsWith("pharmacy/"))).toHaveLength(3);
    // DD8's two-stage gate, as two cells: the storekeeper captures and does NOT sign the verdict.
    expect(materialsTable.cells.get("materials.grn.capture")).toEqual(["materials_head", "storekeeper"]);
    expect(materialsTable.cells.get("materials.grn.qc")).toEqual(["materials_head", "pharmacy"]);
    // The narrowest grant in the module: one action stops every location's stock of a batch.
    expect(materialsTable.cells.get("materials.recall.manage")).toEqual(["materials_head"]);
  });

  it("both README parsers THROW on a shape they do not recognise, never return []", () => {
    expect(() => permissionTables("no table here at all\n", "synthetic")).toThrow(/no .* table found/);
    expect(() =>
      permissionTables("| Permission | cashier |\n| `billing.invoice.issue` | ✓ |\n", "synthetic"),
    ).toThrow(/rather than a markdown separator/);
    expect(() =>
      permissionTables("| Permission | cashier |\n|---|---|\n| `billing.invoice.issue` | yes |\n", "synthetic"),
    ).toThrow(/neither a tick nor blank/);
    expect(() =>
      permissionTables("| Permission | cashier |\n|---|---|\n| billing.invoice.issue | ✓ |\n", "synthetic"),
    ).toThrow(/neither a backticked dotted permission/);
    expect(() =>
      permissionTables("| Permission | cashier |\n|---|---|\n| `billing.invoice.issue` | ✓ | x |\n", "synthetic"),
    ).toThrow(/columns against the header's/);
    // And the shorthand really does expand, rather than the real table merely happening to parse.
    const expanded = permissionTables(
      "| Permission | billing_manager |\n|---|---|\n| `approvals.requests.read` / `.decide` | ✓ |\n",
      "synthetic",
    );
    expect([...(expanded[0]?.cells.keys() ?? [])]).toEqual([
      "approvals.requests.read",
      "approvals.requests.decide",
    ]);
  });

  it("every model role resolves to a title, from OPD_ROLE_KEYS or from LOCAL_ROLE_TITLES", () => {
    const opdKeys = OPD_ROLE_KEYS.map((r) => r.key);
    const modelKeys = ROLE_MODEL.map((r) => r.roleKey);
    // The two sources are NOT nested sets, and this pins the measured difference in both
    // directions: six model roles come from the constant, three are declared locally, and four
    // constant entries are role keys with no permission column anywhere.
    expect(modelKeys.filter((k) => opdKeys.includes(k))).toEqual([
      "front_office",
      "front_office_supervisor",
      "vitals_desk",
      "doctor",
      "opd_admin",
      "display",
      // `OPD_ROLE_KEYS` declared these two all along — the `opd_visit` Class A policy names them.
      // Before the 2026-08-23 ruling they were the third and fourth entries of the list below:
      // role keys with a title and no permission column anywhere.
      "owner",
      "medical_superintendent",
      // Group C, 2026-08-26. `OPD_ROLE_KEYS` had declared it all along; it simply held no model row.
      "duty_manager",
    ]);
    // Group A's three are declared locally: none of them is an OPD station.
    // PLAN 14 / DD11 appends two: neither `materials_head` nor `storekeeper` is an OPD station, so
    // neither belongs in `OPD_ROLE_KEYS` — a store is not a consulting room.
    expect(modelKeys.filter((k) => !opdKeys.includes(k))).toEqual([
      "pharmacy", "cashier", "billing_manager", "tariff_editor", "membership_admin", "mrd_officer",
      "biomedical_engineer", "materials_head", "storekeeper",
    ]);
    // `nurse` is now the ONLY constant entry with no permission column anywhere — `duty_manager`
    // left this list on 2026-08-26 when Group C gave it one.
    expect(opdKeys.filter((k) => !modelKeys.includes(k))).toEqual(["nurse"]);
    // The UNION covers the model exactly, and neither source shadows the other.
    expect(Object.keys(LOCAL_ROLE_TITLES).sort()).toEqual([
      "billing_manager", "biomedical_engineer", "cashier", "materials_head", "membership_admin",
      "mrd_officer", "pharmacy", "storekeeper", "tariff_editor",
    ]);
    expect(Object.keys(LOCAL_ROLE_TITLES).filter((k) => opdKeys.includes(k))).toEqual([]);
    for (const key of modelKeys) expect(roleTitle(key).length).toBeGreaterThan(0);
    expect(() => roleTitle("no_such_role")).toThrow(/resolves to no title/);
  });
});

describe("seed:roles — the reachability invariant (V1, V2)", () => {
  it("V1: every granted string is DECLARED by an installed manifest", () => {
    const declared = new Set(installedRegistry().allPermissions());
    const undeclared: string[] = [];
    for (const role of ROLE_MODEL) {
      for (const permission of role.permissions) {
        if (!declared.has(permission)) undeclared.push(`${role.roleKey}/${permission}`);
      }
    }
    for (const grant of GRANTED_BY_OTHER_SEEDS) {
      for (const permission of grant.permissions) {
        if (!declared.has(permission)) undeclared.push(`${grant.roleKey}/${permission}`);
      }
    }
    // A string no manifest declares is a permission `grantPermissionToRole` refuses outright and
    // therefore a grant that can never exist — a typo the seed would only find at run time, on a
    // live box, halfway through.
    expect(undeclared.sort()).toEqual([]);
  });

  it("V2: every declared permission is held by a role, or named as not yet modelled", () => {
    const declared = installedRegistry().allPermissions();
    const held = new Set(heldPermissions());
    const notYetModelled = new Set(NOT_YET_MODELLED.map((n) => n.permission));
    const orphans = declared.filter((p) => !held.has(p) && !notYetModelled.has(p)).sort();
    // The invariant. It fails the build the day a module adds a permission and forgets the role
    // model, which is the failure mode that produced MAJOR 4 twice.
    expect(orphans).toEqual([]);
  });

  it("V2: the not-yet-modelled list is disjoint from the grants, and every entry carries its reason", () => {
    const held = new Set(heldPermissions());
    const declared = new Set(installedRegistry().allPermissions());
    // A permission may not be both granted and recorded as unmodelled: that list is where a gap
    // is written down, never where an orphan is hidden.
    expect(NOT_YET_MODELLED.map((n) => n.permission).filter((p) => held.has(p))).toEqual([]);
    expect(NOT_YET_MODELLED.map((n) => n.permission).filter((p) => !declared.has(p))).toEqual([]);
    expect(new Set(NOT_YET_MODELLED.map((n) => n.permission)).size).toBe(NOT_YET_MODELLED.length);
    // The REASONS are asserted present, not merely the names. A list of bare strings is an
    // exceptions list wearing a different label, and "unreachable on purpose" is a different
    // claim from "no owner ruling exists yet".
    for (const entry of NOT_YET_MODELLED) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
    expect(NOT_YET_MODELLED.map((n) => n.permission).sort()).toEqual([
      "approvals.requests.create",
      // `approvals.types.manage` LEFT on 2026-08-26 (Group A → `owner`), and the five `tariff.*`
      // strings left with it. That is eight departures in one commit; the census above is what
      // proves they went somewhere rather than merely stopping being counted.
      //
      // Of Plan 09 / DD18's ten, only `membership.catalog.manage` remains — and its reason CHANGED
      // rather than persisted: it is now "guards no route in the tree", a measurement, where its
      // two siblings left because they guard live routes and gained `membership_admin`. The seven
      // `partners.*` still guard lanes that ship structurally OFF pending the owner's O-8 ruling.
      "membership.catalog.manage",
      "partners.agreement.manage",
      "partners.attribution.issue",
      "partners.counterparty.manage",
      "partners.ledger.read",
      "partners.pnl.read",
      "partners.receivable.operate",
      "partners.statement.import",
      "patients.confidential.read",
      // `patients.merge` LEFT on 2026-08-26 — not because a ruling arrived (it had one) but
      // because `seed:patients` finally registered `patient_merge`, so the grant means something.
      // The four `workflow.definitions.*` strings left this list on 2026-08-23 — see
      // WORKFLOW_RULING_PAIRS. The four instance strings below stay, and their reason is now
      // "no live path traverses that controller" rather than "no ruling exists yet".
      "workflow.instances.read",
      "workflow.instances.remediate",
      "workflow.instances.start",
      "workflow.instances.transition",
    ]);
  });
});

describe("seed:roles — README parity, cell for cell (V3)", () => {
  it("V3: the three tables and the model agree over the table-derived subset, both directions", () => {
    const fromReadme = [
      ...tablePairs(opdTable), ...tablePairs(billingTable), ...tablePairs(materialsTable),
    ].sort();
    const fromModel = modelPairs().filter((pair) => !NON_TABLE_PAIRS.includes(pair));
    // 46 until Plan 14 T2 added the twenty ticks of the materials table.
    expect(fromReadme).toHaveLength(66);
    // Direction 1: nothing the README ticks is missing from the model.
    expect(fromReadme.filter((p) => !fromModel.includes(p))).toEqual([]);
    // Direction 2: nothing the model grants from a table is missing from that table.
    expect(fromModel.filter((p) => !fromReadme.includes(p))).toEqual([]);
    expect(fromModel).toEqual(fromReadme);
  });

  it("V3: the three rulings' twenty-five pairs are exactly the model's non-table rows, with all three README prose lines quoted", () => {
    const fromReadme = new Set([
      ...tablePairs(opdTable), ...tablePairs(billingTable), ...tablePairs(materialsTable),
    ]);
    const nonTable = modelPairs().filter((pair) => !fromReadme.has(pair));
    // This is the leg that stops the subset scoping above becoming a hole: a model row that is
    // neither table-derived nor one of the three rulings' twenty-five pairs fails HERE.
    expect(nonTable).toEqual([...NON_TABLE_PAIRS].sort());
    // STILL 55 after Plan 14, and that is the assertion rather than an oversight: materials' twenty
    // grants are TABLE-derived (DD11 ruled the third table in), so a phase that added eleven
    // permissions and two roles added NOTHING to this list. A materials pair appearing here would
    // mean the README table and the model had drifted.
    expect(NON_TABLE_PAIRS).toHaveLength(55);
    expect(nonTable.filter((p) => p.includes("/materials."))).toEqual([]);
    // Plan 13 / DD14's own source sentence, held to exactly the standard of the eight below.
    expect(readme).toContain(RESOURCES_README_PROSE);
    // Plan 16a / DD10's own source sentence, held to exactly the standard of the seven below.
    expect(readme).toContain(FORMULARY_README_PROSE);
    // Group B's own source sentence, held to the same standard as the six below.
    expect(readme).toContain(GROUP_B_README_PROSE);
    // The merge lane's own source sentence, held to the same standard as the five below.
    expect(readme).toContain(MERGE_LANE_README_PROSE);
    // The Group A ruling's own source sentence, held to the same standard as the four below.
    expect(readme).toContain(GROUP_A_README_PROSE);
    // The Group C ruling's own source sentence, held to the same standard as the three below.
    expect(readme).toContain(GROUP_C_README_PROSE);
    // The workflow ruling's own source sentence, held to the same standard as ruling 7's below.
    expect(readme).toContain(WORKFLOW_RULING_README_PROSE);
    // The reason those eight exist, located in the shipped README rather than paraphrased. The
    // ruling transcribes a stated intent; if the sentence goes, the transcription is unsourced.
    expect(readme).toContain(RULING_7_README_PROSE);
    // PLAN 09 / DD18, held to exactly the same standard as the two above: the grants are
    // authorised by a sentence in the shipped README, quoted here rather than paraphrased.
    expect(readme).toContain(PLAN_09_README_PROSE);
    // `vitals_desk` deliberately does NOT get `patients.register`: registration is the desk's
    // work and vitals record against a patient who already exists.
    expect(nonTable).not.toContain("vitals_desk/patients.register");
    // …and it does NOT get the membership three either, for the mirror-image reason: recognition
    // happens where the invoice is issued. DD18 mints as little authority as it can, and this is
    // the assertion that says so rather than leaving it to the reader to notice an absence.
    expect(nonTable.filter((p) => p.startsWith("vitals_desk/"))).toEqual([
      "vitals_desk/patients.read",
      "vitals_desk/patients.update",
    ]);
    // The ONE role that may approve a grace-honor is the one that approves every other billing
    // exception, and no role that can REQUEST one can also approve it.
    expect(nonTable.filter((p) => p.endsWith("/membership.grace_honor.approve"))).toEqual([
      "billing_manager/membership.grace_honor.approve",
    ]);
    expect(nonTable).not.toContain("billing_manager/membership.grace_honor.request");
  });
});

describe("seed:roles — executed against a database (V5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll(db);
  });
  afterAll(async () => {
    await teardown();
  });

  it("V5: is idempotent — the second run creates nothing, grants nothing, and still reports the census", async () => {
    const first = await seedRoles(db);
    expect(first.roles.map((r) => r.created)).toEqual(Array(18).fill(true));
    // The last two are the governance roles the 2026-08-23 ruling added: `owner` 3, `medical_
    // superintendent` 2. `opd_admin` went 4 -> 6 with the two definition-drafting strings. Plan
    // 09 / DD18 then moved four: front_office 9 -> 12, its supervisor 10 -> 13, cashier 8 -> 11,
    // billing_manager 9 -> 10.
    // Group C then moved two more: `medical_superintendent` 2 -> 4 (the two review desks) and a
    // new twelfth entry, `duty_manager`, holding exactly one.
    // Plan 16a / DD10 moved two: `doctor` 9 -> 10 (formulary.read) and `pharmacy` 2 -> 5 (the whole
    // formulary — the module is curated at the dispensing counter and nowhere else).
    // Plan 13 / DD14 moved ONE: `opd_admin` 6 -> 7 (resources.read). It is the fifth entry, and it
    // is the only number in this array a registry phase can move — the registry declares one
    // permission and grants it to the one role that already administers the same rooms.
    // PLAN 14 T2 — eighteen entries now. `pharmacy` (position 7) moved 5 → 8 and the two stores
    // roles append 11 and 6; the array is `ROLE_MODEL` order, so a role inserted rather than
    // appended would fail here rather than silently shifting the comparison.
    expect(first.roles.map((r) => r.granted.length)).toEqual([12, 13, 5, 10, 7, 1, 8, 11, 10, 10, 7, 1, 3, 2, 3, 1, 11, 6]);
    expect(first.roles.every((r) => r.already.length === 0)).toBe(true);
    expect(first.declared).toBe(89);
    // MEASURED from role_permissions, not derived from the model. On this database only seed:roles
    // has run, so what is held is exactly what the model granted — 57, not the 63 the model CLAIMS
    // once seed:admin and seed:ops have also run. That SEVEN-permission gap IS MAJOR 1 (it was ten
    // until Group C moved three `auth.*` strings into the model), and before the 2026-08-23 fix
    // this line read the model's claim against a database holding the grants.
    expect(first.held).toBe(69);
    expect(first.held).toBe(modelPermissions().length);
    expect(heldPermissions()).toHaveLength(75);
    expect(first.notYetModelled).toBe(14);
    expect(first.expectedElsewhereAbsent).toBe(6);
    // And the census RECONCILES against the catalog, which is the property that makes it evidence:
    // 69 held + 14 unmodelled + 6 expected-elsewhere = 89 declared (Plan 14 T2 moved the first
    // and the last by eleven and zero). Plan 13 moved the first and the
    // last of those three by one each and left the middle two alone, which is what a phase whose
    // one new permission is granted in the same commit looks like from here.
    expect(first.held + first.notYetModelled + first.expectedElsewhereAbsent).toBe(first.declared);

    // `createRole` is a BARE INSERT and is not idempotent; the guard around it is what makes this
    // run exit rather than die on a duplicate key.
    const second = await seedRoles(db);
    expect(second.roles.map((r) => r.created)).toEqual(Array(18).fill(false));
    expect(second.roles.every((r) => r.granted.length === 0)).toBe(true);
    expect(second.roles.map((r) => r.already.length)).toEqual([12, 13, 5, 10, 7, 1, 8, 11, 10, 10, 7, 1, 3, 2, 3, 1, 11, 6]);

    // And the database holds the model exactly once.
    const written = await db
      .select({ roleKey: rolePermissions.roleKey, permission: rolePermissions.permission })
      .from(rolePermissions);
    expect(written.map((r) => `${r.roleKey}/${r.permission}`).sort()).toEqual(modelPairs());
  });

  it("MAJOR 1: the census is READ BACK OUT OF THE DATABASE, so granting a permission moves it", async () => {
    const first = await seedRoles(db);

    // The model CLAIMS seven permissions it does not itself grant — FOUR of seed:admin's seven
    // `auth.*` and seed:ops's three `ops.*`. It was ten until Group C (2026-08-26) put
    // `auth.break_glass.review`, `auth.elevation.review` and `auth.temp_role.grant` into the model
    // itself; the four that remain are the account-and-authority strings no model role may hold,
    // plus `auth.break_glass.use`, which is ungranted for a WIRING reason `seed-roles.ts` states.
    // Neither script has run here, so none of the seven is held.
    const claimedElsewhere = heldPermissions().filter((p) => !modelPermissions().includes(p));
    expect(claimedElsewhere).toHaveLength(6);
    const measured = await heldInDatabase(db);
    expect(claimedElsewhere.filter((p) => measured.includes(p))).toEqual([]);
    expect(first.expectedElsewhereAbsent).toBe(6);

    // NOT READY, and the problem NAMES THE REPAIR rather than merely counting.
    //
    // PLAN 11e CLOSE (M4) — THIS ASSERTION MOVED, AND WHY IT HAD TO. It used to pin the substring
    // "RETURNS EARLY", because the guidance told the operator that re-running `seed:admin` could
    // NOT help. 11e T5 deleted that early return and made re-running it the repair, so the old
    // wording became emitted text steering a person away from the fix — caught by the phase's
    // independent reviewer. What is pinned now is the same property one layer up: the message must
    // name the script AND tell the operator what to do about it, because a census that reports a
    // gap without naming its repair is the defect this whole check exists to close.
    expect(first.ready).toBe(false);
    const problem = first.problems.find((t) => t.includes("EXPECTS another seed"));
    expect(problem).toBeDefined();
    expect(problem).toContain("seed:admin");
    expect(problem).toContain("RE-RUNNING seed:admin IS the repair");
    // …and it must NOT resurrect the claim T5 falsified.
    expect(problem).not.toContain("RETURNS EARLY");
    for (const permission of claimedElsewhere) expect(problem).toContain(permission);

    // NOW GRANT ONE OF THEM, the way the missing seed would have. Nothing about the constants at
    // the top of seed-roles.ts changes — only the database does.
    const registry = new ModuleRegistry();
    for (const manifest of ALL_MANIFESTS) registry.install(manifest);
    const [moved] = claimedElsewhere;
    // `admin` is seed:admin's role and does not exist here — creating it is exactly what the
    // missing seed would have done before granting.
    await createRole(db, "admin", "Administrator");
    await grantPermissionToRole(db, registry, "admin", moved!);

    const second = await seedRoles(db);
    // The census MOVED. Under the old model-derived computation both runs returned 46 and this
    // assertion could not have distinguished them — which is precisely why the defect survived.
    expect(second.held).toBe(first.held + 1);
    expect(second.expectedElsewhereAbsent).toBe(5);
    expect(await heldInDatabase(db)).toContain(moved);
    expect(second.held + second.notYetModelled + second.expectedElsewhereAbsent).toBe(second.declared);
  });

  it("reports zero holders per role, because seed:roles mints authority and assigns nobody", async () => {
    const report = await seedRoles(db);
    expect(report.roles.every((r) => r.holders === 0)).toBe(true);
    // A role with no holder is REPORTED rather than silently absent — grants without holders are
    // still 403 for every user on the deployment, and the verdict line has to say so.
    expect(report.ready).toBe(false);
    expect(report.problems.join(" ")).toContain("NO USER HOLDS ANY OF THE 18 ROLES");
  });

  /**
   * PLAN 11f T2 / D2 — THE CENSUS SEES THE TAKEOVER RULE'S MITIGATION UNMET.
   *
   * ROUTINE tier: tests required, mutants NOT required and fail-first NOT owed. The count is
   * `fullAdministrators`' — the takeover rule's own helper — and these legs assert the two
   * transitions an operator lives through: nobody, then the bootstrap admin alone, then two.
   */
  it("11f D2 — the census names the full-administrator shortfall and goes quiet at two", async () => {
    const registry = new ModuleRegistry();
    for (const manifest of ALL_MANIFESTS) registry.install(manifest);

    const none = await seedRoles(db);
    expect(none.fullAdministrators).toEqual([]);
    expect(none.warnings.join(" ")).toContain("0 user(s) hold the FULL auth.* set");
    expect(none.warnings.join(" ")).toContain("takeover rule");
    expect(formatReport(none).join("\n")).toContain("full administrators");
    // IT IS A WARNING AND NOT A PROBLEM (reviewer M1). The shortfall must never reach `problems`,
    // because `problems` feeds `ready` and `ready` feeds the exit code — and D2 marked CODE
    // ENFORCEMENT of the two-admin rule dead. The warning still prints, as loudly.
    expect(none.problems.join(" ")).not.toContain("auth.* set");
    expect(formatReport(none).join("\n")).toContain("ACT ON THIS");

    // One — the bootstrap state, and the state production is in. Named, so the operator knows
    // WHICH account has no repair.
    await createRole(db, "full_admin", "Full administrator");
    for (const permission of authManifest.permissions) {
      await grantPermissionToRole(db, registry, "full_admin", permission);
    }
    const { id: firstId } = await createUser(db, {
      username: "admin", fullName: "The Administrator", password: "bootstrap-secret",
    });
    await assignRole(db, { userId: firstId, roleKey: "full_admin", scopeType: "hospital" });

    const one = await seedRoles(db);
    expect(one.fullAdministrators).toEqual(["admin"]);
    expect(one.warnings.join(" ")).toContain("1 user(s) hold the FULL auth.* set at hospital scope: admin");

    // Two — runbook O1 performed. The line goes quiet, which is what "the detector goes quiet"
    // means and is the half that stops this row passing by warning about everything.
    const { id: secondId } = await createUser(db, {
      username: "second_admin", fullName: "The Second", password: "bootstrap-secret",
    });
    await assignRole(db, { userId: secondId, roleKey: "full_admin", scopeType: "hospital" });

    const two = await seedRoles(db);
    expect(two.fullAdministrators).toEqual(["admin", "second_admin"]);
    expect(two.warnings).toEqual([]);
    expect(formatReport(two).join("\n")).toContain("full administrators (whole auth.* set, hospital scope, active): 2");
    expect(formatReport(two).join("\n")).not.toContain("ACT ON THIS");
  });

  it("11f M1 — the two-admin shortfall never moves the READY verdict, at one admin or none", async () => {
    // The property the reviewer's M1 is about, asserted directly rather than inferred from where
    // the string lands: `seed:roles` exits on `ready`, and a deployment with one administrator is
    // a state D2 calls expected. Whatever `ready` is, it must be the SAME with and without the
    // shortfall — so it is compared against a verdict computed from `problems` alone.
    const none = await seedRoles(db);
    expect(none.warnings).toHaveLength(1);
    expect(none.ready).toBe(none.problems.length === 0);

    const registry = new ModuleRegistry();
    for (const manifest of ALL_MANIFESTS) registry.install(manifest);
    await createRole(db, "full_admin", "Full administrator");
    for (const permission of authManifest.permissions) {
      await grantPermissionToRole(db, registry, "full_admin", permission);
    }
    const { id } = await createUser(db, { username: "admin", fullName: "A", password: "bootstrap-secret" });
    await assignRole(db, { userId: id, roleKey: "full_admin", scopeType: "hospital" });

    const one = await seedRoles(db);
    expect(one.warnings).toHaveLength(1);
    expect(one.ready).toBe(one.problems.length === 0);
  });
});
