import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { abdmCareContexts, abdmLinkTokens, abdmMessages } from "../../kernel/db/schema";
import { openSecret, sealSecret } from "../../kernel/crypto";
import { istDayString } from "../../kernel/approvals/cumulative";
import { getEncounter } from "../opd";
import { AbdmGatewayError } from "./gateway-client";
import { ok2xx } from "./hip-client";
import { hiTypesOf, loadCareContextRecords, patientRow } from "./records";
import type { HipClient } from "./hip-client";
import type { AbdmInboundMessage } from "./callbacks";
import type { AbdmSettings } from "./settings";
import type { HiType } from "./fhir-records";
import type { PatientRow } from "../patients";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ ABDM S2 — HIP-INITIATED LINKING: A COMPLETED VISIT BECOMES A CARE CONTEXT ON THE PATIENT'S ABHA ═══
 *
 * The flow (NHA wrapper `HIPLinkV3Service`, authoritative; every path UNVERIFIED — `hip-client.ts`):
 *
 *   1. `consultation.completed` (the worker's `abdm.care_contexts` consumer) → `onVisitCompleted`:
 *      a patient whose ABHA ABDM VERIFIED (S1) and who has an ABHA address gets ONE care context for
 *      the visit (`abdm_care_contexts`, unique on the encounter), with the HI types it carries.
 *   2. With a live link token for (HIP, ABHA address) → `add care contexts` (X-LINK-TOKEN) for every
 *      PENDING context of that address, which go 'linking'. Without one → `generate-token`, recorded
 *      first (`abdm_link_tokens`) so the `on-generate-token` callback finds it; at most three a day
 *      per address (FT FAQ Q31) and never a second while one is outstanding.
 *   3. `on-generate-token` (api) → the token is stored SEALED, and step 2 runs again.
 *   4. `on_carecontext` (api) → the contexts go 'linked' (or 'failed' with ABDM's reason) and ABDM is
 *      told what each carries (`context/notify`).
 *   5. A lab report or imaging report published LATER for the visit (the same consumer) adds
 *      DiagnosticReport to the context and notifies that type alone.
 *
 * IDEMPOTENT BY STATE, NOT BY LUCK: a redelivered event finds the row it made (unique encounter),
 * sends a link only for 'pending' rows, asks for a token only when none is live or outstanding, and
 * notifies only the types not yet notified. So an event delivered twice sends nothing twice.
 *
 * ABDM OFF (`settings === null`): nothing is recorded and nothing is sent — a care context names the
 * HIP it belongs to, and an ABDM-verified ABHA cannot exist without ABDM anyway.
 */
export const LINK_TOKEN_LIFETIME_MS = 182 * 24 * 60 * 60 * 1000; // "valid for 6 months" (spec §4.1; the wrapper's expiry)
export const GENERATE_TOKEN_DAILY_LIMIT = 3; // FT FAQ Q31: a fourth blocks the address for 24 h
/** A generate-token still unanswered after this is treated as lost, and a new one may be asked. */
export const GENERATE_TOKEN_WAIT_MS = 10 * 60 * 1000;

export type CareContextRow = typeof abdmCareContexts.$inferSelect;
type TokenRow = typeof abdmLinkTokens.$inferSelect;

const o = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** ABDM's gender letters (the M1 profile's `gender`). `U` for unknown is UNVERIFIED. */
export function abdmGender(p: Pick<PatientRow, "administrativeGender">): string {
  return ({ male: "M", female: "F", other: "O" } as Record<string, string>)[p.administrativeGender] ?? "U";
}

/** The `abhaNumber` claim of a link token (the wrapper decodes it the same way; the token came from a JWT-verified callback). */
function tokenClaims(token: string): { abhaNumber: string | null; expMs: number | null } {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { abhaNumber?: unknown; exp?: unknown };
    return {
      abhaNumber: typeof payload.abhaNumber === "string" && payload.abhaNumber !== "" ? payload.abhaNumber : null,
      expMs: typeof payload.exp === "number" ? payload.exp * 1000 : null,
    };
  } catch {
    return { abhaNumber: null, expMs: null };
  }
}

