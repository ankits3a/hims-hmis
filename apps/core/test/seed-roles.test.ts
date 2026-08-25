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

/** All three non-table sets. A model row outside this union fails V3's last leg. */
const NON_TABLE_PAIRS: readonly string[] = [...RULING_7_PAIRS, ...WORKFLOW_RULING_PAIRS, ...PLAN_09_PAIRS];

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
if (opdTable === undefined || billingTable === undefined) {
  throw new Error(
    "README.md: could not identify both permission tables by their first role column " +
      `(found: ${tables.map((t) => t.roles.join("+")).join(" | ")}) — this parser is stale`,
  );
}

describe("seed:roles — the census pins, stated before anything is compared (§2.49)", () => {
  it("ALL_MANIFESTS declares seventy-three permissions, by module", () => {
    const byKey = new Map(ALL_MANIFESTS.map((m) => [m.key, m.permissions.length]));
    expect(Object.fromEntries(byKey)).toEqual({
      auth: 6,
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
    });
    expect(installedRegistry().allPermissions()).toHaveLength(73);
  });

  it("the role model is eleven roles, seventy-one grants, forty-one distinct permissions", () => {
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
    ]);
    expect(Object.fromEntries(ROLE_MODEL.map((r) => [r.roleKey, r.permissions.length]))).toEqual({
      // Plan 09 / DD18 moved four of these: +3 each to the two desk roles and the cashier (read,
      // recognise, request), +1 to billing_manager (approve). No other role gained anything, and
      // `vitals_desk` deliberately gained nothing — vitals are recorded against a patient who is
      // already at the counter, and recognition happens where the invoice is.
      front_office: 12,
      front_office_supervisor: 13,
      vitals_desk: 5,
      doctor: 7,
      opd_admin: 6,
      display: 1,
      pharmacy: 1,
      cashier: 11,
      billing_manager: 10,
      owner: 3,
      medical_superintendent: 2,
    });
    expect(modelPairs()).toHaveLength(71);
    expect(modelPermissions()).toHaveLength(41);
    // No role lists the same permission twice — a duplicate would inflate the counts above
    // without changing a single row of `role_permissions`.
    for (const role of ROLE_MODEL) {
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });

  it("the reachability census closes: 73 declared = 50 held + 23 not yet modelled", () => {
    expect(installedRegistry().allPermissions()).toHaveLength(73);
    // 42 + 13 until the 2026-08-23 ruling moved the four `workflow.definitions.*` strings across;
    // 46 + 13 until Plan 09 declared fourteen and DD18 granted four of them.
    expect(heldPermissions()).toHaveLength(50);
    expect(NOT_YET_MODELLED).toHaveLength(23);
    expect(heldPermissions().length + NOT_YET_MODELLED.length).toBe(73);
  });

  it("the README carries exactly two permission tables, of the measured shapes", () => {
    expect(tables).toHaveLength(2);
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
    ]);
    expect(modelKeys.filter((k) => !opdKeys.includes(k))).toEqual(["pharmacy", "cashier", "billing_manager"]);
    expect(opdKeys.filter((k) => !modelKeys.includes(k))).toEqual(["nurse", "duty_manager"]);
    // The UNION covers the model exactly, and neither source shadows the other.
    expect(Object.keys(LOCAL_ROLE_TITLES).sort()).toEqual(["billing_manager", "cashier", "pharmacy"]);
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
      "approvals.types.manage",
      // PLAN 09 / DD18 — the ten. The three membership strings guard the catalog, the operator
      // import and the reconcile queue; the seven `partners.*` guard lanes that ship structurally
      // OFF pending the owner's O-8 ruling. Each carries its reason in `seed-roles.ts`, and the
      // day any of them is granted this list shrinks and the census above fails.
      "membership.catalog.manage",
      "membership.import.run",
      "membership.reconcile.operate",
      "partners.agreement.manage",
      "partners.attribution.issue",
      "partners.counterparty.manage",
      "partners.ledger.read",
      "partners.pnl.read",
      "partners.receivable.operate",
      "partners.statement.import",
      "patients.confidential.read",
      "patients.merge",
      "tariff.config.manage",
      "tariff.read",
      "tariff.services.manage",
      "tariff.versions.activate",
      "tariff.versions.draft",
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
  it("V3: the two tables and the model agree over the table-derived subset, both directions", () => {
    const fromReadme = [...tablePairs(opdTable), ...tablePairs(billingTable)].sort();
    const fromModel = modelPairs().filter((pair) => !NON_TABLE_PAIRS.includes(pair));
    expect(fromReadme).toHaveLength(46);
    // Direction 1: nothing the README ticks is missing from the model.
    expect(fromReadme.filter((p) => !fromModel.includes(p))).toEqual([]);
    // Direction 2: nothing the model grants from a table is missing from that table.
    expect(fromModel.filter((p) => !fromReadme.includes(p))).toEqual([]);
    expect(fromModel).toEqual(fromReadme);
  });

  it("V3: the three rulings' twenty-five pairs are exactly the model's non-table rows, with all three README prose lines quoted", () => {
    const fromReadme = new Set([...tablePairs(opdTable), ...tablePairs(billingTable)]);
    const nonTable = modelPairs().filter((pair) => !fromReadme.has(pair));
    // This is the leg that stops the subset scoping above becoming a hole: a model row that is
    // neither table-derived nor one of the three rulings' twenty-five pairs fails HERE.
    expect(nonTable).toEqual([...NON_TABLE_PAIRS].sort());
    expect(NON_TABLE_PAIRS).toHaveLength(25);
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
    expect(first.roles.map((r) => r.created)).toEqual(Array(11).fill(true));
    // The last two are the governance roles the 2026-08-23 ruling added: `owner` 3, `medical_
    // superintendent` 2. `opd_admin` went 4 -> 6 with the two definition-drafting strings. Plan
    // 09 / DD18 then moved four: front_office 9 -> 12, its supervisor 10 -> 13, cashier 8 -> 11,
    // billing_manager 9 -> 10.
    expect(first.roles.map((r) => r.granted.length)).toEqual([12, 13, 5, 7, 6, 1, 1, 11, 10, 3, 2]);
    expect(first.roles.every((r) => r.already.length === 0)).toBe(true);
    expect(first.declared).toBe(73);
    // MEASURED from role_permissions, not derived from the model. On this database only seed:roles
    // has run, so what is held is exactly what the model granted — 41, not the 50 the model CLAIMS
    // once seed:admin and seed:ops have also run. That nine-permission gap IS MAJOR 1, and before
    // the 2026-08-23 fix this line read the model's claim against a database holding the grants.
    expect(first.held).toBe(41);
    expect(first.held).toBe(modelPermissions().length);
    expect(heldPermissions()).toHaveLength(50);
    expect(first.notYetModelled).toBe(23);
    expect(first.expectedElsewhereAbsent).toBe(9);
    // And the census RECONCILES against the catalog, which is the property that makes it evidence.
    expect(first.held + first.notYetModelled + first.expectedElsewhereAbsent).toBe(first.declared);

    // `createRole` is a BARE INSERT and is not idempotent; the guard around it is what makes this
    // run exit rather than die on a duplicate key.
    const second = await seedRoles(db);
    expect(second.roles.map((r) => r.created)).toEqual(Array(11).fill(false));
    expect(second.roles.every((r) => r.granted.length === 0)).toBe(true);
    expect(second.roles.map((r) => r.already.length)).toEqual([12, 13, 5, 7, 6, 1, 1, 11, 10, 3, 2]);

    // And the database holds the model exactly once.
    const written = await db
      .select({ roleKey: rolePermissions.roleKey, permission: rolePermissions.permission })
      .from(rolePermissions);
    expect(written.map((r) => `${r.roleKey}/${r.permission}`).sort()).toEqual(modelPairs());
  });

  it("MAJOR 1: the census is READ BACK OUT OF THE DATABASE, so granting a permission moves it", async () => {
    const first = await seedRoles(db);

    // The model CLAIMS nine permissions it does not itself grant — seed:admin's six auth.* and
    // seed:ops's three ops.*. Neither script has run here, so none of the nine is held.
    const claimedElsewhere = heldPermissions().filter((p) => !modelPermissions().includes(p));
    expect(claimedElsewhere).toHaveLength(9);
    const measured = await heldInDatabase(db);
    expect(claimedElsewhere.filter((p) => measured.includes(p))).toEqual([]);
    expect(first.expectedElsewhereAbsent).toBe(9);

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
    expect(second.expectedElsewhereAbsent).toBe(8);
    expect(await heldInDatabase(db)).toContain(moved);
    expect(second.held + second.notYetModelled + second.expectedElsewhereAbsent).toBe(second.declared);
  });

  it("reports zero holders per role, because seed:roles mints authority and assigns nobody", async () => {
    const report = await seedRoles(db);
    expect(report.roles.every((r) => r.holders === 0)).toBe(true);
    // A role with no holder is REPORTED rather than silently absent — grants without holders are
    // still 403 for every user on the deployment, and the verdict line has to say so.
    expect(report.ready).toBe(false);
    expect(report.problems.join(" ")).toContain("NO USER HOLDS ANY OF THE 11 ROLES");
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
