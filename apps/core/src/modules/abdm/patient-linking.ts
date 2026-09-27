import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Logger } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { abdmCareContexts, abdmLinkRequests } from "../../kernel/db/schema";
import { completedVisitIdsOf, getEncounter } from "../opd";
import { findAbhaHolder, listMergedLoserIds } from "../patients";
import { careContextDisplay, abdmGender } from "./care-contexts";
import { answering } from "./hip-client";
import { hiTypesOf, loadCareContextRecords, patientRow } from "./records";
import type { HipClient } from "./hip-client";
import type { AbdmInboundMessage } from "./callbacks";
import type { AbdmSettings } from "./settings";
import type { PatientRow } from "../patients";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ ABDM S2 — PATIENT-INITIATED LINKING: DISCOVER → INIT (OUR OTP) → CONFIRM ═══
 *
 * The patient finds this hospital in their PHR app (FT USER_INIT_LINK_602–607). Sources: the NHA
 * wrapper's `DiscoveryV3Service` and `LinkV3Service` (authoritative); every path UNVERIFIED
 * (`hip-client.ts`).
 *
 *   · DISCOVER (`hip/patient/care-context/discover`) — DECIDED matching: the patient is found by an
 *     ABHA number or address ABDM itself VERIFIED on our record (S1: only ABDM sets `verified`), and
 *     then the demographics ABDM sends must agree with ours — gender, year of birth when we hold a
 *     real one, and the name (case and spacing ignored). A near miss is "not found" (ABDM-1010),
 *     never a guess: a wrong match would hand one person's records to another. Only COMPLETED visits
 *     that are NOT YET LINKED are offered (the spec's rule), grouped per HI type as the wrapper does.
 *     NOT BUILT: the mobile + fuzzy fallback for a patient we hold no verified ABHA for (FT 603's
 *     second step) — such a patient is not found.
 *   · INIT (`hip/link/care-context/init`) — the picked care contexts are re-checked as THIS patient's
 *     and unlinked, a link reference is minted, and WE send the OTP (FT FAQ Q35) through the
 *     `OtpSender`. There is no SMS sender yet (an owner/procurement item — a DLT-registered template),
 *     so the only sender is `LoggingOtpSender`, which REFUSES in production (`X-CM-ID: abdm`) and in
 *     the sandbox REFUSES too unless an operator sets `ABDM_SANDBOX_OTP_TO_LOG=true`, when it writes
 *     the OTP to the server log so the functional test can be run. A refused send
 *     answers on-init with an error; nothing is linked.
 *   · CONFIRM (`hip/link/care-context/confirm`) — the OTP is compared in constant time against its
 *     HMAC (the OTP is stored nowhere); ten minutes, five tries. Right → the care contexts are linked
 *     (`linked_via = 'patient'`) and on-confirm lists them. A repeat confirm of a linked request
 *     answers the same list and links nothing twice.
 */
export const LINK_OTP_TTL_MS = 10 * 60 * 1000;
export const LINK_OTP_MAX_ATTEMPTS = 5;

export interface OtpSender {
  readonly name: string;
  /** Throws when it cannot send. Never logs the OTP unless the implementation says so. */
  send(to: { mobile: string; patientId: string }, otp: string, purpose: string): Promise<void>;
}

export class OtpSenderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtpSenderUnavailable";
  }
}

/**
 * THE ONLY OTP SENDER THERE IS, UNTIL AN SMS PROVIDER IS BOUGHT. It sends nothing. In PRODUCTION
 * (`cmId === "abdm"`) it refuses every send — a patient must never be told an OTP went to their phone
 * when none did. In the SANDBOX it refuses as well unless `toLog` is set (`ABDM_SANDBOX_OTP_TO_LOG`):
 * FT runs on the production box, and an OTP in a server log is a credential in a log, so writing one
 * there is a choice an operator makes for a test window, never a default. When set, the OTP goes to
 * the server log (never to a table) so a tester can complete FT USER_INIT_LINK_605 with a synthetic patient.
 */
export class LoggingOtpSender implements OtpSender {
  readonly name = "logging (no SMS provider configured)";
  private readonly log = new Logger("abdm.otp");

  constructor(private readonly cmId: "sbx" | "abdm", private readonly toLog = false) {}

