import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { abdmCareContexts, abdmHealthInfoRequests } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { ABDM_ACTOR } from "../patients";
import { healthInformationReleased } from "./events";
import { FideliusKeyPair, fideliusEncrypt, parseFideliusPublicKey } from "./fidelius";
import { BUILT_HI_TYPES } from "./fhir-records";
import { PUSH_PAGE_SIZE, answering, ok2xx } from "./hip-client";
import { buildRecords, hipOrganization, loadCareContextRecords, patientRow, recordPatientOf } from "./records";
import type { HipClient } from "./hip-client";
import type { AbdmInboundMessage } from "./callbacks";
import type { AbdmSettings } from "./settings";
import type { ConsentRow, Consents } from "./consents";
import type { FideliusPeer } from "./fidelius";
import type { BuiltRecord } from "./records";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ ABDM S2 — A HEALTH-INFORMATION REQUEST: CHECKED AGAINST THE CONSENT, BUILT, ENCRYPTED, PUSHED ═══
 *
 * FT HIP_INIT_SHARE_CARECONTEXT. Source: the NHA wrapper's `HIPHealthInformationV3Service`
 * (authoritative — it too runs the whole transfer inside the callback, then notifies); every path
 * UNVERIFIED (`hip-client.ts`).
 *
 * THE RELEASE RULE (DECIDED default `ABDM_CONSENT_RELEASE=auto`; the owner has not ruled): the
 * request is served EXACTLY within the stored artefact, and anything outside it releases NOTHING —
 * not a partial answer:
 *   · the consent is known, GRANTED, for THIS HIP, and not past `dataEraseAt` (the HIP enforces the
 *     expiry itself, spec §4.3) — the wrapper checks only these;
 *   · the request's date range lies INSIDE the artefact's `permission.dateRange`, and any care
 *     context or HI type the request names is one the artefact names;
 *   · the requester (`X-HIU-ID`, when ABDM sends it) is the artefact's HIU;
 *   · the key material is ECDH on Curve25519 with a valid public key and a 32-byte nonce, and the push
 *     URL is HTTPS.
 * Then ONLY: the artefact's care contexts that are LINKED here to the consenting patient, ONLY the
 * artefact's HI types (of the three built), ONLY records dated inside the range. A refused request
 * is acknowledged with an error and nothing is built, encrypted or pushed. `manual` acknowledges and
 * HOLDS the request — the review that would release it is owed.
 *
 * EVERY RELEASE IS LOGGED three ways: `abdm_messages` (the exchange; the push as a summary — no
 * ciphertext, no key), `phi_access_log` (`abdm.health_information`, one row per released visit), and
 * `abdm.health_information_released` on the event spine. A request is handled once per
 * `transactionId` (unique): a second delivery releases nothing again.
 *
 * THE PRIVATE KEY is generated here, for this transfer, and goes out of scope with it. It is passed to
 * nothing that logs or stores; the push body carries only our PUBLIC key and nonce.
 */
const o = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const when = (v: unknown): Date | null => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? new Date(t) : null;
};

type CareContextRow = typeof abdmCareContexts.$inferSelect;
type Checked =
  | { ok: false; reason: string }
  | {
    ok: true; consent: ConsentRow; from: Date; to: Date; peer: FideliusPeer; dataPushUrl: string;
    keyMaterial: Record<string, unknown>; contexts: CareContextRow[]; excluded: string[];
  };

export class HealthInformation {
  constructor(private readonly deps: {
    db: Db; settings: AbdmSettings; hip: HipClient; consents: Consents; now: () => Date;
    /** Tests only — a known key pair, so a test can prove the private key reaches no row. */
    keyPair?: () => FideliusKeyPair;
  }) {}

