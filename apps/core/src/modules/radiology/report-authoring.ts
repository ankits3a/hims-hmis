import { and, desc, eq, gte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { imagingReports, imagingStudies } from "../../kernel/db/schema/radiology";
import { patients } from "../../kernel/db/schema/patients";
import { hasPermission } from "../../kernel/auth/permissions";
import { findLockoutHits } from "../pcpndt";
import type { LockoutTier } from "../pcpndt";
import { RadiologyError } from "./errors";
import { outsideStudyFor } from "./outside";
import { requireStudyType } from "./study-types";
import { activeDrafter, proposalLockoutHits } from "./drafter";
import { PCPNDT_AGE_MAX_YEARS, PCPNDT_AGE_MIN_YEARS, ageInYearsOn } from "./applicability";
import { templateKeyFor } from "./templates";
import {
  assertNoFoetalSexDisclosure, isObstetricReport, normaliseReportBody, reportText, scanDayOf,
} from "./obstetric-report";
import { openTeleRead, teleReaderOf } from "./tele";
import type { ResidentSignature, SignerBlock } from "./signer";
import type { SignChecksRecord } from "./report-signature";
import type { ImagingCriticalCategory } from "../../kernel/db/schema/radiology";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18a T8 — **THE REPORT: versioned, signed under a fresh second factor, and never overwritten.**
 *
 * ═══ EVERY ACT INSERTS A VERSION. NOTHING IS EDITED. ═══
 *
 * `imaging_reports_immutable` permits `status` and `published_at` to change and NOTHING else, so
 * there is no such thing as "editing a report" in this system. A draft saved twice is two rows; a
 * signature is its own row; an amendment is v(n+1) with v(n) flipped to `superseded`. **This is the
 * table a courtroom reads**, and the property it has to have is that the document somebody signed
 * is byte-for-byte the document that is still there.
 *
 * A2's mutant is *"amend by UPDATE of v1"*, and the consequence it names is the whole point: *"the
 * courtroom has one version"* — the amended text, with the original gone and no way to show what
 * was communicated at 02:00 and acted on.
 *
 * ═══ #1077 — ONE FILE OF THREE ═══
 *
 * `reports.ts` was split by act. This file WRITES the versions nobody has signed — the draft, the
 * drafter's proposal, the night prelim — and owns what every act shares: loading the study, the
 * version insert, and the PCPNDT lexicon's tier (`lockoutTierFor`, `assertFreeTextSignable`).
 * `report-signature.ts` signs, co-signs, amends, publishes and tells the patient; `criticals.ts`
 * raises and closes a critical finding. The public names are unchanged, through `index.ts`.
 */

export type ReportRow = typeof imagingReports.$inferSelect;

export async function loadStudy(exec: Db | Tx, studyId: string) {
  const rows = await (exec as Db).select().from(imagingStudies).where(eq(imagingStudies.id, studyId));
  const study = rows[0];
  if (!study) throw new RadiologyError("unknown_study", `no study ${studyId}`, { studyId });
  return study;
}

async function nextVersion(exec: Db | Tx, studyId: string): Promise<number> {
  const rows = await (exec as Db)
    .select({ version: imagingReports.version })
    .from(imagingReports)
    .where(eq(imagingReports.studyId, studyId))
    .orderBy(desc(imagingReports.version))
    .limit(1);
  return (rows[0]?.version ?? 0) + 1;
}

export async function latestSigned(exec: Db | Tx, studyId: string): Promise<ReportRow | undefined> {
  const rows = await (exec as Db).select().from(imagingReports)
    .where(and(eq(imagingReports.studyId, studyId), eq(imagingReports.status, "signed")))
    .limit(1);
  return rows[0];
}

export type ReportContent = {
  templateKey?: string;
  body: Record<string, unknown>;
  impression?: string | null;
  laterality?: string | null;
  /**
   * 18-S RS8c — the night-read provider's key, set ONLY by `savePrelim` for a listed teleradiology
   * reader (`imaging_reports.external_reporter_id`, the column 18a reserved for O-3). Never copied
   * forward: the signed version is the hospital consultant's.
   */
  externalReporterId?: string | null;
};

/** The default skeleton for a study, when the caller does not name one. */
export async function defaultTemplateKey(exec: Db | Tx, studyTypeCode: string): Promise<string> {
  const type = await requireStudyType(exec, studyTypeCode);
  return templateKeyFor(type.modality, type.body_part);
}

export async function insertVersion(
  tx: Tx,
  study: { id: string; studyTypeCode: string },
  status: "draft" | "prelim" | "signed" | "awaiting_cosign",
  content: ReportContent,
  signer?: {
    actorId: string; signedAt: Date; secondFactorAt: Date;
    amendmentReason?: string | null; supersedesId?: string | null;
    lockoutOverride?: { approvedBy: string; reason: string } | null;
    /** 18-S RS8a — the signer block (ruling 4) and the pre-sign checks as they ran. RS8b: a resident's signature on `awaiting_cosign`. */
    block?: SignerBlock | ResidentSignature | null;
    checks?: SignChecksRecord | null;
  },
  criticalCategory?: ImagingCriticalCategory | null,
  /** 18b T4 / §6.8 — set ONLY by `proposeDraft`. Never copied forward: the signed document is a human's. */
  provenance?: Record<string, unknown> | null,
): Promise<{ reportId: string; version: number }> {
  const version = await nextVersion(tx, study.id);
  const templateKey = content.templateKey ?? await defaultTemplateKey(tx, study.studyTypeCode);
  const reportId = newId();
  try {
    await tx.insert(imagingReports).values({
    id: reportId,
    studyId: study.id,
    version,
    status,
    templateKey,
    body: content.body,
    impression: content.impression ?? null,
    laterality: content.laterality ?? null,
    criticalCategory: criticalCategory ?? null,
    signerId: signer?.actorId ?? null,
    signedAt: signer?.signedAt ?? null,
    secondFactorAt: signer?.secondFactorAt ?? null,
      amendmentReason: signer?.amendmentReason ?? null,
      supersedesId: signer?.supersedesId ?? null,
      lockoutOverride: signer?.lockoutOverride ?? null,
      provenance: provenance ?? null,
      externalReporterId: status === "prelim" ? content.externalReporterId ?? null : null,
      signer: signer?.block ?? null,
      signChecks: signer?.checks ?? null,
    });
  } catch (e) {
    /**
     * ═══ F78 (CLOSE REVIEW) — TWO CONCURRENT SAVES ARE A 409, NOT A 500 ═══
     *
     * `nextVersion` is read-max-plus-one, so two overlapping inserts compute the same version and
     * one violates `imaging_reports_study_version_ux`. Nothing caught it: `signReport`'s handler
     * inspects the constraint name and only maps the ONE-SIGNED index, so the version collision
     * fell through `toHttp`'s families and Nest rendered a bare **500 with no code**. A radiologist
     * who double-clicks Save (the button has no pending guard) could not tell whether the draft was
     * stored. The concurrency suite races amends and first-signatures — both of which collide on
     * the signed index, which WAS mapped — and never races two drafts.
     */
    const constraint = String((e as { constraint?: unknown })?.constraint ?? "");
    if (constraint.includes("imaging_reports_study_version_ux")) {
      throw new RadiologyError(
        "stale_state",
        `another version of this report was written at the same instant — reload the study and `
        + "apply your change to the version that landed",
        { studyId: study.id, version },
      );
    }
    throw e;
  }
  return { reportId, version };
}

/** A working draft. Nothing is visible to anybody outside the department until it is published. */
export async function draftReport(
  tx: Tx, actor: Actor, input: { studyId: string } & ReportContent,
): Promise<{ reportId: string; version: number }> {
  const study = await loadStudy(tx, input.studyId);
  assertReportable(study.status, input.studyId);
  /** 18-S RS7 T2 — biometry recomputed by the server, the declaration key the server's alone. */
  const obstetric = await isObstetricReport(tx, study, input.templateKey);
  const body = normaliseReportBody(input.body, obstetric, scanDayOf(study, new Date()));
  return await insertVersion(tx, study, "draft", { ...input, body });
}

/**
 * PLAN 18b T4 / D7 — **THE DRAFTER WRITES A `draft` VERSION AND SAYS SO.**
 *
 * The facts handed to the drafter are what the study RECORDED (type, side, contrast, dose) and
 * nothing a human typed. The proposal goes through the lockout before it is stored: a machine
 * that emitted a §5(2) term is refused with `lexical_lockout`, the same code a human gets, and
 * there is no override lane for it. The row carries `provenance` — the column 18a reserved and
 * nobody wrote — and `signReport` copies content, never provenance (§6.8).
 */
export async function proposeDraft(
  tx: Tx, actor: Actor, input: { studyId: string; now?: Date },
): Promise<{
  reportId: string; version: number; templateKey: string;
  body: Record<string, string>; impression: string | null; laterality: string | null;
  provenance: Record<string, unknown>;
}> {
  // Close review B7 — the boundary names who asked, like `openImages`; the row records it in provenance.
  if (actor.type !== "user") {
    throw new RadiologyError("forbidden", `a ${actor.type} actor may not ask for a draft`);
  }
  if (!(await hasPermission(tx, actor.id, "radiology.reports.write", "hospital"))) {
    throw new RadiologyError("forbidden", `${actor.id} does not hold radiology.reports.write`);
  }
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);
  assertReportable(study.status, input.studyId);
  const type = await requireStudyType(tx, study.studyTypeCode);
  const tier = await lockoutTierFor(tx, study, now);
  /** 18a-iii T4 — null for our own studies; the drafter prints the label when it is not. */
  const outsideRow = await outsideStudyFor(tx, study.id);
  const outsideFacts = outsideRow === null
    ? null
    : { centreName: outsideRow.centreName, studyDate: outsideRow.studyDate, arrival: outsideRow.arrival };
  const proposal = await activeDrafter().draft({
    studyId: study.id, accessionNo: study.accessionNo,
    studyType: {
      code: type.code, name: type.name, modality: type.modality, body_part: type.body_part,
      contrast_option: type.contrast_option, ionising: type.ionising,
    },
    laterality: study.laterality, lockoutTier: tier, contrastGiven: study.contrastGiven,
    contrastAgent: study.contrastAgent, contrastVolumeMl: study.contrastVolumeMl,
    dose: { ctdivol: study.doseCtdivol, dlp: study.doseDlp, dap: study.doseDap, fluoroSeconds: study.fluoroSeconds },
    outside: outsideFacts,
  }, now);
  // Close review B1 — the SAME tier a human's text gets (F66: the demographic terms only in an
  // obstetric context), so "USG female pelvis" on a man's scan is not refused on the type's name.
  const terms = proposalLockoutHits(proposal, tier);
  if (terms.length > 0) {
    throw new RadiologyError(
      "lexical_lockout",
      `the drafter "${proposal.provenance.drafter}" proposed text containing ${terms.map((t) => `"${t}"`).join(", ")} — `
      + "a machine draft is refused under §5(2) exactly as a human's is, and nobody may override it",
      { terms, drafter: proposal.provenance.drafter },
    );
  }
  const provenance = { ...proposal.provenance, inputs: { ...proposal.provenance.inputs, requestedBy: actor.id } };
  const created = await insertVersion(tx, study, "draft", {
    templateKey: proposal.templateKey, body: proposal.body,
    impression: proposal.impression, laterality: proposal.laterality,
  }, undefined, null, provenance);
  // Close review C4 — the body rides back so the screen needs no second read (and no PHI row for it).
  return {
    ...created, templateKey: proposal.templateKey, body: proposal.body,
    impression: proposal.impression, laterality: proposal.laterality, provenance,
  };
}

