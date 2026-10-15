import { ApiError, api } from "./api";
import type { ErBoard, ErDeskView, ErDoctorOption, ErPatientHit, ErRefusalBody } from "@hmis/contracts";

/* ═══ ER lane 1 (#808) — `apps/core/src/modules/emergency/emergency.controller.ts`. The paths are the contract's
 * `ER_ROUTES` and the topic its `ER_BOARD_TOPIC`, copied: the web bundle imports the contract package for TYPES only. ═══ */
const ER_ROUTES = {
  board: "/er/board",
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
export const ER_BOARD_TOPIC = "er:board";
export const ER_WALL_TOPIC = "erwall:board";

/** The contract's value lists, copied for the same reason (`packages/contracts/src/emergency/common.ts`). */
export const ER_SEXES = ["male", "female", "other", "unknown"] as const;
export const ER_AGE_BANDS = ["infant", "child", "teen", "young_adult", "adult", "elderly"] as const;
export const ER_ARRIVAL_MODES = ["walk_in", "private_vehicle", "ambulance_108", "own_ambulance", "police", "referred_in", "inter_facility"] as const;
export const ER_PRE_ALERT_MODES = ["ambulance_108", "own_ambulance", "police", "referred_in", "inter_facility"] as const;
export const ER_DOOR_TO_TRIAGE_MINUTES = 5;
export type ErSexValue = (typeof ER_SEXES)[number];
export type ErAgeBandValue = (typeof ER_AGE_BANDS)[number];
export type ErArrivalModeValue = (typeof ER_ARRIVAL_MODES)[number];

export type BandOut = {
  bandId: string; bandSerial: string; printedAt: string;
  band: {
    name: string; nameHi: string | null; uhid: string; ageSex: string; episodeNo: string; arrivedOn: string;
    allergyWords: string[]; alertWords: string[]; size: string; site: string; barcode: string; qr: string;
  };
};
export type ArrivalOut = {
  episodeId: string; episodeNo: string; patientId: string; uhid: string; state: "arrived"; arrivedAt: string;
  registeredAt: string; returnedWithin24h: boolean; band: BandOut; alias?: string; aliasHi?: string;
};

/** A uuid per act: a retried request on a bad network records once (spec §6 edge 8). */
export const newKey = (): string => crypto.randomUUID();

// ER review (2026-10-15) — the wall display reads its own route (`er.board.wall`; a kiosk holds only that).
export const fetchErBoard = (wall: boolean) => api<ErBoard>("GET", wall ? ER_ROUTES.boardWall : ER_ROUTES.board);
export const fetchErDesk = () => api<ErDeskView>("GET", ER_ROUTES.desk);
export const searchErPatients = (q: string) => api<ErPatientHit[]>("GET", `${ER_ROUTES.patients}?q=${encodeURIComponent(q)}`);
export const fetchErDoctors = () => api<ErDoctorOption[]>("GET", ER_ROUTES.doctors);
export const preAlertApi = (body: Record<string, unknown>) => api<{ preAlertId: string }>("POST", ER_ROUTES.preAlerts, { idempotencyKey: newKey(), ...body });
export const cancelPreAlertApi = (preAlertId: string, reason: string) =>
  api<{ preAlertId: string }>("POST", ER_ROUTES.cancelPreAlert, { idempotencyKey: newKey(), preAlertId, reason });
export const registerArrivalApi = (body: Record<string, unknown>, idempotencyKey: string) =>
  api<ArrivalOut>("POST", ER_ROUTES.arrivals, { idempotencyKey, ...body });
export const registerUnidentifiedApi = (body: Record<string, unknown>, idempotencyKey: string) =>
  api<ArrivalOut>("POST", ER_ROUTES.unidentified, { idempotencyKey, ...body });
export const broughtDeadApi = (body: Record<string, unknown>, idempotencyKey: string) =>
  api<{ episodeId: string; episodeNo: string; uhid: string; alias: string | null }>("POST", ER_ROUTES.broughtDead, { idempotencyKey, ...body });
export const printBandApi = (episodeId: string) => api<BandOut>("POST", ER_ROUTES.printBand, { idempotencyKey: newKey(), episodeId, site: "wrist" });
export const reprintBandApi = (episodeId: string, reason: string) =>
  api<BandOut>("POST", ER_ROUTES.reprintBand, { idempotencyKey: newKey(), episodeId, reason });
export const linkIdentityApi = (body: { episodeId: string; truePatientId: string; how: string; note: string }) =>
  api<{ mergeRequestId: string }>("POST", ER_ROUTES.linkIdentity, { idempotencyKey: newKey(), ...body });

export function erRefusalOf(e: unknown): ErRefusalBody | null {
  if (!(e instanceof ApiError) || e.body === null || typeof e.body !== "object") return null;
  const b = e.body as Partial<ErRefusalBody>;
  return typeof b.rule === "string" && typeof b.code === "string" ? (b as ErRefusalBody) : null;
}

/** Whole minutes from `iso` to `now` (negative = in the future). */
export function minutesSince(iso: string, now: number): number {
  return Math.floor((now - new Date(iso).getTime()) / 60_000);
}
