import { and, eq, inArray } from "drizzle-orm";
import { IPD_BED_CLASSES, IPD_BED_CLASS_INFO, IpdBedClassSchema } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { resources } from "../../kernel/db/schema";
import { KERNEL_RESOURCE_KINDS, createResource, updateResource } from "../../kernel/resources";
import {
  IPD_BED_EQUIPMENT, IPD_GENDER_RULES, IPD_ISOLATION_TYPES, IpdBedAttributesSchema, IpdWardAttributesSchema,
  canonicalEquipment,
} from "./bed-attributes";
import { IpdError } from "./errors";
import type { Actor, IpdBedClass } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { IpdBedAttributes, IpdBedEquipment, IpdWardAttributes } from "./bed-attributes";

/**
 * E0.3 — THE BED LAYOUT LOADER: one spreadsheet row per bed puts the whole hospital into the kernel
 * resource registry (floor → ward/hall → room → bed), with the bed's and the ward's IPD attributes
 * in `resources.attributes`.
 *
 * Three promises, each one an acceptance check (`acceptance/bed-layout.acceptance.test.ts`):
 *   · VALIDATION FIRST, WHOLE FILE. Every bad row is listed by its spreadsheet row number (header =
 *     row 1) and NOTHING is written while one exists.
 *   · IDEMPOTENT UPSERT BY CODE in ONE transaction: missing places are created under the right
 *     parent, changed names and attributes are updated, and a second run of the same file writes
 *     nothing.
 *   · NEVER DELETES OR RETIRES. An IPD bed in the registry but not in the file is reported as "not in
 *     file" and left alone; retiring a bed is a person's act on the board, not a side effect of a file.
 *
 * Dry run is the default (`apply: false`): the same validation, the same diff, no writes.
 */

export const BED_LAYOUT_COLUMNS = [
  "floor_code", "floor_name", "ward_code", "ward_name", "ward_kind", "department", "unit_type",
  "room_code", "room_name", "bed_code", "bed_class", "gender_rule", "isolation", "negative_pressure",
  "icu", "equipment", "daycare", "overflow",
] as const;
export type BedLayoutColumn = (typeof BED_LAYOUT_COLUMNS)[number];

/** One data row. `row` is the spreadsheet row number a person can find: the header is row 1. */
export type BedLayoutRow = { row: number; cells: Partial<Record<BedLayoutColumn, string>> };

export type BedLayoutProblem = { row: number | null; code: string; message: string };

// ═══════════════════════════════════ CSV ═══════════════════════════════════

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === "\"") {
        if (line[i + 1] === "\"") { cur += "\""; i += 1; } else quoted = false;
      } else cur += ch;
      continue;
    }
    if (ch === "\"") { quoted = true; continue; }
    if (ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * The file into rows. A missing column refuses the whole file (every row would be wrong the same
 * way); an unknown extra column is refused too, because a misspelt `bed_clas` would otherwise read
 * as "every bed without a class". Blank lines are skipped but still counted, so row numbers stay
 * the ones a spreadsheet shows.
 */
export function parseBedLayoutCsv(text: string): BedLayoutRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let header: string[] | undefined;
  const rows: BedLayoutRow[] = [];
  lines.forEach((raw, idx) => {
    if (raw.trim() === "") return;
    if (header === undefined) {
      header = splitCsvLine(raw).map((h) => h.toLowerCase());
      const missing = BED_LAYOUT_COLUMNS.filter((c) => !header!.includes(c));
      const unknown = header.filter((h) => !(BED_LAYOUT_COLUMNS as readonly string[]).includes(h));
      if (missing.length > 0 || unknown.length > 0) {
        throw new IpdError(
          "bed_layout_invalid",
          `bed layout header refused: ${missing.length > 0 ? `missing ${missing.join(", ")}` : ""}` +
            `${missing.length > 0 && unknown.length > 0 ? "; " : ""}${unknown.length > 0 ? `unknown ${unknown.join(", ")}` : ""}` +
            ` — the columns are ${BED_LAYOUT_COLUMNS.join(", ")}`,
          { missing, unknown },
        );
      }
      return;
    }
    const values = splitCsvLine(raw);
    const cells: Partial<Record<BedLayoutColumn, string>> = {};
    header.forEach((h, i) => { cells[h as BedLayoutColumn] = values[i] ?? ""; });
    rows.push({ row: idx + 1, cells });
  });
  if (header === undefined) throw new IpdError("bed_layout_invalid", "bed layout file is empty — no header row");
  return rows;
}

