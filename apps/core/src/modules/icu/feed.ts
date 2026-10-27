import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import {
  ICU_CLOCK_SKEW_LIMIT_MS, ICU_FEED_STALE_MS, ICU_PARAMS, icuCodeInput, icuDeviceTypeOfParam, icuFeedBatchInput, icuGatewayInput,
  icuSlotInput, newId,
} from "@hmis/contracts";
import { recordHeartbeat, registerInterface } from "../../kernel/ops/interfaces";
import {
  icuDeviceLinks, icuFeedBatches, icuFeedGaps, icuGatewayCodes, icuGateways, icuNumerics, icuNumericsMinute, icuSlots, interfaces,
  resources,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { evaluateAdvisory, raiseAlarm } from "./alarms";
import { hallOfBed, inTx, parse, requirePermission } from "./common";
import { IcuError } from "./errors";
import { icuClockDriftFlagged } from "./events";
import { ensureNumericsPartitions } from "./partitions";
import { ICU_MANAGE } from "./permissions";
import type { Actor, IcuFeedResult, IcuParam } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984, D3, D7) — THE GATEWAY FEED (option A, decision 0090). One gateway per ICU hall turns the maker's
 * central-station HL7 (ORU^R01) into JSON batches (`tools/icu-gateway`) and posts them here with its agent key. A batch
 * is the gateway's heartbeat too (the kernel interface it is bound to, stale after 300 s → D7's grey-out).
 *
 * ATTRIBUTION IS THE WHOLE OF D3. A sample names a station slot; the slot names a bed; the bed's OPEN link of the
 * sample's device type AT THE OBSERVED INSTANT names the admission. No link then, or a device serial that is not the
 * linked device's (an unconfirmed device), and the row is stored with `link_id` null — kept for 72 hours, never charted,
 * never trended, never pre-filled. Rows are never re-attributed later (a link does not reach back).
 *
 * CLOCK. skew = received − sent. |skew| ≤ 120 s: observed = device time + skew. Otherwise the batch is flagged
 * `icu.clock_drift_flagged` and every sample takes the received time. An unmapped code or an unknown slot is
 * QUARANTINED (kept on the batch row for the code-map screen), never dropped. A replayed `batch_ref` answers the first
 * outcome and writes nothing.
 */

const STALE_AFTER_MS = ICU_FEED_STALE_MS;

export async function registerGateway(
  db: Db, actor: Actor, raw: unknown, now: Date = new Date(),
): Promise<{ gatewayId: string; interfaceId: string }> {
  const input = parse(icuGatewayInput, raw);
  await requirePermission(db, actor, ICU_MANAGE);
  const hall = (await db.select().from(resources).where(eq(resources.id, input.hallId)))[0];
  if (hall === undefined || hall.kind !== "ward") throw new IcuError("unknown_hall");
  const iface = await registerInterface(db, { kind: "other", name: `ICU gateway ${input.name}`, location: hall.name, staleAfterMs: STALE_AFTER_MS, agentId: input.agentId }, now);
  const gatewayId = newId();
  await db.insert(icuGateways).values({
    id: gatewayId, hallId: input.hallId, name: input.name, agentId: input.agentId, interfaceId: iface.id, createdBy: actor.id, createdAt: now,
  });
  return { gatewayId, interfaceId: iface.id };
}

async function requireGateway(db: Db | Tx, gatewayId: string) {
  const gw = (await (db as Db).select().from(icuGateways).where(eq(icuGateways.id, gatewayId)))[0];
  if (gw === undefined || !gw.active) throw new IcuError("unknown_gateway");
  return gw;
}

export async function mapSlot(db: Db, actor: Actor, raw: unknown): Promise<void> {
  const input = parse(icuSlotInput, raw);
  await requirePermission(db, actor, ICU_MANAGE);
  const gw = await requireGateway(db, input.gatewayId);
  const hall = await hallOfBed(db, input.bedId);
  if (hall === null || hall.hallId !== gw.hallId) throw new IcuError("unknown_bed");
  await db.transaction(async (tx) => {
    await tx.delete(icuSlots).where(or(eq(icuSlots.bedId, input.bedId), and(eq(icuSlots.gatewayId, gw.id), eq(icuSlots.slot, input.slot))));
    await tx.insert(icuSlots).values({ gatewayId: gw.id, slot: input.slot, bedId: input.bedId });
  });
}

export async function mapCode(db: Db, actor: Actor, raw: unknown): Promise<void> {
  const input = parse(icuCodeInput, raw);
  await requirePermission(db, actor, ICU_MANAGE);
  const gw = await requireGateway(db, input.gatewayId);
  await db.insert(icuGatewayCodes).values({ gatewayId: gw.id, code: input.code, param: input.param, unit: input.unit ?? null })
    .onConflictDoUpdate({ target: [icuGatewayCodes.gatewayId, icuGatewayCodes.code], set: { param: input.param, unit: input.unit ?? null } });
}

type OpenLink = { id: string; bedId: string; deviceType: string; admissionId: string; patientId: string; linkedAt: Date; endedAt: Date | null; serial: string };

