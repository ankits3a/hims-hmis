import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { resources } from "../../kernel/db/schema/resources";
import { AERB_UNLICENSABLE_MODALITIES, unlicensedDevices } from "../aerb";
import { DEVICE_MODALITY_ATTRIBUTE, DEVICE_PORTABLE_ATTRIBUTE, IMAGING_MODALITIES } from "./kinds";
import { DEVICE_AE_TITLE_ATTRIBUTE } from "./mwl";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS2b — **THE IMAGING MACHINES, AS A COUNTER PICKS THEM.**
 *
 * The reception screen booked a study by asking the receptionist to TYPE a device id — a ULID she
 * has no way to know. This read is what replaces that box: every machine the scheduler could book
 * onto, named the way the room is labelled, with the two facts that change what the counter does
 * next — whether it goes to a bed (`portable`), and whether an ionising machine is licensed today.
 *
 * ═══ WHAT IS LISTED — THE MACHINES THE SCHEDULER CAN MATCH, AND NOTHING ELSE ═══
 *
 *   · `kind = 'device'` only. A bed, a room or a bench is not an imaging machine, and a receptionist
 *     who could pick one would meet `device_unavailable` for a reason the list itself caused.
 *   · `attributes.modality` in `IMAGING_MODALITIES`. `assertDeviceBookable` matches that string
 *     EXACTLY against the study type's, so a device whose modality is outside the vocabulary (a
 *     future cath-lab C-arm, or a mis-cased `"CT"`) can never be booked — listing it would offer a
 *     choice that always refuses. The misconfigured machine is the AERB gap list's to show, and it
 *     does (`unlicensedDevices` includes an unrecognised modality on purpose).
 *   · `retired` is left out; `down`, `qa_blocked` and `maintenance` are LISTED with their status, so
 *     the counter sees the CT is down rather than wondering where it went.
 *
 * ═══ LICENSED-NOW IS THE AERB MODULE'S ANSWER, NOT A SECOND COPY OF IT ═══
 *
 * `ionising` and `licensedNow` come from `modules/aerb` through its index: the unlicensable list
 * (ultrasound, MRI) and the gap read. A screen, or this file, that re-derived either would be a
 * second copy of a regulatory rule. `licensedNow` is `null` for a machine AERB does not licence —
 * "not applicable" is a different fact from "not licensed", and a USG marked unlicensed would be a
 * false alarm on every row.
 *
 * No patient is read, so no PHI row is written.
 */
export type ImagingDeviceRow = {
  id: string;
  code: string;
  name: string;
  modality: string;
  /** The parent resource (a room) when the machine hangs off one; null for the seeded machines. */
  room: string | null;
  /** 18-S RS4 — the parent resource's id, so the Setup form can show which room is chosen. */
  roomId: string | null;
  /** 18-S RS4 — the DICOM AE title the modality pulls its worklist as; null = not a DICOM device yet. */
  aeTitle: string | null;
  /** `attributes.portable === true` — the machine can be taken to a bed. */
  portable: boolean;
  status: string;
  ionising: boolean;
  /** Ionising machines only: an active AERB licence covers `onDate`. `null` when AERB licenses none. */
  licensedNow: boolean | null;
};

const parent = alias(resources, "parent_resource");

/**
 * `opts.includeRetired` — 18-S RS4: the Setup station lists the whole register, retired machines
 * included (greyed), so a code that is taken is visibly taken. The counter's list never shows them.
 */
export async function imagingDevices(
  db: Db, onDate: string, opts: { includeRetired?: boolean } = {},
): Promise<ImagingDeviceRow[]> {
  const rows = await db.select({
    id: resources.id,
    code: resources.code,
    name: resources.name,
    status: resources.status,
    attributes: resources.attributes,
    parentName: parent.name,
    parentId: resources.parentId,
  })
    .from(resources)
    .leftJoin(parent, eq(parent.id, resources.parentId))
    .where(opts.includeRetired === true
      ? eq(resources.kind, "device")
      : and(eq(resources.kind, "device"), sql`${resources.status} <> 'retired'`))
    .orderBy(asc(resources.code));

  const unlicensed = new Set((await unlicensedDevices(db, onDate)).map((d) => d.deviceResourceId));
  const vocabulary: readonly string[] = IMAGING_MODALITIES;

  return rows.flatMap((r) => {
    const modality = r.attributes[DEVICE_MODALITY_ATTRIBUTE];
    if (typeof modality !== "string" || !vocabulary.includes(modality)) return [];
    const ionising = !AERB_UNLICENSABLE_MODALITIES.includes(modality);
    return [{
      id: r.id,
      code: r.code,
      name: r.name,
      modality,
      room: r.parentName,
      roomId: r.parentId,
      aeTitle: typeof r.attributes[DEVICE_AE_TITLE_ATTRIBUTE] === "string"
        ? r.attributes[DEVICE_AE_TITLE_ATTRIBUTE] as string : null,
      portable: r.attributes[DEVICE_PORTABLE_ATTRIBUTE] === true,
      status: r.status,
      ionising,
      licensedNow: ionising ? !unlicensed.has(r.id) : null,
    }];
  });
}
