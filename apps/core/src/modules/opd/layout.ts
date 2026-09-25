import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { opdConsultLayouts, opdDepartments, users } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import { doctorForUser } from "./masters";
import { visibleEncounterFor } from "./read-gate";
import { PROFILES } from "./sections";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { EncounterRow } from "./encounters";

/**
 * ═══ THE CONSULT LAYOUT BUILDER (board `Profiles`, approved 2026-09-23; 01-CONSULT-ENGINE.md §3, D1) ═══
 *
 * *"Profile — department default (admin) + doctor overlay (doctor, within the admin's bounds) …
 * which sections, in what order."* The admin sets, per department, the order of the consult's
 * sections, which are shown and which are mandatory. Each doctor then arranges their own screen:
 * *"You may reorder any section … You may hide a section only if it is not mandatory. Mandatory
 * sections stay on your screen."*
 *
 * ONE VALIDATOR, ONE RESOLVER. Every rule below lives in the pure half of this file, and the
 * routes, the consult start and the tests all call the same functions — a second copy of "may this
 * doctor hide Rx" in a controller is how a guard ends up checking the adjacent property.
 *
 * DECIDED 2026-09-25 (planner) — THE SCOPE OF THIS SLICE:
 *   · A SECTION is a consult tab (`opd-consult.tsx` TabStrip). `summary` is not one: it is always
 *     first and always shown. `eye` exists only where the department's engine profile names eye
 *     sections (sections.ts `PROFILES`).
 *   · Five sections are LOCKED — mandatory and shown for everyone, the admin included: complaints,
 *     vitals, examination, diagnosis, Rx (the board's own mandatory rows). The admin may make any
 *     other section mandatory too.
 *   · The board's COLLAPSED, ON PRINT and COPILOT columns and its sex/age/pregnancy gates are a
 *     later slice; the body has no field for them yet, so nothing can half-configure them.
 *   · A VISIT READS THE VERSIONS IT STARTED UNDER. `startConsultation` stamps the ids in force; a
 *     visit started before any stamp existed resolves the rows in force AT ITS START (created at or
 *     before `consult_started_at`), which is what its doctor saw; only a visit not yet started reads
 *     the current rows. That is the board's *"an old visit always reads … in the version it was
 *     written under"*, applied to visits older than this table as well.
 */

/** Every configurable section, in today's consult order — the base layout when no admin has saved one. */
export const LAYOUT_SECTIONS = ["vitals", "eye", "complaints", "exam", "dx", "inv", "rx", "treat", "advice", "notes"] as const;
export type LayoutSection = (typeof LAYOUT_SECTIONS)[number];
/** Mandatory and shown for everyone. Nobody — not the admin — can hide or relax these. */
export const LOCKED_SECTIONS: readonly LayoutSection[] = ["complaints", "vitals", "exam", "dx", "rx"];
/** English names for the audit summary. The screen renders the structured changes in its own language. */
export const SECTION_NAMES: Record<LayoutSection, string> = {
  vitals: "Vitals", eye: "Eye", complaints: "Complaints", exam: "Examination", dx: "Diagnosis",
  inv: "Investigations", rx: "Rx", treat: "Treatment", advice: "Advice", notes: "Notes",
};

export type DefaultRow = { key: LayoutSection; shown: boolean; mandatory: boolean };
export type DefaultBody = { sections: DefaultRow[] };
export type OverlayBody = { order: LayoutSection[]; hidden: LayoutSection[] };
export type ResolvedSection = { key: LayoutSection; mandatory: boolean };

const isLocked = (k: LayoutSection): boolean => LOCKED_SECTIONS.includes(k);
const named = (k: string): string => SECTION_NAMES[k as LayoutSection] ?? k;

/** The sections a department's consult can have: every one, less `eye` where its profile has none. */
export function catalogFor(hasEye: boolean): LayoutSection[] {
  return LAYOUT_SECTIONS.filter((k) => k !== "eye" || hasEye);
}