export function careContextDisplay(v: { visitNo: string; serviceDate: string; departmentName: string | null }): string {
  return `OPD visit ${v.visitNo} · ${v.serviceDate} · ${v.departmentName ?? "OPD"}`;
}

export class CareContexts {
  constructor(private readonly deps: {
    db: Db; settings: AbdmSettings | null; hip: HipClient | null; secretKey: Buffer; now: () => Date;
  }) {}

  private get db(): Db {
    return this.deps.db;
  }

  /**
   * The care context for a completed visit, made once. Null when the visit is not completed, or the
   * patient's ABHA is not ABDM-verified, or they have no ABHA address (the link token needs one).
   */
  async recordVisit(encounterId: string): Promise<CareContextRow | null> {
    const hipId = this.deps.settings?.hipId ?? null;
    const existing = await this.db.select().from(abdmCareContexts).where(eq(abdmCareContexts.encounterId, encounterId));
    if (existing[0] !== undefined) return existing[0];
    if (hipId === null) return null;
    const found = await loadCareContextRecords(this.db, [{ referenceNumber: "", encounterId }]);
    const records = found.get("");
    if (records === undefined) return null;
    const patient = await patientRow(this.db, records.visit.patientId);
    if (patient === null || patient.abhaVerificationStatus !== "verified" || s(patient.abhaAddress) === null) return null;
    await this.db.insert(abdmCareContexts).values({
      id: newId(), patientId: patient.id, encounterId, hipId,
      referenceNumber: records.visit.visitNo, patientReference: patient.uhid,
      display: careContextDisplay(records.visit), hiTypes: hiTypesOf(records),
      abhaAddress: s(patient.abhaAddress), status: "pending",
    }).onConflictDoNothing();
    const [row] = await this.db.select().from(abdmCareContexts).where(eq(abdmCareContexts.encounterId, encounterId));
    return row ?? null;
  }

  /** Step 1 → 2. The consumer's handler for `consultation.completed`. */
  async onVisitCompleted(encounterId: string): Promise<void> {
    const row = await this.recordVisit(encounterId);
    if (row === null || this.deps.hip === null) return;
    if (row.status === "linked") {
      await this.refreshAndNotify(row);
      return;
    }
    await this.linkPending(row.patientId, row.abhaAddress!);
  }

  /** Step 5. A report published for a visit: the context gains DiagnosticReport, and ABDM is told. */
  async onReportPublished(encounterNo: string): Promise<void> {
    const encounter = await getEncounter(this.db, encounterNo);
    if (encounter === null) return;
    const [row] = await this.db.select().from(abdmCareContexts).where(eq(abdmCareContexts.encounterId, encounter.id));
    if (row === undefined) return;
    await this.refreshAndNotify(row);
  }

  private async refreshAndNotify(row: CareContextRow): Promise<void> {
    const records = (await loadCareContextRecords(this.db, [row])).get(row.referenceNumber);
    if (records === undefined) return;
    const types = hiTypesOf(records);
    let current = row;
    if (types.some((t) => !row.hiTypes.includes(t))) {
      const merged = [...new Set([...row.hiTypes, ...types])];
      [current] = await this.db.update(abdmCareContexts).set({ hiTypes: merged, updatedAt: this.deps.now() })
        .where(eq(abdmCareContexts.id, row.id)).returning() as [CareContextRow];
    }
    if (current.status === "linked") await this.notify(current);
  }

  private async liveToken(abhaAddress: string): Promise<TokenRow | null> {
    const hipId = this.deps.settings!.hipId;
    const [t] = await this.db.select().from(abdmLinkTokens)
      .where(and(
        eq(abdmLinkTokens.hipId, hipId), eq(abdmLinkTokens.abhaAddress, abhaAddress),
        eq(abdmLinkTokens.status, "received"), gt(abdmLinkTokens.expiresAt, this.deps.now()),
      ))
      .orderBy(desc(abdmLinkTokens.receivedAt)).limit(1);
    return t ?? null;
  }