// ═══════════════════════════════════ validation ═══════════════════════════════════

type FloorPlan = { code: string; name: string; row: number };
type WardPlan = { code: string; name: string; kind: "ward" | "hall"; floorCode: string; attributes: IpdWardAttributes; row: number };
type RoomPlan = { code: string; name: string; wardKey: string; row: number };
type BedPlan = { code: string; row: number; parentKey: string; attributes: IpdBedAttributes; unitType: string };

export type BedLayoutPlan = {
  floors: Map<string, FloorPlan>;
  wards: Map<string, WardPlan>;
  rooms: Map<string, RoomPlan>;
  beds: BedPlan[];
};

/** `kind:lower(code)` — the registry's own uniqueness (`resources_site_kind_code_lower_ux`). */
function keyOf(kind: string, code: string): string {
  return `${kind}:${code.toLowerCase()}`;
}

const TRUE_WORDS = new Set(["yes", "y", "true", "1"]);
const FALSE_WORDS = new Set(["no", "n", "false", "0", ""]);

/**
 * Pure: rows → a plan, or every problem in the file. Exported so a screen can validate a file
 * before anyone runs the loader.
 */
export function validateBedLayout(rows: readonly BedLayoutRow[]): { plan: BedLayoutPlan; problems: BedLayoutProblem[] } {
  const problems: BedLayoutProblem[] = [];
  const plan: BedLayoutPlan = { floors: new Map(), wards: new Map(), rooms: new Map(), beds: [] };
  const bedRows = new Map<string, number>();

  for (const { row, cells } of rows) {
    const cell = (c: BedLayoutColumn): string => (cells[c] ?? "").trim();
    const say = (code: string, message: string): void => { problems.push({ row, code, message: `row ${String(row)}: ${message}` }); };
    const before = problems.length;

    const flag = (c: BedLayoutColumn): boolean => {
      const v = cell(c).toLowerCase();
      if (TRUE_WORDS.has(v)) return true;
      if (!FALSE_WORDS.has(v)) say("bad_flag", `${c} "${cell(c)}" is not yes or no`);
      return false;
    };

    const bedCode = cell("bed_code");
    const floorCode = cell("floor_code");
    const wardCode = cell("ward_code");
    const roomCode = cell("room_code");
    if (bedCode === "") say("missing_bed_code", "bed without a code");
    if (floorCode === "") say("missing_floor", "bed without a floor_code");
    if (wardCode === "") say("missing_ward", "bed without a ward_code");

    const rawClass = cell("bed_class");
    let cls: IpdBedClass | undefined;
    if (rawClass === "") say("missing_class", `bed ${bedCode || "(no code)"} — bed without a class`);
    else {
      const parsed = IpdBedClassSchema.safeParse(rawClass.toLowerCase());
      if (parsed.success) cls = parsed.data;
      else say("unknown_class", `unknown class "${rawClass}" — the classes are ${IPD_BED_CLASSES.join(", ")}`);
    }

    const gender = cell("gender_rule").toLowerCase();
    if (gender === "") say("missing_gender_rule", `gender_rule is required (${IPD_GENDER_RULES.join(", ")})`);
    else if (!(IPD_GENDER_RULES as readonly string[]).includes(gender)) {
      say("unknown_gender_rule", `gender_rule "${cell("gender_rule")}" — expected ${IPD_GENDER_RULES.join(", ")}`);
    }
    const isolation = cell("isolation").toLowerCase() || "none";
    if (!(IPD_ISOLATION_TYPES as readonly string[]).includes(isolation)) {
      say("unknown_isolation", `isolation "${cell("isolation")}" — expected ${IPD_ISOLATION_TYPES.join(", ")}`);
    }
    const equipment = cell("equipment").split(";").map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
    const unknownEquipment = equipment.filter((e) => !(IPD_BED_EQUIPMENT as readonly string[]).includes(e));
    if (unknownEquipment.length > 0) {
      say("unknown_equipment", `equipment ${unknownEquipment.map((e) => `"${e}"`).join(", ")} — expected ${IPD_BED_EQUIPMENT.join(", ")}`);
    }
    const negativePressure = flag("negative_pressure");
    const icu = flag("icu");
    const daycare = flag("daycare");
    const overflow = flag("overflow");

    const wardKind = cell("ward_kind").toLowerCase();
    if (wardKind !== "ward" && wardKind !== "hall") say("bad_ward_kind", `ward_kind "${cell("ward_kind")}" — expected ward or hall`);
    const wardAttrs = IpdWardAttributesSchema.safeParse({
      department: cell("department").toUpperCase(), unitType: cell("unit_type").toUpperCase(), wardType: wardKind,
    });
    if (!wardAttrs.success) {
      for (const issue of wardAttrs.error.issues) {
        if (issue.path[0] === "wardType") continue; // already said above
        say(`bad_${String(issue.path[0])}`, `${String(issue.path[0])}: ${issue.message}`);
      }
    }

    // The bed's own rules — only once its fields parsed, so one typo is one problem, not three.
    let bedAttrs: IpdBedAttributes | undefined;
    if (problems.length === before && cls !== undefined) {
      const parsed = IpdBedAttributesSchema.safeParse({
        class: cls, genderRule: gender, isolation, negativePressure, icu,
        equipment: canonicalEquipment(equipment as IpdBedEquipment[]), daycare, overflow,
      });
      if (parsed.success) bedAttrs = parsed.data;
      else {
        for (const issue of parsed.error.issues) {
          const [code, ...rest] = issue.message.split(": ");
          say(rest.length > 0 ? code! : "bad_bed", rest.length > 0 ? rest.join(": ") : issue.message);
        }
      }
    }

    if (bedCode !== "") {
      const first = bedRows.get(bedCode.toLowerCase());
      if (first !== undefined) say("duplicate_bed_code", `duplicate bed code ${bedCode} (first at row ${String(first)})`);
      else bedRows.set(bedCode.toLowerCase(), row);
    }

    // Structure: one floor, ward and room is described the same way on every row that names it.
    if (floorCode !== "") {
      const f = plan.floors.get(keyOf("floor", floorCode));
      const name = cell("floor_name") || floorCode;
      if (f === undefined) plan.floors.set(keyOf("floor", floorCode), { code: floorCode, name, row });
      else if (f.name !== name) say("inconsistent_floor", `floor ${floorCode} is named "${name}" here and "${f.name}" at row ${String(f.row)}`);
    }
    let wardKey: string | undefined;
    if (wardCode !== "" && wardAttrs.success && (wardKind === "ward" || wardKind === "hall")) {
      wardKey = keyOf(wardKind, wardCode);
      const name = cell("ward_name") || wardCode;
      const other = plan.wards.get(keyOf(wardKind === "ward" ? "hall" : "ward", wardCode));
      const w = plan.wards.get(wardKey);
      if (other !== undefined) {
        say("inconsistent_ward", `ward ${wardCode} is a ${wardKind} here and a ${other.kind} at row ${String(other.row)}`);
        wardKey = undefined; // one mistake, one problem: the room under it is not judged against a ward that is wrong
      } else if (w === undefined) {
        plan.wards.set(wardKey, { code: wardCode, name, kind: wardKind, floorCode, attributes: wardAttrs.data, row });
      } else if (w.name !== name || w.floorCode.toLowerCase() !== floorCode.toLowerCase()
        || JSON.stringify(w.attributes) !== JSON.stringify(wardAttrs.data)) {
        say("inconsistent_ward", `ward ${wardCode} is described differently here than at row ${String(w.row)} (name, floor, department, unit type)`);
        wardKey = undefined;
      }
    }
    let parentKey = wardKey;
    if (roomCode !== "" && wardKey !== undefined) {
      const rk = keyOf("room", roomCode);
      const name = cell("room_name") || roomCode;
      const r = plan.rooms.get(rk);
      if (r === undefined) plan.rooms.set(rk, { code: roomCode, name, wardKey, row });
      else if (r.name !== name || r.wardKey !== wardKey) {
        say("inconsistent_room", `room ${roomCode} is described differently here than at row ${String(r.row)} (name or ward)`);
      }
      parentKey = rk;
    }

    if (problems.length === before && bedAttrs !== undefined && parentKey !== undefined && wardAttrs.success) {
      plan.beds.push({ code: bedCode, row, parentKey, attributes: bedAttrs, unitType: wardAttrs.data.unitType });
    }
  }
  return { plan, problems };
}