/** No admin has saved: today's order, everything shown, the locked five mandatory. */
export function baseDefault(catalog: readonly LayoutSection[]): DefaultBody {
  return { sections: catalog.map((key) => ({ key, shown: true, mandatory: isLocked(key) })) };
}

function refuseKeys(keys: readonly string[], catalog: readonly LayoutSection[], what: string): void {
  const seen = new Set<string>();
  for (const k of keys) {
    if (!(catalog as readonly string[]).includes(k)) throw new OpdError("invalid_layout", `${what}: unknown section ${k}`);
    if (seen.has(k)) throw new OpdError("invalid_layout", `${what}: section ${k} appears twice`);
    seen.add(k);
  }
}

/**
 * The admin's body, VALIDATED and made whole. Refused: an unknown key, a key twice, a locked section
 * hidden or not mandatory, a mandatory section hidden. A catalog section the body does not name is
 * appended with the base answer, so a client one section behind still saves.
 */
export function validateDefault(input: { sections: { key: string; shown: boolean; mandatory: boolean }[] }, catalog: readonly LayoutSection[]): DefaultBody {
  refuseKeys(input.sections.map((r) => r.key), catalog, "department layout");
  for (const r of input.sections) {
    const k = r.key as LayoutSection;
    if (isLocked(k) && (!r.mandatory || !r.shown)) throw new OpdError("invalid_layout", `${named(k)} is always mandatory and shown`);
    if (r.mandatory && !r.shown) throw new OpdError("invalid_layout", `${named(k)} is mandatory, so it must be shown`);
  }
  return normalizeDefault(input as DefaultBody, catalog);
}

/**
 * A STORED default read against today's catalog: keys the catalog no longer has are dropped, keys it
 * gained are appended with the base answer, and the locked five are forced — a row written before a
 * lock existed cannot unlock it.
 */
export function normalizeDefault(body: DefaultBody, catalog: readonly LayoutSection[]): DefaultBody {
  const seen = new Set<LayoutSection>();
  const rows: DefaultRow[] = [];
  for (const r of body.sections) {
    if (!catalog.includes(r.key) || seen.has(r.key)) continue;
    seen.add(r.key);
    const locked = isLocked(r.key);
    const mandatory = locked || r.mandatory === true;
    rows.push({ key: r.key, shown: mandatory || r.shown === true, mandatory });
  }
  for (const k of catalog) if (!seen.has(k)) rows.push({ key: k, shown: true, mandatory: isLocked(k) });
  return { sections: rows };
}

/** What the admin's default puts on every screen in the department, in the admin's order. */
export function boundsOf(def: DefaultBody): { shown: ResolvedSection[]; adminHidden: LayoutSection[] } {
  return {
    shown: def.sections.filter((r) => r.shown).map((r) => ({ key: r.key, mandatory: r.mandatory })),
    adminHidden: def.sections.filter((r) => !r.shown).map((r) => r.key),
  };
}

/**
 * The doctor's body, VALIDATED against the admin's bounds and made canonical: `order` is every
 * section the admin shows, in the doctor's order (unmentioned ones appended in the admin's order);
 * `hidden` is in that order too. Refused: an unknown key, a key twice, a section the admin hid
 * (the doctor cannot show it, so naming it is a mistake), hiding a mandatory section.
 */
export function validateOverlay(input: { order: string[]; hidden: string[] }, def: DefaultBody, catalog: readonly LayoutSection[]): OverlayBody {
  refuseKeys(input.order, catalog, "my layout order");
  refuseKeys(input.hidden, catalog, "my layout hidden");
  const { shown, adminHidden } = boundsOf(def);
  for (const k of [...input.order, ...input.hidden] as LayoutSection[]) {
    if (adminHidden.includes(k)) throw new OpdError("invalid_layout", `${named(k)} is hidden by the department layout`);
  }
  for (const k of input.hidden as LayoutSection[]) {
    if (shown.find((s) => s.key === k)?.mandatory === true) throw new OpdError("invalid_layout", `${named(k)} is mandatory and cannot be hidden`);
  }
  return canonicalOverlay(input as OverlayBody, def);
}

