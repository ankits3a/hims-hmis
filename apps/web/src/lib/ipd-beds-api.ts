import { api, ApiError, newIdempotencyKey } from "./api";
import type { IpdBedBoard, IpdBedClass, IpdRefusalBody } from "@hmis/contracts";

/**
 * E1.1 (#718) — the Beds capacity board's wire (spec §4.9 A). The shapes are the contract's
 * (`packages/contracts/src/ipd/bed-board.ts`, `intents-admit.ts`); the paths are copied here because the
 * web bundle imports the contract package for TYPES only. Every act carries a fresh idempotency key in its
 * body (the intent's own field) — a retried tap on a flaky ward network records once (§4.10 edge 9).
 */
export const IPD_BEDS_TOPIC = "ipd_beds:board";

const R = {
  board: "/ipd/beds/board",
  reserve: "/ipd/beds/reserve",
  releaseReservation: "/ipd/beds/release-reservation",
  assign: "/ipd/beds/assign",
  block: "/ipd/beds/block",
  unblock: "/ipd/beds/unblock",
  clean: "/ipd/beds/clean",
  releaseIncumbent: "/ipd/beds/release-incumbent",
} as const;

export function getBedBoard(wall: boolean): Promise<IpdBedBoard> {
  return api("GET", wall ? `${R.board}?wall=1` : R.board);
}

export type BedNeedInput = {
  requestedClass: IpdBedClass;
  isolation: "none" | "contact" | "droplet" | "airborne";
  icu: boolean;
};
export type BedActInput = {
  admissionId: string;
  bedId: string;
  patientId: string;
  need: BedNeedInput;
  classChange?: "upgrade" | "downgrade";
};
export type BlockReason = "maintenance" | "infection_control" | "deep_clean" | "staff_shortage" | "other";
export const BLOCK_REASONS: readonly BlockReason[] = ["maintenance", "infection_control", "deep_clean", "staff_shortage", "other"];
export type ReleaseReason = "plan_changed" | "bed_unsuitable" | "other";
export const RELEASE_REASONS: readonly ReleaseReason[] = ["plan_changed", "bed_unsuitable", "other"];

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  return api("POST", path, { idempotencyKey: key, ...body }, key);
}

export const reserveBed = (b: BedActInput): Promise<unknown> => post(R.reserve, b);
export const assignBed = (b: BedActInput): Promise<unknown> => post(R.assign, b);
export const releaseReservation = (reservationId: string, reason: ReleaseReason): Promise<unknown> =>
  post(R.releaseReservation, { reservationId, reason });
export const blockBed = (b: { bedId: string; reason: BlockReason; note: string; expectedReturnAt: string }): Promise<unknown> =>
  post(R.block, b);
export const unblockBed = (bedId: string): Promise<unknown> => post(R.unblock, { bedId });
export const markBedClean = (bedId: string): Promise<unknown> =>
  post(R.clean, { bedId, cleanedAt: new Date().toISOString(), checklistDone: true });
export const releaseIncumbentBed = (bedId: string): Promise<unknown> => post(R.releaseIncumbent, { bedId });

/** A refusal's body when the server sent one (`IpdRefusalBody`), else null. */
export function refusalOf(e: unknown): IpdRefusalBody | null {
  if (!(e instanceof ApiError) || e.body === null || typeof e.body !== "object") return null;
  const b = e.body as Partial<IpdRefusalBody>;
  return typeof b.rule === "string" && typeof b.code === "string" ? (b as IpdRefusalBody) : null;
}