/**
 * O-11's UNVERIFIED read. A prelim is a real, quotable document — the night registrar's opinion,
 * available to the ward — and it is deliberately NOT publishable (A6): a patient must never be
 * handed a report nobody has signed.
 */
export async function savePrelim(
  tx: Tx, actor: Actor, input: { studyId: string } & ReportContent,
): Promise<{ reportId: string; version: number }> {
  const study = await loadStudy(tx, input.studyId);
  assertReportable(study.status, input.studyId);
  /**
   * ═══ F68 (CLOSE REVIEW) — THE PRELIM IS A COMMUNICATION, SO THE LOCKOUT RUNS ON IT ═══
   *
   * `assertSignable` — the only caller of `findLockoutHits` — ran on sign and on amend, and NOT
   * here. This function's own docstring is what makes that a defect rather than an omission: a
   * prelim is *"a real, quotable document — the night registrar's opinion, **available to the
   * ward**"*, `reportView` applies no status filter and serves it in full to any holder of
   * `radiology.reports.read`, and the row is immutable so the text cannot afterwards be removed.
   *
   * §5(2) is about the COMMUNICATION. A night registrar who types *"it's a boy — congratulate the
   * family"* and presses **Save prelim** instead of **Sign** was communicating it, and the refusal
   * the whole file exists to make never fired.
   *
   * A DRAFT is deliberately still unchecked: nothing outside the department can read one, it is the
   * radiologist's own scratch text, and refusing a draft would move the refusal to a place where
   * the author cannot yet see the whole report they are being refused.
   */
  /** 18-S RS7 T1 — a prelim that states the sex of a foetus is refused before any word list runs. */
  const obstetric = await isObstetricReport(tx, study, input.templateKey);
  const body = normaliseReportBody(input.body, obstetric, scanDayOf(study, new Date()));
  assertNoFoetalSexDisclosure(reportText([body, input.impression ?? ""]), obstetric, "prelim");
  const tier = await lockoutTierFor(tx, study, new Date());
  const hits = findLockoutHits(
    `${JSON.stringify(body)} ${input.impression ?? ""}`, tier,
  );
  if (hits.length > 0) {
    throw new RadiologyError(
      "lexical_lockout",
      `this PRELIM cannot be saved: it contains ${hits.map((h) => `"${h.term}"`).join(", ")} — a `
      + "prelim is readable by the ward, so §5(2) applies to it exactly as it applies to a signature",
      { terms: hits.map((h) => h.term), tier },
    );
  }
  /** 18-S RS8c T3 — a night-read partner's prelim carries the provider and opens the over-read row. */
  const tele = await teleReaderOf(tx, actor.id);
  const created = await insertVersion(tx, study, "prelim", { ...input, body, externalReporterId: tele?.provider.key ?? null });
  if (tele !== null) await openTeleRead(tx, tele, study, created.reportId, new Date());
  return created;
}

