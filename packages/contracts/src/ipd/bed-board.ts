import { z } from "zod";
import { IpdBedClassSchema } from "../ipd-bed-classes";
import { IpdIdSchema, IpdInstantSchema } from "./common";
import { IpdWaitingCardSchema } from "./admissions";

/**
 * E1.1 (#718) — THE BEDS CAPACITY BOARD's read model (spec §4.9 A) and the bed routes. One shape for the web board,
 * the wall display and, later, the copilot. Counts follow the midnight-census rules (`IPD_BED_CLASS_INFO`): day-care
 * and emergency beds are outside the census, overflow beds are counted apart and never as normal capacity.
 *
 * Names never travel to a wall display: with `wall=1` the server sends initials only (`occupant.name` is null).
 */

/** What a tile says. `incumbent` = occupied by a patient of the old system at cutover (§4.1). Retired beds are not shown. */
export const IPD_BOARD_BED_STATUSES = ["occupied", "incumbent", "available", "reserved", "cleaning", "blocked"] as const;
export type IpdBoardBedStatus = (typeof IPD_BOARD_BED_STATUSES)[number];

export const IpdBoardCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  occupied: z.number().int().nonnegative(),
  incumbent: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  cleaning: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
});
export type IpdBoardCounts = z.infer<typeof IpdBoardCountsSchema>;

export const IpdBoardBedSchema = z.object({
  id: IpdIdSchema,
  code: z.string(),
  roomCode: z.string().nullable(),
  class: IpdBedClassSchema,
  genderRule: z.enum(["male", "female", "any", "paediatric"]),
  isolation: z.enum(["none", "contact", "droplet", "airborne"]),
  icu: z.boolean(),
  overflow: z.boolean(),
  /** Counted in the midnight census (not day care, not emergency, not overflow). */
  inCensus: z.boolean(),
  status: z.enum(IPD_BOARD_BED_STATUSES),
  /** When the bed entered its current status (occupancy start for an occupied bed). */
  since: IpdInstantSchema.nullable(),
  /** Initials always; the name only off the wall display and only when the viewer may read it (sealed → alias). */
  occupant: z.object({ initials: z.string(), name: z.string().nullable() }).nullable(),
  reservation: z.object({ id: IpdIdSchema, admissionId: IpdIdSchema, expiresAt: IpdInstantSchema }).nullable(),
  block: z.object({
    id: IpdIdSchema,
    reason: z.string(),
    note: z.string(),
    expectedReturnAt: IpdInstantSchema,
    /** A request on an occupied bed: the block applies when the bed is released. */
    onRelease: z.boolean(),
  }).nullable(),
});
export type IpdBoardBed = z.infer<typeof IpdBoardBedSchema>;

export const IpdBoardWardSchema = z.object({
  id: IpdIdSchema,
  code: z.string(),
  name: z.string(),
  kind: z.enum(["ward", "hall"]),
  department: z.string().nullable(),
  unitType: z.string().nullable(),
  /** False when no bed of the ward is in the census (a day-care or emergency unit): the tile says so. */
  inCensus: z.boolean(),
  counts: IpdBoardCountsSchema,
  beds: z.array(IpdBoardBedSchema),
});
export type IpdBoardWard = z.infer<typeof IpdBoardWardSchema>;

export const IpdBoardFloorSchema = z.object({
  id: IpdIdSchema,
  code: z.string(),
  name: z.string(),
  /** Census beds only. */
  census: z.object({ occupied: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  wards: z.array(IpdBoardWardSchema),
});
export type IpdBoardFloor = z.infer<typeof IpdBoardFloorSchema>;

const n = z.number().int().nonnegative();

export const IpdBedBoardSchema = z.object({
  asOf: IpdInstantSchema,
  wall: z.boolean(),
  totals: z.object({
    /** Census beds: occupied (incl. incumbent) / total. Overflow, day care and emergency are not in either number. */
    census: z.object({ occupied: n, total: n }),
    /** Free now (available, not reserved), census classes only. */
    free: n,
    freeByClass: z.record(z.string(), n),
    reserved: n,
    cleaning: n,
    cleaningOver60: n,
    blocked: n,
    blockedPastReturn: n,
    incumbent: n,
    overflow: z.object({ occupied: n, total: n }),
    outsideCensus: z.object({ occupied: n, total: n }),
    /** Beds released since IST midnight. Expected discharges come with ipd-discharge. */
    dischargesToday: n,
    /** Open admission requests (requested or reserved) — E1.2 fills it. */
    waiting: z.object({ count: n, longestMinutes: n.nullable() }),
  }),
  /** E1.2 — the requests waiting for a bed, oldest first (the left column). */
  waiting: z.array(IpdWaitingCardSchema),
  floors: z.array(IpdBoardFloorSchema),
  next24h: z.object({
    cleaningOver60: z.array(z.object({ bedId: IpdIdSchema, bedCode: z.string(), wardName: z.string(), minutes: n })),
    blockedPastReturn: z.array(z.object({
      bedId: IpdIdSchema, bedCode: z.string(), wardName: z.string(), expectedReturnAt: IpdInstantSchema,
    })),
  }),
});
export type IpdBedBoard = z.infer<typeof IpdBedBoardSchema>;

/** Cleaning longer than this is a blocker on the board (§4.9 A, right column). */
export const IPD_CLEANING_OVERDUE_MINUTES = 60;
/** A reservation holds a bed for this long, then lapses back on its own (§4.1). */
export const IPD_RESERVATION_HOLD_MINUTES = 120;

/** The realtime topic the board listens on; any bed act or registry change on a bed says "refetch". */
export const IPD_BEDS_TOPIC = "ipd_beds:board";

/** HTTP routes (under the api prefix). The body of each POST is the intent's own input contract. */
export const IPD_BED_ROUTES = {
  board: "/ipd/beds/board",
  reserve: "/ipd/beds/reserve",
  releaseReservation: "/ipd/beds/release-reservation",
  assign: "/ipd/beds/assign",
  block: "/ipd/beds/block",
  unblock: "/ipd/beds/unblock",
  clean: "/ipd/beds/clean",
  releaseIncumbent: "/ipd/beds/release-incumbent",
} as const;

/** The body every refused bed act answers with (HTTP 403/404/409). `bedRule` names the bed's rule, e.g. "Female-only bed". */
export type IpdRefusalBody = {
  statusCode: number;
  code: string;
  message: string;
  rule: string;
  fix: string;
  bedRule?: string;
  detail?: Record<string, unknown>;
};
