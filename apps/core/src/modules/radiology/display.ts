import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { orderItems } from "../../kernel/db/schema/orders";
import { patients } from "../../kernel/db/schema/patients";
import { imagingDevices } from "./devices";
import { SCHEDULABLE_DEVICE_STATUSES } from "./kinds";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS3 — **THE IMAGING WAITING-HALL BOARD.** What the TV in the hall shows, per machine:
 * who is on the table NOW and the NEXT three who are here and waiting (checked in or ready, today,
 * STAT first, then by slot). It changes nothing — the desk and the rooms drive it.
 *
 * ═══ WHAT IT MAY SAY ABOUT A PERSON (DPDP) ═══
 *
 * The OPD board shows tokens only, because an OPD token is a number the patient holds. Imaging has
 * no separate token: the patient holds a slip with the ACCESSION on it, so the accession is the
 * token. Beside it the board shows the FIRST NAME and the INITIAL of the last name ("Asha D.") —
 * the owner's board and the plan both ask for it, because two patients hold near-identical slips
 * in a busy hall and a name is what a person listens for.
 *
 *   · A CONFIDENTIAL patient (`is_confidential`) or a RESTRICTED order is a token and nothing else.
 *     The alias is not shown either: an alias on a public TV announces that the person has one.
 *   · The study, the machine's findings, the referring doctor — none of them reach this read.
 *
 * **No PHI access row is written.** The OPD board writes none either; a TV polling every fifteen
 * seconds would write one row per patient per poll, and what it discloses is a first name and an
 * initial beside a token — the minimisation IS the control. Recorded as DECIDED in the plan.
 *
 * ═══ CLOSED ROOMS ═══
 *
 * A machine that is not bookable (`down`, `qa_blocked`, `maintenance`) is `closed: "down"`; an
 * ionising machine without an AERB licence today is `closed: "not_licensed"`. The screen turns
 * each into a Hindi + English notice ("rebooked — the desk will call you"), and shows no queue for
 * a closed room.
 */

export type HallEntry = { token: string; name: string | null };
export type HallRoom = {
  deviceResourceId: string;
  code: string;
  name: string;
  room: string | null;
  modality: string;
  closed: "down" | "not_licensed" | null;
  now: HallEntry | null;
  next: HallEntry[];
};
export type HallBoard = { day: string; rooms: HallRoom[] };

/** "Asha Devi" → "Asha D."; one word stays one word. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) return "";
  const first = parts[0]!;
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1]!;
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

const NEXT_SHOWN = 3;

export async function hallBoard(db: Db, now: Date = new Date()): Promise<HallBoard> {
  const day = istDayString(now);
  const dayStart = new Date(`${day}T00:00:00+05:30`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);

  const devices = await imagingDevices(db, day);
  const rows = devices.length === 0 ? [] : await db
    .select({
      deviceResourceId: imagingStudies.deviceResourceId,
      accessionNo: imagingStudies.accessionNo,
      status: imagingStudies.status,
      name: patients.name,
      isConfidential: patients.isConfidential,
      restricted: orderItems.restricted,
    })
    .from(imagingStudies)
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .where(and(
      inArray(imagingStudies.deviceResourceId, devices.map((d) => d.id)),
      inArray(imagingStudies.status, ["checked_in", "ready", "in_acquisition"]),
      gte(imagingStudies.scheduledAt, dayStart),
      lt(imagingStudies.scheduledAt, dayEnd),
    ))
    .orderBy(
      sql`case when ${imagingStudies.priority} = 'stat' then 0 when ${imagingStudies.priority} = 'urgent' then 1 else 2 end`,
      asc(imagingStudies.scheduledAt),
    );

  const entry = (r: (typeof rows)[number]): HallEntry => ({
    token: r.accessionNo,
    name: r.isConfidential || r.restricted ? null : shortName(r.name),
  });

  return {
    day,
    rooms: devices.map((d): HallRoom => {
      const closed = !SCHEDULABLE_DEVICE_STATUSES.includes(d.status)
        ? "down" as const
        : d.licensedNow === false ? "not_licensed" as const : null;
      const mine = closed === null ? rows.filter((r) => r.deviceResourceId === d.id) : [];
      const onTable = mine.find((r) => r.status === "in_acquisition");
      return {
        deviceResourceId: d.id, code: d.code, name: d.name, room: d.room, modality: d.modality, closed,
        now: onTable === undefined ? null : entry(onTable),
        next: mine.filter((r) => r.status !== "in_acquisition").slice(0, NEXT_SHOWN).map(entry),
      };
    }),
  };
}
