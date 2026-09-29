import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { resources } from "../../kernel/db/schema/resources";
import {
  changeResourceStatus, createResource, moveResource, updateResource,
} from "../../kernel/resources/registry";
import { AERB_UNLICENSABLE_MODALITIES } from "../aerb";
import { RadiologyError } from "./errors";
import {
  DEVICE_MODALITY_ATTRIBUTE, DEVICE_PORTABLE_ATTRIBUTE, IMAGING_MODALITIES, RADIOLOGY_RESOURCE_KINDS,
} from "./kinds";
import { DEVICE_AE_TITLE_ATTRIBUTE } from "./mwl";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { ImagingModality } from "./kinds";

/**
 * PLAN 18-S RS4 T1 — **THE MACHINE REGISTER'S WRITE DOOR.**
 *
 * Until this file, `seed:radiology` was the only writer of an imaging device (`seed-radiology.ts`'s
 * header, "HOW A HOSPITAL ADDS A SECOND CT") and nothing anywhere could set an AE title — so the
 * modality worklist (`mwl.ts`) exported nothing, and a CT with a failed tube could be stopped only
 * by a QA failure in the AERB register. Three acts, one door:
 *
 *   · **register** a machine (code, name, modality, room, AE title, portable);
 *   · **edit** its description (name, code, room, AE title, portable) — never its modality;
 *   · **set its status** with a REQUIRED reason, and answer with the studies booked on it.
 *
 * ═══ NO KERNEL ROUTE — THE REGISTRY'S OWN WRITE SURFACE, CALLED FROM THE MODULE (spike a) ═══
 *
 * `kernel/resources` exposes its writers through its index and ships no write ROUTE on purpose
 * (DD14: "master writes for rooms keep going through OPD's routes, which delegate into the
 * registry"). OPD's rooms, the lab's instruments and the stores already follow that shape; this is
 * the fourth caller of it, and `kernel/**` is untouched. The registry writes the audit: every call
 * below appends `resource.registered` / `resource.updated` / `resource.status_changed` in the
 * caller's transaction, and every status move a `resource_status_history` row carrying the reason.
 *
 * ═══ THE AE TITLE IS STRICTER HERE THAN AT THE EXPORT, ON PURPOSE ═══
 *
 * `mwl.ts`'s `AE_TITLE_RE` is the PS3.5 repertoire the export can survive (spaces, punctuation).
 * Every modality console and every PACS in practice is configured in upper-case letters, digits
 * and underscore — and a title that differs only in case or a trailing space from what the console
 * sends is a worklist that silently matches nothing. So the WRITER admits the narrow form and the
 * READER keeps tolerating the wide one (a hand-set value from before this door stays exported).
 * Unique among imaging devices: two machines answering to one title would each pull the other's
 * patients.
 *
 * ═══ STATUS: WHAT THIS DOOR MAY SET, AND THE TWO IT MAY NOT LEAVE ═══
 *
 *   · `available`, `down`, `maintenance`, `qa_blocked`, `retired` — each with a reason.
 *   · `in_use` is NOT settable: it is the occupancy the acquisition writes (`assignResource`), and
 *     the kernel refuses a status move off an occupied machine (`already_occupied`) — a scan is on
 *     the table, and stopping it is a console decision, not a register one.
 *   · **Out of `qa_blocked` is refused** (`device_status_locked`). `aerb/qa.ts` says a passing QA
 *     record is *"the ONLY exit from qa_blocked in the whole tree, so the release condition IS the
 *     control"* — a Setup button that cleared it would be a second exit with no physicist behind
 *     it. INTO `qa_blocked` is allowed: stopping a machine is always fail-safe.
 *   · **Out of `retired` is refused.** DD2: retired means "no longer part of the hospital" and the
 *     row keeps its history. A machine that comes back is registered again under a new code.
 */

/** The permission the Setup station and every write below is guarded by (T1). */
export const RADIOLOGY_DEVICES_MANAGE = "radiology.devices.manage";

/** DICOM AE title as this hospital configures it: 1–16 of A–Z, 0–9 and underscore. */
export const DEVICE_AE_TITLE_RE = /^[A-Z0-9_]{1,16}$/;

