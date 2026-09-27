import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  abdmExternalRecords, abdmHiuConsentArtefacts, abdmHiuConsentRequests, abdmHiuDataRequests,
} from "../../kernel/db/schema";
import { openSecret, randomToken, sealSecret, sha256Hex } from "../../kernel/crypto";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { ABDM_ACTOR, getPatient, listMergedLoserIds } from "../patients";
import { OpdError, getEncounter, requireTreatingDoctor } from "../opd";
import { externalRecordsErased, externalRecordsReceived } from "./events";
import {
  FIDELIUS_CRYPTO_ALG, FIDELIUS_CURVE_NAME, FIDELIUS_KEY_PARAMETERS, FideliusKeyPair, fideliusDecrypt, parseFideliusPublicKey,
} from "./fidelius";
import { classifyBundle, summarizeBundle } from "./fhir-read";
import {
  ABDM_PURPOSES, ALL_HI_TYPES, CONSULT_PURPOSES, DEFAULT_REQUEST_HI_TYPES, HIU_PUSH_PREFIX, HIU_PUSH_TOKEN_PARAM, PURPOSE_REF_URI,
} from "./hiu-client";
import { answering, ok2xx } from "./hip-client";
import { completeInbound, inboundAnswer, insertInbound } from "./messages";
import { REDACTED } from "./redact";
import type { Actor } from "@hmis/contracts";
import type { AbdmInboundMessage } from "./callbacks";
import type { AbdmPurpose, AnyHiType, HiuClient } from "./hiu-client";
import type { AbdmSettings } from "./settings";
import type { ExternalRecordSummary } from "./fhir-read";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ ABDM S3 — M3: THE HOSPITAL FETCHES A PATIENT'S RECORDS FROM OTHER FACILITIES, WITH CONSENT ═══
 *
 * FT HIU_FLOW_101–113, 202, 301. Sources and every path's standing: `hiu-client.ts` (all UNVERIFIED).
 *
 *   1. ASK. The TREATING doctor, in an OPEN consultation (`requireTreatingDoctor` — the consult's own
 *      guard, D5; the route rides `opd.consult`, so no new permission), asks for the patient's
 *      records for their ABDM-VERIFIED ABHA address: purpose (CAREMGT default, BTG allowed), HI types
 *      (the three the consult renders, by default; any of the eight), a date range (the last 12
 *      months) and an expiry (30 days). `consent/v3/request/init` → `on-init` names ABDM's id.
 *   2. THE PATIENT DECIDES in their ABHA app — outside this system. `notify` says GRANTED (with one
 *      artefact per facility), DENIED, or later REVOKED / EXPIRED; `on-status` answers a status check.
 *   3. PER GRANTED ARTEFACT: `consent/v3/fetch` → `on-fetch` (checked: OUR HIU, THIS patient, still
 *      granted, not past `dataEraseAt`) → `health-information/request` with a FRESH Fidelius key pair,
 *      built from the ARTEFACT's date range (ABDM-1063 otherwise) → `on-request` names the transaction.
 *   4. THE PUSH arrives at `{callback base}/hiu/data-push?pt=<token>` (its authentication, and why the
 *      token is a QUERY parameter and not a path segment: `hiu-client.ts`).
 *      Every entry must decrypt under OUR key, match its checksum, be a FHIR document of an HI type
 *      and a care context THE ARTEFACT names — or the page stores NOTHING and the transfer fails.
 *      Accepted documents are stored as EXTERNAL records (`abdm_external_records`), never merged
 *      into our clinical tables, and once every page is in, `health-information/notify` says so.
 *   5. THE END OF A CONSENT DELETES ITS DATA. A REVOKED or EXPIRED notify, or our own clock passing
 *      the artefact's `dataEraseAt` — NHA's wrapper: "Data related to this consent to be deleted on
 *      this date" (`docs_wrapperV3.yaml`, ConsentV3Permission.dataEraseAt); FT HIU_FLOW_202/301:
 *      "not viewable" — DELETES every record held under it (`eraseArtefact`), closes any open
 *      transfer and drops its key, and records the erasure (the artefact's `erased_*`, and
 *      `abdm.external_records_erased` on the spine). The read sweeps expired artefacts FIRST, so an
 *      expired record is never shown even between sweeps.
 *
 * READING THEM (`readExternalRecords`) is `opd.consult`, walks `getPatient`'s confidentiality gate, and
 * writes one `abdm.external_records` PHI-access row per read that returned any.
 *
 * DUPLICATES: callbacks de-duplicate on REQUEST-ID (S0); a push on its ADDRESS and REQUEST-ID (or, when
 * the HIP sends none — the NHA wrapper's HIP does not — its address and the hash of its body), and a
 * document on (consent, care context, MD5 of its plaintext): a page pushed twice is stored once and
 * notified once.
 *
 * KEYS: the private half is generated per request, held only SEALED (`sealPrivateKey`, AES-GCM under
 * SECRET_KEY) and only while the transfer is open; it is never in `abdm_messages` (the request logs
 * our PUBLIC key and nonce, and the push URL's token is scrubbed from it).
 */
const o = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const when = (v: unknown): Date | null => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? new Date(t) : null;
};
const hasError = (v: unknown): boolean => Object.keys(o(v)).length > 0;

export const HIU_DEFAULT_RANGE_MONTHS = 12;
export const HIU_DEFAULT_EXPIRY_DAYS = 30;
export const HIU_MAX_EXPIRY_DAYS = 365;
/** Our key pair's life: the push normally follows within seconds; an hour is ample and then the key is dropped. */
export const HIU_KEY_LIFETIME_MS = 60 * 60_000;
/** The expiry sweep's period in the api (`abdm.module.ts`); the read also sweeps first. */
export const HIU_SWEEP_INTERVAL_MS = 10 * 60_000;
const MAX_ENTRIES_PER_PAGE = 100;
const OPEN_TRANSFER = ["requested", "acknowledged", "receiving"] as const;
const TERMINAL_REQUEST = new Set(["denied", "expired", "revoked", "failed"]);

type RequestRow = typeof abdmHiuConsentRequests.$inferSelect;
type ArtefactRow = typeof abdmHiuConsentArtefacts.$inferSelect;

export type HiuErrorCode =
  | "abdm_hiu_not_configured" | "encounter_not_found" | "not_a_doctor" | "not_your_patient" | "consultation_not_open"
  | "patient_not_found" | "abha_not_verified" | "purpose_not_allowed" | "hi_types_invalid" | "date_range_invalid"
  | "expiry_invalid" | "consent_request_not_found" | "consent_request_not_ready";

export class HiuError extends Error {
  constructor(readonly code: HiuErrorCode, message: string) {
    super(message);
    this.name = "HiuError";
  }
}

export type ConsentRequestInput = {
  encounterId: string;
  purposeCode?: string;
  hiTypes?: string[];
  from?: string;
  to?: string;
  dataEraseAt?: string;
};

export type HiuArtefactView = {
  consentId: string; hipId: string | null; hipName: string | null; status: string;
  dataEraseAt: string | null; erasedAt: string | null; erasedCount: number; recordCount: number; error: string | null;
};
export type HiuRequestView = {
  id: string; encounterId: string; status: string; purposeCode: string; purposeText: string; hiTypes: string[];
  dateFrom: string; dateTo: string; dataEraseAt: string; createdAt: string; requesterName: string;
  consentRequestId: string | null; error: string | null; artefacts: HiuArtefactView[];
};
export type ExternalRecordView = {
  id: string; hiType: string; recordDate: string | null; title: string | null; careContextReference: string;
  consentId: string; consentExpiresAt: string | null; checksumVerified: boolean; receivedAt: string; summary: ExternalRecordSummary;
};
export type ExternalFacility = { hipId: string; hipName: string | null; records: ExternalRecordView[] };
export type PatientExternalRecords = {
  hiuConfigured: boolean;
  abha: { address: string | null; verified: boolean };
  purposes: { code: string; text: string }[];
  hiTypes: string[];
  defaults: { purposeCode: string; hiTypes: string[]; from: string; to: string; dataEraseAt: string };
  requests: HiuRequestView[];
  facilities: ExternalFacility[];
};
export type PushAnswer = { status: number; code: string; message: string };

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const md5 = (text: string): Buffer => createHash("md5").update(text, "utf8").digest();

function defaultsAt(now: Date): { from: Date; to: Date; dataEraseAt: Date } {
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - HIU_DEFAULT_RANGE_MONTHS);
  return { from, to: new Date(now), dataEraseAt: new Date(now.getTime() + HIU_DEFAULT_EXPIRY_DAYS * 86_400_000) };
}