/** A stored or validated overlay against the CURRENT default: the doctor's order, the admin's additions appended, nothing out of bounds. */
export function canonicalOverlay(body: OverlayBody, def: DefaultBody): OverlayBody {
  const { shown } = boundsOf(def);
  const allowed = shown.map((s) => s.key);
  const order: LayoutSection[] = [];
  for (const k of body.order) if (allowed.includes(k) && !order.includes(k)) order.push(k);
  for (const k of allowed) if (!order.includes(k)) order.push(k);
  const hidden = order.filter((k) => body.hidden.includes(k) && shown.find((s) => s.key === k)?.mandatory !== true);
  return { order, hidden };
}

/** THE RESOLVER — the sections one doctor's consult shows, in order, each with whether it is mandatory. */
export function resolveLayout(def: DefaultBody | null, overlay: OverlayBody | null, catalog: readonly LayoutSection[]): ResolvedSection[] {
  const d = normalizeDefault(def ?? baseDefault(catalog), catalog);
  const { shown } = boundsOf(d);
  if (overlay === null) return shown;
  const o = canonicalOverlay(overlay, d);
  return o.order.filter((k) => !o.hidden.includes(k)).map((k) => ({ key: k, mandatory: shown.find((s) => s.key === k)!.mandatory }));
}

export const sameDefault = (a: DefaultBody, b: DefaultBody): boolean => JSON.stringify(a.sections) === JSON.stringify(b.sections);
export const sameOverlay = (a: OverlayBody, b: OverlayBody): boolean =>
  JSON.stringify(a.order) === JSON.stringify(b.order) && JSON.stringify(a.hidden) === JSON.stringify(b.hidden);

// ——— the audit: a diff of consecutive versions, computed on read, never stored as prose ———

export type LayoutChange =
  | { kind: "hidden" | "shown" | "mandatory" | "optional"; key: LayoutSection }
  | { kind: "moved"; key: LayoutSection; above: LayoutSection | null; below: LayoutSection | null };

/**
 * Which keys MOVED between two orders: those outside a longest common subsequence. Each is said
 * relative to its new neighbour — "Advice moved above Rx" — the way a person describes a drag.
 */
function moves(prev: readonly LayoutSection[], next: readonly LayoutSection[]): LayoutChange[] {
  const a = prev.filter((k) => next.includes(k));
  const b = next.filter((k) => prev.includes(k));
  const L: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  }
  const kept = new Set<LayoutSection>();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { kept.add(a[i]!); i++; j++; } else if (L[i + 1]![j]! >= L[i]![j + 1]!) i++; else j++;
  }
  return b.flatMap((k, i): LayoutChange[] => kept.has(k) ? [] : [{
    kind: "moved", key: k, above: b[i + 1] ?? null, below: b[i + 1] === undefined ? b[i - 1] ?? null : null,
  }]);
}

export function diffDefault(prev: DefaultBody, next: DefaultBody): LayoutChange[] {
  const out: LayoutChange[] = [];
  for (const r of next.sections) {
    const p = prev.sections.find((x) => x.key === r.key);
    if (p === undefined) continue;
    if (p.shown !== r.shown) out.push({ kind: r.shown ? "shown" : "hidden", key: r.key });
    if (p.mandatory !== r.mandatory) out.push({ kind: r.mandatory ? "mandatory" : "optional", key: r.key });
  }
  return [...out, ...moves(prev.sections.map((r) => r.key), next.sections.map((r) => r.key))];
}

