import {
  BadRequestException, Body, Controller, ConflictException, ForbiddenException, Get, HttpCode, Inject,
  NotFoundException, Param, Patch, PayloadTooLargeException, Post, Put, Query,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { SodViolationError } from "../../kernel/auth/sod";
import { ApprovalError } from "../../kernel/approvals/types";
import { WorkflowError } from "../../kernel/workflow/instances";
import { withTx } from "../../kernel/db/client";
import { PatientError } from "./uhid";
import { getPatient, registerPatient, updatePatient } from "./registration";
import { AMENDMENT_REASONS, IDENTITY_ASSURANCE, touchesIdentity, upgradeAssurance } from "./identity";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { searchPatients } from "./search";
import { getPatientPhoto, storePatientPhoto } from "./photos";
import { addAllergy, listAllergies, markAllergyEnteredInError } from "./allergies";
import { effectiveGuardianAuthority, endGuardian, linkGuardian, updateGuardianAuthority } from "./guardians";
import { patientGuardians } from "../../kernel/db/schema";
import { eq } from "drizzle-orm";
import { buildQrPayload, reissueQrCard, verifyQrScan } from "./qr";
import { createMergeRequest, executeMerge, executeUnmerge, getMergeRequest, requestUnmerge } from "./merge";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

const NOT_FOUND_CODES = new Set(["patient_not_found", "unknown_merge_request", "allergy_not_found", "guardian_not_found"]);
/**
 * PLAN 22c-A — CLOSE REVIEW m8. The two privacy-write denials are FORBIDDEN, not BAD REQUEST.
 * They fell through `toHttp`'s default and arrived as 400s, indistinguishable — to a client or to
 * a log aggregator — from a malformed body. These are exactly the two an Indian hospital would
 * want alerting on: an attempted write to the confidential flag or to the deceased hard stop.
 */
const FORBIDDEN_CODES = new Set(["confidential_write_denied", "deceased_write_denied"]);
const CONFLICT_CODES = new Set([
  "patient_not_active", "merge_same_patient", "merge_already_requested", "merge_not_requested",
  "merge_not_executed", "approval_not_granted", "unmerge_already_requested", "unmerge_not_requested",
  "allergy_not_active", "guardian_not_active",
]);

/** Patients errors → HTTP, defined once. Unrecognized errors rethrow — a 500 is a genuine bug, loudly. */
function toHttp(e: unknown): never {
  if (e instanceof SodViolationError) throw new ForbiddenException(e.message);
  if (e instanceof PatientError) {
    if (NOT_FOUND_CODES.has(e.code)) throw new NotFoundException(e.message);
    if (FORBIDDEN_CODES.has(e.code)) throw new ForbiddenException(e.message);
    if (e.code === "photo_too_large") throw new PayloadTooLargeException(e.message);
    if (CONFLICT_CODES.has(e.code)) throw new ConflictException(e.message);
    throw new BadRequestException(e.message);
  }
  // Merge-request paths surface these when the approval types are not yet registered (runbook)
  // or the backing definition moved — state conflicts, not client mistakes.
  if (e instanceof ApprovalError) throw new ConflictException(e.message);
  if (e instanceof WorkflowError) throw new ConflictException(e.message);
  throw e;
}

const sexEnum = z.enum(["male", "female", "other", "unknown"]);
const languageEnum = z.enum(["hi", "en"]);
const bloodGroupEnum = z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);
const severityEnum = z.enum(["mild", "moderate", "severe"]);
const relationshipEnum = z.enum(["father", "mother", "spouse", "sibling", "legal_guardian", "other"]);
const phoneField = z.string().regex(/^[6-9]\d{9}$/, "10-digit Indian mobile");

const guardianBody = z.object({
  name: z.string().min(1),
  phone: phoneField.optional(),
  relationship: relationshipEnum,
  idType: z.enum(["aadhaar", "pan", "voter_id", "other"]).optional(),
  idNumberMasked: z.string().max(4).optional(),
  idVerified: z.boolean().optional(),
  authorityMessages: z.boolean().optional(),
  authorityConsents: z.boolean().optional(),
  authorityDsr: z.boolean().optional(),
  authorityBills: z.boolean().optional(),
  consentNote: z.string().optional(),
});

