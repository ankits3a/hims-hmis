import { z } from "zod";
import {
  ErAgeBandSchema, ErArrivalModeSchema, ErEpisodeStateSchema, ErIdSchema, ErInstantSchema, ErPreAlertModeSchema, ErSexSchema,
} from "./common";

/**
 * ER lane 1 (#808) — THE TRACKING BOARD v1 AND THE ER DESK's read models (spec §5 A and C), the routes and the live topic.
 *
 * NO MONEY (decision 0058, spec §3.6): no amount, no paid/unpaid word, anywhere in these shapes — the contract test walks
 * every key. Names never travel to a wall display: with `wall=1` the server sends the alias of an unidentified patient
 * (an alias is not a name) or a named patient's initials only.
 */

/** Chips on a tile, each shown as a word (never colour alone). */
export const ER_TILE_CHIPS = ["unidentified", "returned_24h", "name_alert", "police", "ambulance", "paper"] as const;
export type ErTileChip = (typeof ER_TILE_CHIPS)[number];

export const ErTileSchema = z.object({
  episodeId: ErIdSchema,
  episodeNo: z.string(),
  /** Desktop: the name (or alias). Wall: the alias, or the initials of a named patient. */
  label: z.string(),
  /** Hindi alias of an unidentified patient; null otherwise. */
  labelHi: z.string().nullable(),
  /** Null on the wall display. */
  uhid: z.string().nullable(),
  sex: ErSexSchema,
  ageBand: ErAgeBandSchema.nullable(),
  /** Whole years from a recorded date of birth; null when only the band is known. */
  ageYears: z.number().int().nonnegative().nullable(),
  state: ErEpisodeStateSchema,
  /** Null on the wall display when the police brought the patient (MLC-sensitive; ER review 2026-10-15). */
  arrivalMode: ErArrivalModeSchema.nullable(),
  arrivedAt: ErInstantSchema,
  /** The door-to-triage clock (spec §3.2: ≤ 5 min) while the patient waits for triage; null after. */
  triageDueAt: ErInstantSchema.nullable(),
  chips: z.array(z.enum(ER_TILE_CHIPS)),
});
export type ErTile = z.infer<typeof ErTileSchema>;

export const ErExpectedCardSchema = z.object({
  preAlertId: ErIdSchema,
  /** Null on the wall display for a police call (MLC-sensitive; ER review 2026-10-15). */
  mode: ErPreAlertModeSchema.nullable(),
  expectedAt: ErInstantSchema,
  expiresAt: ErInstantSchema,
  count: z.number().int().positive(),
  arrivedCount: z.number().int().nonnegative(),
  sex: ErSexSchema.nullable(),
  ageBand: ErAgeBandSchema.nullable(),
  /** The call's complaint words; null on the wall display. */
  complaint: z.string().nullable(),
});
export type ErExpectedCard = z.infer<typeof ErExpectedCardSchema>;

export const ErBoardSchema = z.object({
  generatedAt: ErInstantSchema,
  wall: z.boolean(),
  stats: z.object({
    inDepartment: z.number().int().nonnegative(),
    waitingTriage: z.number().int().nonnegative(),
    /** The longest wait for triage, in whole minutes since the gate; null when nobody waits. */
    longestTriageWaitMinutes: z.number().int().nonnegative().nullable(),
    expected: z.number().int().nonnegative(),
    arrivalsToday: z.number().int().nonnegative(),
    broughtDeadToday: z.number().int().nonnegative(),
    /** Emergency-class beds in the bed registry: free (kernel `available`) of the total in service. */
    bays: z.object({ free: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  }),
  expected: z.array(ErExpectedCardSchema),
  /** Arrived, not yet triaged — longest wait first. */
  waiting: z.array(ErTileSchema),
  /** Triaged and beyond (lane 2 fills it: bays, ESI, doctor). */
  inTreatment: z.array(ErTileSchema),
});
export type ErBoard = z.infer<typeof ErBoardSchema>;

export const ErDeskRowSchema = z.object({
  episodeId: ErIdSchema,
  episodeNo: z.string(),
  patientId: ErIdSchema,
  uhid: z.string(),
  name: z.string(),
  nameHi: z.string().nullable(),
  unidentified: z.boolean(),
  sex: ErSexSchema,
  ageBand: ErAgeBandSchema.nullable(),
  ageYears: z.number().int().nonnegative().nullable(),
  state: ErEpisodeStateSchema,
  arrivalMode: ErArrivalModeSchema,
  arrivedAt: ErInstantSchema,
  registeredAt: ErInstantSchema,
  returnedWithin24h: z.boolean(),
  /** The live band, and whether it still prints the patient's current name (a merge or a name change makes it stale). */
  band: z.object({ serial: z.string(), stale: z.boolean() }).nullable(),
  /** The identity link filed for an unidentified patient: waiting for the approval, merged, or refused. */
  identity: z.object({
    mergeRequestId: ErIdSchema, stage: z.enum(["waiting", "granted", "merged", "refused"]), trueUhid: z.string(),
  }).nullable(),
});
export type ErDeskRow = z.infer<typeof ErDeskRowSchema>;

export const ErDeskViewSchema = z.object({
  generatedAt: ErInstantSchema,
  /** Every open episode and every episode that arrived in the last 24 hours, newest first. */
  episodes: z.array(ErDeskRowSchema),
  expected: z.array(ErExpectedCardSchema),
});
export type ErDeskView = z.infer<typeof ErDeskViewSchema>;

/** A patient the desk may pick (scan, UHID, phone or name). */
export const ErPatientHitSchema = z.object({
  patientId: ErIdSchema,
  uhid: z.string(),
  name: z.string(),
  sex: z.string(),
  ageYears: z.number().int().nonnegative().nullable(),
  /** The last four digits of the mobile, to tell two people of one name apart; null when none. */
  phoneTail: z.string().nullable(),
  unidentified: z.boolean(),
});
export type ErPatientHit = z.infer<typeof ErPatientHitSchema>;

/** A doctor the desk may name as the one who examined a body brought dead. */
export const ErDoctorOptionSchema = z.object({ userId: z.string(), name: z.string() });
export type ErDoctorOption = z.infer<typeof ErDoctorOptionSchema>;

export const ER_BOARD_TOPIC = "er:board";
/** ER review (2026-10-15) — the wall display's own channel, readable with `er.board.wall` (ids only, as the board's). */
export const ER_WALL_TOPIC = "erwall:board";

/** HTTP routes (under the api prefix). The body of each POST is the intent's own input contract. */
export const ER_ROUTES = {
  board: "/er/board",
  /** The wall display (`er.board.wall`): always wall mode. */
  boardWall: "/er/board/wall",
  desk: "/er/desk",
  patients: "/er/patients",
  doctors: "/er/doctors",
  preAlerts: "/er/pre-alerts",
  cancelPreAlert: "/er/pre-alerts/cancel",
  arrivals: "/er/arrivals",
  unidentified: "/er/arrivals/unidentified",
  broughtDead: "/er/arrivals/brought-dead",
  printBand: "/er/bands/print",
  reprintBand: "/er/bands/reprint",
  linkIdentity: "/er/identity/link",
} as const;