  async handleRequest(m: AbdmInboundMessage): Promise<void> {
    const body = o(m.body);
    const transactionId = s(body.transactionId);
    const hiRequest = o(body.hiRequest);
    const consentId = s(o(hiRequest.consent).id);
    const range = o(hiRequest.dateRange);
    const onRequest = async (error: string | null, patientId: string | null): Promise<void> => {
      await this.deps.hip.hiOnRequest({
        hiRequest: { transactionId, sessionStatus: error === null ? "ACKNOWLEDGED" : "FAILED" },
        ...(error === null ? {} : { error: { code: "ABDM-1000", message: error } }),
        ...answering(m.requestId),
      }, patientId);
    };
    if (transactionId === null || consentId === null) { await onRequest("transactionId and consent id are required", null); return; }

    // CLAIM the transaction before anything else: a second delivery of it stops here.
    const [claimed] = await this.deps.db.insert(abdmHealthInfoRequests).values({
      id: newId(), transactionId, consentId, hipId: this.deps.settings.hipId, messageId: m.messageId,
      requestedFrom: when(range.from), requestedTo: when(range.to), dataPushUrl: s(hiRequest.dataPushUrl),
      status: "transferring",
    }).onConflictDoNothing().returning();
    if (claimed === undefined) return;

    const checked = await this.check(m, hiRequest);
    if (!checked.ok) {
      await this.deps.db.update(abdmHealthInfoRequests).set({ status: "refused", refusal: checked.reason, updatedAt: this.deps.now() })
        .where(eq(abdmHealthInfoRequests.id, claimed.id));
      await onRequest(checked.reason, null);
      return;
    }
    const patientId = checked.consent.patientId ?? checked.contexts[0]!.patientId;
    await this.deps.db.update(abdmHealthInfoRequests).set({ patientId, updatedAt: this.deps.now() }).where(eq(abdmHealthInfoRequests.id, claimed.id));
    if (this.deps.settings.consentRelease === "manual") {
      await this.deps.db.update(abdmHealthInfoRequests).set({ status: "held", updatedAt: this.deps.now() }).where(eq(abdmHealthInfoRequests.id, claimed.id));
      await onRequest(null, patientId);
      return;
    }
    await onRequest(null, patientId);
    await this.transfer(claimed.id, transactionId, checked, patientId);
  }