const registerBody = z.object({
  name: z.string().min(1).max(200),
  phone: phoneField.optional(),
  altPhone: phoneField.optional(),
  dob: z.coerce.date().optional(),
  ageYears: z.number().int().min(0).max(130).optional(),
  sex: sexEnum,
  addressLine: z.string().max(500).optional(),
  district: z.string().max(100).optional(),
  stateName: z.string().max(100).optional(),
  pincode: z.string().regex(/^\d{6}$/).optional(),
  language: languageEnum.optional(),
  bloodGroup: bloodGroupEnum.optional(),
  isConfidential: z.boolean().optional(),
  alias: z.string().max(200).optional(),
  sensitiveContext: z.boolean().optional(),
  abhaAddress: z.string().max(200).optional(),
  abhaNumber: z.string().max(20).optional(),
  abhaVerificationStatus: z.enum(["none", "self_declared", "verified"]).optional(),
  legacyUhid: z.string().max(50).optional(),
  guardian: guardianBody.optional(),
  // D9 (DPDP): opt-IN means the patient acted — default false, never pre-checked (T6).
  promotionalOptIn: z.boolean().default(false),
});

const patchBody = registerBody
  .omit({ ageYears: true, guardian: true })
  .partial()
  .extend({
    phone: phoneField.nullable().optional(),
    altPhone: phoneField.nullable().optional(),
    dob: z.coerce.date().nullable().optional(),
    dobEstimated: z.boolean().optional(),
    alias: z.string().max(200).nullable().optional(),
    bloodGroup: bloodGroupEnum.nullable().optional(),
    abhaAddress: z.string().max(200).nullable().optional(),
    abhaNumber: z.string().max(20).nullable().optional(),
    abhaLinkToken: z.string().max(500).nullable().optional(),
    legacyUhid: z.string().max(50).nullable().optional(),
    addressLine: z.string().max(500).nullable().optional(),
    district: z.string().max(100).nullable().optional(),
    stateName: z.string().max(100).nullable().optional(),
    pincode: z.string().regex(/^\d{6}$/).nullable().optional(),
    // Overridden here, NOT inherited via .partial(): registerBody's field carries
    // `.default(false)`, and zod v4 applies a default to a key the caller omits entirely —
    // `.partial()` alone would make every PATCH that never mentions consent parse to
    // `promotionalOptIn: false` and silently revert an existing opt-in on any unrelated edit.
    // Redeclaring it here (no default) restores "omitted key" as "leave it alone".
    promotionalOptIn: z.boolean().optional(),
    // D10 (D-33): settable on the existing edit surface — Phase 1 has no death-recording flow.
    // Strict ISO-8601 (not z.coerce.date()): the deceased hard stop is CRITICAL machinery and
    // the wire contract should reject a loosely-parsed date rather than silently accept one.
    deceasedAt: z.string().datetime().nullable().optional(),
    /**
     * PLAN 22c-A — CLOSE REVIEW C1 (CRITICAL). **THIS LINE WAS MISSING AND IT MADE THE WHOLE
     * PHASE UNREACHABLE THROUGH ITS OWN ROUTE.**
     *
     * `patchBody` derives from `registerBody`, which declares `sex` and — correctly, because the
     * counter captures one value — does NOT declare `administrativeGender`. zod strips unknown
     * keys, so a PATCH carrying the field had it removed before `updatePatient` ever saw it. The
     * resulting `patch` was empty, `touchesIdentity` was false so the reason gate did not fire,
     * `changes.length === 0` returned early, and the clerk got **HTTP 200 with nothing written**:
     * no column, no version, no event, no error. The one field DD4 exists to protect, and A12
     * asserts on, could not be amended by the only surface a human uses.
     *
     * Every test that amends it called `updatePatient` directly. That is what a test suite looks
     * like when it verifies a function and forgets the wire.
     */
    administrativeGender: sexEnum.optional(),
    /**
     * PLAN 22c-A T7 — THE AMENDMENT CONTEXT, AND `reasonClass` IS AN ENUM RATHER THAN FREE TEXT
     * (series R-018; the shipped precedent is `refunds.ts`'s `reasonClass`). Free text on an
     * amendment produces "correction", "corrected", "as per document" and a thousand other
     * spellings of five actual reasons, and nothing can ever be counted or audited from it.
     *
     * It is OPTIONAL at the schema and REQUIRED for a Class I change — enforced below rather than
     * here, because the same body also carries Class II edits (a phone fix) that owe no reason at
     * all, and a schema-level requirement would make the desk type a reason to correct a typo.
     */
    reasonClass: z.enum(AMENDMENT_REASONS).optional(),
    /** What the clerk saw: a document number, an upload id later. Free text by nature. */
    evidenceRef: z.string().max(200).nullable().optional(),
    /** The assurance level the presented evidence supports (DD5) — decides whether the stamp drops. */
    evidencedAt: z.enum(IDENTITY_ASSURANCE).optional(),
  });

/** PLAN 22c-A T7 — the assurance upgrade is its own act, with its own body. */
const assuranceBody = z.object({
  toLevel: z.enum(IDENTITY_ASSURANCE),
  evidenceRef: z.string().max(200).nullable().optional(),
});