export function diffOverlay(prev: OverlayBody, next: OverlayBody): LayoutChange[] {
  const out: LayoutChange[] = [];
  for (const k of next.order) {
    const was = prev.hidden.includes(k);
    const is = next.hidden.includes(k);
    if (was !== is) out.push({ kind: is ? "hidden" : "shown", key: k });
  }
  return [...out, ...moves(prev.order, next.order)];
}

/** The English line an audit row carries: "Examination set to mandatory", "Advice moved above Rx". */
export function describeChanges(changes: readonly LayoutChange[]): string {
  return changes.map((c) => {
    const n = named(c.key);
    switch (c.kind) {
      case "hidden": return `${n} hidden`;
      case "shown": return `${n} shown`;
      case "mandatory": return `${n} set to mandatory`;
      case "optional": return `${n} no longer mandatory`;
      case "moved": return c.above !== null ? `${n} moved above ${named(c.above)}` : c.below !== null ? `${n} moved below ${named(c.below)}` : `${n} moved`;
    }
    return n;
  }).join("; ");
}

// ——— the store ———

export type AuditRow = { version: number; by: string; byName: string; at: string; changes: LayoutChange[]; summary: string };
type LayoutRow = typeof opdConsultLayouts.$inferSelect;

async function departmentOf(db: Db | Tx, departmentId: string): Promise<{ id: string; name: string; catalog: LayoutSection[] }> {
  const [d] = await db.select({ id: opdDepartments.id, name: opdDepartments.name, code: opdDepartments.code })
    .from(opdDepartments).where(eq(opdDepartments.id, departmentId));
  if (d === undefined) throw new OpdError("unknown_department", `unknown department ${departmentId}`);
  const hasEye = (PROFILES[d.code]?.sections ?? []).some((k) => k.startsWith("eye."));
  return { id: d.id, name: d.name, catalog: catalogFor(hasEye) };
}

const scopeIs = (departmentId: string, doctorId: string | null) => and(
  eq(opdConsultLayouts.departmentId, departmentId),
  doctorId === null ? isNull(opdConsultLayouts.doctorId) : eq(opdConsultLayouts.doctorId, doctorId),
);

/** The scope's rows, oldest first. A department has a handful of versions; reading them all is the audit. */
async function scopeRows(db: Db | Tx, departmentId: string, doctorId: string | null): Promise<LayoutRow[]> {
  return db.select().from(opdConsultLayouts).where(scopeIs(departmentId, doctorId)).orderBy(opdConsultLayouts.version);
}

/** The row in force for a scope — the newest, or the newest at or before `asOf`. */
async function rowInForce(db: Db | Tx, departmentId: string, doctorId: string | null, asOf?: Date): Promise<LayoutRow | null> {
  const [r] = await db.select().from(opdConsultLayouts)
    .where(asOf === undefined ? scopeIs(departmentId, doctorId) : and(scopeIs(departmentId, doctorId), lte(opdConsultLayouts.createdAt, asOf)))
    .orderBy(desc(opdConsultLayouts.version)).limit(1);
  return r ?? null;
}

async function namesOf(db: Db | Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: users.id, fullName: users.fullName, username: users.username }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.fullName.trim() !== "" ? r.fullName : r.username]));
}

/** Newest first, each row diffed against the one before it (the first against the base it replaced). */
async function auditOf<B>(db: Db | Tx, rows: LayoutRow[], base: B, diff: (p: B, n: B) => LayoutChange[]): Promise<AuditRow[]> {
  const names = await namesOf(db, [...new Set(rows.map((r) => r.createdBy))]);
  let prev = base;
  const out: AuditRow[] = [];
  for (const r of rows) {
    const body = r.body as B;
    const changes = diff(prev, body);
    out.push({ version: r.version, by: r.createdBy, byName: names.get(r.createdBy) ?? r.createdBy, at: r.createdAt.toISOString(), changes, summary: describeChanges(changes) });
    prev = body;
  }
  return out.reverse();
}