  async send(to: { mobile: string; patientId: string }, otp: string, purpose: string): Promise<void> {
    if (this.cmId === "abdm") {
      throw new OtpSenderUnavailable("no SMS sender is configured — the hospital cannot send the linking OTP in production");
    }
    if (!this.toLog) {
      throw new OtpSenderUnavailable("no SMS sender is configured — set ABDM_SANDBOX_OTP_TO_LOG=true for a sandbox test window to see the OTP in the server log");
    }
    this.log.warn(`SANDBOX ONLY — no SMS sender: ${purpose} OTP for patient ${to.patientId} (mobile ending ${to.mobile.slice(-4)}) is ${otp}`);
  }
}

const o = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const norm = (n: string): string => n.toLowerCase().replace(/[^a-zऀ-ॿ]+/g, " ").trim();
const digits = (v: string): string => v.replace(/\D/g, "");
const masked = (mobile: string): string => `******${mobile.slice(-4)}`;

type Offered = { referenceNumber: string; display: string; encounterId: string; hiTypes: string[] };

export class PatientLinking {
  constructor(private readonly deps: {
    db: Db; settings: AbdmSettings; hip: HipClient; secretKey: Buffer; otp: OtpSender; now: () => Date;
  }) {}

  private otpHash(linkRef: string, otp: string): string {
    return createHmac("sha256", this.deps.secretKey).update(`abdm.link-otp:${linkRef}:${otp}`).digest("hex");
  }

  /** The patient ABDM says this is — by a VERIFIED ABHA on our record, then the demographics. */
  private async matchPatient(p: Record<string, unknown>): Promise<{ patient: PatientRow; matchedBy: string } | null> {
    const identifiers = arr(p.verifiedIdentifiers).map(o);
    const byType = (t: string): string[] => identifiers.filter((i) => s(i.type) === t).map((i) => s(i.value)).filter((v): v is string => v !== null);
    const addresses = [s(p.id), ...byType("ABHA_ADDRESS")].filter((v): v is string => v !== null);
    const numbers = byType("ABHA_NUMBER");
    const probes: { matchedBy: string; abhaNumber?: string; abhaAddress?: string }[] = [
      ...addresses.map((a) => ({ matchedBy: "ABHA_ADDRESS", abhaAddress: a })),
      ...numbers.map((n) => ({ matchedBy: "ABHA_NUMBER", abhaNumber: n })),
    ];
    for (const probe of probes) {
      const holder = await findAbhaHolder(this.deps.db, { abhaNumber: probe.abhaNumber ?? null, abhaAddress: probe.abhaAddress ?? null }, null);
      if (holder === null) continue;
      const patient = await patientRow(this.deps.db, holder.patientId);
      if (patient === null || patient.abhaVerificationStatus !== "verified") continue;
      if (probe.abhaAddress !== undefined && (patient.abhaAddress ?? "").trim().toLowerCase() !== probe.abhaAddress.toLowerCase()) continue;
      if (probe.abhaNumber !== undefined && digits(patient.abhaNumber ?? "") !== digits(probe.abhaNumber)) continue;
      if (!this.demographicsAgree(patient, p)) return null;
      return { patient, matchedBy: probe.matchedBy };
    }
    return null;
  }

  private demographicsAgree(patient: PatientRow, p: Record<string, unknown>): boolean {
    const gender = s(p.gender);
    if (gender !== null && gender.toUpperCase() !== abdmGender(patient)) return false;
    const yob = Number(p.yearOfBirth);
    if (Number.isFinite(yob) && yob > 0 && patient.dob !== null && !patient.dobEstimated && patient.dob.getUTCFullYear() !== yob) return false;
    const name = s(p.name);
    if (name !== null && norm(name) !== norm(patient.name)) return false;
    return true;
  }

  /** The patient's completed visits that are not yet linked, with what each carries. */
  private async unlinkedContexts(patient: PatientRow): Promise<Offered[]> {
    const chain = [patient.id, ...(await listMergedLoserIds(this.deps.db, patient.id))];
    const visits = await completedVisitIdsOf(this.deps.db, chain);
    if (visits.length === 0) return [];
    const linked = await this.deps.db.select({ encounterId: abdmCareContexts.encounterId }).from(abdmCareContexts)
      .where(and(inArray(abdmCareContexts.encounterId, visits.map((v) => v.encounterId)), eq(abdmCareContexts.status, "linked")));
    const linkedIds = new Set(linked.map((l) => l.encounterId));
    const open = visits.filter((v) => !linkedIds.has(v.encounterId));
    const records = await loadCareContextRecords(this.deps.db, open.map((v) => ({ referenceNumber: v.encounterId, encounterId: v.encounterId })));
    return [...records.values()].map((r) => ({
      referenceNumber: r.visit.visitNo, display: careContextDisplay(r.visit), encounterId: r.visit.encounterId, hiTypes: hiTypesOf(r),
    }));
  }

