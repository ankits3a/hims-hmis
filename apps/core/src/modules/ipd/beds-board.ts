import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { IPD_BED_CLASS_INFO, IPD_CLEANING_OVERDUE_MINUTES } from "@hmis/contracts";
import { ipdAdmissions, ipdBedBlocks, ipdBedReservations, ipdBedStays, ipdTransfers, resourceStatusHistory, resources } from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { getPatientSummaries } from "../patients";
import { IpdBedAttributesSchema, IpdWardAttributesSchema } from "./bed-attributes";
import type {
  IpdBedClass, IpdWaitingCard,
  Actor, IpdBedBoard, IpdBoardBed, IpdBoardBedStatus, IpdBoardCounts, IpdBoardFloor, IpdBoardWard,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E1.1 (#718) — THE CAPACITY BOARD's read (spec §4.9 A). One read of the whole hospital's places (~1,600 rows), the
 * live reservations, blocks and stays, and the patients' display names. Counts follow the midnight-census rules:
 * a bed is in the census when its class is (`IPD_BED_CLASS_INFO.inCensus`) and it is not an overflow bed; overflow
 * is counted apart and day care and emergency sit outside both. Retired beds are not shown.
 *
 * WALL MODE never puts a name on the wire: `occupant.name` is null and only initials travel (sealed and VIP
 * patients by their alias's initials, as `getPatientSummaries` restricts them).
 */


export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^[\p{L}]/u.test(w));
  return words.slice(0, 3).map((w) => `${w.charAt(0).toUpperCase()}.`).join(" ") || "—";
}

const byCode = (a: { code: string }, b: { code: string }): number => a.code.localeCompare(b.code, "en", { numeric: true });

function zero(): IpdBoardCounts {
  return { total: 0, occupied: 0, incumbent: 0, available: 0, reserved: 0, cleaning: 0, blocked: 0 };
}

function count(c: IpdBoardCounts, status: IpdBoardBedStatus): void {
  c.total += 1;
  c[status === "occupied" ? "occupied" : status] += 1;
}

export async function readBedBoard(db: Db, actor: Actor, opts: { wall?: boolean; now?: Date } = {}): Promise<IpdBedBoard> {
  const now = opts.now ?? new Date();
  const wall = opts.wall === true;
  const places = await db.select().from(resources)
    .where(and(inArray(resources.kind, ["floor", "ward", "hall", "room", "bed"]), ne(resources.status, "retired")));
  const byId = new Map(places.map((p) => [p.id, p]));
  const beds = places.filter((p) => p.kind === "bed" && IpdBedAttributesSchema.safeParse(p.attributes).success);
  const bedIds = beds.map((b) => b.id);

  const [reservations, blocks, stays] = bedIds.length === 0 ? [[], [], []] : await Promise.all([
    db.select().from(ipdBedReservations).where(eq(ipdBedReservations.status, "active")),
    db.select().from(ipdBedBlocks).where(inArray(ipdBedBlocks.status, ["pending_release", "active"])),
    db.select().from(ipdBedStays).where(isNull(ipdBedStays.endedAt)),
  ]);
  const resByBed = new Map(reservations.map((r) => [r.bedId, r]));
  const blockByBed = new Map(blocks.map((b) => [b.bedId, b]));
  const stayByBed = new Map(stays.map((s) => [s.bedId, s]));
  // E3.1 (#729): open transfers mark their origin (patient still here) and target (held) tiles.
  const transferOf = new Map<string, { transferId: string; role: "origin" | "target" }>();
  if (bedIds.length > 0) {
    for (const t of await db.select().from(ipdTransfers).where(eq(ipdTransfers.status, "open"))) {
      transferOf.set(t.fromBedId, { transferId: t.id, role: "origin" });
      transferOf.set(t.toBedId, { transferId: t.id, role: "target" });
    }
  }

  const summaries = await getPatientSummaries(db, actor, stays.map((s) => s.patientId));
  const nameOf = new Map(summaries.map((s) => [s.requestedId, s.name ?? s.alias ?? null]));

  // When did each cleaning or blocked bed enter its status? The latest history row into the current status.
  const waiting = beds.filter((b) => b.status === "cleaning" || b.status === "blocked").map((b) => b.id);
  const enteredAt = new Map<string, Date>();
  if (waiting.length > 0) {
    const rows = await db.selectDistinctOn([resourceStatusHistory.resourceId], {
      resourceId: resourceStatusHistory.resourceId, toStatus: resourceStatusHistory.toStatus, at: resourceStatusHistory.at,
    }).from(resourceStatusHistory)
      .where(inArray(resourceStatusHistory.resourceId, waiting))
      .orderBy(resourceStatusHistory.resourceId, desc(resourceStatusHistory.seq));
    for (const r of rows) enteredAt.set(r.resourceId, r.at);
  }

  const midnight = istDayWindow(now).start; // the hospital clock (ist-clock-parity), never a local copy
  const [released] = await db.select({ n: sql<number>`count(*)::int` }).from(resourceStatusHistory)
    .innerJoin(resources, eq(resources.id, resourceStatusHistory.resourceId))
    .where(and(
      eq(resources.kind, "bed"), eq(resourceStatusHistory.fromStatus, "occupied"), ne(resourceStatusHistory.toStatus, "occupied"),
      gte(resourceStatusHistory.at, midnight),
    ));

  const floors = new Map<string, IpdBoardFloor>();
  const wards = new Map<string, IpdBoardWard>();
  const totals: IpdBedBoard["totals"] = {
    census: { occupied: 0, total: 0 }, free: 0, freeByClass: {}, reserved: 0, cleaning: 0, cleaningOver60: 0,
    blocked: 0, blockedPastReturn: 0, incumbent: 0, overflow: { occupied: 0, total: 0 },
    outsideCensus: { occupied: 0, total: 0 }, dischargesToday: released?.n ?? 0, waiting: { count: 0, longestMinutes: null },
  };
  const next24h: IpdBedBoard["next24h"] = { cleaningOver60: [], blockedPastReturn: [] };

  for (const bed of beds) {
    const attrs = IpdBedAttributesSchema.parse(bed.attributes);
    // Walk up: bed → (room) → ward or hall → floor.
    let room: typeof bed | undefined;
    let ward: typeof bed | undefined;
    let floor: typeof bed | undefined;
    for (let cur = bed.parentId === null ? undefined : byId.get(bed.parentId), hops = 0; cur !== undefined && hops < 6; hops += 1) {
      if (cur.kind === "room" && room === undefined) room = cur;
      else if ((cur.kind === "ward" || cur.kind === "hall") && ward === undefined) ward = cur;
      else if (cur.kind === "floor") { floor = cur; break; }
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    if (ward === undefined || floor === undefined) continue; // not placed in a ward on a floor: not an IPD bed on the board

    const reservation = resByBed.get(bed.id);
    const block = blockByBed.get(bed.id);
    const incumbent = bed.attributes.incumbent === true && bed.occupantType === "incumbent";
    const status: IpdBoardBedStatus =
      incumbent ? "incumbent"
        : bed.occupantRef !== null ? "occupied"
          : bed.status === "blocked" ? "blocked"
            : reservation !== undefined ? "reserved"
              : bed.status === "cleaning" ? "cleaning" : "available";
    const since = status === "occupied" || status === "incumbent" ? bed.since
      : status === "reserved" ? reservation!.reservedAt
        : enteredAt.get(bed.id) ?? null;

    const stay = stayByBed.get(bed.id);
    const fullName = stay === undefined ? null : nameOf.get(stay.patientId) ?? null;
    const occupant = stay === undefined ? null : {
      initials: fullName === null ? "—" : initialsOf(fullName), name: wall ? null : fullName,
      ...(wall ? {} : { admissionId: stay.admissionId }), // E3.1: the drawer's Transfer panel opens it
    };
    const transfer = transferOf.get(bed.id);

    const overflow = attrs.overflow;
    const inCensus = IPD_BED_CLASS_INFO[attrs.class].inCensus && !overflow;
    const tile: IpdBoardBed = {
      id: bed.id, code: bed.code, roomCode: room?.code ?? null, class: attrs.class, genderRule: attrs.genderRule,
      isolation: attrs.isolation, icu: attrs.icu, overflow, inCensus, status,
      since: since === null ? null : since.toISOString(), occupant,
      reservation: reservation === undefined ? null
        : { id: reservation.id, admissionId: reservation.admissionId, expiresAt: reservation.expiresAt.toISOString() },
      block: block === undefined ? null : {
        id: block.id, reason: block.reason, note: wall ? "" : block.note,
        expectedReturnAt: block.expectedReturnAt.toISOString(), onRelease: block.status === "pending_release",
      },
      ...(transfer === undefined ? {} : { transfer }),
    };

    let f = floors.get(floor.id);
    if (f === undefined) {
      f = { id: floor.id, code: floor.code, name: floor.name, census: { occupied: 0, total: 0 }, wards: [] };
      floors.set(floor.id, f);
    }
    let w = wards.get(ward.id);
    if (w === undefined) {
      const wa = IpdWardAttributesSchema.safeParse(ward.attributes);
      w = {
        id: ward.id, code: ward.code, name: ward.name, kind: ward.kind === "hall" ? "hall" : "ward",
        department: wa.success ? wa.data.department : null, unitType: wa.success ? wa.data.unitType : null,
        inCensus: false, counts: zero(), beds: [],
      };
      wards.set(ward.id, w);
      f.wards.push(w);
    }
    w.beds.push(tile);
    count(w.counts, status);
    const isOccupied = status === "occupied" || status === "incumbent";
    if (inCensus) {
      w.inCensus = true;
      f.census.total += 1;
      totals.census.total += 1;
      if (isOccupied) { f.census.occupied += 1; totals.census.occupied += 1; }
      if (status === "available") {
        totals.free += 1;
        totals.freeByClass[attrs.class] = (totals.freeByClass[attrs.class] ?? 0) + 1;
      }
    } else if (overflow) {
      totals.overflow.total += 1;
      if (isOccupied) totals.overflow.occupied += 1;
    } else {
      totals.outsideCensus.total += 1;
      if (isOccupied) totals.outsideCensus.occupied += 1;
    }
    if (status === "reserved") totals.reserved += 1;
    if (status === "incumbent") totals.incumbent += 1;
    if (status === "cleaning") {
      totals.cleaning += 1;
      const minutes = since === null ? 0 : Math.floor((now.getTime() - since.getTime()) / 60_000);
      if (minutes > IPD_CLEANING_OVERDUE_MINUTES) {
        totals.cleaningOver60 += 1;
        next24h.cleaningOver60.push({ bedId: bed.id, bedCode: bed.code, wardName: ward.name, minutes });
      }
    }
    if (status === "blocked") {
      totals.blocked += 1;
      if (block !== undefined && block.status === "active" && block.expectedReturnAt.getTime() < now.getTime()) {
        totals.blockedPastReturn += 1;
        next24h.blockedPastReturn.push({
          bedId: bed.id, bedCode: bed.code, wardName: ward.name, expectedReturnAt: block.expectedReturnAt.toISOString(),
        });
      }
    }
  }

  const floorList = [...floors.values()].sort(byCode);
  for (const f of floorList) {
    f.wards.sort(byCode);
    for (const w of f.wards) w.beds.sort(byCode);
  }
  next24h.cleaningOver60.sort((a, b) => b.minutes - a.minutes);
  // E1.2 — the waiting column: open admission requests, oldest first (wall: initials only).
  const open = await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.state, ["requested", "reserved"]))
    .orderBy(asc(ipdAdmissions.requestedAt)).limit(100);
  const waitNames = new Map((await getPatientSummaries(db, actor, open.map((a) => a.patientId)))
    .map((p) => [p.requestedId, { name: p.restricted ? p.alias : p.name, uhid: p.uhid }] as const));
  const heldCode = new Map(reservations.map((r) => [r.admissionId, byId.get(r.bedId)?.code ?? null] as const));
  const waitingCards: IpdWaitingCard[] = open.map((a) => {
    const who = waitNames.get(a.patientId);
    return {
      admissionId: a.id, state: a.state as "requested" | "reserved", source: a.source as IpdWaitingCard["source"],
      initials: initialsOf(who?.name ?? who?.uhid ?? "?"), name: wall ? null : who?.name ?? null,
      requestedClass: a.requestedClass as IpdBedClass, isolation: a.isolation as IpdWaitingCard["isolation"], icu: a.icu,
      requestedAt: a.requestedAt.toISOString(),
      waitMinutes: Math.max(0, Math.floor((now.getTime() - a.requestedAt.getTime()) / 60_000)),
      reservedBedCode: heldCode.get(a.id) ?? null,
    };
  });
  totals.waiting = { count: waitingCards.length, longestMinutes: waitingCards.length === 0 ? null : Math.max(...waitingCards.map((w) => w.waitMinutes)) };
  return { asOf: now.toISOString(), wall, totals, waiting: waitingCards, floors: floorList, next24h };
}