/** The statuses a person may set at Setup. `in_use` belongs to the acquisition. */
export const SETTABLE_DEVICE_STATUSES = ["available", "down", "maintenance", "qa_blocked", "retired"] as const;
export type SettableDeviceStatus = (typeof SETTABLE_DEVICE_STATUSES)[number];

/** Statuses a person may not walk a machine OUT of at Setup — see the header. */
const LOCKED_FROM: Readonly<Record<string, string>> = {
  qa_blocked: "a QA block is lifted only by a passing QA record — the RSO records it under Radiation safety → QA",
  retired: "a retired machine stays retired and keeps its history — register the returning machine under a new code",
};

/** The study states a machine going out of service leaves stranded: booked and not yet on the table. */
export const BOOKED_STUDY_STATUSES = ["scheduled", "checked_in", "ready"] as const;

export type BookedStudyRow = {
  studyId: string;
  accessionNo: string;
  studyTypeCode: string;
  status: string;
  scheduledAt: string | null;
};

export type CreateImagingDeviceInput = {
  code: string;
  name: string;
  modality: string;
  roomId?: string | null;
  aeTitle?: string | null;
  portable?: boolean;
};

export type EditImagingDevicePatch = {
  code?: string;
  name?: string;
  roomId?: string | null;
  aeTitle?: string | null;
  portable?: boolean;
  /** Present only to be refused: a machine's modality is what its history was booked against. */
  modality?: string;
};

function requireUser(actor: Actor): void {
  if (actor.type !== "user") {
    throw new RadiologyError("user_actor_required", "the machine register is changed by a person");
  }
}

function requireText(field: string, value: string, max: number): string {
  const v = value.trim();
  if (v.length === 0 || v.length > max) {
    throw new RadiologyError("invalid_device", `${field} must be 1–${String(max)} characters`, { field });
  }
  return v;
}

/**
 * The AE title, normalised only by trimming. **Case is NOT folded**: `ct_1` refused tells the
 * person the console will send `CT_1`; silently upper-casing would store a title nobody typed.
 */