// ═══════════════════════════════════ the loader ═══════════════════════════════════

type Kind = "floor" | "ward" | "hall" | "room" | "bed";
type ResourceRow = typeof resources.$inferSelect;

export type BedLayoutChange = { kind: Kind; code: string; row: number; fields?: string[] };

export type BedLayoutReport = {
  applied: boolean;
  beds: number;
  /** Beds of a class counted in the midnight census (`IPD_BED_CLASS_INFO.inCensus`). */
  inCensus: number;
  byClass: Record<IpdBedClass, number>;
  byUnitType: Record<string, number>;
  create: BedLayoutChange[];
  update: BedLayoutChange[];
  unchanged: number;
  /** IPD beds (a bed whose attributes carry a class) in the registry and not in the file — left alone. */
  notInFile: string[];
  /** Rows actually written: 0 on a dry run, and 0 on a second run of the same file. */
  writes: number;
};

/** The attribute keys this file owns on a row; anything else already on the row is kept. */
function attributeDiff(existing: Record<string, unknown>, desired: Record<string, unknown>): string[] {
  return Object.keys(desired).filter((k) => JSON.stringify(existing[k]) !== JSON.stringify(desired[k]));
}

/**
 * Validate, diff against the registry, and (with `apply`) write — all inside ONE transaction, so a
 * failure part-way leaves the registry exactly as it was.
 *
 * Refuses with `IpdError("bed_layout_invalid")` — `detail.problems` lists every one — when any row is
 * bad, or when a code in the file is already a place elsewhere in the registry (under another
 * parent, or retired): the loader never moves or revives a place, because that is a person's act.
 */