async function insertVersion(db: Db | Tx, departmentId: string, doctorId: string | null, version: number, body: unknown, actor: Actor, now: Date): Promise<void> {
  try {
    await db.insert(opdConsultLayouts).values({ id: newId(), departmentId, doctorId, version, body: body as Record<string, unknown>, createdBy: actor.id, createdAt: now });
  } catch (e) {
    // The partial unique index: a concurrent save took this version number. Re-read and save again.
    if (String((e as { code?: unknown }).code ?? "") === "23505") throw new OpdError("layout_state_conflict", "the layout was saved concurrently; reload it");
    throw e;
  }
}

async function currentDefault(db: Db | Tx, departmentId: string, catalog: LayoutSection[]): Promise<{ row: LayoutRow | null; body: DefaultBody }> {
  const row = await rowInForce(db, departmentId, null);
  return { row, body: normalizeDefault(row === null ? baseDefault(catalog) : (row.body as DefaultBody), catalog) };
}

export type DepartmentLayoutView = {
  departmentId: string; departmentName: string; version: number | null;
  sections: (DefaultRow & { locked: boolean })[];
  audit: AuditRow[];
};

/** GET /opd/layouts/:departmentId — the admin's current default and its audit. */
export async function departmentLayout(db: Db | Tx, departmentId: string): Promise<DepartmentLayoutView> {
  const dept = await departmentOf(db, departmentId);
  const rows = await scopeRows(db, departmentId, null);
  const last = rows.at(-1);
  const body = normalizeDefault(last === undefined ? baseDefault(dept.catalog) : (last.body as DefaultBody), dept.catalog);
  return {
    departmentId, departmentName: dept.name, version: last?.version ?? null,
    sections: body.sections.map((r) => ({ ...r, locked: isLocked(r.key) })),
    audit: await auditOf<DefaultBody>(db, rows, baseDefault(dept.catalog), diffDefault),
  };
}

/** PUT /opd/layouts/:departmentId — a new version, or nothing at all when the body changes nothing. */
export async function saveDepartmentLayout(
  db: Db | Tx, actor: Actor, departmentId: string, input: { sections: { key: string; shown: boolean; mandatory: boolean }[] }, now: Date = new Date(),
): Promise<DepartmentLayoutView> {
  const dept = await departmentOf(db, departmentId);
  const next = validateDefault(input, dept.catalog);
  const cur = await currentDefault(db, departmentId, dept.catalog);
  if (!sameDefault(cur.body, next)) await insertVersion(db, departmentId, null, (cur.row?.version ?? 0) + 1, next, actor, now);
  return departmentLayout(db, departmentId);
}

export type MyLayoutView = {
  departmentId: string; departmentName: string; version: number | null; defaultVersion: number | null;
  /** Every section the admin shows, in this doctor's order; `hidden` is the doctor's own choice. */
  sections: { key: LayoutSection; mandatory: boolean; hidden: boolean }[];
  /** Sections the department layout hides — not on this doctor's screen and not theirs to show. */
  adminHidden: LayoutSection[];
  audit: AuditRow[];
};

async function myDoctor(db: Db | Tx, actor: Actor): Promise<{ id: string; departmentId: string }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "only a user actor has a layout");
  const doctor = await doctorForUser(db, actor.id);
  if (doctor === null) throw new OpdError("not_a_doctor", "no OPD doctor profile for this user");
  return { id: doctor.id, departmentId: doctor.departmentId };
}

/** GET /opd/me/layout — the actor's own overlay in their department, its bounds, and its audit. */
export async function myLayout(db: Db | Tx, actor: Actor): Promise<MyLayoutView> {
  const doctor = await myDoctor(db, actor);
  const dept = await departmentOf(db, doctor.departmentId);
  const def = await currentDefault(db, dept.id, dept.catalog);
  const rows = await scopeRows(db, dept.id, doctor.id);
  const last = rows.at(-1);
  const o = canonicalOverlay(last === undefined ? { order: [], hidden: [] } : (last.body as OverlayBody), def.body);
  const { shown, adminHidden } = boundsOf(def.body);
  return {
    departmentId: dept.id, departmentName: dept.name, version: last?.version ?? null, defaultVersion: def.row?.version ?? null,
    sections: o.order.map((k) => ({ key: k, mandatory: shown.find((s) => s.key === k)!.mandatory, hidden: o.hidden.includes(k) })),
    adminHidden,
    audit: await auditOf<OverlayBody>(db, rows, canonicalOverlay({ order: [], hidden: [] }, def.body), diffOverlay),
  };
}