async function assertAeTitle(tx: Tx, aeTitle: string, selfId: string | null): Promise<string> {
  const v = aeTitle.trim();
  if (!DEVICE_AE_TITLE_RE.test(v)) {
    throw new RadiologyError(
      "invalid_ae_title",
      `"${aeTitle}" is not a DICOM AE title this department uses — 1 to 16 characters, capital letters `
      + "A–Z, digits and underscore only, exactly as it is set on the machine's console (e.g. CT_1)",
      { aeTitle },
    );
  }
  /**
   * Serialise AE-title writers: there is no unique index over a jsonb key, and two people
   * registering two machines at once must not both pass the check below. One transaction-scoped
   * advisory lock, released at commit, costs nothing on a register edited a few times a year.
   */
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('radiology.device.ae_title'))`);
  const clash = await tx.select({ code: resources.code, name: resources.name })
    .from(resources)
    .where(and(
      eq(resources.kind, "device"),
      sql`${resources.attributes} ->> ${DEVICE_AE_TITLE_ATTRIBUTE} = ${v}`,
      ...(selfId === null ? [] : [ne(resources.id, selfId)]),
    ));
  if (clash[0]) {
    throw new RadiologyError(
      "duplicate_ae_title",
      `AE title ${v} is already set on ${clash[0].code} (${clash[0].name}) — two machines answering to one `
      + "title would each pull the other's worklist",
      { aeTitle: v, code: clash[0].code },
    );
  }
  return v;
}

async function assertRoom(tx: Tx, roomId: string): Promise<void> {
  const rows = await tx.select({ kind: resources.kind, status: resources.status })
    .from(resources).where(eq(resources.id, roomId));
  const row = rows[0];
  if (!row || row.kind !== "room" || row.status === "retired") {
    throw new RadiologyError(
      "invalid_device",
      "the room chosen is not a room in service — a machine hangs in a room (or in none)",
      { roomId, kind: row?.kind ?? null },
    );
  }
}

type DeviceRecord = typeof resources.$inferSelect;

async function requireDevice(exec: Db | Tx, id: string): Promise<DeviceRecord> {
  const rows = await (exec as Db).select().from(resources).where(eq(resources.id, id));
  const row = rows[0];
  const modality = row?.attributes[DEVICE_MODALITY_ATTRIBUTE];
  if (!row || row.kind !== "device" || typeof modality !== "string"
    || !(IMAGING_MODALITIES as readonly string[]).includes(modality)) {
    throw new RadiologyError("unknown_device", "no imaging machine by that id — reload the machine list", { deviceResourceId: id });
  }
  return row;
}

/** True when AERB licenses this modality (X-ray, CT, mammography); USG and MRI are not ionising. */
export function isIonisingModality(modality: string): boolean {
  return !AERB_UNLICENSABLE_MODALITIES.includes(modality);
}

/** Registers an imaging machine. Returns the new resource id. */
export async function createImagingDevice(
  tx: Tx,
  actor: Actor,
  input: CreateImagingDeviceInput,
): Promise<{ deviceResourceId: string }> {
  requireUser(actor);
  const code = requireText("code", input.code, 32);
  const name = requireText("name", input.name, 120);
  if (!(IMAGING_MODALITIES as readonly string[]).includes(input.modality)) {
    throw new RadiologyError(
      "invalid_device",
      `"${input.modality}" is not a modality this department books — one of ${IMAGING_MODALITIES.join(", ")}`,
      { field: "modality" },
    );
  }
  const attributes: Record<string, unknown> = { [DEVICE_MODALITY_ATTRIBUTE]: input.modality as ImagingModality };
  if (input.portable === true) attributes[DEVICE_PORTABLE_ATTRIBUTE] = true;
  if (input.aeTitle !== undefined && input.aeTitle !== null && input.aeTitle.trim() !== "") {
    attributes[DEVICE_AE_TITLE_ATTRIBUTE] = await assertAeTitle(tx, input.aeTitle, null);
  }
  const roomId = input.roomId ?? null;
  if (roomId !== null) await assertRoom(tx, roomId);
  const { resourceId } = await createResource(tx, actor, RADIOLOGY_RESOURCE_KINDS, {
    kind: "device", code, name, parentId: roomId, attributes,
  });
  return { deviceResourceId: resourceId };
}

/**
 * Edits a machine's description. The attributes are MERGED onto what the row carries —
 * `updateResource` replaces the jsonb whole, and a keys-we-know rewrite would silently drop a key a
 * later phase (18b's PACS, RS6's console) put there.
 */
export async function editImagingDevice(
  tx: Tx,
  actor: Actor,
  id: string,
  patch: EditImagingDevicePatch,
): Promise<void> {
  requireUser(actor);
  const existing = await requireDevice(tx, id);
  if (patch.modality !== undefined && patch.modality !== existing.attributes[DEVICE_MODALITY_ATTRIBUTE]) {
    throw new RadiologyError(
      "invalid_device",
      `${existing.code} is a ${String(existing.attributes[DEVICE_MODALITY_ATTRIBUTE])} machine and its studies, `
      + "doses and licences were recorded against that — retire it and register the new machine instead",
      { field: "modality" },
    );
  }
  if (existing.status === "retired") {
    throw new RadiologyError("device_status_locked", `${existing.code} (${existing.name}) is retired — ${LOCKED_FROM.retired!}`);
  }

  const attributes: Record<string, unknown> = { ...existing.attributes };
  let attributesChanged = false;
  if (patch.aeTitle !== undefined) {
    const cleared = patch.aeTitle === null || patch.aeTitle.trim() === "";
    if (cleared) {
      if (DEVICE_AE_TITLE_ATTRIBUTE in attributes) {
        delete attributes[DEVICE_AE_TITLE_ATTRIBUTE];
        attributesChanged = true;
      }
    } else {
      const v = await assertAeTitle(tx, patch.aeTitle!, id);
      if (attributes[DEVICE_AE_TITLE_ATTRIBUTE] !== v) {
        attributes[DEVICE_AE_TITLE_ATTRIBUTE] = v;
        attributesChanged = true;
      }
    }
  }
  if (patch.portable !== undefined && (attributes[DEVICE_PORTABLE_ATTRIBUTE] === true) !== patch.portable) {
    if (patch.portable) attributes[DEVICE_PORTABLE_ATTRIBUTE] = true;
    else delete attributes[DEVICE_PORTABLE_ATTRIBUTE];
    attributesChanged = true;
  }

  const description: { name?: string; code?: string; attributes?: Record<string, unknown> } = {};
  if (patch.name !== undefined) {
    const name = requireText("name", patch.name, 120);
    if (name !== existing.name) description.name = name;
  }
  if (patch.code !== undefined) {
    const code = requireText("code", patch.code, 32);
    if (code !== existing.code) description.code = code;
  }
  if (attributesChanged) description.attributes = attributes;
  if (Object.keys(description).length > 0) {
    await updateResource(tx, actor, RADIOLOGY_RESOURCE_KINDS, id, description);
  }

  if (patch.roomId !== undefined && patch.roomId !== existing.parentId) {
    if (patch.roomId !== null) await assertRoom(tx, patch.roomId);
    await moveResource(tx, actor, RADIOLOGY_RESOURCE_KINDS, id, patch.roomId);
  }
}

/** The studies booked on a machine and not yet on the table, earliest slot first. No patient read. */
export async function bookedStudiesOn(exec: Db | Tx, deviceResourceId: string): Promise<BookedStudyRow[]> {
  const rows = await (exec as Db).select({
    studyId: imagingStudies.id,
    accessionNo: imagingStudies.accessionNo,
    studyTypeCode: imagingStudies.studyTypeCode,
    status: imagingStudies.status,
    scheduledAt: imagingStudies.scheduledAt,
  })
    .from(imagingStudies)
    .where(and(
      eq(imagingStudies.deviceResourceId, deviceResourceId),
      inArray(imagingStudies.status, [...BOOKED_STUDY_STATUSES]),
    ))
    .orderBy(asc(imagingStudies.scheduledAt), asc(imagingStudies.accessionNo));
  return rows.map((r) => ({ ...r, scheduledAt: r.scheduledAt?.toISOString() ?? null }));
}

/**
 * Sets a machine's status with a reason, and answers with what the desk must now move.
 *
 * `studiesToMove` is returned for EVERY out-of-service status and is empty for `available`: the
 * studies stay booked (moving them is the desk's decision — another machine, another day, or a
 * call to the patient), and the desk diary's downtime banner reads the same rows.
 */
export async function setImagingDeviceStatus(
  tx: Tx,
  actor: Actor,
  id: string,
  input: { status: string; reason: string },
): Promise<{ from: string; to: string; studiesToMove: BookedStudyRow[] }> {
  requireUser(actor);
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new RadiologyError(
      "reason_required",
      "say why the machine's status is changing — the reason is kept on the machine's history for the inspector and the engineer",
    );
  }
  if (reason.length > 500) {
    throw new RadiologyError("reason_required", "the reason must be 500 characters or fewer");
  }
  if (!(SETTABLE_DEVICE_STATUSES as readonly string[]).includes(input.status)) {
    throw new RadiologyError(
      "invalid_device",
      `"${input.status}" is not a status this register sets — one of ${SETTABLE_DEVICE_STATUSES.join(", ")}`,
      { field: "status" },
    );
  }
  const existing = await requireDevice(tx, id);
  const lock = LOCKED_FROM[existing.status];
  if (lock !== undefined && existing.status !== input.status) {
    throw new RadiologyError(
      "device_status_locked",
      `${existing.code} (${existing.name}) is ${existing.status} — ${lock}`,
      { deviceResourceId: id, status: existing.status },
    );
  }
  await changeResourceStatus(tx, actor, RADIOLOGY_RESOURCE_KINDS, id, input.status, { reason });
  const studiesToMove = input.status === "available" ? [] : await bookedStudiesOn(tx, id);
  return { from: existing.status, to: input.status, studiesToMove };
}
