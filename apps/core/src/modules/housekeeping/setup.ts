import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  HK_IN_HOUSE, HK_PHOTO_BY_CLASS, HK_SKILLS, addContractorInput, areaRefInput, defineAreaInput, newId, saveChecklistInput, setHkStaffInput,
} from "@hmis/contracts";
import { hmacSign, hmacVerify } from "../../kernel/crypto";
import { withTx } from "../../kernel/db/client";
import { hkAreas, hkChecklists, hkContractors, hkStaff, resources, users } from "../../kernel/db/schema";
import { HousekeepingRefusal } from "./errors";
import { HOUSEKEEPING_SKILL } from "./names";
import { ancestry, floorIn } from "./places";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { skillRoles } from "../tasks";
import type { Actor, HkAreaClass, HkAreaView, HkChecklistView, HkContractorView, HkSetupView, HkSkill, HkStaffView } from "@hmis/contracts";
import type { z } from "zod";
import type { Db } from "../../kernel/db/client";
import type { AreaRow, Exec } from "./places";

/**
 * HK-1 (#973, decision 0086) — SETUP: checklists, areas with a class and a door QR, contractors and staff. The door QR is
 * `a1.<areaId>.<qrVersion>.<hmac>` under the server key: it names the area and nothing else, and revoking it (a reprint)
 * bumps the version so the old print stops working. A QR alone is weak proof (a photo of it passes); the photo and the
 * signed-in person are the evidence (plan, "QR as proof").
 */
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new HousekeepingRefusal("bad_input", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return r.data;
}

/** The kinds of place housekeeping looks after. Toilets are `room` resources and public spaces `hall` (plan). */
const AREA_PLACE_KINDS = ["floor", "ward", "room", "hall", "bed"];

function checklistView(r: typeof hkChecklists.$inferSelect): HkChecklistView {
  return { id: r.id, lineageId: r.lineageId, version: r.version, name: r.name, items: r.items };
}

export async function saveChecklist(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<HkChecklistView> {
  const input = parse(saveChecklistInput, raw);
  return withTx(db, async (tx) => {
    let lineageId = newId();
    let version = 1;
    if (input.lineageId !== undefined) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hk:checklist:${input.lineageId}`}))`);
      const prev = (await tx.select().from(hkChecklists).where(eq(hkChecklists.lineageId, input.lineageId))
        .orderBy(desc(hkChecklists.version)).limit(1))[0];
      if (prev === undefined) throw new HousekeepingRefusal("unknown_checklist", { lineageId: input.lineageId });
      lineageId = prev.lineageId;
      version = prev.version + 1;
    }
    const row = (await tx.insert(hkChecklists).values({
      id: newId(), lineageId, version, name: input.name, items: input.items.map((i) => ({ id: newId(), text: i.text })),
      createdBy: actor.id, createdAt: now,
    }).returning())[0]!;
    // Areas on an older version of this checklist move to the new one; their past work keeps the version it answered.
    if (version > 1) {
      const older = (await tx.select({ id: hkChecklists.id }).from(hkChecklists).where(eq(hkChecklists.lineageId, lineageId))).map((r) => r.id)
        .filter((id) => id !== row.id);
      if (older.length > 0) {
        await tx.update(hkAreas).set({ checklistId: row.id, updatedBy: actor.id, updatedAt: now }).where(inArray(hkAreas.checklistId, older));
      }
    }
    return checklistView(row);
  });
}

