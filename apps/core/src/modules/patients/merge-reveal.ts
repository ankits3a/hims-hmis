import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { patientMergeRequests } from "../../kernel/db/schema";
import { hasPermission } from "../../kernel/auth/permissions";
import { activeBreakGlass } from "../../kernel/auth/break-glass";
import { recordPhiAccess } from "../../kernel/phi/audit";
import type { Db } from "../../kernel/db/client";
import { getPatient } from "./registration";

/**
 * #653 (S1) — THE MERGE REVIEW'S CONTACT AND IDENTITY FIELDS ARE MASKED ON THE SERVER.
 *
 * A merge request freezes both patient rows whole (`snapshot`). `GET /patients/merge-requests/:id`
 * hands that snapshot to every `patients.read` holder, so a mask drawn only on the screen left the
 * numbers in the response. The detail now carries, for every reader:
 *   phone, alt phone, referrer's phone   the last 4 digits     `•••••• 3210`
 *   date of birth                        the year only         `dob: null, dobYear: 1974`
 *   address                              the locality only     `addressLine: null, pincode: null, locality: "Patna, Bihar"`
 *   ABHA number and address              the last 4            `•••• 4321`
 *   ABHA link token                      never
 * and a `differs` block computed on the full values, so "same phone?" still has an answer.
 *
 * The full values come back only through `revealMergeSnapshot` (the logged Show), which applies the
 * sealed-record gate to both records and writes one access row per ORIGINAL record id.
 */
export type SnapshotRow = Record<string, unknown>;
export type MergeDiffers = { dob: boolean; phone: boolean; address: boolean; abha: boolean };
export type RevealedFields = {
  phone: string | null; altPhone: string | null; referredByPhone: string | null; dob: string | null;
  addressLine: string | null; pincode: string | null; abhaNumber: string | null; abhaAddress: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function maskPhoneLast4(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  return `•••••• ${s.replace(/\D/g, "").slice(-4)}`;
}

function maskAbha(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  return `•••• ${s.replace(/[^0-9A-Za-z]/g, "").slice(-4)}`;
}

function dobDay(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = str(v);
  return s === null ? null : s.slice(0, 10);
}

export function maskMergeSnapshotRow(row: SnapshotRow): SnapshotRow {
  const day = dobDay(row["dob"]);
  const locality = [str(row["district"]), str(row["stateName"])].filter((x): x is string => x !== null).join(", ");
  return {
    ...row,
    phone: maskPhoneLast4(row["phone"]),
    altPhone: maskPhoneLast4(row["altPhone"]),
    referredByPhone: maskPhoneLast4(row["referredByPhone"]),
    dob: null,
    dobYear: day === null ? null : Number(day.slice(0, 4)),
    addressLine: null,
    pincode: null,
    locality: locality === "" ? null : locality,
    abhaNumber: maskAbha(row["abhaNumber"]),
    abhaAddress: maskAbha(row["abhaAddress"]),
    abhaLinkToken: null,
    masked: true,
  };
}

/** The same comparisons the screen drew from the full rows, made here so the mask costs no answer. */
export function mergeSnapshotDiffers(a: SnapshotRow, b: SnapshotRow): MergeDiffers {
  const same = (x: unknown, y: unknown): boolean => (str(x) ?? "") === (str(y) ?? "");
  return {
    dob: (dobDay(a["dob"]) ?? "") !== (dobDay(b["dob"]) ?? ""),
    phone: !same(a["phone"], b["phone"]),
    address: !same(a["addressLine"], b["addressLine"]),
    abha: (str(a["abhaAddress"]) ?? str(a["abhaNumber"]) ?? "") !== (str(b["abhaAddress"]) ?? str(b["abhaNumber"]) ?? ""),
  };
}

function revealed(row: SnapshotRow): RevealedFields {
  return {
    phone: str(row["phone"]), altPhone: str(row["altPhone"]), referredByPhone: str(row["referredByPhone"]), dob: dobDay(row["dob"]),
    addressLine: str(row["addressLine"]), pincode: str(row["pincode"]), abhaNumber: str(row["abhaNumber"]), abhaAddress: str(row["abhaAddress"]),
  };
}

/**
 * The logged Show for one merge request. Null (the route's 404) when the request is unknown or when
 * either record is sealed to this reader: sealed now (`getPatient`'s gate, merge chain followed) or
 * sealed when the request froze it (the snapshot's own flag), unless they hold
 * `patients.confidential.read` or an active break-glass. Nothing is logged unless both pass.
 */
export async function revealMergeSnapshot(
  db: Db,
  actor: Actor,
  mergeRequestId: string,
): Promise<{ winner: RevealedFields; loser: RevealedFields } | null> {
  const [req] = await db.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, mergeRequestId));
  if (!req) return null;
  const snap = req.snapshot as { winnerBefore: SnapshotRow; loserBefore: SnapshotRow };
  const sides: [string, SnapshotRow][] = [[req.winnerId, snap.winnerBefore], [req.loserId, snap.loserBefore]];
  const passed: { patientId: string; sealed: boolean; reason: string | null }[] = [];
  for (const [patientId, row] of sides) {
    const found = await getPatient(db, actor, patientId);
    if (!found) return null;
    let reason = found.breakGlass?.reason ?? null;
    const sealedThen = row["isConfidential"] === true;
    if (sealedThen && !found.patient.isConfidential && actor.type !== "system") {
      if (actor.type === "agent") return null;
      if (!(await hasPermission(db, actor.id, "patients.confidential.read", "hospital"))) {
        const grant = await activeBreakGlass(db, actor.id, found.patient.id);
        if (!grant) return null;
        reason = grant.reason;
      }
    }
    passed.push({ patientId, sealed: sealedThen || found.patient.isConfidential, reason });
  }
  for (const p of passed) {
    await recordPhiAccess(db, { actor, patientId: p.patientId, surface: "patient.merge_reveal", sealed: p.sealed, reason: p.reason });
  }
  return { winner: revealed(snap.winnerBefore), loser: revealed(snap.loserBefore) };
}
