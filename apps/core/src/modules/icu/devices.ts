import { and, asc, eq, isNull } from "drizzle-orm";
import { ICU_DEVICE_TYPES, icuLinkInput, icuUnlinkInput, newId } from "@hmis/contracts";
import { assignResource, releaseResource } from "../../kernel/resources";
import { icuDeviceLinks, icuLines, ipdAdmissions, ipdBedStays, resources } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { admissionForTransport, resolveBandScan } from "../ipd";
import { RADIOLOGY_RESOURCE_KINDS } from "../radiology";
import { ICU_SYSTEM, inTx, istDay, parse, requirePermission } from "./common";
import { IcuError } from "./errors";
import { icuDeviceLinked, icuDeviceUnlinked } from "./events";
import { ICU_CARE } from "./permissions";
import type { Actor, IcuDeviceDays, IcuDeviceType, IcuLinkEndReason } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984, D2) — DEVICE LINKS. The `device` resource kind is RADIOLOGY's (`modules/radiology/kinds.ts` declares it
 * for the whole hospital); ICU reuses it and never redeclares it: an ICU device is a `device` resource whose attributes
 * carry `icuType` (monitor | ventilator | pump) and the `serial` its maker's central station reports. A link puts the
 * device `in_use` with the admission as its occupant (the kernel's `assignResource`), so a device on one patient is
 * refused for another by the registry itself as well as by the link's partial unique index.
 *
 * A link is made ONLY from two scans — the device's asset label and the patient's wristband — and the bed is the bed the
 * band's admission lies on now (an ICU bed, or refused). One device of a type per bed. The device-day runs from the link
 * to the unlink, or to the stay's end (transfer, discharge, death): `reconcileLinks` closes a link whose stay ended at the
 * stay's own end instant, so a late sweep never lengthens a device-day.
 */

const OCCUPANT = "icu_admission";

type DeviceRow = typeof resources.$inferSelect;

async function deviceByScan(db: Db | Tx, scan: string): Promise<{ row: DeviceRow; type: IcuDeviceType; serial: string }> {
  const code = scan.trim();
  const row = (await (db as Db).select().from(resources).where(and(eq(resources.kind, "device"), eq(resources.code, code))))[0];
  if (row === undefined) throw new IcuError("unknown_device", { scan: code });
  const attrs = (row.attributes ?? {}) as { icuType?: string; serial?: string };
  if (!(ICU_DEVICE_TYPES as readonly string[]).includes(attrs.icuType ?? "")) throw new IcuError("not_icu_device", { code });
  return { row, type: attrs.icuType as IcuDeviceType, serial: attrs.serial ?? row.code };
}

export type LinkResult = { linkId: string; deviceId: string; deviceType: IcuDeviceType; bedId: string; admissionId: string; linkedAt: string };

export async function linkDevice(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<LinkResult> {
  const input = parse(icuLinkInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  const device = await deviceByScan(db, input.deviceScan);
  const band = await resolveBandScan(db, input.bandScan);
  if (band === null) throw new IcuError("unknown_band");
  if (!band.live) throw new IcuError("band_not_live");
  if (band.uhidMatches === false) throw new IcuError("band_mismatch");
  const facts = await admissionForTransport(db, band.admissionId);
  if (facts === null || facts.bedId === null || !facts.movable || !facts.criticalCareBed) throw new IcuError("not_on_icu_bed");
  const bedId = facts.bedId;
  const linkId = newId();
  try {
    await inTx(db, async (tx) => {
      const busy = (await tx.select().from(icuDeviceLinks).where(and(eq(icuDeviceLinks.deviceId, device.row.id), isNull(icuDeviceLinks.endedAt))))[0];
      if (busy !== undefined) throw new IcuError("device_busy", { admissionId: busy.admissionId });
      const same = (await tx.select().from(icuDeviceLinks)
        .where(and(eq(icuDeviceLinks.bedId, bedId), eq(icuDeviceLinks.deviceType, device.type), isNull(icuDeviceLinks.endedAt))))[0];
      if (same !== undefined) throw new IcuError("bed_has_type", { linkId: same.id });
      await tx.insert(icuDeviceLinks).values({
        id: linkId, deviceId: device.row.id, deviceType: device.type, bedId, admissionId: facts.admissionId, patientId: facts.patientId,
        linkedAt: now, linkedBy: actor.id,
      });
      await assignResource(tx, actor, RADIOLOGY_RESOURCE_KINDS, device.row.id, {
        occupantType: OCCUPANT, occupantRef: facts.admissionId, at: now, reason: "ICU device linked by scan",
      }).catch((e: unknown) => {
        if (e instanceof Error && "code" in e && (e as { code: string }).code === "already_occupied") throw new IcuError("device_busy");
        throw e;
      });
      await appendEvent(tx, icuDeviceLinked.make({
        payload: { linkId, deviceId: device.row.id, deviceType: device.type, bedId, admissionId: facts.admissionId },
        actor, correlationId: facts.admissionId, patientId: facts.patientId, occurredAt: now,
      }));
    });
  } catch (e) {
    // The partial unique indexes are the race guard: the loser reads as the refusal the winner caused.
    if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
      const msg = String((e as { constraint?: string }).constraint ?? e.message);
      throw new IcuError(msg.includes("bed_type") ? "bed_has_type" : "device_busy");
    }
    throw e;
  }
  return { linkId, deviceId: device.row.id, deviceType: device.type, bedId, admissionId: facts.admissionId, linkedAt: now.toISOString() };
}

/** Close one open link at `at` and give the device back (in the caller's transaction). */
async function endLink(tx: Tx, actor: Actor, link: typeof icuDeviceLinks.$inferSelect, reason: IcuLinkEndReason, at: Date): Promise<void> {
  const done = await tx.update(icuDeviceLinks).set({ endedAt: at, endedBy: actor.id, endReason: reason })
    .where(and(eq(icuDeviceLinks.id, link.id), isNull(icuDeviceLinks.endedAt))).returning({ id: icuDeviceLinks.id });
  if (done.length === 0) return;
  const dev = (await tx.select().from(resources).where(eq(resources.id, link.deviceId)).for("update"))[0];
  if (dev?.occupantType === OCCUPANT && dev.occupantRef === link.admissionId) {
    await releaseResource(tx, actor, RADIOLOGY_RESOURCE_KINDS, link.deviceId, { at, reason: `ICU link ended: ${reason}` });
  }
  await appendEvent(tx, icuDeviceUnlinked.make({
    payload: { linkId: link.id, deviceId: link.deviceId, admissionId: link.admissionId, reason },
    actor, correlationId: link.admissionId, patientId: link.patientId, occurredAt: at,
  }));
}

export async function unlinkDevice(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ linkId: string; endedAt: string }> {
  const input = parse(icuUnlinkInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  const device = await deviceByScan(db, input.deviceScan);
  return inTx(db, async (tx) => {
    const link = (await tx.select().from(icuDeviceLinks).where(and(eq(icuDeviceLinks.deviceId, device.row.id), isNull(icuDeviceLinks.endedAt))))[0];
    if (link === undefined) throw new IcuError("device_not_linked");
    await endLink(tx, actor, link, "unlinked", now);
    return { linkId: link.id, endedAt: now.toISOString() };
  });
}

/**
 * The sweep's half of D2: every open link whose admission no longer lies on the link's bed is closed AT THE STAY'S OWN END
 * (transfer → `transfer`, a death → `death`, any other exit → `discharge`). Idempotent; a tick with nothing to close reads
 * one join and writes nothing.
 */
export async function reconcileLinks(db: Db, now: Date = new Date()): Promise<number> {
  const open = await db.select().from(icuDeviceLinks).where(isNull(icuDeviceLinks.endedAt));
  let closed = 0;
  for (const link of open) {
    const stays = await db.select().from(ipdBedStays).where(eq(ipdBedStays.admissionId, link.admissionId)).orderBy(asc(ipdBedStays.startedAt));
    const onBed = stays.find((s) => s.bedId === link.bedId && s.endedAt === null);
    if (onBed !== undefined) continue;
    const a = (await db.select({ state: ipdAdmissions.state, endedAt: ipdAdmissions.endedAt }).from(ipdAdmissions).where(eq(ipdAdmissions.id, link.admissionId)))[0];
    const lastOnBed = stays.filter((s) => s.bedId === link.bedId && s.endedAt !== null).at(-1);
    const at = lastOnBed?.endedAt ?? a?.endedAt ?? now;
    const stillIn = stays.some((s) => s.endedAt === null);
    const reason: IcuLinkEndReason = stillIn ? "transfer" : a?.state === "deceased" ? "death" : "discharge";
    await inTx(db, (tx) => endLink(tx, ICU_SYSTEM, link, reason, at < link.linkedAt ? link.linkedAt : at));
    closed += 1;
  }
  return closed;
}

/** IST calendar days touched by [from, to] (inclusive): the device-day and line-day count. */
function daysTouched(from: Date, to: Date): number {
  if (to < from) return 0;
  const DAY = 86_400_000;
  const a = Date.parse(`${istDay(from)}T00:00:00+05:30`);
  const b = Date.parse(`${istDay(to)}T00:00:00+05:30`);
  return Math.round((b - a) / DAY) + 1;
}

/** Device-days, ventilator-days and line-days of one admission up to `asOf` (IC-1 counts; no charge lines — money is owed). */
export async function deviceDays(db: Db, admissionId: string, asOf: Date = new Date()): Promise<IcuDeviceDays> {
  const links = await db.select().from(icuDeviceLinks).where(eq(icuDeviceLinks.admissionId, admissionId));
  const lines = await db.select().from(icuLines).where(eq(icuLines.admissionId, admissionId));
  const count = (spans: { from: Date; to: Date | null }[]): number => {
    const days = new Set<string>();
    for (const s of spans) {
      const end = s.to === null || s.to > asOf ? asOf : s.to;
      const n = daysTouched(s.from, end);
      for (let i = 0; i < n; i += 1) days.add(istDay(new Date(s.from.getTime() + i * 86_400_000)));
      if (n > 0) days.add(istDay(end));
    }
    return days.size;
  };
  const ofType = (t: IcuDeviceType) => count(links.filter((l) => l.deviceType === t).map((l) => ({ from: l.linkedAt, to: l.endedAt })));
  const ofLine = (k: string) => count(lines.filter((l) => l.kind === k).map((l) => ({ from: l.insertedAt, to: l.removedAt })));
  return {
    ventilatorDays: ofType("ventilator"), monitorDays: ofType("monitor"), pumpDays: ofType("pump"),
    centralLineDays: ofLine("central_line"), arterialLineDays: ofLine("arterial_line"), catheterDays: ofLine("urinary_catheter"),
    endotrachealTubeDays: ofLine("endotracheal_tube"),
  };
}

/** The open links of an admission (the bed view). */
export async function openLinksOf(db: Db, admissionId: string) {
  return db.select({ link: icuDeviceLinks, code: resources.code, name: resources.name, attributes: resources.attributes })
    .from(icuDeviceLinks).innerJoin(resources, eq(resources.id, icuDeviceLinks.deviceId))
    .where(and(eq(icuDeviceLinks.admissionId, admissionId), isNull(icuDeviceLinks.endedAt)))
    .orderBy(asc(icuDeviceLinks.linkedAt));
}
