import { createHash } from "node:crypto";

/**
 * PLAN 18b T1/T2 — **THE STUDY INSTANCE UID, MINTED FROM THE STUDY AND FROM NOTHING ELSE.**
 *
 * ═══ `2.25.<128-bit integer>` NEEDS NO REGISTERED ROOT (D3) ═══
 *
 * ITU-T X.667 reserves the `2.25` arc for UUID-derived identifiers: any 128-bit value rendered in
 * decimal under it is a globally unique OID and nobody has to buy or register a root. A hospital
 * that has not yet chosen a PACS vendor (§7 R1) can therefore put a valid, permanent UID on the
 * worklist TODAY, and the modality that reads the worklist copies it into every image it produces.
 *
 * ═══ DETERMINISTIC, SO A SECOND PULL IS THE SAME WORKLIST ═══
 *
 * The export is a pull route (D1) and the bridge re-pulls it every few seconds. A UID minted at
 * random on each pull would hand the modality a different identity for the same study between one
 * pull and the next; the one below is a pure function of the study id — the first 128 bits of
 * SHA-256 over it — so every pull, every console and `recordAcquired` (T2) agree without a lookup.
 * The phase doc said "the ULID's own bits"; a hash is used instead because fixture ids in this repo
 * are not always Crockford-valid and a minter that threw on a test id would be a minter nobody
 * could test.
 *
 * A UID is at most 64 characters (PS3.5 §9.1): `2.25.` is five, and 2^128 is thirty-nine digits.
 */
export const STUDY_UID_ROOT = "2.25";

export function mintStudyInstanceUid(studyId: string): string {
  const digest = createHash("sha256").update(studyId, "utf8").digest();
  const value = BigInt(`0x${digest.subarray(0, 16).toString("hex")}`);
  return `${STUDY_UID_ROOT}.${value.toString(10)}`;
}

/** PS3.5 §9.1 — numeric components joined by dots, no component with a leading zero, ≤ 64 chars. */
export const DICOM_UID_MAX_LENGTH = 64;

export function isValidDicomUid(value: string): boolean {
  if (value.length === 0 || value.length > DICOM_UID_MAX_LENGTH) return false;
  if (!/^[0-9]+(\.[0-9]+)*$/.test(value)) return false;
  return value.split(".").every((c) => c === "0" || !c.startsWith("0"));
}