const searchQuery = z.object({ q: z.string(), limit: z.coerce.number().int().positive().max(50).optional() });
const photoBody = z.object({ imageBase64: z.string().min(1) });
const allergyBody = z.object({
  substance: z.string().min(1).max(200),
  reaction: z.string().max(500).optional(),
  severity: severityEnum.optional(),
  source: z.enum(["registration", "vitals", "consult"]),
});
const reasonBody = z.object({ reason: z.string().min(1) });
const guardianPatchBody = z.object({
  messages: z.boolean().optional(),
  consents: z.boolean().optional(),
  dsr: z.boolean().optional(),
  bills: z.boolean().optional(),
  phone: phoneField.nullable().optional(),
  idVerified: z.boolean().optional(),
  validTo: z.coerce.date().nullable().optional(),
  consentNote: z.string().nullable().optional(),
});
const qrVerifyBody = z.object({ payload: z.string().min(1).max(500) });
const mergeBody = z.object({ winnerId: z.string().min(1), loserId: z.string().min(1), note: z.string().min(1) });
const unmergeBody = z.object({ note: z.string().min(1), actFirst: z.boolean().optional() });

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

@Controller("patients")
export class PatientsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ——— literal-segment routes FIRST (Nest matches in declaration order) ———

  @RequirePermission("patients.read", "hospital")
  @Get("search")
  async search(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ items: unknown[] }> {
    const q = parsed(searchQuery, query);
    try {
      return { items: await searchPatients(this.db, actor, q.q, q.limit) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.read", "hospital")
  @Post("qr/verify")
  @HttpCode(200) // a failed scan is a domain answer (ok:false), not a transport error — never 4xx, and never Nest's POST-default 201
  async qrVerify(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(qrVerifyBody, body);
    try {
      return await verifyQrScan(this.db, this.cfg, actor, b.payload);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.merge", "hospital")
  @Post("merge-requests")
  async mergeRequest(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(mergeBody, body);
    try {
      return await withTx(this.db, (tx) => createMergeRequest(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.read", "hospital")
  @Get("merge-requests/:id")
  async mergeDetail(@Param("id") id: string): Promise<unknown> {
    const view = await getMergeRequest(this.db, id);
    if (!view) throw new NotFoundException(`unknown merge request ${id}`);
    return view;
  }

  @RequirePermission("patients.merge", "hospital")
  @Post("merge-requests/:id/execute")
  async mergeExecute(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try {
      return await executeMerge(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.merge", "hospital")
  @Post("merge-requests/:id/unmerge-request")
  async unmergeRequest(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(unmergeBody, body);
    try {
      return await withTx(this.db, (tx) => requestUnmerge(tx, actor, { mergeRequestId: id, ...b }));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.merge", "hospital")
  @Post("merge-requests/:id/unmerge")
  async unmergeExecute(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ ok: true }> {
    try {
      await executeUnmerge(this.db, actor, id);
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.register", "hospital")
  @Post()
  async register(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(registerBody, body);
    try {
      return await withTx(this.db, (tx) => registerPatient(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— :id routes ———

  @RequirePermission("patients.read", "hospital")
  @Get(":id")
  async detail(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    const found = await getPatient(this.db, actor, id);
    if (!found) throw new NotFoundException(`unknown patient ${id}`);
    // PLAN 07a T2 — recorded HERE and not inside `getPatient`, deliberately. `getPatient` is the
    // confidentiality decision every module calls, including the OPD read gate's own check; logging
    // there would record a row for every internal permission test and bury the reads a records-access
    // enquiry is actually about. The controller is the HTTP read surface, and that is what to log.
    await recordPhiAccess(this.db, {
      actor, patientId: found.patient.id, surface: "patient.detail",
      sealed: found.patient.isConfidential, reason: found.breakGlass?.reason ?? null,
    });
    return found;
  }

  @RequirePermission("patients.update", "hospital")
  @Patch(":id")
  async patch(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const { reasonClass, evidenceRef, evidencedAt, ...patch } = parsed(patchBody, body);
    /**
     * PLAN 22c-A T7 — A CLASS I AMENDMENT MUST SAY WHY, AND THE CHECK IS HERE RATHER THAN IN THE
     * DOMAIN FUNCTION. `updatePatient` is also reached by the merge path and the walk-in path,
     * which amend for reasons of their own and would be broken by a blanket requirement; this is
     * the human-facing door, and a person changing a patient's legal name owes a reason.
     *
     * Class II is deliberately exempt: making the desk pick a reason to fix a mistyped phone
     * number is how a required field becomes whatever is first in the list.
     */
    if (reasonClass === undefined && touchesIdentity(Object.keys(patch))) {
      throw new BadRequestException("reason_required: an identity amendment records why (22c-A T7)");
    }
    try {
      return await withTx(this.db, (tx) =>
        updatePatient(tx, actor, id, patch, { reasonClass, evidenceRef, evidencedAt }));
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * PLAN 22c-A T7 — raise a patient's identity assurance. Separate from PATCH because it is a
   * different act: PATCH changes what the record SAYS, this changes how much the hospital is
   * willing to VOUCH for it, and conflating them is how "I fixed a typo" becomes "I verified this
   * person's identity". Staff only, upgrades only, evidence required at `id_verified` and above —
   * all enforced in `upgradeAssurance` so a future caller cannot route around it.
   */
  @RequirePermission("patients.update", "hospital")
  @Post(":id/assurance")
  async setAssurance(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ from: string; to: string }> {
    const b = parsed(assuranceBody, body);
    try {
      return await withTx(this.db, (tx) =>
        upgradeAssurance(tx, actor, id, b.toLevel, b.evidenceRef ?? null));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("patients.update", "hospital")
  @Put(":id/photo")
  async putPhoto(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const b = parsed(photoBody, body);
    try {
      const bytes = Buffer.from(b.imageBase64, "base64");
      await withTx(this.db, (tx) => storePatientPhoto(tx, actor, id, { mimeType: "image/jpeg", bytes }));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.read", "hospital")
  @Get(":id/photo")
  async getPhoto(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ mimeType: string; imageBase64: string }> {
    const photo = await getPatientPhoto(this.db, actor, id);
    if (!photo) throw new NotFoundException("no photo");
    return { mimeType: photo.mimeType, imageBase64: photo.bytes.toString("base64") };
  }

  @RequirePermission("patients.read", "hospital")
  @Get(":id/qr")
  async qrCard(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    const found = await getPatient(this.db, actor, id);
    if (!found) throw new NotFoundException(`unknown patient ${id}`);
    const p = found.patient;
    return { payload: buildQrPayload(this.cfg, p), uhid: p.uhid, name: p.name, administrativeGender: p.administrativeGender, dob: p.dob };
  }

  @RequirePermission("patients.update", "hospital")
  @Post(":id/qr/reissue")
  async qrReissue(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try {
      return await reissueQrCard(this.db, this.cfg, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.update", "hospital")
  @Post(":id/allergies")
  async postAllergy(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(allergyBody, body);
    try {
      return await withTx(this.db, (tx) => addAllergy(tx, actor, id, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.read", "hospital")
  @Get(":id/allergies")
  async getAllergies(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    const found = await getPatient(this.db, actor, id);
    if (!found) throw new NotFoundException(`unknown patient ${id}`);
    await recordPhiAccess(this.db, {
      actor, patientId: found.patient.id, surface: "patient.allergies",
      sealed: found.patient.isConfidential, reason: found.breakGlass?.reason ?? null,
    });
    return { items: await listAllergies(this.db, found.patient.id) };
  }

  @RequirePermission("patients.update", "hospital")
  @Post(":id/allergies/:allergyId/entered-in-error")
  async allergyError(
    @CurrentActor() actor: Actor,
    @Param("allergyId") allergyId: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(reasonBody, body);
    try {
      await withTx(this.db, (tx) => markAllergyEnteredInError(tx, actor, allergyId, b.reason));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.update", "hospital")
  @Post(":id/guardians")
  async postGuardian(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(guardianBody, body);
    try {
      return await withTx(this.db, (tx) => linkGuardian(tx, actor, id, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.read", "hospital")
  @Get(":id/guardians")
  async getGuardians(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    const found = await getPatient(this.db, actor, id);
    if (!found) throw new NotFoundException(`unknown patient ${id}`);
    const rows = await this.db
      .select()
      .from(patientGuardians)
      .where(eq(patientGuardians.patientId, found.patient.id));
    return {
      items: rows.map((g) => ({ guardian: g, effectiveAuthority: effectiveGuardianAuthority(found.patient, g) })),
    };
  }

  @RequirePermission("patients.update", "hospital")
  @Patch(":id/guardians/:guardianId")
  async patchGuardian(
    @CurrentActor() actor: Actor,
    @Param("guardianId") guardianId: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(guardianPatchBody, body);
    try {
      await withTx(this.db, (tx) => updateGuardianAuthority(tx, actor, guardianId, b));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.update", "hospital")
  @Post(":id/guardians/:guardianId/end")
  async endGuardianRoute(@CurrentActor() actor: Actor, @Param("guardianId") guardianId: string): Promise<{ ok: true }> {
    try {
      await withTx(this.db, (tx) => endGuardian(tx, actor, guardianId));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }
}