// ═══ THE END OF A CONSENT (usable with ABDM off: stored data is erased whether or not we can talk to ABDM) ═══

/**
 * DELETES every record held under an artefact, closes its open transfers (dropping their keys), and
 * records the erasure. The artefact moves to `reason` if it was still GRANTED; the event is appended
 * once per artefact (its first erasure) and again only if a later one actually deleted rows.
 */
export async function eraseArtefact(
  db: Db, art: ArtefactRow, reason: "REVOKED" | "EXPIRED", by: "abdm_notify" | "data_erase_at", now: Date,
): Promise<number> {
  return withTx(db, async (tx) => {
    const deleted = await tx.delete(abdmExternalRecords).where(eq(abdmExternalRecords.artefactId, art.id)).returning({ id: abdmExternalRecords.id });
    await tx.update(abdmHiuDataRequests).set({ status: "erased", privateKeySealed: null, error: `consent ${reason}`, updatedAt: now })
      .where(and(eq(abdmHiuDataRequests.artefactId, art.id), inArray(abdmHiuDataRequests.status, [...OPEN_TRANSFER])));
    const moved = await tx.update(abdmHiuConsentArtefacts).set({ status: reason, updatedAt: now })
      .where(and(eq(abdmHiuConsentArtefacts.id, art.id), eq(abdmHiuConsentArtefacts.status, "GRANTED"))).returning({ id: abdmHiuConsentArtefacts.id });
    const n = deleted.length;
    if (moved.length > 0 || n > 0) {
      await tx.update(abdmHiuConsentArtefacts).set({
        erasedAt: now, erasedCount: sql`${abdmHiuConsentArtefacts.erasedCount} + ${n}`, eraseReason: `${reason} (${by})`, updatedAt: now,
      }).where(eq(abdmHiuConsentArtefacts.id, art.id));
      await appendEvent(tx, externalRecordsErased.make({
        actor: ABDM_ACTOR, patientId: art.patientId, correlationId: art.consentId,
        idempotencyKey: moved.length > 0 ? `abdm.external_records_erased:${art.consentId}` : `abdm.external_records_erased:${art.consentId}:${now.getTime()}`,
        payload: { consentId: art.consentId, hipId: art.hipId, reason, by, erased: n },
      }));
    }
    return n;
  });
}

/** Our own clock: every GRANTED artefact past `dataEraseAt`, erased; every transfer whose key expired, closed. */
export async function purgeExpiredExternalRecords(db: Db, now: Date): Promise<{ artefacts: number; records: number }> {
  const due = await db.select().from(abdmHiuConsentArtefacts)
    .where(and(eq(abdmHiuConsentArtefacts.status, "GRANTED"), lte(abdmHiuConsentArtefacts.dataEraseAt, now)));
  let records = 0;
  for (const art of due) records += await eraseArtefact(db, art, "EXPIRED", "data_erase_at", now);
  await db.update(abdmHiuDataRequests).set({ status: "failed", privateKeySealed: null, error: "our key expired before the transfer completed", updatedAt: now })
    .where(and(inArray(abdmHiuDataRequests.status, [...OPEN_TRANSFER]), lte(abdmHiuDataRequests.keyExpiresAt, now)));
  await db.update(abdmHiuConsentRequests).set({ status: "expired", updatedAt: now })
    .where(and(inArray(abdmHiuConsentRequests.status, ["requested", "awaiting_patient"]), lte(abdmHiuConsentRequests.dataEraseAt, now)));
  return { artefacts: due.length, records };
}

// ═══ THE READ ═══

function requestView(r: RequestRow, arts: ArtefactRow[], counts: Map<string, number>): HiuRequestView {
  return {
    id: r.id, encounterId: r.encounterId, status: r.status, purposeCode: r.purposeCode,
    purposeText: ABDM_PURPOSES[r.purposeCode as AbdmPurpose] ?? r.purposeCode, hiTypes: r.hiTypes,
    dateFrom: r.dateFrom.toISOString(), dateTo: r.dateTo.toISOString(), dataEraseAt: r.dataEraseAt.toISOString(),
    createdAt: r.createdAt.toISOString(), requesterName: r.requesterName, consentRequestId: r.consentRequestId, error: r.error,
    artefacts: arts.map((a) => ({
      consentId: a.consentId, hipId: a.hipId, hipName: a.hipName, status: a.status, dataEraseAt: iso(a.dataEraseAt),
      erasedAt: iso(a.erasedAt), erasedCount: a.erasedCount, recordCount: counts.get(a.id) ?? 0, error: a.error,
    })),
  };
}