  private grouped(patient: PatientRow, offered: Offered[]): Record<string, unknown>[] {
    const byType = new Map<string, Offered[]>();
    for (const c of offered) for (const t of c.hiTypes) byType.set(t, [...(byType.get(t) ?? []), c]);
    return [...byType.entries()].map(([hiType, list]) => ({
      referenceNumber: patient.uhid, display: patient.name,
      careContexts: list.map((c) => ({ referenceNumber: c.referenceNumber, display: c.display })),
      hiType, count: list.length,
    }));
  }

  async handleDiscover(m: AbdmInboundMessage): Promise<void> {
    const body = o(m.body);
    const transactionId = s(body.transactionId);
    const match = await this.matchPatient(o(body.patient));
    const offered = match === null ? [] : await this.unlinkedContexts(match.patient);
    if (match === null || offered.length === 0) {
      await this.deps.hip.onDiscover({
        transactionId,
        error: match === null
          ? { code: "ABDM-1010", message: "Patient not found" }
          : { code: "ABDM-1000", message: "Care Contexts not found for patient" },
        ...answering(m.requestId),
      }, match?.patient.id ?? null);
      return;
    }
    await this.deps.hip.onDiscover({
      transactionId,
      patient: this.grouped(match.patient, offered),
      matchedBy: [match.matchedBy],
      ...answering(m.requestId),
    }, match.patient.id);
  }

  async handleLinkInit(m: AbdmInboundMessage): Promise<void> {
    const body = o(m.body);
    const transactionId = s(body.transactionId) ?? "";
    const abhaAddress = s(body.abhaAddress);
    const requested = arr(body.patient).map(o);
    const refs = [...new Set(requested.flatMap((p) => arr(p.careContexts).map(o).map((c) => s(c.referenceNumber)).filter((r): r is string => r !== null)))];
    const refuse = async (message: string, patientId: string | null): Promise<void> => {
      await this.deps.hip.onInit({ transactionId, error: { code: "ABDM-1000", message }, ...answering(m.requestId) }, patientId);
    };
    const holder = abhaAddress === null ? null : await findAbhaHolder(this.deps.db, { abhaAddress }, null);
    const patient = holder === null ? null : await patientRow(this.deps.db, holder.patientId);
    if (patient === null || patient.abhaVerificationStatus !== "verified") { await refuse("Patient not found", null); return; }
    const patientRefs = requested.map((p) => s(p.referenceNumber));
    if (refs.length === 0 || patientRefs.some((r) => r !== null && r !== patient.uhid)) { await refuse("The care contexts do not belong to this patient", patient.id); return; }
    const offered = new Map((await this.unlinkedContexts(patient)).map((c) => [c.referenceNumber, c]));
    if (refs.some((r) => !offered.has(r))) { await refuse("A care context is unknown, not this patient's, or already linked", patient.id); return; }

    const now = this.deps.now();
    const linkRef = randomUUID();
    const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const mobile = patient.phone;
    let sendError: string | null = mobile === null ? "the patient has no mobile number on record" : null;
    if (sendError === null) {
      try {
        await this.deps.otp.send({ mobile: mobile!, patientId: patient.id }, otp, "ABDM care-context linking");
      } catch (e) {
        sendError = e instanceof Error ? e.message : String(e);
      }
    }
    const inserted = await this.deps.db.insert(abdmLinkRequests).values({
      id: newId(), linkRefNumber: linkRef, transactionId, requestId: m.requestId, hipId: this.deps.settings.hipId,
      patientId: patient.id, abhaAddress: abhaAddress!, careContexts: refs,
      otpHash: sendError === null ? this.otpHash(linkRef, otp) : null,
      otpExpiresAt: sendError === null ? new Date(now.getTime() + LINK_OTP_TTL_MS) : null,
      status: sendError === null ? "otp_sent" : "otp_unsent", error: sendError,
    }).onConflictDoNothing().returning({ id: abdmLinkRequests.id });
    if (inserted.length === 0) return; // this init was handled already
    if (sendError !== null) { await refuse(`The hospital could not send the OTP: ${sendError}`, patient.id); return; }
    await this.deps.hip.onInit({
      transactionId,
      link: {
        referenceNumber: linkRef,
        authenticationType: "MEDIATE",
        meta: { communicationMedium: "MOBILE", communicationHint: masked(mobile!), communicationExpiry: new Date(now.getTime() + LINK_OTP_TTL_MS).toISOString() },
      },
      ...answering(m.requestId),
    }, patient.id);
  }