/** PUT /opd/me/layout — the doctor's new overlay version, within the admin's bounds; an unchanged body writes nothing. */
export async function saveMyLayout(
  db: Db | Tx, actor: Actor, input: { order: string[]; hidden: string[] }, now: Date = new Date(),
): Promise<MyLayoutView> {
  const doctor = await myDoctor(db, actor);
  const dept = await departmentOf(db, doctor.departmentId);
  const def = await currentDefault(db, dept.id, dept.catalog);
  const next = validateOverlay(input, def.body, dept.catalog);
  const last = await rowInForce(db, dept.id, doctor.id);
  const cur = canonicalOverlay(last === null ? { order: [], hidden: [] } : (last.body as OverlayBody), def.body);
  if (!sameOverlay(cur, next)) await insertVersion(db, dept.id, doctor.id, (last?.version ?? 0) + 1, next, actor, now);
  return myLayout(db, actor);
}

/** The ids `startConsultation` stamps on the encounter: the default and the overlay in force now. */
export async function layoutStampFor(tx: Db | Tx, departmentId: string | null, doctorId: string | null): Promise<{ layoutDefaultId: string | null; layoutOverlayId: string | null }> {
  if (departmentId === null) return { layoutDefaultId: null, layoutOverlayId: null };
  const def = await rowInForce(tx, departmentId, null);
  const overlay = doctorId === null ? null : await rowInForce(tx, departmentId, doctorId);
  return { layoutDefaultId: def?.id ?? null, layoutOverlayId: overlay?.id ?? null };
}

export type VisitLayout = { sections: ResolvedSection[]; defaultVersion: number | null; overlayVersion: number | null };

async function rowById(db: Db | Tx, id: string): Promise<LayoutRow | null> {
  const [r] = await db.select().from(opdConsultLayouts).where(eq(opdConsultLayouts.id, id));
  return r ?? null;
}

/** The layout a visit's consult shows — the versions stamped at its start (see the header's DECIDED). */
export async function layoutForEncounter(db: Db | Tx, enc: EncounterRow): Promise<VisitLayout> {
  if (enc.departmentId === null) return { sections: resolveLayout(null, null, catalogFor(false)), defaultVersion: null, overlayVersion: null };
  const dept = await departmentOf(db, enc.departmentId);
  const started = enc.consultStartedAt ?? undefined;
  const pick = async (stamped: string | null, doctorId: string | null): Promise<LayoutRow | null> => {
    if (stamped !== null) return rowById(db, stamped);
    return rowInForce(db, enc.departmentId!, doctorId, started);
  };
  const def = await pick(enc.layoutDefaultId, null);
  const overlay = enc.doctorId === null ? null : await pick(enc.layoutOverlayId, enc.doctorId);
  return {
    sections: resolveLayout(def === null ? null : (def.body as DefaultBody), overlay === null ? null : (overlay.body as OverlayBody), dept.catalog),
    defaultVersion: def?.version ?? null, overlayVersion: overlay?.version ?? null,
  };
}

/** GET /opd/visits/:id/layout — visible exactly as the consult is (`visibleEncounterFor`: sealed patients, break-glass). */
export async function visitLayout(db: Db, actor: Actor, encounterId: string): Promise<VisitLayout> {
  const visible = await visibleEncounterFor(db, actor, encounterId);
  if (visible === null) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  return layoutForEncounter(db, visible.encounter);
}