  /** Step 2: link every pending context of the address, or ask for the token that lets us. */
  async linkPending(patientId: string, abhaAddress: string): Promise<void> {
    const hip = this.deps.hip;
    const settings = this.deps.settings;
    if (hip === null || settings === null) return;
    const pending = await this.db.select().from(abdmCareContexts)
      .where(and(eq(abdmCareContexts.hipId, settings.hipId), eq(abdmCareContexts.abhaAddress, abhaAddress), eq(abdmCareContexts.status, "pending")));
    if (pending.length === 0) return;

    const token = await this.liveToken(abhaAddress);
    if (token === null) {
      await this.requestToken(patientId, abhaAddress, pending);
      return;
    }
    const linkToken = openSecret(this.deps.secretKey, token.tokenSealed!);
    const patient = await patientRow(this.db, patientId);
    const byType = new Map<string, CareContextRow[]>();
    for (const row of pending) for (const t of row.hiTypes) byType.set(t, [...(byType.get(t) ?? []), row]);
    const body = {
      abhaNumber: token.abhaNumber,
      abhaAddress,
      patient: [...byType.entries()].map(([hiType, rows]) => ({
        referenceNumber: pending[0]!.patientReference,
        display: patient?.name ?? pending[0]!.patientReference,
        careContexts: rows.map((r) => ({ referenceNumber: r.referenceNumber, display: r.display })),
        hiType,
        count: rows.length,
      })),
    };
    const requestId = randomUUID();
    const ids = pending.map((r) => r.id);
    // 'linking' BEFORE the call: `on_carecontext` may arrive before `call` returns.
    await this.db.update(abdmCareContexts).set({ status: "linking", linkRequestId: requestId, lastError: null, updatedAt: this.deps.now() })
      .where(and(inArray(abdmCareContexts.id, ids), eq(abdmCareContexts.status, "pending")));
    let failure: string | null = null;
    try {
      const res = await hip.addCareContexts(linkToken, body, patientId, requestId);
      if (!ok2xx(res)) failure = `ABDM answered add-care-contexts with HTTP ${res.status}`;
    } catch (e) {
      failure = e instanceof AbdmGatewayError ? e.message : String(e);
    }
    if (failure !== null) {
      // Back to pending, and the token is not trusted again (ABDM-1038 is a token mismatch): the next
      // attempt asks for a fresh one within the day's limit.
      await this.db.update(abdmCareContexts).set({ status: "pending", linkRequestId: null, lastError: failure, updatedAt: this.deps.now() })
        .where(and(inArray(abdmCareContexts.id, ids), eq(abdmCareContexts.linkRequestId, requestId), eq(abdmCareContexts.status, "linking")));
      await this.db.update(abdmLinkTokens).set({ expiresAt: this.deps.now() }).where(eq(abdmLinkTokens.id, token.id));
      throw new Error(failure);
    }
  }