/** The links on `bedIds` that were open at any instant in [from, to]. */
async function linksAround(tx: Tx, bedIds: string[], from: Date, to: Date): Promise<OpenLink[]> {
  if (bedIds.length === 0) return [];
  const rows = await tx.select({ l: icuDeviceLinks, code: resources.code, attributes: resources.attributes })
    .from(icuDeviceLinks).innerJoin(resources, eq(resources.id, icuDeviceLinks.deviceId))
    .where(and(inArray(icuDeviceLinks.bedId, bedIds), lte(icuDeviceLinks.linkedAt, to), or(isNull(icuDeviceLinks.endedAt), gt(icuDeviceLinks.endedAt, from))));
  return rows.map((r) => ({
    id: r.l.id, bedId: r.l.bedId, deviceType: r.l.deviceType, admissionId: r.l.admissionId, patientId: r.l.patientId,
    linkedAt: r.l.linkedAt, endedAt: r.l.endedAt, serial: ((r.attributes ?? {}) as { serial?: string }).serial ?? r.code,
  }));
}

function linkAt(links: OpenLink[], bedId: string, type: string, at: Date, serial: string | undefined): OpenLink | null {
  const l = links.find((x) => x.bedId === bedId && x.deviceType === type && x.linkedAt <= at && (x.endedAt === null || x.endedAt > at));
  if (l === undefined) return null;
  // An unconfirmed device: the station says another device sits on this slot.
  if (serial !== undefined && serial !== l.serial) return null;
  return l;
}

const minuteOf = (d: Date): Date => new Date(Math.floor(d.getTime() / 60_000) * 60_000);

