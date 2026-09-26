import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { abdmConsents } from "../../kernel/db/schema";
import { findAbhaHolder } from "../patients";
import { answering } from "./hip-client";
import type { HipClient } from "./hip-client";
import type { AbdmInboundMessage } from "./callbacks";
import type { AbdmSettings } from "./settings";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ ABDM S2 — THE CONSENT ARTEFACT ABDM HANDS THE HIP (`consent/request/hip/notify`) ═══
 *
 * FT HIP_INIT_GRANT_CONSENT / REVOKE / EXPIRE. Source: the NHA wrapper's `ConsentV3Service`
 * (authoritative); the body shape is the one `abdm-spec-summary.md` §4.3 transcribes.
 *
 *   · GRANTED with a `consentDetail` naming THIS HIP → stored (`abdm_consents`), projected onto the
 *     columns the release check reads, and acknowledged `OK`. A GRANTED artefact for another HIP, or
 *     one with no patient, is acknowledged with an error and stored nowhere.
 *   · REVOKED / EXPIRED / DENIED → the stored row takes the status (the wrapper's
 *     `updateConsentStatus`); nothing is ever served on it again. Acknowledged `OK` either way — the
 *     notification is ABDM's statement, not a question.
 *   · A second GRANTED for the same `consentId` updates the one row (unique) — never two artefacts.
 *
 * The acknowledgement goes out in the same request, well inside ABDM's 60 s (FT FAQ Q36: a late
 * `on-notify` means the data request never arrives).
 */
const o = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const when = (v: unknown): Date | null => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? new Date(t) : null;
};
const STATUSES = new Set(["GRANTED", "REVOKED", "EXPIRED", "DENIED"]);

export type ConsentRow = typeof abdmConsents.$inferSelect;

export class Consents {
  constructor(private readonly deps: { db: Db; settings: AbdmSettings; hip: HipClient; now: () => Date }) {}

  async handleNotify(m: AbdmInboundMessage): Promise<void> {
    const n = o(o(m.body).notification);
    const status = (s(n.status) ?? "").toUpperCase();
    const detail = o(n.consentDetail);
    const consentId = s(n.consentId) ?? s(detail.consentId);
    const ack = async (error: { code: string; message: string } | null, patientId: string | null): Promise<void> => {
      await this.deps.hip.consentOnNotify({
        acknowledgement: { status: error === null ? "OK" : "FAILURE", consentId },
        ...(error === null ? {} : { error }),
        ...answering(m.requestId),
      }, patientId);
    };
    if (consentId === null || !STATUSES.has(status)) { await ack({ code: "ABDM-1000", message: "Invalid hip/notify request" }, null); return; }
    const now = this.deps.now();

    if (status !== "GRANTED") {
      const updated = await this.deps.db.update(abdmConsents)
        .set({ status, revokedAt: now, messageId: m.messageId, updatedAt: now })
        .where(eq(abdmConsents.consentId, consentId)).returning({ patientId: abdmConsents.patientId });
      await ack(null, updated[0]?.patientId ?? null);
      return;
    }

    const hipId = s(o(detail.hip).id);
    const abhaAddress = s(o(detail.patient).id);
    if (hipId !== this.deps.settings.hipId || abhaAddress === null) {
      await ack({ code: "ABDM-1000", message: hipId !== this.deps.settings.hipId ? "This consent names a different HIP" : "The consent names no patient" }, null);
      return;
    }
    const permission = o(detail.permission);
    const range = o(permission.dateRange);
    const careContexts = (Array.isArray(detail.careContexts) ? detail.careContexts : []).map(o)
      .map((c) => ({ patientReference: s(c.patientReference) ?? "", careContextReference: s(c.careContextReference) ?? "" }))
      .filter((c) => c.careContextReference !== "");
    const hiTypes = (Array.isArray(detail.hiTypes) ? detail.hiTypes : []).map((t) => s(t)).filter((t): t is string => t !== null);
    const existing = await this.get(consentId);
    if (existing !== null && existing.status !== "GRANTED") {
      // A GRANTED that arrives after the REVOKE/EXPIRE (a retry out of order) never brings it back.
      await ack(null, existing.patientId);
      return;
    }
    const holder = await findAbhaHolder(this.deps.db, { abhaAddress }, null);
    const values = {
      status, hipId, patientAbhaAddress: abhaAddress, patientId: holder?.patientId ?? null,
      hiuId: s(o(detail.hiu).id), purposeCode: s(o(detail.purpose).code), hiTypes, careContexts,
      dateFrom: when(range.from), dateTo: when(range.to), dataEraseAt: when(permission.dataEraseAt),
      accessMode: s(permission.accessMode), artefact: detail, signature: s(n.signature),
      messageId: m.messageId, grantedAt: now, revokedAt: null, updatedAt: now,
    };
    await this.deps.db.insert(abdmConsents).values({ id: newId(), consentId, ...values })
      .onConflictDoUpdate({ target: abdmConsents.consentId, set: values });
    await ack(null, values.patientId);
  }

  async get(consentId: string): Promise<ConsentRow | null> {
    const [row] = await this.deps.db.select().from(abdmConsents).where(eq(abdmConsents.consentId, consentId));
    return row ?? null;
  }
}
