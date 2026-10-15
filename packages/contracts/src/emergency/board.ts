import { z } from "zod";
import { ErEwsSchema, ErEsiLevelSchema } from "./triage";
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
export const ER_TILE_CHIPS = [
  "unidentified", "returned_24h", "name_alert", "police", "ambulance", "paper",
  // lane 3 (#810): an open critical result, a specialty call waiting, stabilised (a clinical word only).
  "critical", "call_waiting", "stabilised",
  // lane 5 (#812): admitted, waiting on the ER board for the inpatient bed.
  "boarding",
] as const;
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
  /* ── lane 2 (#809): triage, the bay, the doctor and their clocks ── */
  esi: ErEsiLevelSchema.nullable(),
  /** The bay's code (an emergency-class bed of the registry); null until placed. */
  bayCode: z.string().nullable(),
  /** The ER doctor of record: the name on the desktop, initials on the wall; null until seen. */
  doctor: z.string().nullable(),
  /** Door-to-doctor target by ESI from the GATE (§3.2); null once a doctor has seen the patient or before triage. */
  doctorDueAt: ErInstantSchema.nullable(),
  /** The re-triage clock (until a doctor has seen the patient); null for ESI 1 and after the doctor. */
  retriageDueAt: ErInstantSchema.nullable(),
  /**
   * The last early-warning score (NEWS2 / MEOWS / PEWS), shown beside the level as a second signal. On the wall display
   * `kind` is null: the number and the band only (MEOWS would disclose a pregnancy; ER review 2026-10-15).
   */
  ews: ErEwsSchema.extend({ kind: ErEwsSchema.shape.kind.nullable() }).nullable(),
  /** Lane 7 (#814): the activation clocks running for this patient (from the door), the nearest first. */
  activations: z.array(z.object({ kind: z.string(), milestone: z.string(), dueAt: ErInstantSchema, metAt: ErInstantSchema.nullable() })).optional(),
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
  /** Lane 2 (E9): an OPD red flag's patient — the name on the desk, initials on the wall; null for a call. */
  patientId: ErIdSchema.nullable(),
  patientLabel: z.string().nullable(),
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
    /** Lane 5 (#812): admitted patients waiting in the ER for an inpatient bed, and left-without-being-seen today. */
    boarding: z.number().int().nonnegative(),
    lwbsToday: z.number().int().nonnegative(),
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
  // lane 2 (#809)
  triage: "/er/triage",
  reTriage: "/er/triage/again",
  vitals: "/er/vitals",
  placeInBay: "/er/bays/place",
  moveBay: "/er/bays/move",
  assignDoctor: "/er/doctor",
  bays: "/er/bays",
  episode: "/er/episodes",
  triageDoctors: "/er/triage-doctors",
  // lane 3 (#810)
  care: "/er/care",
  notes: "/er/notes",
  cosign: "/er/notes/cosign",
  orders: "/er/orders",
  items: "/er/items",
  issue: "/er/meds/issue",
  dose: "/er/meds/dose",
  signVerbal: "/er/meds/sign-verbal",
  procedures: "/er/procedures",
  consents: "/er/consents",
  calls: "/er/calls",
  answerCall: "/er/calls/answer",
  stabilised: "/er/stabilised",
} as const;

/** Lane 2 (#809) — a bay the triage screen may pick: an emergency-class bed of the registry, with who is in it. */
export const ErBaySchema = z.object({
  bedId: ErIdSchema,
  code: z.string(),
  /** The room or hall it hangs from ("Bay 1"). */
  zone: z.string().nullable(),
  status: z.enum(["free", "occupied", "cleaning", "blocked", "reserved"]),
  /** The ER episode in it (null when free or held by an inpatient admission). */
  episodeId: ErIdSchema.nullable(),
});
export type ErBay = z.infer<typeof ErBaySchema>;

/** Lane 2 (#809) — one episode as the triage screen opens it: the identity header and the triage so far. */
export const ErEpisodeViewSchema = z.object({
  tile: ErTileSchema,
  ageYears: z.number().int().nonnegative().nullable(),
  complaint: z.string().nullable(),
  /** Every triage, re-triage and vital set, newest first. */
  history: z.array(z.object({
    kind: z.enum(["triage", "re_triage", "vitals"]),
    level: ErEsiLevelSchema.nullable(),
    algorithmLevel: ErEsiLevelSchema.nullable(),
    reason: z.string().nullable(),
    ews: ErEwsSchema.nullable(),
    by: z.string(),
    at: ErInstantSchema,
  })),
});
export type ErEpisodeView = z.infer<typeof ErEpisodeViewSchema>;

/** Lane 3 (#810) — the ER doctor's and nurse's view of one episode's care. No money anywhere (0058). */
export const ErCareViewSchema = z.object({
  episodeId: ErIdSchema,
  stabilisedAt: ErInstantSchema.nullable(),
  /** "Allergy: Penicillin (severe)", "Allergy: unknown" (unidentified), "Allergy: none recorded". */
  allergyWords: z.array(z.string()),
  notes: z.array(z.object({
    noteId: ErIdSchema, kind: z.string(), text: z.string(), author: z.string(), at: ErInstantSchema,
    status: z.enum(["signed", "draft"]), cosignedBy: z.string().nullable(),
  })),
  orders: z.array(z.object({ orderId: ErIdSchema, kind: z.string(), priority: z.string().nullable(), tests: z.array(z.string()), at: ErInstantSchema })),
  meds: z.array(z.object({
    issueId: ErIdSchema, name: z.string(), doseWords: z.string(), route: z.string(), units: z.number().int(), highAlert: z.boolean(),
    own: z.boolean(), orderedBy: z.string(), verbalPending: z.boolean(), at: ErInstantSchema,
    dose: z.object({ outcome: z.enum(["given", "held", "refused"]), at: ErInstantSchema, by: z.string(), reason: z.string().nullable() }).nullable(),
  })),
  procedures: z.array(z.object({ procedureId: ErIdSchema, name: z.string(), by: z.string(), at: ErInstantSchema })),
  consents: z.array(z.object({ consentId: ErIdSchema, kind: z.string(), about: z.string(), signedBy: z.string(), at: ErInstantSchema })),
  calls: z.array(z.object({
    callId: ErIdSchema, departmentCode: z.string(), urgency: z.string(), reason: z.string(), calledAt: ErInstantSchema,
    answeredAt: ErInstantSchema.nullable(), seenAt: ErInstantSchema.nullable(), callees: z.array(z.string()),
  })),
  /** Open critical results for this episode (from the lab's call ladder), and whether the read-back closed them. */
  criticals: z.array(z.object({ callId: z.string(), analyte: z.string(), value: z.string(), unit: z.string().nullable(), openedAt: ErInstantSchema })),
});
export type ErCareView = z.infer<typeof ErCareViewSchema>;

/** Lane 3 — an ER store item the nurse may issue (no price: the issue screen is clinical). */
export const ErItemOptionSchema = z.object({ itemId: ErIdSchema, name: z.string(), highAlert: z.boolean(), lasa: z.boolean(), onHand: z.number() });
export type ErItemOption = z.infer<typeof ErItemOptionSchema>;