  /** The release rule (see the header). Pure reads; decides everything before a byte is built. */
  private async check(m: AbdmInboundMessage, hiRequest: Record<string, unknown>): Promise<Checked> {
    const consentId = s(o(hiRequest.consent).id)!;
    const consent = await this.deps.consents.get(consentId);
    const now = this.deps.now();
    if (consent === null) return { ok: false, reason: `consent ${consentId} is not known to this HIP` };
    if (consent.status !== "GRANTED") return { ok: false, reason: `consent is ${consent.status}` };
    if (consent.hipId !== this.deps.settings.hipId) return { ok: false, reason: "consent is for another HIP" };
    if (consent.dataEraseAt === null || consent.dataEraseAt.getTime() <= now.getTime()) return { ok: false, reason: "consent has expired (dataEraseAt)" };
    if (m.hiuId !== null && consent.hiuId !== null && m.hiuId !== consent.hiuId) return { ok: false, reason: "the requester is not the consent's HIU" };
    if (consent.dateFrom === null || consent.dateTo === null) return { ok: false, reason: "consent carries no date range" };

    const range = o(hiRequest.dateRange);
    const reqFrom = range.from === undefined ? consent.dateFrom : when(range.from);
    const reqTo = range.to === undefined ? consent.dateTo : when(range.to);
    if (reqFrom === null || reqTo === null || reqFrom.getTime() > reqTo.getTime()) return { ok: false, reason: "the request's date range is invalid" };
    if (reqFrom.getTime() < consent.dateFrom.getTime() || reqTo.getTime() > consent.dateTo.getTime()) {
      return { ok: false, reason: "the request's date range lies outside the consented range" };
    }
    const allowedRefs = new Set(consent.careContexts.map((c) => c.careContextReference));
    const namedRefs = (Array.isArray(hiRequest.careContexts) ? hiRequest.careContexts : []).map(o).map((c) => s(c.careContextReference) ?? s(c.referenceNumber));
    if (namedRefs.some((r) => r === null || !allowedRefs.has(r))) return { ok: false, reason: "the request names a care context the consent does not" };
    const namedTypes = (Array.isArray(hiRequest.hiTypes) ? hiRequest.hiTypes : []).map((t) => s(t));
    if (namedTypes.some((t) => t === null || !consent.hiTypes.includes(t))) return { ok: false, reason: "the request names an HI type the consent does not" };

    const km = o(hiRequest.keyMaterial);
    const dh = o(km.dhPublicKey);
    const peer = { publicKey: s(dh.keyValue) ?? "", nonce: s(km.nonce) ?? "" };
    try {
      if (s(km.cryptoAlg)?.toUpperCase() !== "ECDH" || s(km.curve)?.toLowerCase() !== "curve25519") throw new Error("not ECDH/Curve25519");
      parseFideliusPublicKey(peer.publicKey);
      if (Buffer.from(peer.nonce, "base64").length !== 32) throw new Error("nonce");
    } catch {
      return { ok: false, reason: "invalid key material" };
    }
    const dataPushUrl = s(hiRequest.dataPushUrl);
    if (dataPushUrl === null || !/^https:\/\//i.test(dataPushUrl)) return { ok: false, reason: "dataPushUrl must be HTTPS" };

    // The artefact's care contexts that are LINKED here, to the consenting patient's ABHA.
    const contexts: CareContextRow[] = [];
    const excluded: string[] = [];
    for (const c of consent.careContexts) {
      const [row] = await this.deps.db.select().from(abdmCareContexts).where(and(
        eq(abdmCareContexts.hipId, this.deps.settings.hipId), eq(abdmCareContexts.referenceNumber, c.careContextReference),
        eq(abdmCareContexts.status, "linked"),
      ));
      const sameAbha = row !== undefined && (row.abhaAddress ?? "").toLowerCase() === (consent.patientAbhaAddress ?? "").toLowerCase();
      const samePatient = row !== undefined && (consent.patientId === null || row.patientId === consent.patientId);
      if (row === undefined || row.patientReference !== c.patientReference || !sameAbha || !samePatient) excluded.push(c.careContextReference);
      else contexts.push(row);
    }
    if (contexts.length === 0) return { ok: false, reason: "no care context of this consent is linked here to the consenting patient" };
    return { ok: true, consent, from: reqFrom, to: reqTo, peer, dataPushUrl, keyMaterial: km, contexts, excluded };
  }

  private async transfer(rowId: string, transactionId: string, c: Extract<Checked, { ok: true }>, patientId: string): Promise<void> {
    const { db, settings, hip } = this.deps;
    const now = this.deps.now();
    const statuses: { careContextReference: string; hiStatus: "DELIVERED" | "ERRORED"; description: string }[] =
      c.excluded.map((ref) => ({ careContextReference: ref, hiStatus: "ERRORED", description: "Not a care context linked here to this patient" }));
    let built: BuiltRecord[] = [];
    let pushed = true;
    let failure: string | null = null;
    try {
      const patient = await patientRow(db, patientId);
      if (patient === null) throw new Error("the consenting patient is not on record");
      const ctx = { hip: await hipOrganization(db, settings.hipId), patient: recordPatientOf(patient), now };
      const records = await loadCareContextRecords(db, c.contexts);
      const types = new Set(c.consent.hiTypes.filter((t) => (BUILT_HI_TYPES as readonly string[]).includes(t)));
      for (const row of c.contexts) {
        const r = records.get(row.referenceNumber);
        const inRange = r === undefined ? [] : buildRecords(ctx, r, types)
          .filter((b) => b.date.getTime() >= c.from.getTime() && b.date.getTime() <= c.to.getTime());
        built = built.concat(inRange);
        statuses.push(inRange.length > 0
          ? { careContextReference: row.referenceNumber, hiStatus: "DELIVERED", description: "Delivered" }
          : { careContextReference: row.referenceNumber, hiStatus: "ERRORED", description: "No record of the consented types in the consented range" });
      }
      if (built.length > 0) {
        const own = this.deps.keyPair?.() ?? FideliusKeyPair.generate();
        const entries = built.map((b) => {
          const plain = JSON.stringify(b.bundle);
          return {
            content: fideliusEncrypt(own, c.peer, plain),
            media: "application/fhir+json",
            checksum: createHash("md5").update(plain, "utf8").digest("hex"),
            careContextReference: b.careContextReference,
          };
        });
        const dh = o(c.keyMaterial.dhPublicKey);
        const keyMaterial = {
          cryptoAlg: s(c.keyMaterial.cryptoAlg), curve: s(c.keyMaterial.curve),
          dhPublicKey: { expiry: dh.expiry ?? null, parameters: dh.parameters ?? null, keyValue: own.publicKeyX509() },
          nonce: own.nonce,
        };
        const pageCount = Math.ceil(entries.length / PUSH_PAGE_SIZE);
        for (let page = 0; page < pageCount; page += 1) {
          const slice = entries.slice(page * PUSH_PAGE_SIZE, (page + 1) * PUSH_PAGE_SIZE);
          const pushBody = { pageNumber: page, pageCount, transactionId, entries: slice, keyMaterial };
          const summary = {
            pageNumber: page, pageCount, transactionId, keyMaterial,
            entries: slice.map((e) => ({ careContextReference: e.careContextReference, media: e.media, checksum: e.checksum, contentBytes: e.content.length })),
          };
          const status = await hip.push(c.dataPushUrl, pushBody, summary, patientId);
          if (status < 200 || status >= 300) { pushed = false; failure = `the HIU answered the push with HTTP ${status}`; }
        }
      }
    } catch (e) {
      pushed = false;
      failure = e instanceof Error ? e.message : String(e);
    }
    const final = pushed
      ? statuses
      : statuses.map((st) => (st.hiStatus === "DELIVERED" ? { ...st, hiStatus: "ERRORED" as const, description: failure ?? "Transfer failed" } : st));
    let notified: Date | null = null;
    try {
      const res = await hip.hiNotify({
        notification: {
          consentId: c.consent.consentId, transactionId, doneAt: this.deps.now().toISOString(),
          notifier: { type: "HIP", id: settings.hipId },
          statusNotification: { sessionStatus: pushed ? "TRANSFERRED" : "FAILED", hipId: settings.hipId, statusResponses: final },
        },
      }, patientId);
      if (ok2xx(res)) notified = this.deps.now();
    } catch {
      // The transfer's own outcome is recorded below either way; the notify's is in abdm_messages.
    }
    const releasedRefs = pushed ? [...new Set(built.map((b) => b.careContextReference))] : [];
    await db.update(abdmHealthInfoRequests).set({
      status: pushed ? "transferred" : "failed",
      released: pushed ? built.map((b) => ({ careContextReference: b.careContextReference, hiType: b.hiType, checksum: createHash("md5").update(JSON.stringify(b.bundle), "utf8").digest("hex") })) : [],
      entryCount: pushed ? built.length : 0,
      pushedAt: pushed && built.length > 0 ? this.deps.now() : null,
      notifiedAt: notified, error: failure, updatedAt: this.deps.now(),
    }).where(eq(abdmHealthInfoRequests.id, rowId));

    if (releasedRefs.length > 0) {
      const patient = await patientRow(db, patientId);
      for (const ref of releasedRefs) {
        const row = c.contexts.find((x) => x.referenceNumber === ref)!;
        await recordPhiAccess(db, {
          actor: ABDM_ACTOR, patientId: patient?.id ?? patientId, surface: "abdm.health_information",
          encounterId: row.encounterId, sealed: patient?.isConfidential ?? false,
          reason: `ABDM consent ${c.consent.consentId} → ${c.consent.hiuId ?? "HIU"}`,
        });
      }
      await withTx(db, (tx) => appendEvent(tx, healthInformationReleased.make({
        actor: ABDM_ACTOR, patientId: patient?.id ?? patientId, correlationId: transactionId,
        idempotencyKey: `abdm.health_information_released:${transactionId}`,
        payload: {
          transactionId, consentId: c.consent.consentId, hiuId: c.consent.hiuId, purposeCode: c.consent.purposeCode,
          careContexts: releasedRefs.map((ref) => ({
            careContextReference: ref,
            hiTypes: [...new Set(built.filter((b) => b.careContextReference === ref).map((b) => b.hiType))],
            entries: built.filter((b) => b.careContextReference === ref).length,
          })),
          entryCount: built.length,
        },
      })));
    }
    if (failure !== null) throw new Error(failure);
  }
}