export async function loadBedLayout(
  db: Db,
  actor: Actor,
  rows: readonly BedLayoutRow[],
  opts: { apply?: boolean; siteId?: string } = {},
): Promise<BedLayoutReport> {
  const apply = opts.apply ?? false;
  const siteId = opts.siteId ?? "main";
  const { plan, problems } = validateBedLayout(rows);
  if (rows.length === 0) problems.push({ row: null, code: "empty", message: "the file has no bed rows" });
  if (problems.length > 0) throw refusal(problems);

  return withTx(db, async (tx) => {
    const existingRows = await tx.select().from(resources)
      .where(and(eq(resources.siteId, siteId), inArray(resources.kind, ["floor", "ward", "hall", "room", "bed"])));
    const existing = new Map<string, ResourceRow>(existingRows.map((r) => [keyOf(r.kind, r.code), r]));
    const idOf = new Map<string, string | null>(); // key → id; null = to be created

    const report: BedLayoutReport = {
      applied: apply, beds: plan.beds.length, inCensus: 0,
      byClass: Object.fromEntries(IPD_BED_CLASSES.map((c) => [c, 0])) as Record<IpdBedClass, number>,
      byUnitType: {}, create: [], update: [], unchanged: 0, notInFile: [], writes: 0,
    };
    for (const b of plan.beds) {
      report.byClass[b.attributes.class] += 1;
      report.byUnitType[b.unitType] = (report.byUnitType[b.unitType] ?? 0) + 1;
      if (IPD_BED_CLASS_INFO[b.attributes.class].inCensus) report.inCensus += 1;
    }

    type Step = { key: string; kind: Kind; code: string; name: string; row: number; parentKey: string | null; attributes?: Record<string, unknown> };
    const steps: Step[] = [
      ...[...plan.floors].map(([key, f]) => ({ key, kind: "floor" as const, code: f.code, name: f.name, row: f.row, parentKey: null })),
      ...[...plan.wards].map(([key, w]) => ({
        key, kind: w.kind, code: w.code, name: w.name, row: w.row, parentKey: keyOf("floor", w.floorCode), attributes: w.attributes,
      })),
      ...[...plan.rooms].map(([key, r]) => ({ key, kind: "room" as const, code: r.code, name: r.name, row: r.row, parentKey: r.wardKey })),
      ...plan.beds.map((b) => ({
        key: keyOf("bed", b.code), kind: "bed" as const, code: b.code, name: b.code, row: b.row, parentKey: b.parentKey, attributes: b.attributes,
      })),
    ];

    // Pass 1 — the diff, and every conflict with the registry. Nothing is written in this pass.
    const conflicts: BedLayoutProblem[] = [];
    const work: { step: Step; current?: ResourceRow; fields?: string[] }[] = [];
    for (const step of steps) {
      const current = existing.get(step.key);
      const parentId = step.parentKey === null ? null : idOf.get(step.parentKey) ?? null;
      // A parent this run creates has no id yet, so `parentId` is null — and a place that already
      // exists can never be under it. Without this an existing top-level row (an OT recovery bay)
      // would compare equal to "under a floor not yet created" and be adopted.
      const parentIsNew = step.parentKey !== null && parentId === null;
      if (current === undefined) {
        idOf.set(step.key, null);
        report.create.push({ kind: step.kind, code: step.code, row: step.row });
        work.push({ step });
        continue;
      }
      idOf.set(step.key, current.id);
      if (current.status === "retired") {
        conflicts.push({ row: step.row, code: "retired_in_registry", message: `row ${String(step.row)}: ${step.kind} ${step.code} is retired in the registry — the loader does not revive a place; remove the row or un-retire it on the board` });
        continue;
      }
      if (parentIsNew || current.parentId !== parentId) {
        const where = current.parentId === null ? "at the top of the registry" : `under ${existingRows.find((r) => r.id === current.parentId)?.code ?? current.parentId}`;
        conflicts.push({ row: step.row, code: "code_taken_elsewhere", message: `row ${String(step.row)}: ${step.kind} ${step.code} already exists ${where}, not where this file puts it — the loader never moves a place` });
        continue;
      }
      const fields = [
        ...(current.name !== step.name ? ["name"] : []),
        ...(step.attributes === undefined ? [] : attributeDiff(current.attributes, step.attributes).map((k) => `attributes.${k}`)),
      ];
      if (fields.length === 0) report.unchanged += 1;
      else {
        report.update.push({ kind: step.kind, code: step.code, row: step.row, fields });
        work.push({ step, current, fields });
      }
    }
    if (conflicts.length > 0) throw refusal(conflicts);

    const fileBeds = new Set(plan.beds.map((b) => b.code.toLowerCase()));
    report.notInFile = existingRows
      .filter((r) => r.kind === "bed" && r.status !== "retired" && typeof r.attributes.class === "string" && !fileBeds.has(r.code.toLowerCase()))
      .map((r) => r.code)
      .sort();

    if (!apply) return report;

    // Pass 2 — the writes, parents before children (the step order above).
    for (const { step, current, fields } of work) {
      if (current === undefined) {
        const parentId = step.parentKey === null ? null : idOf.get(step.parentKey);
        if (parentId === undefined || (step.parentKey !== null && parentId === null)) {
          throw new Error(`bed layout: parent ${String(step.parentKey)} of ${step.kind} ${step.code} was not created first`);
        }
        const { resourceId } = await createResource(tx, actor, KERNEL_RESOURCE_KINDS, {
          kind: step.kind, code: step.code, name: step.name, parentId, siteId, attributes: step.attributes ?? {},
        });
        idOf.set(step.key, resourceId);
      } else {
        await updateResource(tx, actor, KERNEL_RESOURCE_KINDS, current.id, {
          ...(fields!.includes("name") ? { name: step.name } : {}),
          ...(step.attributes !== undefined && fields!.some((f) => f.startsWith("attributes."))
            ? { attributes: { ...current.attributes, ...step.attributes } } : {}),
        });
      }
      report.writes += 1;
    }
    return report;
  });
}

