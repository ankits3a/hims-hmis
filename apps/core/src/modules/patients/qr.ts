import { and, eq, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { hmacSign, hmacVerify } from "../../kernel/crypto";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { patients } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { patientUpdated, qrSignatureFailed } from "./events";
import { PatientError } from "./uhid";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

export const QR_PREFIX = "q1";

/** Card payload: q1.<patientId>.<uhid>.<qrVersion>.<sig> — HMAC under the existing SECRET_KEY (no new env var). */
export function buildQrPayload(cfg: AppConfig, p: { id: string; uhid: string; qrVersion: number }): string {
  const body = `${QR_PREFIX}.${p.id}.${p.uhid}.${p.qrVersion}`;
  return `${body}.${hmacSign(cfg.secretKey, body)}`;
}

export type QrVerifyResult =
  | { ok: true; patient: { id: string; uhid: string; name: string; sex: string; dob: Date | null } }
  | { ok: false; reason: "malformed" | "invalid_signature" | "stale_version" | "unknown_patient" };

/**
 * Scanner-side verification (D-23: a photographed or edited static code fails; a reissued
 * card's predecessors fail). Every failure appends qr.signature_failed in its OWN
 * transaction — the scan itself is a read, but the failure is an auditable fact.
 */
export async function verifyQrScan(
  db: Db,
  cfg: AppConfig,
  actor: Actor,
  payload: string,
): Promise<QrVerifyResult> {
  if (actor.type !== "user") throw new PatientError("user_actor_required", "scanners are desk surfaces — user actors only");

  const fail = async (
    reason: "malformed" | "invalid_signature" | "stale_version" | "unknown_patient",
    patientId?: string,
  ): Promise<QrVerifyResult> => {
    await withTx(db, (tx) =>
      appendEvent(
        tx,
        qrSignatureFailed.make({
          actor,
          patientId,
          payload: { reason, payloadPrefix: payload.slice(0, 32), ...(patientId !== undefined ? { patientId } : {}) },
        }),
      ),
    );
    return { ok: false, reason };
  };

  const parts = payload.split(".");
  if (parts.length !== 5 || parts[0] !== QR_PREFIX || !/^\d+$/.test(parts[3]!)) {
    return fail("malformed");
  }
  const [prefix, id, uhid, versionPart, sig] = parts as [string, string, string, string, string];
  const body = `${prefix}.${id}.${uhid}.${versionPart}`;
  if (!hmacVerify(cfg.secretKey, body, sig)) {
    return fail("invalid_signature"); // forged/edited — the embedded id is NOT trusted, no patientId on the event
  }

  const rows = await db.select().from(patients).where(eq(patients.id, id));
  const row = rows[0];
  if (!row) return fail("unknown_patient", id); // signature is ours, so the id is ours to event
  if (row.qrVersion !== Number(versionPart) || row.uhid !== uhid) {
    return fail("stale_version", id); // reissue rotated the card (or the uhid predates a correction)
  }

  // Follow the merge chain — an old card of a merged loser must land on the canonical record (§6).
  let resolved = row;
  for (let hop = 0; resolved.status === "merged" && resolved.mergedIntoPatientId !== null && hop < 5; hop++) {
    const next = await db.select().from(patients).where(eq(patients.id, resolved.mergedIntoPatientId));
    if (!next[0]) return fail("unknown_patient", resolved.mergedIntoPatientId);
    resolved = next[0];
  }

  // §14: the card was physically presented, so the scan resolves — but the display name is
  // the alias for callers without the permission. D-37: nothing here affects any priority.
  let name = resolved.name;
  if (resolved.isConfidential) {
    const canSee = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
    if (!canSee) name = resolved.alias ?? "—";
  }
  return {
    ok: true,
    patient: { id: resolved.id, uhid: resolved.uhid, name, sex: resolved.sex, dob: resolved.dob },
  };
}

/** Single-winner version bump; prior cards fail with stale_version from this commit on. */
export async function reissueQrCard(
  db: Db,
  cfg: AppConfig,
  actor: Actor,
  patientId: string,
): Promise<{ qrVersion: number; payload: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  return withTx(db, async (tx) => {
    const updated = await tx
      .update(patients)
      // Atomic in-place increment — never read-then-write (house rule).
      .set({ qrVersion: sql`${patients.qrVersion} + 1`, updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(patients.id, patientId), eq(patients.status, "active")))
      .returning();
    if (updated.length === 0) {
      const exists = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId));
      throw new PatientError(exists.length === 0 ? "patient_not_found" : "patient_not_active");
    }
    const row = updated[0]!;
    await appendEvent(
      tx,
      patientUpdated.make({
        actor,
        patientId,
        payload: {
          patientId,
          changes: [{ field: "qrVersion", from: String(row.qrVersion - 1), to: String(row.qrVersion) }],
        },
      }),
    );
    return { qrVersion: row.qrVersion, payload: buildQrPayload(cfg, row) };
  });
}
