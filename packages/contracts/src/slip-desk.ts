/**
 * THE SLIP DESK'S RULES — one copy, read by the web desk (apps/web/src/screens/slip-capture.tsx)
 * and the phone's (apps/mobile/src/screens/slip-desk.tsx). Owner 2026-10-06: "build the next mobile
 * app screen, slip desk". Pure: no React, no DOM, no fetch. Imported by path; not in the index.
 *
 * The server stays the authority: `captureDocument` refuses a page over 1.5 MB rather than
 * re-encoding it, and a visit the caller may not see answers exactly as "no such visit".
 */
import { resolveDoor } from "./vitals-entry";
import type { Door, WireBenchRow } from "./vitals-entry";

/** Longest edge of a filed page: about 190 dpi across an A5 slip. */
export const MAX_EDGE = 1600;
/** Just under the server's 1.5 MB refusal (`patients/documents.ts` DOCUMENT_MAX_BYTES). */
export const TARGET_BYTES = 1_400_000;
/** JPEG qualities tried in turn until the page fits the budget. */
export const QUALITIES: readonly number[] = [0.82, 0.7, 0.6, 0.5, 0.4];

/** NEVER UPSCALES: a 400 px photograph of a slip is a bad photograph, and stretching it makes a bigger bad one. */
export function fitToMaxEdge(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest === 0 ? 1 : Math.min(1, MAX_EDGE / longest);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** The byte count of a base64 payload WITHOUT decoding it — 4 characters carry 3 bytes. */
export function base64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

export function fitsBudget(b64: string): boolean {
  return base64Bytes(b64) <= TARGET_BYTES;
}

export const SLIP_KINDS = ["consult_prescription", "outside_prescription", "outside_report"] as const;
export type SlipKind = (typeof SLIP_KINDS)[number];

export type SlipPatient = {
  uhid: string; name: string | null; alias: string | null;
  administrativeGender?: string | null; dob?: string | null;
};

/** `GET /opd/visits/by-number/:visitNo` — and each hit of `GET /opd/slips/find`. */
export type SlipReadback = {
  encounterId: string;
  patientId: string;
  visitNo: string;
  serviceDate: string;
  patient: SlipPatient | null;
  doctorCode?: string | null;
  departmentName?: string | null;
  roomName?: string | null;
  filed?: { id: string; kind: string; capturedAt: string; retakeRequestedAt: string | null }[];
};

export type SlipRow = {
  encounterId: string; patientId: string; visitNo: string; patient: SlipPatient;
  doctorCode: string | null; roomName: string | null; state: "waiting" | "retake" | "filed";
  /** The token as the slip prints it (`<departmentCode>-<tokenNo>`). Optional: an older server sends neither. */
  tokenNo?: number | null; departmentCode?: string | null;
  consultDoneAt: string | null; filedAt: string | null; pages: number; kinds: string[];
  retakeRequestedAt: string | null; retakeReason: string | null;
};
export type SlipDay = { serviceDate: string; items: SlipRow[]; counts: { waiting: number; retake: number; filed: number } };

/** Whole years from an ISO date of birth, at `now` (ms). */
export function ageYearsAt(dob: string | null | undefined, now: number): number | null {
  if (dob === null || dob === undefined) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const n = new Date(now);
  let y = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) y -= 1;
  return y;
}

export const minutesSince = (iso: string | null, now: number): number =>
  iso === null ? 0 : Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));

/**
 * WHAT THE DESK TYPED OR SCANNED, AND WHERE TO TAKE IT. The same reader as the vitals bay
 * (`resolveDoor`), against today's slips instead of the bench:
 *
 *   visit    ask the server for this visit number's read-back (`/opd/visits/by-number`) — a visit
 *            number is never matched on the screen alone, because the read-back is the control;
 *   verify   a patient card (`q1.…`): the server verifies it, then `slipOfPatient`;
 *   search   words or a UHID nobody on today's list answers: the torn-slip search (name / UHID);
 *   ambiguous a bare token two doctors both hold — never guessed;
 *   miss     a token or a prescription code that names nobody who has finished a consultation today.
 */
export type SlipDoor =
  | { to: "visit"; visitNo: string }
  | { to: "verify"; payload: string }
  | { to: "search"; q: string }
  | { to: "ambiguous"; door: Extract<Door, { kind: "token" }>; rows: SlipRow[] }
  | { to: "miss"; door: Door }
  | { to: "empty" };

function asBench(items: readonly SlipRow[]): WireBenchRow[] {
  return items.map((r, i) => ({
    encounterId: r.encounterId, entryId: r.encounterId, tokenNo: r.tokenNo ?? -1, seq: i,
    visitNo: r.visitNo, departmentCode: r.departmentCode ?? null,
    doctorId: "", doctorName: "", serviceDate: "",
    patient: { requestedId: r.patientId, id: r.patientId, uhid: r.patient.uhid, name: r.patient.name, alias: r.patient.alias, restricted: false, administrativeGender: "", dob: null },
    benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
  }));
}

export function slipDoor(items: readonly SlipRow[], raw: string): SlipDoor {
  const r = resolveDoor(asBench(items), raw);
  switch (r.outcome) {
    case "empty": return { to: "empty" };
    case "verify": return { to: "verify", payload: r.payload };
    case "row": return { to: "visit", visitNo: r.row.visitNo! };
    case "ambiguous": {
      const ids = new Set(r.rows.map((x) => x.encounterId));
      return { to: "ambiguous", door: r.door, rows: items.filter((i) => ids.has(i.encounterId)) };
    }
    case "miss":
      if (r.door.kind === "visit") return { to: "visit", visitNo: r.door.visitNo };
      if (r.door.kind === "uhid") return { to: "search", q: raw.trim() };
      return { to: "miss", door: r.door };
  }
}

/** A verified card names a patient; their slip is today's row for that patient, when there is exactly one. */
export function slipOfPatient(items: readonly SlipRow[], patientId: string): SlipRow | null {
  const mine = items.filter((i) => i.patientId === patientId);
  return mine.length === 1 ? mine[0]! : (mine.find((i) => i.state !== "filed") ?? mine[0] ?? null);
}