function refusal(problems: BedLayoutProblem[]): IpdError {
  return new IpdError(
    "bed_layout_invalid",
    `bed layout refused — ${String(problems.length)} problem${problems.length === 1 ? "" : "s"}, nothing written:\n` +
      problems.map((p) => `  ${p.message}`).join("\n"),
    { problems },
  );
}

// ═══════════════════════════════════ the summary a person reads ═══════════════════════════════════

function summariseChanges(list: readonly BedLayoutChange[]): string {
  const by = new Map<string, number>();
  for (const c of list) by.set(c.kind, (by.get(c.kind) ?? 0) + 1);
  const parts = (["floor", "ward", "hall", "room", "bed"] as const)
    .filter((k) => by.has(k)).map((k) => `${String(by.get(k))} ${k}${by.get(k) === 1 ? "" : "s"}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

const LIST_LIMIT = 20;

function listSome(items: readonly string[]): string[] {
  const shown = items.slice(0, LIST_LIMIT).map((s) => `    ${s}`);
  return items.length > LIST_LIMIT ? [...shown, `    … and ${String(items.length - LIST_LIMIT)} more`] : shown;
}

/** The dry-run / apply summary: counts per class and per unit type, then the diff. */
export function formatBedLayoutReport(r: BedLayoutReport): string {
  const pad = (s: string): string => s.padEnd(14);
  const lines = [
    r.applied ? "Bed layout — APPLIED" : "Bed layout — DRY RUN (nothing written; add --apply to write)",
    `Beds in file: ${String(r.beds)} (midnight census ${String(r.inCensus)}, outside it ${String(r.beds - r.inCensus)})`,
    "By class:",
    ...IPD_BED_CLASSES.map((c) => `  ${pad(c)}${String(r.byClass[c]).padStart(5)}`),
    "By unit type:",
    ...Object.keys(r.byUnitType).sort().map((u) => `  ${pad(u)}${String(r.byUnitType[u]).padStart(5)}`),
    "Against the registry:",
    `  create:    ${summariseChanges(r.create)}`,
    `  update:    ${summariseChanges(r.update)}`,
    ...listSome(r.update.map((u) => `${u.kind} ${u.code} (row ${String(u.row)}): ${(u.fields ?? []).join(", ")}`)),
    `  unchanged: ${String(r.unchanged)}`,
    `  not in file (left alone): ${String(r.notInFile.length)}`,
    ...listSome(r.notInFile),
    `Writes: ${String(r.writes)}`,
  ];
  return lines.join("\n");
}