  private async requestToken(patientId: string, abhaAddress: string, pending: CareContextRow[]): Promise<void> {
    const hip = this.deps.hip!;
    const hipId = this.deps.settings!.hipId;
    const now = this.deps.now();
    const outstanding = await this.db.select({ id: abdmLinkTokens.id }).from(abdmLinkTokens)
      .where(and(
        eq(abdmLinkTokens.hipId, hipId), eq(abdmLinkTokens.abhaAddress, abhaAddress), eq(abdmLinkTokens.status, "pending"),
        gt(abdmLinkTokens.createdAt, new Date(now.getTime() - GENERATE_TOKEN_WAIT_MS)),
      )).limit(1);
    if (outstanding.length > 0) return;
    const today = istDayString(now);
    const [{ n }] = (await this.db.select({ n: sql<number>`count(*)::int` }).from(abdmLinkTokens)
      .where(and(
        eq(abdmLinkTokens.hipId, hipId), eq(abdmLinkTokens.abhaAddress, abhaAddress),
        sql`to_char(${abdmLinkTokens.createdAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD') = ${today}`,
      ))) as [{ n: number }];
    const ids = pending.map((r) => r.id);
    if (n >= GENERATE_TOKEN_DAILY_LIMIT) {
      await this.db.update(abdmCareContexts).set({ lastError: `generate-token limit (${GENERATE_TOKEN_DAILY_LIMIT} a day for this ABHA address) reached; retried on the next visit or tomorrow`, updatedAt: now })
        .where(inArray(abdmCareContexts.id, ids));
      return;
    }
    const patient = await patientRow(this.db, patientId);
    const yearOfBirth = patient?.dob === null || patient?.dob === undefined ? null : patient.dob.getUTCFullYear();
    if (patient === null || yearOfBirth === null) {
      await this.db.update(abdmCareContexts).set({ lastError: "the link token needs the patient's year of birth", updatedAt: now })
        .where(inArray(abdmCareContexts.id, ids));
      return;
    }
    const requestId = randomUUID();
    const [tokenRow] = await this.db.insert(abdmLinkTokens).values({
      id: newId(), hipId, abhaAddress, patientId: patient.id, requestId, status: "pending", createdAt: now,
    }).returning();
    let failure: string | null = null;
    try {
      const res = await hip.generateToken({ abhaAddress, name: patient.name, gender: abdmGender(patient), yearOfBirth }, patient.id, requestId);
      if (!ok2xx(res)) failure = `ABDM answered generate-token with HTTP ${res.status}`;
    } catch (e) {
      failure = e instanceof AbdmGatewayError ? e.message : String(e);
    }
    if (failure !== null) {
      await this.db.update(abdmLinkTokens).set({ status: "failed", error: failure }).where(eq(abdmLinkTokens.id, tokenRow!.id));
      throw new Error(failure);
    }
  }

  /** Step 3 — `on-generate-token`. Correlated by `response.requestId`, else the address's outstanding request (the wrapper's rule). */
  async handleOnGenerateToken(m: AbdmInboundMessage): Promise<void> {
    const body = o(m.body);
    const abhaAddress = s(body.abhaAddress);
    const hipId = this.deps.settings!.hipId;
    const byRequest = m.correlationRequestId === null ? [] : await this.db.select().from(abdmLinkTokens).where(eq(abdmLinkTokens.requestId, m.correlationRequestId));
    const row = byRequest[0] ?? (abhaAddress === null ? undefined : (await this.db.select().from(abdmLinkTokens)
      .where(and(eq(abdmLinkTokens.hipId, hipId), eq(abdmLinkTokens.abhaAddress, abhaAddress), eq(abdmLinkTokens.status, "pending")))
      .orderBy(desc(abdmLinkTokens.createdAt)).limit(1))[0]);
    if (row === undefined) throw new Error("on-generate-token answers no request of ours");
    if (row.status !== "pending") return; // a second answer to one request changes nothing
    const error = o(body.error);
    const token = s(body.linkToken);
    if (Object.keys(error).length > 0 || token === null) {
      const reason = `${String(error.code ?? "")} ${String(error.message ?? "no linkToken in the answer")}`.trim();
      await this.db.update(abdmLinkTokens).set({ status: "failed", error: reason }).where(eq(abdmLinkTokens.id, row.id));
      await this.db.update(abdmCareContexts).set({ lastError: `link token refused: ${reason}`, updatedAt: this.deps.now() })
        .where(and(eq(abdmCareContexts.abhaAddress, row.abhaAddress), eq(abdmCareContexts.status, "pending")));
      return;
    }
    const now = this.deps.now();
    const claims = tokenClaims(token);
    const sixMonths = now.getTime() + LINK_TOKEN_LIFETIME_MS;
    await this.db.update(abdmLinkTokens).set({
      status: "received", tokenSealed: sealSecret(this.deps.secretKey, token), abhaNumber: claims.abhaNumber,
      expiresAt: new Date(claims.expMs === null ? sixMonths : Math.min(claims.expMs, sixMonths)), receivedAt: now,
    }).where(eq(abdmLinkTokens.id, row.id));
    await this.linkPending(row.patientId, row.abhaAddress);
  }