/**
 * "Records from other hospitals" for one patient: the requests and their status (FT HIU_FLOW_104), and
 * the RECEIVED records grouped by facility, newest first. Expired artefacts are erased BEFORE the read.
 */
export async function readExternalRecords(
  db: Db, actor: Actor, patientId: string, opts: { hiuConfigured: boolean; now: Date },
): Promise<PatientExternalRecords> {
  await purgeExpiredExternalRecords(db, opts.now);
  const visible = await getPatient(db, actor, patientId);
  if (visible === null) throw new HiuError("patient_not_found", `unknown patient ${patientId}`);
  const p = visible.patient;
  const chain = [p.id, ...(await listMergedLoserIds(db, p.id))];
  const requests = await db.select().from(abdmHiuConsentRequests).where(inArray(abdmHiuConsentRequests.patientId, chain))
    .orderBy(desc(abdmHiuConsentRequests.createdAt)).limit(50);
  const arts = requests.length === 0 ? [] : await db.select().from(abdmHiuConsentArtefacts)
    .where(inArray(abdmHiuConsentArtefacts.hiuRequestId, requests.map((r) => r.id))).orderBy(asc(abdmHiuConsentArtefacts.createdAt));
  const records = await db.select().from(abdmExternalRecords).where(inArray(abdmExternalRecords.patientId, chain))
    .orderBy(desc(abdmExternalRecords.recordDate), desc(abdmExternalRecords.receivedAt)).limit(500);
  const artById = new Map(arts.map((a) => [a.id, a]));
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.artefactId, (counts.get(r.artefactId) ?? 0) + 1);

  const byHip = new Map<string, ExternalFacility>();
  for (const r of records) {
    const art = artById.get(r.artefactId);
    const summary = summarizeBundle(r.bundle);
    const facility = byHip.get(r.hipId) ?? { hipId: r.hipId, hipName: art?.hipName ?? r.hipName ?? summary.custodian, records: [] };
    facility.records.push({
      id: r.id, hiType: r.hiType, recordDate: iso(r.recordDate), title: r.title ?? summary.title, careContextReference: r.careContextReference,
      consentId: r.consentId, consentExpiresAt: iso(art?.dataEraseAt ?? null), checksumVerified: r.checksumVerified,
      receivedAt: r.receivedAt.toISOString(), summary,
    });
    byHip.set(r.hipId, facility);
  }
  if (records.length > 0) {
    await recordPhiAccess(db, {
      actor, patientId: p.id, surface: "abdm.external_records", sealed: p.isConfidential,
      reason: visible.breakGlass?.reason ?? null, now: opts.now,
    });
  }
  const d = defaultsAt(opts.now);
  return {
    hiuConfigured: opts.hiuConfigured,
    abha: { address: p.abhaAddress, verified: p.abhaVerificationStatus === "verified" && p.abhaAddress !== null },
    purposes: CONSULT_PURPOSES.map((code) => ({ code, text: ABDM_PURPOSES[code] })),
    hiTypes: [...ALL_HI_TYPES],
    defaults: {
      purposeCode: "CAREMGT", hiTypes: [...DEFAULT_REQUEST_HI_TYPES],
      from: d.from.toISOString(), to: d.to.toISOString(), dataEraseAt: d.dataEraseAt.toISOString(),
    },
    requests: requests.map((r) => requestView(r, arts.filter((a) => a.hiuRequestId === r.id), counts)),
    facilities: [...byHip.values()],
  };
}

// ═══ THE HIU, WHEN ABDM IS CONFIGURED WITH AN HIU ID ═══

export class Hiu {
  constructor(private readonly deps: {
    db: Db; settings: AbdmSettings; hiuId: string; client: HiuClient; secretKey: Buffer; now: () => Date;
    /** Tests only — a known key pair per health-information request (the README vector's requester key). */
    keyPair?: () => FideliusKeyPair;
  }) {}

  // ——— 1. ask ———