export async function ingestBatch(db: Db, actor: Actor, gatewayId: string, raw: unknown, now: Date = new Date()): Promise<IcuFeedResult> {
  if (actor.type !== "agent") throw new IcuError("gateway_agent_only");
  const input = parse(icuFeedBatchInput, raw);
  const gw = await requireGateway(db, gatewayId);
  if (gw.agentId !== actor.id) throw new IcuError("gateway_agent_mismatch");
  await recordHeartbeat(db, actor, gw.interfaceId, now);

  const prior = (await db.select().from(icuFeedBatches).where(and(eq(icuFeedBatches.gatewayId, gw.id), eq(icuFeedBatches.batchRef, input.batchRef))))[0];
  if (prior !== undefined) {
    return { accepted: prior.outcome.accepted, quarantined: prior.outcome.quarantined, duplicate: true, serverTime: now.toISOString(), driftFlagged: prior.driftFlagged };
  }
  const skewMs = now.getTime() - Date.parse(input.sentAt);
  const drift = Math.abs(skewMs) > ICU_CLOCK_SKEW_LIMIT_MS;
  const observedOf = (deviceAt: string): Date => (drift ? now : new Date(Date.parse(deviceAt) + skewMs));

  const codes = new Map((await db.select().from(icuGatewayCodes).where(eq(icuGatewayCodes.gatewayId, gw.id))).map((c) => [c.code, c.param as IcuParam]));
  const slots = new Map((await db.select().from(icuSlots).where(eq(icuSlots.gatewayId, gw.id))).map((s) => [s.slot, s.bedId]));
  const instants = [...input.samples.map((s) => observedOf(s.at)), ...input.alarms.map((a) => observedOf(a.at))];
  if (input.samples.length > 0) await ensureNumericsPartitions(db, input.samples.map((s) => observedOf(s.at)));
  const from = new Date(Math.min(now.getTime(), ...instants.map((i) => i.getTime())));
  const to = new Date(Math.max(now.getTime(), ...instants.map((i) => i.getTime())));

  try {
    return await inTx(db, async (tx) => {
      const quarantine: { slot: string; code: string; why: string }[] = [];
      const links = await linksAround(tx, [...new Set(slots.values())], from, to);
      const rows: (typeof icuNumerics.$inferInsert)[] = [];
      for (const s of input.samples) {
        const param = codes.get(s.code);
        const bedId = slots.get(s.slot);
        if (param === undefined || !(ICU_PARAMS as readonly string[]).includes(param)) { quarantine.push({ slot: s.slot, code: s.code, why: "unmapped_code" }); continue; }
        if (bedId === undefined) { quarantine.push({ slot: s.slot, code: s.code, why: "unknown_slot" }); continue; }
        const observedAt = observedOf(s.at);
        const link = linkAt(links, bedId, icuDeviceTypeOfParam(param), observedAt, s.deviceSerial);
        rows.push({
          gatewayId: gw.id, slot: s.slot, bedId, linkId: link?.id ?? null, admissionId: link?.admissionId ?? null, param,
          value: s.technical !== undefined ? null : s.value, technical: s.technical ?? (s.value === null ? "no_value" : null),
          deviceAt: new Date(s.at), observedAt, receivedAt: now,
        });
      }
      if (rows.length > 0) await tx.insert(icuNumerics).values(rows);

      // One value per minute, kept with the record: the first attributed, real value of each minute.
      const minute = new Map<string, typeof icuNumericsMinute.$inferInsert>();
      for (const r of rows) {
        if (r.admissionId === null || r.admissionId === undefined || r.technical !== null || r.value === null || r.value === undefined) continue;
        const m = minuteOf(r.observedAt);
        const k = `${r.admissionId}|${r.param}|${String(m.getTime())}`;
        if (!minute.has(k)) minute.set(k, { admissionId: r.admissionId, param: r.param, minute: m, value: r.value });
      }
      if (minute.size > 0) await tx.insert(icuNumericsMinute).values([...minute.values()]).onConflictDoNothing();

      // Device alarms: onto the ladder of the admission linked on that bed (any linked device of the hall's slot).
      for (const a of input.alarms) {
        const bedId = slots.get(a.slot);
        const at = observedOf(a.at);
        const link = bedId === undefined ? null : linkAt(links, bedId, "monitor", at, a.deviceSerial) ?? linkAt(links, bedId, "ventilator", at, a.deviceSerial);
        if (bedId === undefined || link === null) { quarantine.push({ slot: a.slot, code: a.code ?? "alarm", why: "alarm_unattributed" }); continue; }
        const param = a.code === undefined ? null : codes.get(a.code) ?? null;
        await raiseAlarm(tx, { admissionId: link.admissionId, patientId: link.patientId, bedId, source: "device", severity: a.severity, param, message: a.message, at });
      }

      // Advisory alarms from the doctor's limits, per admission and parameter this batch touched.
      const touched = new Map<string, { bedId: string; params: Set<IcuParam>; latest: Map<IcuParam, Date>; patientId: string }>();
      for (const r of rows) {
        if (r.admissionId === null || r.admissionId === undefined || r.technical !== null) continue;
        const link = links.find((l) => l.id === r.linkId)!;
        const t = touched.get(r.admissionId) ?? { bedId: r.bedId!, params: new Set<IcuParam>(), latest: new Map<IcuParam, Date>(), patientId: link.patientId };
        const p = r.param as IcuParam;
        t.params.add(p);
        const prev = t.latest.get(p);
        if (prev === undefined || r.observedAt > prev) t.latest.set(p, r.observedAt);
        touched.set(r.admissionId, t);
      }
      for (const [admissionId, t] of touched) await evaluateAdvisory(tx, { admissionId, patientId: t.patientId, bedId: t.bedId, latest: t.latest });

      const accepted = rows.length;
      await tx.insert(icuFeedBatches).values({
        id: newId(), gatewayId: gw.id, batchRef: input.batchRef, sentAt: new Date(input.sentAt), receivedAt: now, skewMs, driftFlagged: drift,
        outcome: { accepted, quarantined: quarantine.length }, quarantine,
      });
      if (drift) {
        await appendEvent(tx, icuClockDriftFlagged.make({ payload: { gatewayId: gw.id, batchRef: input.batchRef, skewMs }, actor, correlationId: gw.id, occurredAt: now }));
      }
      return { accepted, duplicate: false, quarantined: quarantine.length, serverTime: now.toISOString(), driftFlagged: drift };
    });
  } catch (e) {
    // Two deliveries of one batch racing past the read: the loser answers the winner's outcome.
    if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
      const won = (await db.select().from(icuFeedBatches).where(and(eq(icuFeedBatches.gatewayId, gw.id), eq(icuFeedBatches.batchRef, input.batchRef))))[0];
      if (won !== undefined) return { accepted: won.outcome.accepted, quarantined: won.outcome.quarantined, duplicate: true, serverTime: now.toISOString(), driftFlagged: won.driftFlagged };
    }
    throw e;
  }
}

export type HallFeed = { gatewayId: string | null; grey: boolean; lastSeenAt: Date | null; gapSince: Date | null };

/**
 * D7 — the hall's feed state at `now`, read from the gateway's heartbeat (not from the sweep, so the station turns grey
 * the moment the five minutes pass): grey when the gateway was seen and not for more than 5 minutes, or the kernel
 * sweep has marked it down. A hall with no gateway, or one never seen, is manual and grey (nothing feeds it).
 */
export async function hallFeed(db: Db | Tx, hallId: string, now: Date): Promise<HallFeed> {
  const row = (await (db as Db).select({ gw: icuGateways, status: interfaces.status, lastSeenAt: interfaces.lastSeenAt })
    .from(icuGateways).innerJoin(interfaces, eq(interfaces.id, icuGateways.interfaceId))
    .where(and(eq(icuGateways.hallId, hallId), eq(icuGateways.active, true))))[0];
  if (row === undefined) return { gatewayId: null, grey: true, lastSeenAt: null, gapSince: null };
  const gap = (await (db as Db).select().from(icuFeedGaps).where(and(eq(icuFeedGaps.gatewayId, row.gw.id), isNull(icuFeedGaps.endedAt))))[0];
  const silent = row.lastSeenAt === null || now.getTime() - row.lastSeenAt.getTime() > STALE_AFTER_MS;
  return { gatewayId: row.gw.id, grey: silent || row.status === "down", lastSeenAt: row.lastSeenAt, gapSince: gap?.startedAt ?? (silent ? row.lastSeenAt : null) };
}