function assertReportable(status: string, studyId: string): void {
  if (!["acquired", "reported", "published"].includes(status)) {
    throw new RadiologyError(
      "report_not_signed",
      `study ${studyId} is ${status} — a report is written about images that exist`,
      { studyId, status },
    );
  }
}

/**
 * ═══ F66 (CLOSE REVIEW, OWNER RULING) — WHICH TIER OF THE LEXICON THIS REPORT IS CHECKED AGAINST ═══
 *
 * `coded` is the floor and it applies to EVERY report: the euphemisms, the karyotype and the naming
 * of the act have no innocent use in a radiology report, so there is nothing to trade away.
 *
 * `full` adds the plain demographic words, and it applies in an OBSTETRIC CONTEXT — which is where
 * §5(2)'s harm actually lives, and E24's own words: *"on obstetric types AND on any patient with a
 * pregnancy declaration in 280 days"*. Three ways to be in that context, any one is enough:
 *
 *   1. the study is PCPNDT-applicable (`form_f_required`) — the Act covers this very scan;
 *   2. the study type's body part is obstetric — including the types the applicability rule exempts
 *      by age or sex, because N9's harm is the COMMUNICATION and not the applicability;
 *   3. this patient had ANY PCPNDT-applicable study in the last 280 days — 280 days is a full
 *      gestation, and the register-bearing scan is the record the hospital actually holds;
 *   4. **the patient is female and inside the Act's own age band (10–55).** This is the clause that
 *      keeps N9 intact, and the first draft of this fix did not have it. A3's harm is *the pregnant
 *      trauma patient's CT abdomen* — a scan that is not obstetric, carries no Form F, may be the
 *      first imaging this woman has ever had, and can disclose a foetal sex as easily as an anomaly
 *      scan. Clauses 1–3 all miss her. **Her sex and her age do not**, and they are exactly the
 *      population §5(2) is written about, so this is the Act's own line rather than one invented
 *      here.
 *
 * What that leaves free, which is the whole point of the narrowing: a 45-year-old man's chest film,
 * a child's, an older woman's. `"45-year-old male, chest PA view. No focal consolidation."` signs.
 * `"Also, it is a boy."` on a 30-year-old woman's abdomen does not.
 */