  async requestConsent(actor: Actor, input: ConsentRequestInput): Promise<HiuRequestView> {
    const { db, hiuId, client } = this.deps;
    const now = this.deps.now();
    const enc = await getEncounter(db, input.encounterId);
    if (!enc) throw new HiuError("encounter_not_found", `unknown encounter ${input.encounterId}`);
    let doctor;
    try {
      doctor = await requireTreatingDoctor(db, actor, enc);
    } catch (e) {
      if (e instanceof OpdError) throw new HiuError(e.code === "not_your_patient" ? "not_your_patient" : "not_a_doctor", e.message);
      throw e;
    }
    if (enc.status !== "in_consultation") throw new HiuError("consultation_not_open", `records are requested from an open consultation, not a ${enc.status} visit`);
    const visible = await getPatient(db, actor, enc.patientId);
    if (visible === null) throw new HiuError("patient_not_found", `unknown patient ${enc.patientId}`);
    const p = visible.patient;
    if (p.abhaVerificationStatus !== "verified" || p.abhaAddress === null) {
      throw new HiuError("abha_not_verified", "the patient has no ABDM-verified ABHA address — verify it at the counter first");
    }

    const purposeCode = input.purposeCode ?? "CAREMGT";
    if (!(CONSULT_PURPOSES as readonly string[]).includes(purposeCode)) {
      throw new HiuError("purpose_not_allowed", `a consultation asks for ${CONSULT_PURPOSES.join(" or ")}, not ${purposeCode}`);
    }
    const hiTypes = [...new Set(input.hiTypes ?? DEFAULT_REQUEST_HI_TYPES)];
    if (hiTypes.length === 0 || hiTypes.some((t) => !(ALL_HI_TYPES as readonly string[]).includes(t))) {
      throw new HiuError("hi_types_invalid", `HI types are one or more of ${ALL_HI_TYPES.join(", ")}`);
    }
    const d = defaultsAt(now);
    const from = input.from === undefined ? d.from : when(input.from);
    const to = input.to === undefined ? d.to : when(input.to);
    if (from === null || to === null || from.getTime() >= to.getTime()) throw new HiuError("date_range_invalid", "the date range must run forwards");
    const eraseAt = input.dataEraseAt === undefined ? d.dataEraseAt : when(input.dataEraseAt);
    if (eraseAt === null || eraseAt.getTime() <= now.getTime() || eraseAt.getTime() > now.getTime() + HIU_MAX_EXPIRY_DAYS * 86_400_000) {
      throw new HiuError("expiry_invalid", `the consent's expiry must be in the future and within ${HIU_MAX_EXPIRY_DAYS} days`);
    }

    const requestId = randomUUID();
    const [row] = await db.insert(abdmHiuConsentRequests).values({
      id: newId(), patientId: p.id, encounterId: enc.id, requestedBy: actor.id, requesterName: doctor.displayName,
      requesterRegNo: doctor.registrationNo, hiuId, abhaAddress: p.abhaAddress, purposeCode, hiTypes,
      dateFrom: from, dateTo: to, dataEraseAt: eraseAt, requestId, status: "requested",
    }).returning();
    const regNo = s(doctor.registrationNo);
    const body = {
      consent: {
        purpose: { text: ABDM_PURPOSES[purposeCode as AbdmPurpose], code: purposeCode, refUri: PURPOSE_REF_URI },
        patient: { id: p.abhaAddress },
        hiu: { id: hiuId },
        requester: {
          name: doctor.displayName,
          identifier: regNo !== null
            ? { type: "REGNO", value: regNo, system: "https://www.mciindia.org" }
            : { type: "EI", value: doctor.code, system: `urn:hmis:hiu:${hiuId}:doctor` },
        },
        hiTypes,
        permission: {
          accessMode: "VIEW",
          dateRange: { from: from.toISOString(), to: to.toISOString() },
          dataEraseAt: eraseAt.toISOString(),
          frequency: { unit: "HOUR", value: 1, repeats: 0 },
        },
      },
    };
    let failure: string | null = null;
    try {
      const res = await client.consentInit(body, { patientId: p.id, requestId, actorId: actor.id });
      if (!ok2xx(res)) failure = `ABDM refused the consent request (HTTP ${res.status})${errorText(res.body)}`;
    } catch (e) {
      failure = `ABDM could not be reached: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (failure !== null) {
      await db.update(abdmHiuConsentRequests).set({ status: "failed", error: failure.slice(0, 1000), updatedAt: this.deps.now() })
        .where(and(eq(abdmHiuConsentRequests.id, row!.id), eq(abdmHiuConsentRequests.status, "requested")));
    }
    return this.view(row!.id);
  }

  /** FT HIU_FLOW_104 — ask ABDM where a request stands; `on-status` answers. */
  async refreshStatus(actor: Actor, id: string): Promise<HiuRequestView> {
    const { db, client } = this.deps;
    const [row] = await db.select().from(abdmHiuConsentRequests).where(eq(abdmHiuConsentRequests.id, id));
    if (!row || (await getPatient(db, actor, row.patientId)) === null) throw new HiuError("consent_request_not_found", `unknown consent request ${id}`);
    if (row.consentRequestId === null) throw new HiuError("consent_request_not_ready", "ABDM has not yet acknowledged this request");
    let error: string | null = null;
    try {
      const res = await client.consentStatus({ consentRequestId: row.consentRequestId }, { patientId: row.patientId, actorId: actor.id });
      if (!ok2xx(res)) error = `ABDM refused the status check (HTTP ${res.status})${errorText(res.body)}`;
    } catch (e) {
      error = `ABDM could not be reached: ${e instanceof Error ? e.message : String(e)}`;
    }
    await db.update(abdmHiuConsentRequests).set({ statusCheckedAt: this.deps.now(), ...(error === null ? {} : { error }), updatedAt: this.deps.now() })
      .where(eq(abdmHiuConsentRequests.id, id));
    return this.view(id);
  }

  private async view(id: string): Promise<HiuRequestView> {
    const [r] = await this.deps.db.select().from(abdmHiuConsentRequests).where(eq(abdmHiuConsentRequests.id, id));
    const arts = await this.deps.db.select().from(abdmHiuConsentArtefacts).where(eq(abdmHiuConsentArtefacts.hiuRequestId, id));
    return requestView(r!, arts, new Map());
  }

  // ——— 2. ABDM's answers about the consent ———

  async handleOnInit(m: AbdmInboundMessage): Promise<void> {
    const body = o(m.body);
    const row = await this.requestBy(eq(abdmHiuConsentRequests.requestId, m.correlationRequestId ?? ""));
    if (row === null) throw new Error(`on-init answers no consent request of ours (${m.correlationRequestId ?? "no response.requestId"})`);
    const id = s(o(body.consentRequest).id);
    const now = this.deps.now();
    if (id === null || hasError(body.error)) {
      await this.deps.db.update(abdmHiuConsentRequests).set({ status: "failed", error: s(o(body.error).message) ?? "ABDM refused the consent request", updatedAt: now })
        .where(and(eq(abdmHiuConsentRequests.id, row.id), eq(abdmHiuConsentRequests.status, "requested")));
      return;
    }
    await this.deps.db.update(abdmHiuConsentRequests).set({ consentRequestId: id, status: "awaiting_patient", updatedAt: now })
      .where(and(eq(abdmHiuConsentRequests.id, row.id), eq(abdmHiuConsentRequests.status, "requested")));
  }

  async handleOnStatus(m: AbdmInboundMessage): Promise<void> {
    const cr = o(o(m.body).consentRequest);
    const row = await this.requestBy(eq(abdmHiuConsentRequests.consentRequestId, s(cr.id) ?? ""));
    if (row === null) throw new Error("on-status names no consent request of ours");
    const next = ({ REQUESTED: "awaiting_patient", GRANTED: "granted", DENIED: "denied", EXPIRED: "expired", REVOKED: "revoked" } as Record<string, string>)[(s(cr.status) ?? "").toUpperCase()];
    const now = this.deps.now();
    // A terminal answer never moves again; "granted" moves only to its end; nothing moves backwards.
    const allowed = next !== undefined && !TERMINAL_REQUEST.has(row.status) && !(row.status === "granted" && (next === "awaiting_patient" || next === "denied"));
    await this.deps.db.update(abdmHiuConsentRequests).set({ ...(allowed ? { status: next } : {}), statusCheckedAt: now, updatedAt: now })
      .where(eq(abdmHiuConsentRequests.id, row.id));
  }

  /** `consent/request/notify` — GRANTED (with artefacts), DENIED, REVOKED, EXPIRED. Acknowledged in an ARRAY. */
  async handleNotify(m: AbdmInboundMessage): Promise<void> {
    const { db, client } = this.deps;
    const n = o(o(m.body).notification);
    const status = (s(n.status) ?? "").toUpperCase();
    const artefactIds = [...new Set(arr(n.consentArtefacts).map((a) => s(o(a).id)).filter((x): x is string => x !== null))];
    const crId = s(n.consentRequestId);
    let request = crId === null ? null : await this.requestBy(eq(abdmHiuConsentRequests.consentRequestId, crId));
    const now = this.deps.now();
    const ack = async (error: { code: string; message: string } | null, patientId: string | null): Promise<void> => {
      await client.consentOnNotify({
        acknowledgement: error === null ? artefactIds.map((consentId) => ({ status: "OK", consentId })) : [],
        ...(error === null ? {} : { error }),
        ...answering(m.requestId),
      }, patientId);
    };

    if (status === "GRANTED") {
      if (request === null || request.status === "failed" || request.status === "denied") {
        await ack({ code: "ABDM-1000", message: request === null ? "This consent request is not known to this HIU" : `This consent request is ${request.status}` }, request?.patientId ?? null);
        return;
      }
      if (artefactIds.length === 0) { await ack({ code: "ABDM-1000", message: "A GRANTED consent names no artefact" }, request.patientId); return; }
      await db.update(abdmHiuConsentRequests).set({ status: "granted", updatedAt: now })
        .where(and(eq(abdmHiuConsentRequests.id, request.id), inArray(abdmHiuConsentRequests.status, ["requested", "awaiting_patient", "granted"])));
      for (const consentId of artefactIds) {
        await db.insert(abdmHiuConsentArtefacts).values({ id: newId(), hiuRequestId: request.id, consentId, patientId: request.patientId, status: "GRANTED" })
          .onConflictDoNothing();
      }
      await ack(null, request.patientId);
      // Fetch each artefact ONCE: the fetch request id is claimed before it is sent.
      for (const consentId of artefactIds) {
        const requestId = randomUUID();
        const claimed = await db.update(abdmHiuConsentArtefacts).set({ fetchRequestId: requestId, updatedAt: now })
          .where(and(eq(abdmHiuConsentArtefacts.consentId, consentId), eq(abdmHiuConsentArtefacts.hiuRequestId, request.id), isNull(abdmHiuConsentArtefacts.fetchRequestId)))
          .returning({ id: abdmHiuConsentArtefacts.id });
        if (claimed.length === 0) continue;
        const res = await client.consentFetch({ consentId }, { patientId: request.patientId, requestId });
        if (!ok2xx(res)) {
          await db.update(abdmHiuConsentArtefacts).set({ error: `ABDM refused the artefact fetch (HTTP ${res.status})`, updatedAt: this.deps.now() })
            .where(eq(abdmHiuConsentArtefacts.id, claimed[0]!.id));
        }
      }
      return;
    }
    if (status === "DENIED") {
      if (request !== null) {
        await db.update(abdmHiuConsentRequests).set({ status: "denied", updatedAt: now })
          .where(and(eq(abdmHiuConsentRequests.id, request.id), inArray(abdmHiuConsentRequests.status, ["requested", "awaiting_patient"])));
      }
      await ack(null, request?.patientId ?? null);
      return;
    }
    if (status === "REVOKED" || status === "EXPIRED") {
      const held = artefactIds.length === 0 ? [] : await db.select().from(abdmHiuConsentArtefacts).where(inArray(abdmHiuConsentArtefacts.consentId, artefactIds));
      for (const art of held) await eraseArtefact(db, art, status, "abdm_notify", now);
      if (request === null && held[0] !== undefined) request = await this.requestBy(eq(abdmHiuConsentRequests.id, held[0].hiuRequestId));
      if (request !== null) {
        const all = await db.select({ status: abdmHiuConsentArtefacts.status }).from(abdmHiuConsentArtefacts).where(eq(abdmHiuConsentArtefacts.hiuRequestId, request.id));
        if (all.every((a) => a.status !== "GRANTED")) {
          await db.update(abdmHiuConsentRequests).set({ status: status === "REVOKED" ? "revoked" : "expired", updatedAt: now })
            .where(and(eq(abdmHiuConsentRequests.id, request.id), inArray(abdmHiuConsentRequests.status, ["requested", "awaiting_patient", "granted"])));
        }
      }
      await ack(null, request?.patientId ?? held[0]?.patientId ?? null);
      return;
    }
    await ack({ code: "ABDM-1000", message: `Unknown consent status ${status || "(none)"}` }, request?.patientId ?? null);
  }

  /** `consent/on-fetch` — the artefact itself. Checked, stored, and then the data is asked for, once. */
  async handleOnFetch(m: AbdmInboundMessage): Promise<void> {
    const { db, hiuId } = this.deps;
    const body = o(m.body);
    const consent = o(body.consent);
    const detail = o(consent.consentDetail);
    const consentId = s(detail.consentId);
    const [art] = await db.select().from(abdmHiuConsentArtefacts).where(consentId !== null
      ? eq(abdmHiuConsentArtefacts.consentId, consentId)
      : eq(abdmHiuConsentArtefacts.fetchRequestId, m.correlationRequestId ?? ""));
    if (!art) throw new Error(`on-fetch delivers an artefact this HIU never asked for (${consentId ?? "no consentId"})`);
    if (art.fetchedAt !== null) return;
    const now = this.deps.now();
    const refuse = async (error: string): Promise<void> => {
      await db.update(abdmHiuConsentArtefacts).set({ error, updatedAt: now }).where(eq(abdmHiuConsentArtefacts.id, art.id));
    };
    if (hasError(body.error) || consentId === null) { await refuse(s(o(body.error).message) ?? "ABDM returned no artefact"); return; }
    const request = await this.requestBy(eq(abdmHiuConsentRequests.id, art.hiuRequestId));
    if (s(o(detail.hiu).id) !== hiuId) { await refuse("the artefact names another HIU"); return; }
    if ((s(o(detail.patient).id) ?? "").toLowerCase() !== (request?.abhaAddress ?? "").toLowerCase()) { await refuse("the artefact names another patient"); return; }
    const status = (s(consent.status) ?? "GRANTED").toUpperCase();
    if (status !== "GRANTED" || art.status !== "GRANTED") { await refuse(`the artefact is ${status !== "GRANTED" ? status : art.status}`); return; }
    const permission = o(detail.permission);
    const range = o(permission.dateRange);
    const dateFrom = when(range.from);
    const dateTo = when(range.to);
    const dataEraseAt = when(permission.dataEraseAt);
    if (dateFrom === null || dateTo === null || dataEraseAt === null) { await refuse("the artefact carries no date range or expiry"); return; }
    const values = {
      hipId: s(o(detail.hip).id), hipName: s(o(detail.hip).name),
      careContexts: arr(detail.careContexts).map(o)
        .map((c) => ({ patientReference: s(c.patientReference) ?? "", careContextReference: s(c.careContextReference) ?? "" }))
        .filter((c) => c.careContextReference !== ""),
      hiTypes: arr(detail.hiTypes).map((t) => s(t)).filter((t): t is string => t !== null),
      dateFrom, dateTo, dataEraseAt, accessMode: s(permission.accessMode), artefact: detail, signature: s(consent.signature),
      fetchedAt: now, error: null, updatedAt: now,
    };
    const [stored] = await db.update(abdmHiuConsentArtefacts).set(values)
      .where(and(eq(abdmHiuConsentArtefacts.id, art.id), isNull(abdmHiuConsentArtefacts.fetchedAt), eq(abdmHiuConsentArtefacts.status, "GRANTED"))).returning();
    if (!stored) return;
    if (dataEraseAt.getTime() <= now.getTime()) { await eraseArtefact(db, stored, "EXPIRED", "data_erase_at", now); return; }
    if (stored.hipId === null) { await refuse("the artefact names no HIP"); return; }
    await this.requestData(stored);
  }

  // ——— 3. the health-information request ———

  private async requestData(art: ArtefactRow): Promise<void> {
    const { db, settings, secretKey, client } = this.deps;
    const now = this.deps.now();
    const own = this.deps.keyPair?.() ?? FideliusKeyPair.generate();
    const token = randomToken();
    const requestId = randomUUID();
    const keyExpiresAt = new Date(Math.min(now.getTime() + HIU_KEY_LIFETIME_MS, art.dataEraseAt!.getTime()));
    const id = newId();
    await db.insert(abdmHiuDataRequests).values({
      id, artefactId: art.id, consentId: art.consentId, patientId: art.patientId, requestId,
      pushTokenHash: sha256Hex(token), publicKey: own.publicKeyX509(), nonce: own.nonce,
      privateKeySealed: own.sealPrivateKey((p) => sealSecret(secretKey, p)),
      keyExpiresAt, dateFrom: art.dateFrom!, dateTo: art.dateTo!, status: "requested",
    });
    const body = {
      hiRequest: {
        consent: { id: art.consentId },
        dateRange: { from: art.dateFrom!.toISOString(), to: art.dateTo!.toISOString() },
        dataPushUrl: `${settings.callbackBaseUrl}${HIU_PUSH_PREFIX}?${HIU_PUSH_TOKEN_PARAM}=${token}`,
        keyMaterial: {
          cryptoAlg: FIDELIUS_CRYPTO_ALG, curve: FIDELIUS_CURVE_NAME,
          dhPublicKey: { expiry: keyExpiresAt.toISOString(), parameters: FIDELIUS_KEY_PARAMETERS, keyValue: own.publicKeyX509() },
          nonce: own.nonce,
        },
      },
    };
    let failure: string | null = null;
    try {
      // The token is a credential: `secrets` scrubs it out of the logged body.
      const res = await client.hiRequest(body, { patientId: art.patientId, requestId, secrets: [token] });
      if (!ok2xx(res)) failure = `ABDM refused the health-information request (HTTP ${res.status})${errorText(res.body)}`;
    } catch (e) {
      failure = `ABDM could not be reached: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (failure !== null) await this.closeTransfer(id, "failed", failure);
  }

  async handleOnHiRequest(m: AbdmInboundMessage): Promise<void> {
    const { db } = this.deps;
    const body = o(m.body);
    const hi = o(body.hiRequest);
    const [row] = await db.select().from(abdmHiuDataRequests).where(eq(abdmHiuDataRequests.requestId, m.correlationRequestId ?? ""));
    if (!row) throw new Error(`on-request answers no health-information request of ours (${m.correlationRequestId ?? "no response.requestId"})`);
    const txn = s(hi.transactionId);
    if (hasError(body.error) || txn === null || (s(hi.sessionStatus) ?? "").toUpperCase() === "FAILED") {
      await this.closeTransfer(row.id, "failed", s(o(body.error).message) ?? "ABDM refused the health-information request");
      return;
    }
    if (row.transactionId !== null && row.transactionId !== txn) {
      await this.closeTransfer(row.id, "failed", "on-request names a different transaction than the push did");
      return;
    }
    await db.update(abdmHiuDataRequests).set({
      transactionId: txn, status: sql`case when ${abdmHiuDataRequests.status} = 'requested' then 'acknowledged' else ${abdmHiuDataRequests.status} end`,
      updatedAt: this.deps.now(),
    }).where(and(eq(abdmHiuDataRequests.id, row.id), inArray(abdmHiuDataRequests.status, [...OPEN_TRANSFER])));
  }

  private async closeTransfer(id: string, status: "failed" | "received", error: string | null): Promise<boolean> {
    const closed = await this.deps.db.update(abdmHiuDataRequests).set({ status, privateKeySealed: null, error, updatedAt: this.deps.now() })
      .where(and(eq(abdmHiuDataRequests.id, id), inArray(abdmHiuDataRequests.status, [...OPEN_TRANSFER]))).returning({ id: abdmHiuDataRequests.id });
    return closed.length > 0;
  }

  // ——— 4. the push ———

  /**
   * One page of a data push. Logged (as a summary: no ciphertext, no key), answered with what its
   * processing decided, and a re-delivered page gets the first answer again.
   */
  async receivePush(token: string, headers: Record<string, string>, body: unknown): Promise<PushAnswer> {
    const { db } = this.deps;
    const b = o(body);
    const km = o(b.keyMaterial);
    const dh = o(km.dhPublicKey);
    const entries = arr(b.entries).map(o);
    const summary = {
      pageNumber: b.pageNumber ?? null, pageCount: b.pageCount ?? null, transactionId: s(b.transactionId),
      keyMaterial: { cryptoAlg: s(km.cryptoAlg), curve: s(km.curve), dhPublicKey: { expiry: dh.expiry ?? null, parameters: dh.parameters ?? null, keyValue: s(dh.keyValue) }, nonce: s(km.nonce) },
      entries: entries.map((e) => ({ careContextReference: s(e.careContextReference), media: s(e.media), checksum: s(e.checksum), contentBytes: typeof e.content === "string" ? e.content.length : 0 })),
    };
    // A page's identity is its ADDRESS and its REQUEST-ID — or, when the HIP sends none, its body — so
    // the same body (or id) at another address is another message, answered for that address, and a
    // push can never pre-empt an ABDM callback's REQUEST-ID (the log's inbound de-duplication key).
    const address = sha256Hex(token).slice(0, 24);
    const given = s(headers["request-id"]);
    const requestId = given !== null ? `push:${address}:${given}` : `push:${address}:body:${sha256Hex(JSON.stringify(body ?? null))}`;
    // An address we never issued is answered before anything is written: a stranger's POSTs to made-up
    // addresses carry nothing of ours and must not be able to grow the message log.
    const [known] = await db.select({ id: abdmHiuDataRequests.id }).from(abdmHiuDataRequests).where(eq(abdmHiuDataRequests.pushTokenHash, sha256Hex(token)));
    if (!known) return { status: 404, code: "unknown_transfer", message: "no health-information request of this HIU has this push address" };
    const messageId = await insertInbound(db, {
      kind: "hiu.data_push", path: `/abdm/callbacks${HIU_PUSH_PREFIX}?${HIU_PUSH_TOKEN_PARAM}=${REDACTED}`, requestId, correlationRequestId: null,
      headers, body: summary, httpStatus: 202,
    });
    if (messageId === null) {
      const first = await inboundAnswer(db, requestId);
      const status = first?.httpStatus ?? 202;
      return { status, code: "duplicate", message: status < 300 ? "this page was already received" : (first?.error ?? "this page was already refused") };
    }
    let patientId: string | null = null;
    let answer: PushAnswer;
    try {
      const r = await this.processPush(token, b, entries);
      patientId = r.patientId;
      answer = r.answer;
    } catch (e) {
      answer = { status: 500, code: "push_failed", message: e instanceof Error ? e.message.slice(0, 500) : String(e) };
    }
    await completeInbound(db, messageId, {
      httpStatus: answer.status, dispatch: answer.status < 300 ? "handled" : "failed",
      error: answer.status < 300 ? null : `${answer.code}: ${answer.message}`, patientId,
    });
    return answer;
  }

  private async processPush(token: string, b: Record<string, unknown>, entries: Record<string, unknown>[]): Promise<{ answer: PushAnswer; patientId: string | null }> {
    const { db, secretKey } = this.deps;
    const now = this.deps.now();
    const refuse = (status: number, code: string, message: string, patientId: string | null = null) => ({ answer: { status, code, message }, patientId });
    const [dr] = await db.select().from(abdmHiuDataRequests).where(eq(abdmHiuDataRequests.pushTokenHash, sha256Hex(token)));
    if (!dr) return refuse(404, "unknown_transfer", "no health-information request of this HIU has this push address");
    const patientId = dr.patientId;
    const [art] = await db.select().from(abdmHiuConsentArtefacts).where(eq(abdmHiuConsentArtefacts.id, dr.artefactId));
    if (!art || art.status !== "GRANTED") return refuse(410, "consent_not_active", `the consent is ${art?.status ?? "unknown"}; nothing is stored`, patientId);
    if (art.dataEraseAt === null || art.dataEraseAt.getTime() <= now.getTime()) {
      await eraseArtefact(db, art, "EXPIRED", "data_erase_at", now);
      return refuse(410, "consent_expired", "the consent has expired (dataEraseAt); nothing is stored", patientId);
    }
    if (!(OPEN_TRANSFER as readonly string[]).includes(dr.status) || dr.privateKeySealed === null) {
      return refuse(409, "transfer_closed", `this transfer is ${dr.status}`, patientId);
    }
    if (dr.keyExpiresAt.getTime() <= now.getTime()) {
      await this.closeTransfer(dr.id, "failed", "our key expired before the push");
      return refuse(410, "key_expired", "the key material of this request has expired", patientId);
    }
    const txn = s(b.transactionId);
    if (txn === null) return refuse(400, "invalid_push", "transactionId is required", patientId);
    if (dr.transactionId !== null && dr.transactionId !== txn) return refuse(409, "transaction_mismatch", "the push names another transaction", patientId);
    const pageCount = typeof b.pageCount === "number" && Number.isInteger(b.pageCount) ? b.pageCount : null;
    const pageNumber = typeof b.pageNumber === "number" && Number.isInteger(b.pageNumber) ? b.pageNumber : null;
    if (pageCount === null || pageNumber === null || pageCount < 1 || pageNumber < 0 || pageNumber > pageCount) {
      return refuse(400, "invalid_push", "pageNumber and pageCount must be integers, 0 ≤ pageNumber ≤ pageCount, pageCount ≥ 1", patientId);
    }
    if (entries.length === 0 || entries.length > MAX_ENTRIES_PER_PAGE) return refuse(400, "invalid_push", `a page carries 1–${MAX_ENTRIES_PER_PAGE} entries`, patientId);
    const km = o(b.keyMaterial);
    const sender = { publicKey: s(o(km.dhPublicKey).keyValue) ?? "", nonce: s(km.nonce) ?? "" };
    try {
      parseFideliusPublicKey(sender.publicKey);
      if (Buffer.from(sender.nonce, "base64").length !== 32) throw new Error("nonce");
    } catch {
      return refuse(400, "invalid_key_material", "the push's key material is not a Curve25519 public key and a 32-byte nonce", patientId);
    }
    if (dr.transactionId === null) {
      // The push may beat `on-request` (spec §5): the address authenticates it, and it binds the transaction.
      try {
        const bound = await db.update(abdmHiuDataRequests).set({ transactionId: txn, updatedAt: now })
          .where(and(eq(abdmHiuDataRequests.id, dr.id), isNull(abdmHiuDataRequests.transactionId))).returning({ id: abdmHiuDataRequests.id });
        if (bound.length === 0) {
          const [again] = await db.select({ t: abdmHiuDataRequests.transactionId }).from(abdmHiuDataRequests).where(eq(abdmHiuDataRequests.id, dr.id));
          if (again?.t !== txn) return refuse(409, "transaction_mismatch", "the push names another transaction", patientId);
        }
      } catch {
        return refuse(409, "transaction_mismatch", "that transaction belongs to another request", patientId);
      }
    }

    // EVERY entry is checked before ANY is stored: one bad entry refuses the page.
    const own = FideliusKeyPair.fromSealed(dr.privateKeySealed, dr.nonce, (x) => openSecret(secretKey, x));
    const allowedRefs = new Set(art.careContexts.map((c) => c.careContextReference));
    const accepted: { ref: string; hiType: AnyHiType; title: string | null; date: Date | null; checksum: string; verified: boolean; bundle: Record<string, unknown> }[] = [];
    const refs = entries.map((e) => s(e.careContextReference) ?? "(none)");
    let integrity: string | null = null;
    for (const e of entries) {
      const ref = s(e.careContextReference);
      if (ref === null) { integrity = "an entry names no care context"; break; }
      if (allowedRefs.size > 0 && !allowedRefs.has(ref)) { integrity = `entry ${ref} is a care context the consent does not name`; break; }
      const media = s(e.media);
      if (media !== null && !/^application\/(fhir\+)?json/i.test(media)) { integrity = `entry ${ref} is ${media}, not a FHIR JSON document`; break; }
      if (typeof e.content !== "string" || e.content === "") { integrity = `entry ${ref} carries no content`; break; }
      let plain: string;
      try {
        plain = fideliusDecrypt(own, sender, e.content);
      } catch {
        integrity = `entry ${ref} does not decrypt under this request's key`;
        break;
      }
      const digest = md5(plain);
      const given = s(e.checksum);
      const isMd5 = given !== null && (/^[0-9a-f]{32}$/i.test(given) || /^[A-Za-z0-9+/]{22}==$/.test(given));
      if (isMd5 && given!.toLowerCase() !== digest.toString("hex") && given !== digest.toString("base64")) {
        integrity = `entry ${ref} fails its checksum`;
        break;
      }
      let bundle: unknown;
      try { bundle = JSON.parse(plain); } catch { integrity = `entry ${ref} is not JSON`; break; }
      const verdict = classifyBundle(bundle);
      if (!verdict.ok) { integrity = `entry ${ref}: ${verdict.reason}`; break; }
      if (!art.hiTypes.includes(verdict.hiType)) { integrity = `entry ${ref} is ${verdict.hiType}, which the consent does not allow`; break; }
      accepted.push({ ref, hiType: verdict.hiType, title: verdict.title, date: verdict.date, checksum: digest.toString("hex"), verified: isMd5, bundle: bundle as Record<string, unknown> });
    }
    if (integrity !== null) {
      if (await this.closeTransfer(dr.id, "failed", integrity)) {
        await this.notify(art, txn, "FAILED", [...new Set(refs)].map((careContextReference) => ({ careContextReference, hiStatus: "ERRORED", description: integrity! })), dr.id);
      }
      return refuse(400, "entry_refused", `${integrity}; nothing from this page is stored`, patientId);
    }

    const stored = await withTx(db, async (tx: Tx) => {
      let n = 0;
      for (const a of accepted) {
        const ins = await tx.insert(abdmExternalRecords).values({
          id: newId(), dataRequestId: dr.id, artefactId: art.id, consentId: art.consentId, patientId: art.patientId,
          careContextReference: a.ref, hipId: art.hipId!, hipName: art.hipName, hiType: a.hiType, recordDate: a.date,
          title: a.title, checksum: a.checksum, checksumVerified: a.verified, bundle: a.bundle, receivedAt: now,
        }).onConflictDoNothing().returning({ id: abdmExternalRecords.id });
        n += ins.length;
      }
      await tx.update(abdmHiuDataRequests).set({
        pagesReceived: sql`(select coalesce(array_agg(distinct p order by p), '{}') from unnest(array_append(${abdmHiuDataRequests.pagesReceived}, ${pageNumber}::integer)) as p)`,
        pageCount, entryCount: sql`${abdmHiuDataRequests.entryCount} + ${n}`, status: "receiving", updatedAt: now,
      }).where(and(eq(abdmHiuDataRequests.id, dr.id), inArray(abdmHiuDataRequests.status, [...OPEN_TRANSFER])));
      await appendEvent(tx, externalRecordsReceived.make({
        actor: ABDM_ACTOR, patientId: art.patientId, correlationId: txn,
        idempotencyKey: `abdm.external_records_received:${dr.id}:${pageNumber}`,
        payload: { consentId: art.consentId, transactionId: txn, hipId: art.hipId, pageNumber, stored: n, hiTypes: [...new Set(accepted.map((a) => a.hiType))] },
      }));
      return n;
    });

    const [after] = await db.select({ pages: abdmHiuDataRequests.pagesReceived }).from(abdmHiuDataRequests).where(eq(abdmHiuDataRequests.id, dr.id));
    if ((after?.pages.length ?? 0) >= pageCount && await this.closeTransfer(dr.id, "received", null)) {
      const done = await db.selectDistinct({ ref: abdmExternalRecords.careContextReference }).from(abdmExternalRecords).where(eq(abdmExternalRecords.dataRequestId, dr.id));
      await this.notify(art, txn, "TRANSFERRED", done.map((d) => ({ careContextReference: d.ref, hiStatus: "OK", description: "Received" })), dr.id);
    }
    return { answer: { status: 202, code: "received", message: `${stored} of ${accepted.length} stored` }, patientId };
  }

  /** `health-information/notify` as the HIU — once per transfer (the close that precedes it is the claim). */
  private async notify(
    art: ArtefactRow, transactionId: string, sessionStatus: "TRANSFERRED" | "FAILED",
    statusResponses: { careContextReference: string; hiStatus: "OK" | "ERRORED"; description: string }[], dataRequestId?: string,
  ): Promise<void> {
    try {
      const res = await this.deps.client.hiNotify({
        notification: {
          consentId: art.consentId, transactionId, doneAt: this.deps.now().toISOString(),
          notifier: { type: "HIU", id: this.deps.hiuId },
          statusNotification: { sessionStatus, hipId: art.hipId, statusResponses },
        },
      }, art.patientId);
      if (ok2xx(res) && dataRequestId !== undefined) {
        await this.deps.db.update(abdmHiuDataRequests).set({ notifiedAt: this.deps.now() }).where(eq(abdmHiuDataRequests.id, dataRequestId));
      }
    } catch {
      // The notify's outcome is in abdm_messages; the transfer's own is already recorded.
    }
  }

  private async requestBy(where: ReturnType<typeof eq>): Promise<RequestRow | null> {
    const [row] = await this.deps.db.select().from(abdmHiuConsentRequests).where(where);
    return row ?? null;
  }
}

function errorText(body: unknown): string {
  const b = o(body);
  const e = o(b.error);
  const msg = s(e.message) ?? s(b.message);
  const code = s(e.code) ?? s(b.code);
  return msg === null && code === null ? "" : ` — ${[code, msg].filter((x) => x !== null).join(": ")}`;
}
