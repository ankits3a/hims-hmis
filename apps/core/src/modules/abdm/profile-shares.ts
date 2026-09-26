import { and, desc, eq, gt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { abdmProfileShares } from "../../kernel/db/schema";
import { istDayString } from "../../kernel/approvals/cumulative";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { withTx } from "../../kernel/db/client";
import { acceptAbdmDemographics, findAbhaHolder, getPatient, holderUhidVisibleTo, recordAbhaVerifiedByAbdm } from "../patients";
import { AbdmGatewayError } from "./gateway-client";
import { attachPatientToMessage } from "./messages";
import { abdmDemographicsPatch, compareWithPatient, dashedAbhaNumber, readAbdmProfile } from "./profile";
import { demographicsOfPatient } from "./abha-service";
import type { Actor } from "@hmis/contracts";
import type { AbdmGatewayClient } from "./gateway-client";
import type { AbdmInboundMessage } from "./callbacks";
import type { AbdmProfile, DemographicChange, FieldComparison } from "./profile";
import type { AbdmSettings } from "./settings";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ ABDM S1 — SCAN AND SHARE: THE COUNTER QR, THE SHARED PROFILE, THE TOKEN, THE LINK ═══
 *
 * The flow, end to end:
 *
 *   1. The counter shows a QR (`counterQrUrl`). The patient scans it with an ABHA/PHR app.
 *   2. ABDM posts their profile to `POST {bridge}/api/v3/hip/patient/share` — S0's callback route
 *      verifies ABDM's JWT, logs it, de-duplicates it on REQUEST-ID, and dispatches it HERE.
 *   3. `handleProfileShare` stores it as a PENDING share with a token number for today, and replies
 *      `POST {gateway}/patient-share/v3/on-share` with that token — which the patient's phone shows.
 *   4. The counter lists pending shares (`listPendingShares`), opens one, and either pre-fills a new
 *      registration from it (the ordinary `POST /patients`) or matches it to a patient on file;
 *      either way `linkShare` then stamps the ABHA through `recordAbhaVerifiedByAbdm`.
 *
 * SOURCES — every detail UNVERIFIED until sandbox login. Care (`abdm/service/v3/gateway.py`
 * `patient_share__on_share`, `settings.py`, the integration doc) is primary; nha-in
 * `hiecm/patient-share.yaml` a cross-check:
 *
 *   · on-share path `/patient-share/v3/on-share`, header `X-CM-ID` (no X-HIP-ID) — Care, nha-in and
 *     the NHA wrapper (`profileOnSharePath`) agree.
 *   · body `{acknowledgement:{status, abhaAddress, profile:{context, tokenNumber, expiry}}, response:{requestId}}`
 *     — Care; nha-in agrees. `error:{code, message}` on refusal — Care; nha-in agrees.
 *   · `expiry` — Care's token lifetime is `ABDM_SCAN_AND_SHARE_TOKEN_EXPIRY_TIME = 1800` (seconds).
 *     UNVERIFIED: Care says 1800 s and does not show the wire type; nha-in says a NUMBER, example 180.
 *   · `tokenNumber` — a string. UNVERIFIED: Care passes its queue token (type not shown); nha-in
 *     says string, example '3'.
 *   · The QR — UNVERIFIED: Care says `<scanAndShareUrl>?hf=<HF id>&counter=<n>`; nha-in (and the
 *     2023 sandbox docs mirror) say `https://phrsbx.abdm.gov.in/share-profile?hip-id=<HIP id>&counter-id=<counter>`.
 *     This follows Care's parameters on nha-in's host, and `ABDM_SCAN_SHARE_URL` may carry a full
 *     template with `{hipId}` and `{counterId}` so the sandbox answer is a config change, not a release.
 *   · Observed in the field [nha-in NA §5.2]: `abhaNumber` may be null, birth fields are strings,
 *     the key is `pincode`. `readAbdmProfile` takes all of that.
 */
export const SHARE_TOKEN_EXPIRY_S = 1800;
export const ON_SHARE_PATH = "/patient-share/v3/on-share"; // UNVERIFIED until sandbox login
const COUNTER_ID = /^[A-Za-z0-9]{1,20}$/;

export type ShareView = {
  id: string;
  tokenNumber: number;
  tokenDate: string;
  counterId: string | null;
  status: "pending" | "linked" | "dismissed";
  createdAt: string;
  expiresAt: string;
  ackStatus: "sent" | "failed" | null;
  profile: AbdmProfile;
  patientId: string | null;
  /** Another active patient already holds this ABHA — `uhid` only when this user may see it (TAGGING_…). */
  linkedElsewhere?: { uhid: string | null } | null;
};

export type ShareErrorCode =
  | "share_not_found" | "share_not_pending" | "share_expired" | "counter_invalid" | "abha_profile_mismatch"
  | "patient_not_found" | "abha_already_linked";
export class ShareError extends Error {
  constructor(readonly code: ShareErrorCode, message: string, readonly detail?: unknown) {
    super(`${code}: ${message}`);
    this.name = "ShareError";
  }
}

/** The QR a counter prints. See the header for why this shape and why it is configurable. */
export function counterQrUrl(settings: Pick<AbdmSettings, "hipId" | "scanShareUrl">, counterId: string): string {
  if (!COUNTER_ID.test(counterId)) throw new ShareError("counter_invalid", "a counter id is 1–20 letters or digits");
  const t = settings.scanShareUrl;
  if (t.includes("{hipId}")) {
    return t.replace(/\{hipId\}/g, encodeURIComponent(settings.hipId)).replace(/\{counterId\}/g, encodeURIComponent(counterId));
  }
  // UNVERIFIED: Care says ?hf=&counter=, nha-in says ?hip-id=&counter-id=
  return `${t}?hf=${encodeURIComponent(settings.hipId)}&counter=${encodeURIComponent(counterId)}`;
}

type ShareRow = typeof abdmProfileShares.$inferSelect;

function viewOf(r: ShareRow): ShareView {
  return {
    id: r.id,
    tokenNumber: r.tokenNumber,
    tokenDate: r.tokenDate,
    counterId: r.counterId,
    status: r.status as ShareView["status"],
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    ackStatus: (r.ackStatus ?? null) as ShareView["ackStatus"],
    profile: readAbdmProfile(r.profile),
    patientId: r.patientId,
  };
}

function isUniqueViolation(e: unknown): boolean {
  const code = (x: unknown): unknown => (typeof x === "object" && x !== null ? (x as { code?: unknown }).code : undefined);
  return code(e) === "23505" || code((e as { cause?: unknown } | null)?.cause) === "23505";
}

const o = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export class ProfileShares {
  constructor(
    private readonly deps: { db: Db; settings: AbdmSettings; client: Pick<AbdmGatewayClient, "call">; now: () => Date },
  ) {}

  private nowDate(): Date {
    return this.deps.now();
  }

  /**
   * The callback handler for `callback.hip/patient/share`. Runs once per REQUEST-ID (S0's log
   * de-duplicates retries before dispatch). A share for a DIFFERENT facility, or with no ABHA
   * address, is answered with an error and stored nowhere. A share this slice does not handle
   * (RECORD_SHARE, PAYMENT_SHARE) throws, so the message is recorded `failed` and can be replayed
   * from the log once a later slice handles it.
   */
  async handleProfileShare(m: AbdmInboundMessage): Promise<void> {
    const body = o(m.body);
    const meta = o(body.metaData);
    const patient = o(o(body.profile).patient);
    const intent = s(body.intent) ?? "PROFILE_SHARE";
    if (intent !== "PROFILE_SHARE") throw new Error(`share intent ${intent} is not handled in S1`);
    const hipId = s(meta.hipId) ?? m.hipId;
    const abhaAddress = s(patient.abhaAddress);
    const context = s(meta.context);

    if (hipId !== this.deps.settings.hipId || abhaAddress === null) {
      await this.reply(m.requestId, {
        error: { code: "ABDM-1000", message: hipId !== this.deps.settings.hipId ? "This profile was shared with a different facility" : "The shared profile carried no ABHA address" },
      });
      return;
    }

    const now = this.nowDate();
    const expiresAt = new Date(now.getTime() + SHARE_TOKEN_EXPIRY_S * 1000);
    const abhaNumber = dashedAbhaNumber(patient.abhaNumber);
    const row = await this.takeToken({ m, hipId, abhaAddress, abhaNumber, context, intent, profile: patient, now, expiresAt });

    let ackError: string | null = null;
    try {
      const res = await this.reply(m.requestId, {
        acknowledgement: {
          status: "SUCCESS",
          abhaAddress,
          profile: { context: context ?? "", tokenNumber: String(row.tokenNumber), expiry: SHARE_TOKEN_EXPIRY_S },
        },
      });
      // Care: success is 202. Any 2xx is taken.
      if (res.status < 200 || res.status >= 300) ackError = `ABDM answered the on-share with HTTP ${res.status}`;
    } catch (e) {
      ackError = e instanceof AbdmGatewayError ? e.message : String(e);
    }
    await this.deps.db.update(abdmProfileShares)
      .set({ ackStatus: ackError === null ? "sent" : "failed", ackError, updatedAt: new Date() })
      .where(eq(abdmProfileShares.id, row.id));
    // The share is kept either way — the patient is at the counter — but the message is `failed`, so
    // the log says the phone never got its token.
    if (ackError !== null) throw new Error(ackError);
  }

  private reply(requestId: string, payload: Record<string, unknown>): Promise<{ status: number }> {
    return this.deps.client.call("POST", ON_SHARE_PATH, { ...payload, response: { requestId } }, { kind: "gateway.patient_share.on_share" });
  }

  /**
   * Get-or-create, Care's `get_or_create_scan_and_share_token`: a pending, unexpired share from the
   * same ABHA address at this facility is REFRESHED (new profile, new expiry, SAME token) rather than
   * issued a second token; otherwise today's next token. The number is allocated by the unique index
   * — a racing insert that loses retries with the next number.
   */
  private async takeToken(i: {
    m: AbdmInboundMessage; hipId: string; abhaAddress: string; abhaNumber: string | null; context: string | null;
    intent: string; profile: Record<string, unknown>; now: Date; expiresAt: Date;
  }): Promise<ShareRow> {
    const { db } = this.deps;
    const refreshed = await db.update(abdmProfileShares)
      .set({ profile: i.profile, abhaNumber: i.abhaNumber, counterId: i.context, expiresAt: i.expiresAt, updatedAt: new Date(), ackStatus: null, ackError: null })
      .where(and(
        eq(abdmProfileShares.hipId, i.hipId), eq(abdmProfileShares.abhaAddress, i.abhaAddress),
        eq(abdmProfileShares.status, "pending"), gt(abdmProfileShares.expiresAt, i.now),
      ))
      .returning();
    if (refreshed[0] !== undefined) return refreshed[0];

    const tokenDate = istDayString(i.now);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const [{ next }] = (await db.select({ next: sql<number>`coalesce(max(${abdmProfileShares.tokenNumber}), 0)::int + 1` })
        .from(abdmProfileShares)
        .where(and(eq(abdmProfileShares.hipId, i.hipId), eq(abdmProfileShares.tokenDate, tokenDate)))) as [{ next: number }];
      try {
        const inserted = await db.insert(abdmProfileShares).values({
          id: newId(), requestId: i.m.requestId, messageId: i.m.messageId, hipId: i.hipId, counterId: i.context,
          intent: i.intent, abhaNumber: i.abhaNumber, abhaAddress: i.abhaAddress, profile: i.profile,
          tokenDate, tokenNumber: next, status: "pending", expiresAt: i.expiresAt,
        }).returning();
        return inserted[0]!;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    throw new Error("could not allocate a scan-and-share token after 8 attempts");
  }

  /**
   * The counter's list: pending and unexpired, newest token first. Each says whether its ABHA is
   * already on another record ("already linked in HMIS with UHID X", VRFY_ABHA_303's wording) —
   * naming the UHID only to a user who may see it.
   */
  async listPending(actor: Actor | null = null): Promise<ShareView[]> {
    const rows = await this.deps.db.select().from(abdmProfileShares)
      .where(and(
        eq(abdmProfileShares.hipId, this.deps.settings.hipId), eq(abdmProfileShares.status, "pending"),
        gt(abdmProfileShares.expiresAt, this.nowDate()),
      ))
      .orderBy(desc(abdmProfileShares.createdAt))
      .limit(50);
    const out: ShareView[] = [];
    for (const r of rows) {
      const v = viewOf(r);
      const holder = await findAbhaHolder(this.deps.db, { abhaNumber: v.profile.abhaNumber, abhaAddress: v.profile.abhaAddress }, null);
      out.push({ ...v, linkedElsewhere: holder === null ? null : { uhid: await holderUhidVisibleTo(this.deps.db, actor, holder) } });
    }
    return out;
  }

  private async row(id: string): Promise<ShareRow> {
    const [r] = await this.deps.db.select().from(abdmProfileShares).where(eq(abdmProfileShares.id, id));
    if (r === undefined || r.hipId !== this.deps.settings.hipId) throw new ShareError("share_not_found", "no such shared profile");
    return r;
  }

  async get(id: string): Promise<ShareView> {
    return viewOf(await this.row(id));
  }

  /**
   * Link a pending share to a patient — a new one the counter just registered from it, or one already
   * on file. The same rules as the OTP verification: one ABHA per patient (`abha_already_linked`);
   * ABDM's name, birth and gender are shown against the record and, once the clerk ACCEPTS them, taken
   * through the amendment path; then `recordAbhaVerifiedByAbdm` stamps the ABHA. A share with no ABHA
   * number (ABDM allows it) links the share and changes nothing — there is no number to call
   * verified, so nothing of ABDM's becomes authoritative either.
   */
  async link(actor: Actor, id: string, input: { patientId: string; acceptAbdmDemographics?: boolean }): Promise<{
    share: ShareView; changed: string[]; comparison: FieldComparison[]; demographicsApplied: DemographicChange[];
  }> {
    const r = await this.row(id);
    if (r.status !== "pending") throw new ShareError("share_not_pending", "this shared profile was already handled");
    if (r.expiresAt.getTime() <= this.nowDate().getTime()) throw new ShareError("share_expired", "this shared profile has expired — ask the patient to scan again");
    const found = await getPatient(this.deps.db, actor, input.patientId);
    if (found === null) throw new ShareError("patient_not_found", `unknown patient ${input.patientId}`);
    const patient = found.patient;
    const profile = readAbdmProfile(r.profile);
    const holder = await findAbhaHolder(this.deps.db, { abhaNumber: profile.abhaNumber, abhaAddress: profile.abhaAddress }, patient.id);
    if (holder !== null) {
      const uhid = await holderUhidVisibleTo(this.deps.db, actor, holder);
      throw new ShareError("abha_already_linked", uhid === null ? "this ABHA is already linked to another patient record" : `this ABHA is already linked with UHID ${uhid}`, { uhid });
    }
    const comparison = compareWithPatient(profile, demographicsOfPatient(patient));
    const verifying = profile.abhaNumber !== null;
    const { patch, changes } = verifying ? abdmDemographicsPatch(profile, patient) : { patch: {}, changes: [] as DemographicChange[] };
    if (changes.length > 0 && input.acceptAbdmDemographics !== true) {
      throw new ShareError("abha_profile_mismatch", "ABDM's name, birth or gender differ from this record — check with the patient, then accept ABDM's details", { comparison, demographicsToApply: changes });
    }
    const { db } = this.deps;
    const via = "M1 scan and share";
    const result = await withTx(db, async (tx) => {
      const demo = changes.length === 0 ? [] : (await acceptAbdmDemographics(tx, actor, patient.id, patch, via)).changed;
      const changed = profile.abhaNumber === null
        ? []
        : [...demo, ...(await recordAbhaVerifiedByAbdm(tx, patient.id, { abhaNumber: profile.abhaNumber, abhaAddress: profile.abhaAddress, via, requestedBy: actor })).changed];
      const updated = await tx.update(abdmProfileShares)
        .set({ status: "linked", patientId: patient.id, linkedBy: actor.id, linkedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(abdmProfileShares.id, r.id), eq(abdmProfileShares.status, "pending")))
        .returning();
      if (updated[0] === undefined) throw new ShareError("share_not_pending", "this shared profile was handled concurrently");
      return { row: updated[0], changed };
    });
    await attachPatientToMessage(db, r.messageId, patient.id);
    await recordPhiAccess(db, { actor, patientId: patient.id, surface: "abdm.profile_share" });
    return { share: viewOf(result.row), changed: result.changed, comparison, demographicsApplied: changes };
  }

  async dismiss(id: string): Promise<ShareView> {
    const r = await this.row(id);
    const updated = await this.deps.db.update(abdmProfileShares)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(and(eq(abdmProfileShares.id, r.id), eq(abdmProfileShares.status, "pending")))
      .returning();
    if (updated[0] === undefined) throw new ShareError("share_not_pending", "this shared profile was already handled");
    return viewOf(updated[0]);
  }
}