  /** Step 4 — `on_carecontext`. Success is "no `error`" (the wrapper's rule; ABDM's success text is prose). */
  async handleOnCareContext(m: AbdmInboundMessage): Promise<void> {
    if (m.correlationRequestId === null) throw new Error("on_carecontext names no request");
    const rows = await this.db.select().from(abdmCareContexts).where(eq(abdmCareContexts.linkRequestId, m.correlationRequestId));
    if (rows.length === 0) throw new Error("on_carecontext answers no link request of ours");
    const error = o(o(m.body).error);
    const now = this.deps.now();
    const linking = rows.filter((r) => r.status === "linking");
    if (Object.keys(error).length > 0) {
      await this.db.update(abdmCareContexts)
        .set({ status: "failed", lastError: `${String(error.code ?? "")} ${String(error.message ?? "")}`.trim(), updatedAt: now })
        .where(and(eq(abdmCareContexts.linkRequestId, m.correlationRequestId), eq(abdmCareContexts.status, "linking")));
      return;
    }
    if (linking.length > 0) {
      await this.db.update(abdmCareContexts)
        .set({ status: "linked", linkedVia: "hip", linkedAt: now, lastError: null, updatedAt: now })
        .where(and(eq(abdmCareContexts.linkRequestId, m.correlationRequestId), eq(abdmCareContexts.status, "linking")));
    }
    const linked = await this.db.select().from(abdmCareContexts)
      .where(and(eq(abdmCareContexts.linkRequestId, m.correlationRequestId), eq(abdmCareContexts.status, "linked")));
    for (const row of linked) await this.notify(row);
  }

  /** `context/notify` for the types ABDM has not been told of. Sent at most once per type. */
  async notify(row: CareContextRow): Promise<void> {
    const hip = this.deps.hip;
    const settings = this.deps.settings;
    if (hip === null || settings === null || row.status !== "linked" || row.abhaAddress === null) return;
    const fresh = row.hiTypes.filter((t) => !row.notifiedHiTypes.includes(t)) as HiType[];
    if (fresh.length === 0) return;
    const now = this.deps.now();
    const body = {
      notification: {
        patient: { id: row.abhaAddress },
        careContext: { patientReference: row.patientReference, careContextReference: row.referenceNumber },
        hiTypes: fresh,
        date: now.toISOString(),
        hip: { id: settings.hipId },
      },
    };
    let failure: string | null = null;
    try {
      const res = await hip.contextNotify(body, row.patientId);
      if (!ok2xx(res)) failure = `ABDM answered context/notify with HTTP ${res.status}`;
    } catch (e) {
      failure = e instanceof AbdmGatewayError ? e.message : String(e);
    }
    if (failure !== null) {
      await this.db.update(abdmCareContexts).set({ notifyError: failure, updatedAt: now }).where(eq(abdmCareContexts.id, row.id));
      return;
    }
    await this.db.update(abdmCareContexts).set({
      notifiedHiTypes: [...new Set([...row.notifiedHiTypes, ...fresh])],
      notifiedAt: now, notifyError: null, updatedAt: now,
    }).where(eq(abdmCareContexts.id, row.id));
  }

  /**
   * `links/context/on-notify`. An ERRORED acknowledgement (ABDM-1006 is common right after a link,
   * spec §4.1) forgets what was notified, so the context's next event notifies again.
   */
  async handleContextOnNotify(m: AbdmInboundMessage): Promise<void> {
    const body = o(m.body);
    const status = s(o(body.acknowledgement).status);
    const error = o(body.error);
    if (status !== "ERRORED" && Object.keys(error).length === 0) return;
    if (m.correlationRequestId === null) return;
    const [sent] = await this.db.select({ body: abdmMessages.body }).from(abdmMessages)
      .where(and(eq(abdmMessages.direction, "out"), eq(abdmMessages.requestId, m.correlationRequestId), eq(abdmMessages.kind, "gateway.hip.context_notify")))
      .limit(1);
    const ref = s(o(o(o(sent?.body).notification).careContext).careContextReference);
    if (ref === null) return;
    await this.db.update(abdmCareContexts).set({
      notifiedHiTypes: [], notifyError: `${String(error.code ?? "")} ${String(error.message ?? "ERRORED")}`.trim(), updatedAt: this.deps.now(),
    }).where(and(eq(abdmCareContexts.hipId, this.deps.settings!.hipId), eq(abdmCareContexts.referenceNumber, ref)));
  }
}