const OBSTETRIC_CONTEXT_DAYS = 280;

export async function lockoutTierFor(
  tx: Tx, study: typeof imagingStudies.$inferSelect, now: Date,
): Promise<LockoutTier> {
  if (study.formFRequired) return "full";
  const type = await requireStudyType(tx, study.studyTypeCode);
  if (type.body_part.toLowerCase().includes("obstetric")) return "full";
  const since = new Date(now.getTime() - OBSTETRIC_CONTEXT_DAYS * 86_400_000);
  const prior = await (tx as unknown as Db).select({ id: imagingStudies.id })
    .from(imagingStudies)
    .where(and(
      eq(imagingStudies.patientId, study.patientId),
      eq(imagingStudies.formFRequired, true),
      gte(imagingStudies.createdAt, since),
    ))
    .limit(1);
  if (prior.length > 0) return "full";

  /** (4) The Act's own population, read from the patient rather than from the examination. */
  const rows = await (tx as unknown as Db)
    .select({ sex: patients.sex, dob: patients.dob })
    .from(patients).where(eq(patients.id, study.patientId));
  const patient = rows[0];
  if (!patient || patient.sex !== "female") return "coded";
  /** A null DOB is `full`, for the same asymmetry `applicability.ts` argues at length. */
  if (patient.dob === null) return "full";
  const age = ageInYearsOn(patient.dob, now);
  return age >= PCPNDT_AGE_MIN_YEARS && age <= PCPNDT_AGE_MAX_YEARS ? "full" : "coded";
}

/**
 * F79 — the lockout applied to ONE free-text field that is not a report body: a critical's
 * `communicatedTo`, a read-back, an amendment reason. Same tier rule, same words, same refusal —
 * because §5(2) is about the communication and these fields are communications that get stored,
 * served by `reportView`, and read out in a courtroom exactly like an impression.
 *
 * There is no override lane here on purpose: these fields have no demographic line to protect, so
 * anything they trip is worth a rephrase.
 */
export async function assertFreeTextSignable(
  tx: Tx, studyId: string, text: string, now: Date = new Date(),
): Promise<void> {
  if (text.trim() === "") return;
  const study = await loadStudy(tx, studyId);
  assertNoFoetalSexDisclosure(text, await isObstetricReport(tx, study), "note");
  const hits = findLockoutHits(text, await lockoutTierFor(tx, study, now));
  if (hits.length > 0) {
    throw new RadiologyError(
      "lexical_lockout",
      `this text cannot be recorded: it contains ${hits.map((h) => `"${h.term}"`).join(", ")} — `
      + "§5(2) forbids communicating the sex of a foetus in any manner, including in a note",
      { terms: hits.map((h) => h.term) },
    );
  }
}