/** Give a place a class (and a checklist, and whether a photo is needed). Again on the same place updates it. */
export async function defineArea(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<AreaRow> {
  const input = parse(defineAreaInput, raw);
  return withTx(db, async (tx) => {
    const chain = await ancestry(tx, input.resourceId);
    const place = chain[0];
    if (place === undefined || !AREA_PLACE_KINDS.includes(place.kind)) throw new HousekeepingRefusal("not_a_place", { resourceId: input.resourceId });
    const checklistId = input.checklistId ?? null;
    if (checklistId !== null && (await tx.select({ id: hkChecklists.id }).from(hkChecklists).where(eq(hkChecklists.id, checklistId))).length === 0) {
      throw new HousekeepingRefusal("unknown_checklist", { checklistId });
    }
    const values = {
      areaClass: input.areaClass, floorId: floorIn(chain), checklistId,
      photoNeeded: input.photoNeeded ?? HK_PHOTO_BY_CLASS[input.areaClass], active: true, updatedBy: actor.id, updatedAt: now,
    };
    return (await tx.insert(hkAreas).values({ id: newId(), resourceId: input.resourceId, ...values })
      .onConflictDoUpdate({ target: hkAreas.resourceId, set: values }).returning())[0]!;
  });
}

const QR_PREFIX = "a1";

/** The door QR's text for an area at its current version. */
export async function areaQrToken(exec: Exec, key: Buffer, areaId: string): Promise<string> {
  const area = (await (exec as Db).select().from(hkAreas).where(eq(hkAreas.id, areaId)))[0];
  if (area === undefined) throw new HousekeepingRefusal("unknown_area", { areaId });
  const body = `${QR_PREFIX}.${area.id}.${String(area.qrVersion)}`;
  return `${body}.${hmacSign(key, body)}`;
}

/** The area a scanned door QR names, if it is genuine, current and active; else `bad_qr`. */
export async function readQrToken(exec: Exec, key: Buffer, token: string): Promise<AreaRow> {
  const parts = token.trim().split(".");
  if (parts.length !== 4 || parts[0] !== QR_PREFIX) throw new HousekeepingRefusal("bad_qr", {});
  const [, areaId, version, sig] = parts as [string, string, string, string];
  if (!hmacVerify(key, `${QR_PREFIX}.${areaId}.${version}`, sig)) throw new HousekeepingRefusal("bad_qr", {});
  const area = (await (exec as Db).select().from(hkAreas).where(eq(hkAreas.id, areaId)))[0];
  if (area === undefined || !area.active || String(area.qrVersion) !== version) throw new HousekeepingRefusal("bad_qr", { areaId });
  return area;
}

/** A reprint: the old door QR stops working. */
export async function revokeAreaQr(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<AreaRow> {
  const input = parse(areaRefInput, raw);
  const row = (await db.update(hkAreas).set({ qrVersion: sql`${hkAreas.qrVersion} + 1`, updatedBy: actor.id, updatedAt: now })
    .where(eq(hkAreas.id, input.areaId)).returning())[0];
  if (row === undefined) throw new HousekeepingRefusal("unknown_area", { areaId: input.areaId });
  return row;
}

export async function addContractor(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<HkContractorView> {
  const input = parse(addContractorInput, raw);
  const row = (await db.insert(hkContractors).values({ id: newId(), name: input.name, createdBy: actor.id, createdAt: now })
    .onConflictDoNothing().returning())[0];
  if (row === undefined) throw new HousekeepingRefusal("contractor_exists", { name: input.name });
  return { id: row.id, name: row.name };
}

/** In-house (no contractor) or a contractor's person, and their trained skills. */
export async function setHkStaff(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<void> {
  const input = parse(setHkStaffInput, raw);
  const person = (await db.select({ active: users.active }).from(users).where(eq(users.id, input.userId)))[0];
  if (person === undefined || !person.active) throw new HousekeepingRefusal("unknown_person", { userId: input.userId });
  if (input.contractorId !== null
    && (await db.select({ id: hkContractors.id }).from(hkContractors).where(and(eq(hkContractors.id, input.contractorId), eq(hkContractors.active, true)))).length === 0) {
    throw new HousekeepingRefusal("unknown_contractor", { contractorId: input.contractorId });
  }
  const skills = HK_SKILLS.filter((s) => input.skills.includes(s));
  const values = { contractorId: input.contractorId, skills, updatedBy: actor.id, updatedAt: now };
  await db.insert(hkStaff).values({ userId: input.userId, ...values }).onConflictDoUpdate({ target: hkStaff.userId, set: values });
}

/** Each person's company (the contractor's name, or In-house) and trained skills. People without a row are in-house. */
export async function staffFacts(exec: Exec, userIds: readonly string[]): Promise<Map<string, { company: string; contractorId: string | null; skills: HkSkill[] }>> {
  const out = new Map<string, { company: string; contractorId: string | null; skills: HkSkill[] }>();
  if (userIds.length === 0) return out;
  const rows = await (exec as Db).select({ userId: hkStaff.userId, contractorId: hkStaff.contractorId, skills: hkStaff.skills, name: hkContractors.name })
    .from(hkStaff).leftJoin(hkContractors, eq(hkContractors.id, hkStaff.contractorId)).where(inArray(hkStaff.userId, [...userIds]));
  for (const r of rows) out.set(r.userId, { company: r.name ?? HK_IN_HOUSE, contractorId: r.contractorId, skills: r.skills as HkSkill[] });
  return out;
}

/** The setup page: areas, checklists (newest version of each), contractors, staff, and the places that may be areas. */
export async function setupView(db: Db): Promise<HkSetupView> {
  const areaRows = await db.select({ a: hkAreas, name: resources.name, code: resources.code, kind: resources.kind })
    .from(hkAreas).innerJoin(resources, eq(resources.id, hkAreas.resourceId)).where(eq(hkAreas.active, true)).orderBy(asc(resources.code));
  const placeRows = await db.select({ id: resources.id, name: resources.name, code: resources.code, kind: resources.kind, parentId: resources.parentId })
    .from(resources).where(inArray(resources.kind, ["floor", "ward", "room", "hall"])).orderBy(asc(resources.code)).limit(2000);
  const bedRows = await db.select({ id: resources.id, code: resources.code, parentId: resources.parentId })
    .from(resources).where(eq(resources.kind, "bed")).orderBy(asc(resources.code)).limit(2000);
  const floorNames = new Map(placeRows.filter((p) => p.kind === "floor").map((p) => [p.id, p.name]));
  const parentOf = new Map(placeRows.map((p) => [p.id, p.parentId]));
  const floorOf = (id: string): string | null => {
    let cur: string | null | undefined = id;
    for (let i = 0; i < 8 && cur; i += 1) { if (floorNames.has(cur)) return cur; cur = parentOf.get(cur); }
    return null;
  };
  const roleHolders = new Set<string>();
  for (const role of skillRoles(HOUSEKEEPING_SKILL)) for (const u of await db.transaction((t) => usersHoldingRole(t, role))) roleHolders.add(u);
  const peopleRows = roleHolders.size === 0 ? [] : await db.select({ userId: users.id, name: users.fullName }).from(users)
    .where(and(inArray(users.id, [...roleHolders]), eq(users.active, true)));
  const peopleFacts = await staffFacts(db, peopleRows.map((p) => p.userId));
  const areas: HkAreaView[] = areaRows.map(({ a, name, code, kind }) => ({
    id: a.id, resourceId: a.resourceId, name, code, kind, areaClass: a.areaClass as HkAreaClass, floorId: a.floorId,
    floorName: a.floorId === null ? null : floorNames.get(a.floorId) ?? null, checklistId: a.checklistId,
    photoNeeded: a.photoNeeded, qrVersion: a.qrVersion,
  }));
  const lists = await db.select().from(hkChecklists).orderBy(asc(hkChecklists.name), desc(hkChecklists.version));
  const newest = new Map<string, typeof lists[number]>();
  for (const l of lists) if (!newest.has(l.lineageId)) newest.set(l.lineageId, l);
  const contractors = await db.select({ id: hkContractors.id, name: hkContractors.name }).from(hkContractors)
    .where(eq(hkContractors.active, true)).orderBy(asc(hkContractors.name));
  const staffRows = await db.select({ userId: hkStaff.userId, name: users.fullName }).from(hkStaff).innerJoin(users, eq(users.id, hkStaff.userId));
  const facts = await staffFacts(db, staffRows.map((s) => s.userId));
  const staff: HkStaffView[] = staffRows.map((s) => {
    const f = facts.get(s.userId);
    return { userId: s.userId, name: s.name, contractorId: f?.contractorId ?? null, company: f?.company ?? HK_IN_HOUSE, skills: f?.skills ?? [] };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    areas, checklists: [...newest.values()].map(checklistView), contractors, staff,
    places: placeRows.map((p) => {
      const f = floorOf(p.id);
      return { id: p.id, name: p.name, code: p.code, kind: p.kind, floorName: f === null ? null : floorNames.get(f) ?? null };
    }),
    beds: bedRows.map((b) => {
      const f = b.parentId === null ? null : floorOf(b.parentId);
      return { id: b.id, code: b.code, floorId: f, floorName: f === null ? null : floorNames.get(f) ?? null };
    }),
    people: peopleRows.map((p) => {
      const f = peopleFacts.get(p.userId);
      return { userId: p.userId, name: p.name, company: f?.company ?? HK_IN_HOUSE, skills: f?.skills ?? [] };
    }).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