  async handleLinkConfirm(m: AbdmInboundMessage): Promise<void> {
    const confirmation = o(o(m.body).confirmation);
    const linkRef = s(confirmation.linkRefNumber);
    const token = s(confirmation.token);
    const [req] = linkRef === null ? [] : await this.deps.db.select().from(abdmLinkRequests).where(eq(abdmLinkRequests.linkRefNumber, linkRef));
    const refuse = async (code: string, message: string): Promise<void> => {
      await this.deps.hip.onConfirm({ error: { code, message }, ...answering(m.requestId) }, req?.patientId ?? null);
    };
    if (req === undefined || req.hipId !== this.deps.settings.hipId) { await refuse("ABDM-1000", "Unknown link reference"); return; }
    const patient = await patientRow(this.deps.db, req.patientId);
    if (patient === null) { await refuse("ABDM-1000", "Unknown link reference"); return; }
    if (req.status === "linked") { await this.confirmed(m, patient, req.careContexts); return; }
    if (req.status !== "otp_sent" || req.otpHash === null) { await refuse("ABDM-1000", "This link request cannot be confirmed"); return; }
    const now = this.deps.now();
    if (req.otpExpiresAt === null || req.otpExpiresAt.getTime() <= now.getTime()) {
      await this.deps.db.update(abdmLinkRequests).set({ status: "failed", error: "OTP expired", updatedAt: now }).where(eq(abdmLinkRequests.id, req.id));
      await refuse("ABDM-1000", "OTP expired");
      return;
    }
    const given = Buffer.from(this.otpHash(req.linkRefNumber, token ?? ""), "hex");
    const want = Buffer.from(req.otpHash, "hex");
    if (token === null || given.length !== want.length || !timingSafeEqual(given, want)) {
      const attempts = req.attempts + 1;
      await this.deps.db.update(abdmLinkRequests).set({
        attempts, status: attempts >= LINK_OTP_MAX_ATTEMPTS ? "failed" : "otp_sent",
        error: attempts >= LINK_OTP_MAX_ATTEMPTS ? "too many wrong OTPs" : null, updatedAt: now,
      }).where(eq(abdmLinkRequests.id, req.id));
      await refuse("ABDM-1035", "Incorrect OTP");
      return;
    }
    // Right OTP: link every picked context (a completed visit that is still this patient's).
    for (const ref of req.careContexts) {
      const encounter = await getEncounter(this.deps.db, ref);
      if (encounter === null) continue;
      const records = (await loadCareContextRecords(this.deps.db, [{ referenceNumber: ref, encounterId: encounter.id }])).get(ref);
      if (records === undefined) continue;
      await this.deps.db.insert(abdmCareContexts).values({
        id: newId(), patientId: patient.id, encounterId: encounter.id, hipId: this.deps.settings.hipId,
        referenceNumber: ref, patientReference: patient.uhid, display: careContextDisplay(records.visit),
        hiTypes: hiTypesOf(records), abhaAddress: req.abhaAddress,
        status: "linked", linkedVia: "patient", linkedAt: now,
      }).onConflictDoUpdate({
        target: abdmCareContexts.encounterId,
        set: { status: "linked", linkedVia: "patient", linkedAt: now, abhaAddress: req.abhaAddress, lastError: null, updatedAt: now },
      });
    }
    await this.deps.db.update(abdmLinkRequests).set({ status: "linked", updatedAt: now }).where(eq(abdmLinkRequests.id, req.id));
    await this.confirmed(m, patient, req.careContexts);
  }

  private async confirmed(m: AbdmInboundMessage, patient: PatientRow, refs: string[]): Promise<void> {
    const rows = await this.deps.db.select().from(abdmCareContexts)
      .where(and(eq(abdmCareContexts.hipId, this.deps.settings.hipId), inArray(abdmCareContexts.referenceNumber, refs), eq(abdmCareContexts.status, "linked")));
    const offered: Offered[] = rows.map((r) => ({ referenceNumber: r.referenceNumber, display: r.display, encounterId: r.encounterId, hiTypes: r.hiTypes }));
    await this.deps.hip.onConfirm({ patient: this.grouped(patient, offered), ...answering(m.requestId) }, patient.id);
  }
}
