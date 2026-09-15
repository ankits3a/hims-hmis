import { and, desc, eq, gte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { enqueueNotification } from "../../kernel/notify/enqueue";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { secondFactorFresh } from "../../kernel/auth/totp";
import { transition } from "../../kernel/workflow/instances";
import {
  imagingCriticalFindings, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { invoiceLines } from "../../kernel/db/schema/billing";
import { users } from "../../kernel/db/schema/auth";
import { invoiceSettlement } from "../billing";
import { findLockoutHits } from "../pcpndt";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import type { LockoutTier } from "../pcpndt";
import { RadiologyError } from "./errors";
import { outsideStudyFor } from "./outside";
import {
  imagingCriticalAcknowledged, imagingCriticalFlagged, imagingReportPublished,
} from "./events";
import { requireStudyType } from "./study-types";
import { activeDrafter, proposalLockoutHits } from "./drafter";
import { hasPermission } from "../../kernel/auth/permissions";
import { PCPNDT_AGE_MAX_YEARS, PCPNDT_AGE_MIN_YEARS, ageInYearsOn } from "./applicability";
import { patients } from "../../kernel/db/schema/patients";
import { templateKeyFor } from "./templates";
import type { ImagingCriticalCategory } from "../../kernel/db/schema/radiology";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { OrderKindDecl } from "../../kernel/orders/kinds";

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
 * ═══ THREE THINGS ARE CHECKED AT SIGN, AND ALL THREE ARE CHECKED BEFORE THE INSERT ═══
 *
 *   · **the second factor is FRESH** (A1) — §11.19-D-27. A signature is an identity claim, and one
 *     made on a session that authenticated this morning is a claim about the morning.
 *   · **the lockout** (A3) — on EVERY report, not only the PCPNDT-applicable ones. A3's mutant
 *     applies it only when `form_f_required`, and N9 is what slips through: the pregnant trauma
 *     patient's CT, which is not an obstetric scan and can still disclose a foetal sex.
 *   · **the laterality** (A4) — against the ORDER ITEM's, on types where a side exists at all.
 */

/**
 * §11.19-D-27's window, as a FALLBACK only.
 *
 * ═══ THE COMPARISON IS THE KERNEL'S, AND §6.8 SAYS SO ═══
 *
 * The contract promises downstream plans that *"the second factor is the kernel's
 * `secondFactorFresh`"*, and the first draft of this file re-implemented the arithmetic instead —
 * two owners of one rule, with this module's constant free to drift from
 * `cfg.secondFactorWindowMinutes`, which is what `AuthGuard` compares against on the very same
 * request. A signature could then be refused by the route and accepted by the function, or the
 * reverse. Caught by T9's §6 confirmation pass.
 *
 * The controller passes the CONFIG's window; this constant is what an internal caller with no
 * config gets, and it matches the shipped default.
 */
export const SECOND_FACTOR_WINDOW_MINUTES = 15;

export type ReportRow = typeof imagingReports.$inferSelect;

async function loadStudy(exec: Db | Tx, studyId: string) {
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
};

/** The default skeleton for a study, when the caller does not name one. */
async function defaultTemplateKey(exec: Db | Tx, studyTypeCode: string): Promise<string> {
  const type = await requireStudyType(exec, studyTypeCode);
  return templateKeyFor(type.modality, type.body_part);
}

async function insertVersion(
  tx: Tx,
  study: { id: string; studyTypeCode: string },
  status: "draft" | "prelim" | "signed",
  content: ReportContent,
  signer?: {
    actorId: string; signedAt: Date; secondFactorAt: Date;
    amendmentReason?: string | null; supersedesId?: string | null;
    lockoutOverride?: { approvedBy: string; reason: string } | null;
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
  return await insertVersion(tx, study, "draft", input);
}

/**
 * O-11's UNVERIFIED read. A prelim is a real, quotable document — the night registrar's opinion,
 * available to the ward — and it is deliberately NOT publishable (A6): a patient must never be
 * handed a report nobody has signed.
 */
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
  const tier = await lockoutTierFor(tx, study, new Date());
  const hits = findLockoutHits(
    `${JSON.stringify(input.body)} ${input.impression ?? ""}`, tier,
  );
  if (hits.length > 0) {
    throw new RadiologyError(
      "lexical_lockout",
      `this PRELIM cannot be saved: it contains ${hits.map((h) => `"${h.term}"`).join(", ")} — a `
      + "prelim is readable by the ward, so §5(2) applies to it exactly as it applies to a signature",
      { terms: hits.map((h) => h.term), tier },
    );
  }
  return await insertVersion(tx, study, "prelim", input);
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
 * ═══ A1/A3/A4 — THE SIGNATURE ═══
 *
 * `secondFactorAt` is the SESSION's, carried by the controller rather than typed by the caller: a
 * signature that could name its own freshness is not a second factor at all.
 */
export async function signReport(
  tx: Tx,
  actor: Actor,
  input: {
    studyId: string;
    /** The draft or prelim being signed. Its content is copied forward into the signed version. */
    reportId: string;
    secondFactorAt: Date | null;
    /** `cfg.secondFactorWindowMinutes`, supplied by the controller. Falls back to the constant. */
    windowMinutes?: number;
    criticalCategory?: ImagingCriticalCategory | null;
    /** F66 — the medical superintendent who approved a demographic-tier hit, and why. */
    lockoutOverride?: { approvedBy: string; reason: string } | null;
    /** F69 — who the radiologist told, if they told anybody at signing time. */
    communicatedTo?: string | null;
    now?: Date;
  },
): Promise<{ reportId: string; version: number }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);

  /** A1 — §11.19-D-27. Checked FIRST: nothing about the content matters if the signer is not fresh. */
  const windowMinutes = input.windowMinutes ?? SECOND_FACTOR_WINDOW_MINUTES;
  const factorAt = input.secondFactorAt;
  /** The null check is separate so the type narrows; `secondFactorFresh` owns the ARITHMETIC. */
  if (factorAt === null || !secondFactorFresh({ secondFactorAt: factorAt }, windowMinutes, now)) {
    throw new RadiologyError(
      "second_factor_required",
      `signing a report needs a second factor no older than ${String(windowMinutes)} `
      + "minutes — a signature made on a session that authenticated this morning is a claim about the morning",
      { studyId: input.studyId, windowMinutes },
    );
  }

  const rows = await (tx as unknown as Db).select().from(imagingReports)
    .where(eq(imagingReports.id, input.reportId));
  const source = rows[0];
  if (!source || source.studyId !== study.id) {
    throw new RadiologyError("unknown_study", `no report ${input.reportId} on study ${study.id}`);
  }
  /**
   * ═══ CLOSE REVIEW B2 — A MACHINE'S DRAFT IS NOT SIGNABLE AS IT STANDS (§6.8) ═══
   *
   * The offline drafter leaves every clinical section empty by design, and `assertSignable` checks
   * lockout, laterality and category — never that a finding exists. So "Start from template" then
   * "Sign" would have produced a signed, publishable report with a technique line and nothing else,
   * with `provenance` null, indistinguishable from a deliberate read. The rule that closes it is the
   * contract's own sentence: the signed document is a HUMAN's. A version with provenance is a
   * proposal; the human saves their own draft (which carries none) and signs that.
   */
  if (source.provenance !== null) {
    throw new RadiologyError(
      "machine_draft_not_signable",
      `report ${input.reportId} is the drafter's proposal — save your own draft over it and sign that (§6.8)`,
      { reportId: input.reportId, drafter: (source.provenance as { drafter?: unknown }).drafter ?? null },
    );
  }
  if (!["draft", "prelim"].includes(source.status)) {
    throw new RadiologyError(
      "already_signed", `report ${input.reportId} is ${source.status}`, { status: source.status },
    );
  }

  const category = (input.criticalCategory ?? source.criticalCategory) as ImagingCriticalCategory | null;
  await assertSignable(tx, study, source, category, input.lockoutOverride ?? null, now);

  let created: { reportId: string; version: number };
  try {
    created = await insertVersion(
      tx, study, "signed",
      {
        templateKey: source.templateKey, body: source.body as Record<string, unknown>,
        impression: source.impression, laterality: source.laterality,
      },
      { actorId: actor.id, signedAt: now, secondFactorAt: factorAt, lockoutOverride: input.lockoutOverride ?? null },
      category,
    );
  } catch (e) {
    throw asAlreadySigned(e, study.id);
  }

  /**
   * ═══ F69 (CLOSE REVIEW) — SIGNING `red` NOW RAISES THE CRITICAL. IT USED TO RAISE NOTHING. ═══
   *
   * `critical_category` on the report and the `imaging_critical_findings` table were two
   * independent records of one fact with nothing joining them. The column was written here; the ROW
   * and the `imaging.critical_flagged` event were written only by `flagCritical`, whose sole caller
   * in the tree was its own HTTP route — and `radiology-api.ts` shipped no wire function for it, so
   * **from the product it was unreachable.**
   *
   * A head CT read at 02:10 and signed `red` produced one report row, ZERO critical rows, no event,
   * and nothing for 18a-iii's Critical Chaser to chase. The only observable consequence of choosing
   * "red" was that the PATIENT got their SMS sooner. The neurosurgeon was never told.
   *
   * The lab is the precedent and it does this at the bench: `enterResult` opens the call itself. So
   * does this now. `flagCritical` stays a route for the case where a category is raised after the
   * fact, and it is idempotent per report so the two paths cannot double-flag.
   */
  if (category !== null) {
    await flagCritical(tx, actor, {
      reportId: created.reportId,
      category,
      communicatedTo: input.communicatedTo ?? null,
    });
  }
  return created;
}

/** B10 — `imaging_reports_one_signed_ux`. A second signature is the DATABASE's refusal, not ours. */
function asAlreadySigned(e: unknown, studyId: string): unknown {
  const constraint = String((e as { constraint?: unknown })?.constraint ?? "");
  if (constraint.includes("imaging_reports_one_signed_ux")) {
    return new RadiologyError(
      "already_signed",
      `study ${studyId} already has a signed report — amend it rather than signing a second (B10)`,
      { studyId },
    );
  }
  return e;
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

async function lockoutTierFor(
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
async function assertFreeTextSignable(
  tx: Tx, studyId: string, text: string, now: Date = new Date(),
): Promise<void> {
  if (text.trim() === "") return;
  const study = await loadStudy(tx, studyId);
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

/** A3 and A4, in the order a reader would check them: the statute, then the side. */
async function assertSignable(
  tx: Tx,
  study: typeof imagingStudies.$inferSelect,
  content: {
    body: unknown; impression?: string | null; laterality?: string | null;
    /** F79 — every other free-text field that rides this act into a permanent, servable row. */
    reason?: string | null;
  },
  criticalCategory: string | null,
  lockoutOverride: { approvedBy: string; reason: string } | null,
  /** F66, second pass — the CALLER's clock. `Date.now()` here was F28's own pattern, reintroduced. */
  now: Date,
): Promise<void> {
  /**
   * ═══ A3 — THE LOCKOUT RUNS ON EVERY REPORT, NOT ONLY THE PCPNDT ONES ═══
   *
   * A3's mutant applies it only when `form_f_required`, and N9 names what slips: **the pregnant
   * trauma patient's CT abdomen.** That scan is not obstetric, carries no Form F, and can disclose a
   * foetal sex as easily as any anomaly scan. §5(2) is about the COMMUNICATION, not about the
   * examination code. The tier decides WHICH WORDS, never WHETHER — see `lockoutTierFor`.
   *
   * ═══ F79 — AND IT READS EVERY FREE-TEXT FIELD, NOT TWO ═══
   *
   * It used to read `body` and `impression` only, while four other free-text fields rode the same
   * chain into permanent rows that `reportView` serves: the **amendment reason** (which was on this
   * very object and simply not read), the critical `communicatedTo`, the critical `readBackText`
   * — *"the clinician repeats the finding in their own words"*, the likeliest place in the system
   * for a verbatim disclosure — and the gate waiver/override reasons. An amendment reasoned
   * *"correcting — the foetus is male, family informed"* was accepted and served. The two callers
   * that own those fields now pass them here.
   */
  const tier = await lockoutTierFor(tx, study, now);
  const text = [
    JSON.stringify(content.body),
    content.impression ?? "",
    content.reason ?? "",
  ].join(" ");
  const hits = findLockoutHits(text, tier);
  if (hits.length > 0) {
    /**
     * ═══ THE MEDICAL SUPERINTENDENT'S LANE (F66) — AND IT CANNOT LIFT THE CODED TIER ═══
     *
     * The refusal has always told the radiologist to *"say so to the medical superintendent"*, and
     * until now the medical superintendent had no route that could do anything about it. The
     * override is the `prior_contrast_reaction` pattern this module already uses: the signer names
     * the MS who agreed and why, and the code verifies that person actually holds the role. It is
     * stored on the report (`lockout_override`), so an inspector asking who let a flagged phrase
     * through gets a name, a reason and a timestamp rather than silence.
     *
     * **It lifts DEMOGRAPHIC hits only.** A coded euphemism — `mithai`, `Jai Mata Di`, a blue room,
     * `XX` — is refused to everybody, for ever, with no lane, the same way `form_f` is waivable by
     * nobody. The words that have an innocent use are the only words anyone may argue about.
     */
    const codedHits = findLockoutHits(text, "coded");
    const overridable = codedHits.length === 0;
    if (!(overridable && lockoutOverride)) {
      throw new RadiologyError(
        "lexical_lockout",
        `this report cannot be signed: it contains ${hits.map((h) => `"${h.term}"`).join(", ")} — `
        + "§5(2) of the PCPNDT Act forbids communicating the sex of a foetus in any manner. Rephrase, "
        + (overridable
          ? "or have the medical superintendent approve it (lockoutOverride)"
          : "and note that a coded phrase can be approved by nobody"),
        { terms: hits.map((h) => h.term), count: hits.length, tier, overridable },
      );
    }
    if (!(await actorHoldsAnyRole(tx, lockoutOverride.approvedBy, ["medical_superintendent"]))) {
      throw new RadiologyError(
        "lexical_lockout",
        `${lockoutOverride.approvedBy} does not hold the medical_superintendent role, so this is not `
        + "an approval anybody can rely on",
        { approvedBy: lockoutOverride.approvedBy },
      );
    }
    if (lockoutOverride.reason.trim() === "") {
      throw new RadiologyError("reason_required", "a lockout override needs a reason");
    }
  }

  /** A4 — the side the radiologist typed against the side the order carries. */
  const type = await requireStudyType(tx, study.studyTypeCode);
  if (type.laterality_applicable) {
    if (content.laterality === null || content.laterality === undefined) {
      throw new RadiologyError(
        "laterality_mismatch",
        `${study.studyTypeCode} is a lateralised examination and the report names no side`,
        { studyTypeCode: study.studyTypeCode, ordered: study.laterality },
      );
    }
    if (content.laterality !== study.laterality) {
      throw new RadiologyError(
        "laterality_mismatch",
        `the report says ${content.laterality} and the order says ${study.laterality} — a report on `
        + "the wrong side is a wrong-site finding with a signature on it",
        { reported: content.laterality, ordered: study.laterality },
      );
    }
  }

  if (criticalCategory !== null && !["red", "orange", "yellow"].includes(criticalCategory)) {
    throw new RadiologyError("evidence_invalid", `unknown criticality tier "${criticalCategory}"`);
  }
}

/**
 * ═══ A2 — THE AMENDMENT: v(n+1) SIGNED, v(n) SUPERSEDED, ONE TRANSACTION ═══
 *
 * Two concurrent amends produce exactly ONE v2, and the mechanism is the same partial unique that
 * refuses a second signature: both insert `status = 'signed'`, and `imaging_reports_one_signed_ux`
 * lets one through. The loser's whole transaction rolls back, so the superseded flip goes with it.
 */
export async function amendReport(
  tx: Tx,
  actor: Actor,
  input: {
    studyId: string; secondFactorAt: Date | null; reason: string; windowMinutes?: number;
    criticalCategory?: ImagingCriticalCategory | null;
    /** F66 — the medical superintendent who approved a demographic-tier hit, and why. */
    lockoutOverride?: { approvedBy: string; reason: string } | null;
    now?: Date;
  } & ReportContent,
): Promise<{ reportId: string; version: number; supersededId: string }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);

  if (input.reason.trim() === "") {
    throw new RadiologyError("reason_required", "an amendment carries a reason — what changed and why");
  }
  const amendFactorAt = input.secondFactorAt;
  if (amendFactorAt === null || !secondFactorFresh(
    { secondFactorAt: amendFactorAt }, input.windowMinutes ?? SECOND_FACTOR_WINDOW_MINUTES, now,
  )) {
    throw new RadiologyError(
      "second_factor_required",
      "amending a report needs a fresh second factor, exactly as signing one does",
    );
  }

  const previous = await latestSigned(tx, study.id);
  if (!previous) {
    throw new RadiologyError(
      "report_not_signed", `study ${study.id} has no signed report to amend`, { studyId: study.id },
    );
  }
  /**
   * ═══ F72 (CLOSE REVIEW) — AN AMENDMENT NO LONGER SILENTLY DOWNGRADES A RED CRITICAL ═══
   *
   * `signReport` inherits the source's category (`input.criticalCategory ?? source.criticalCategory`)
   * and this call passed `?? null`. So an amendment that did not RESTATE the category erased it:
   * v1 signed `red` for a large extradural haematoma, v2 signed with `critical_category = null`, the
   * flagged critical still hanging off the superseded v1 — and `publishReport`, reading `null`, then
   * put the corrected report BACK behind the settlement gate, so an unpaid patient's corrected
   * critical report sent no message at all. Inheriting is the same rule the sign path already had.
   */
  const category = (input.criticalCategory ?? previous.criticalCategory) as ImagingCriticalCategory | null;
  await assertSignable(tx, study, input, category, input.lockoutOverride ?? null, now);

  /**
   * THE FLIP COMES FIRST, and it has to: `imaging_reports_one_signed_ux` is a partial unique on
   * `status = 'signed'`, so inserting v2 while v1 is still signed collides with the constraint that
   * exists to stop exactly that. Superseding first, in the same transaction, is what makes the pair
   * atomic — a reader between the two statements is impossible.
   */
  await tx.update(imagingReports).set({ status: "superseded" })
    .where(eq(imagingReports.id, previous.id));

  const created = await insertVersion(
    tx, study, "signed", input,
    {
      actorId: actor.id, signedAt: now, secondFactorAt: amendFactorAt,
      amendmentReason: input.reason.trim(), supersedesId: previous.id,
      lockoutOverride: input.lockoutOverride ?? null,
    },
    category,
  );

  /**
   * ═══ F70 (CLOSE REVIEW) — AN AMENDMENT OF A PUBLISHED REPORT IS PUBLISHED WITH IT ═══
   *
   * The first version carried no `published_at` forward, re-emitted no `imaging.report_published`
   * and never touched the study. So after a publish-then-amend the ONLY row carrying a publication
   * timestamp was the **superseded** one: *"7 mm calculus, left renal pelvis — missed on the first
   * read"* was signed and invisible to every publication-aware consumer, 22c-F's patient app still
   * held v1, and nothing anywhere prompted a re-publish.
   *
   * **If v1 was published, v2 is published in the same transaction.** The hospital has already told
   * this patient and this ward that a report exists; the only question an amendment leaves open is
   * WHICH text they are holding, and the answer must not be the withdrawn one. Leaving the decision
   * to a second human is the shape that produced the defect — there is no screen that would prompt
   * them, and a correction that waits is a correction nobody reads.
   *
   * If v1 was NOT published, nothing happens here and the normal publish path still owns the act.
   *
   * The STUDY's status and its workflow instance are deliberately untouched: `published` is a
   * TERMINAL state in `imagingStudyDefinition`, so walking it backwards would need an edge the
   * definition does not have, and inventing one to model "published, then corrected" would make
   * every downstream reader of that machine wrong about what terminal means.
   */
  /**
   * ═══ F69, SECOND PASS — A CRITICAL FOUND ON RE-READ RAISED NOTHING ═══
   *
   * The first fix made `signReport` raise the critical and left `amendReport` alone, which is the
   * path where *"missed on the first read"* actually happens: v1 signed `green` and published, then
   * amended to `red` for a large extradural haematoma. `critical_category` landed on v2's row and
   * **no `imaging_critical_findings` row, no `imaging.critical_flagged`, nothing for 18a-iii's
   * Critical Chaser** — the exact defect F69 was raised for, closed on one path and open on the
   * other. `flagCritical` is idempotent per REPORT, and v2 is a new report, so the amendment's
   * critical is its own row rather than a duplicate of v1's.
   */
  if (category !== null) {
    await flagCritical(tx, actor, { reportId: created.reportId, category, communicatedTo: null });
  }

  if (previous.publishedAt !== null) {
    await tx.update(imagingReports).set({ publishedAt: now })
      .where(eq(imagingReports.id, created.reportId));
    /**
     * ═══ F70, SECOND PASS — AND THE PATIENT IS TOLD ═══
     *
     * The first fix moved `published_at` and emitted the event and stopped there, so the patient
     * who was told *"your report is ready"* for v1 was never told the report had CHANGED. The
     * notification's dedupe key is per REPORT ID, so v2's message is a distinct one and is not
     * suppressed by v1's. `notifyIfDue` owns the settlement gate exactly as it does on the ordinary
     * publish path, so a correction does not become a way around the cashier either.
     */
    await notifyIfDue(
      tx, study,
      { id: created.reportId, criticalCategory: category } as ReportRow,
      now,
    );
    await appendEvent(tx, imagingReportPublished.make({
      actor,
      patientId: study.patientId,
      encounterId: study.encounterNo,
      payload: {
        studyId: study.id, reportId: created.reportId, version: created.version,
        patientId: study.patientId, encounterNo: study.encounterNo,
        criticalCategory: category,
      },
    }));
  }
  return { ...created, supersededId: previous.id };
}

/**
 * ═══ A6/A7 — PUBLICATION, AND MONEY GATES THE MESSAGE AND NEVER THE REPORT ═══
 *
 * A6's mutant gates publication itself on payment, and D5's inversion is what it produces: **the
 * critical finding waits for the cashier.** So `publishReport` always publishes — the report becomes
 * visible in the app and the envelope closes — and settlement decides only whether the *"your report
 * is ready"* MESSAGE goes out (O-2/D5). A `red` critical sends regardless: somebody has to be told
 * about the bleed whether or not the bill is paid.
 */
export async function publishReport(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: { studyId: string; now?: Date },
): Promise<{ reportId: string; version: number; notified: boolean }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);
  const signed = await latestSigned(tx, study.id);
  if (!signed) {
    /** A6 — a prelim is a real document and is deliberately not publishable. */
    const anyPrelim = await (tx as unknown as Db).select({ id: imagingReports.id })
      .from(imagingReports)
      .where(and(eq(imagingReports.studyId, study.id), eq(imagingReports.status, "prelim")));
    if (anyPrelim.length > 0) {
      throw new RadiologyError(
        "prelim_not_publishable",
        `study ${study.id} has only a PRELIM report — a patient must never be handed a report nobody has signed (O-11)`,
        { studyId: study.id },
      );
    }
    throw new RadiologyError("report_not_signed", `study ${study.id} has no signed report`, { studyId: study.id });
  }
  if (signed.publishedAt !== null) {
    throw new RadiologyError("already_signed", `report ${signed.id} is already published`, { reportId: signed.id });
  }

  /**
   * ═══ F71 (CLOSE REVIEW) — THE STAMP IS A COMPARE-AND-SET, NOT A BLIND UPDATE BY ID ═══
   *
   * `withTx` is READ COMMITTED. The first version re-read `latestSigned` and then updated
   * `WHERE id = signed.id` with no guard that the row was STILL signed. Interleave a publish with an
   * amend: B's `SET status='superseded' WHERE id=v1` takes the row lock, A blocks, B commits (v1
   * superseded, v2 signed), A's update re-evaluates `id = v1`, still matches — and stamps
   * `published_at` on the **superseded** row, then announces v1 to every consumer. The hospital's
   * published report is the withdrawn one and the current one has no publication record.
   *
   * Adding `status = 'signed'` to the WHERE makes the update its own CAS: after B commits, A matches
   * zero rows and answers `stale_state`, which is a 409 and exactly what losing a race is.
   * `reports.concurrency.test.ts` raced amend-vs-amend and sign-vs-sign and never raced publish —
   * and its invariant (*"exactly one row with status='signed'"*) holds in the failing interleaving
   * too, because the defect lives in a column that file never selected.
   */
  const stamped = await tx.update(imagingReports).set({ publishedAt: now })
    .where(and(eq(imagingReports.id, signed.id), eq(imagingReports.status, "signed")))
    .returning({ id: imagingReports.id });
  if (stamped.length === 0) {
    throw new RadiologyError(
      "stale_state",
      `report ${signed.id} stopped being the signed version while it was being published — it was `
      + "amended by somebody else; publish the amendment",
      { reportId: signed.id },
    );
  }

  /** DD4 — `published` is where the envelope item reaches `completed` and the order may close. */
  if (study.status !== "published") {
    if (study.status === "acquired") {
      await transition(tx, study.workflowInstanceId, "reported", actor);
    }
    await transition(tx, study.workflowInstanceId, "published", actor);
    await tx.update(imagingStudies).set({ status: "published" }).where(eq(imagingStudies.id, study.id));
  }
  const itemRows = await (tx as unknown as Db).select({ status: orderItems.status })
    .from(orderItems).where(eq(orderItems.id, study.orderItemId));
  if (itemRows[0]?.status === "in_progress") {
    await advanceOrderItem(tx, actor, decls, study.orderItemId, "completed", {});
  }

  await appendEvent(tx, imagingReportPublished.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo,
    payload: {
      studyId: study.id, reportId: signed.id, version: signed.version,
      patientId: study.patientId, encounterNo: study.encounterNo,
      criticalCategory: signed.criticalCategory,
    },
  }));

  const notified = await notifyIfDue(tx, study, signed, now);
  return { reportId: signed.id, version: signed.version, notified };
}

/**
 * A6's settlement rule and A7's swallow, in one place.
 *
 * **A7 — `enqueueNotification` throwing must not fail the publish.** S7's case is a patient with no
 * channel at all, and C7 is the consequence of getting it wrong: a report signed at 02:00 sits
 * unpublished because a phone number is missing. The report is the clinical artefact; the message is
 * a courtesy.
 */
async function notifyIfDue(
  tx: Tx,
  study: typeof imagingStudies.$inferSelect,
  signed: ReportRow,
  now: Date,
): Promise<boolean> {
  const isRedCritical = signed.criticalCategory === "red";
  if (!isRedCritical && !(await invoiceIsSettled(tx, study.invoiceLineId))) return false;

  try {
    const orderRows = await (tx as unknown as Db).select({ orderNo: orders.orderNo })
      .from(orders).where(eq(orders.id, study.orderId));
    await enqueueNotification(tx, {
      templateKey: "imaging_report_ready",
      params: { orderNo: orderRows[0]?.orderNo ?? study.accessionNo },
      dedupeKey: `imaging_report_ready:${signed.id}`,
      occurredAt: now,
      patientId: study.patientId,
    });
    return true;
  } catch {
    /** A7 — deliberately swallowed. See the header; the read is the priority, not the message. */
    return false;
  }
}

/** O-2/D5 — no line at all is UNSETTLED, which is the strict direction for a courtesy message. */
async function invoiceIsSettled(exec: Db | Tx, invoiceLineId: string | null): Promise<boolean> {
  if (invoiceLineId === null) return false;
  const rows = await (exec as Db).select({ invoiceId: invoiceLines.invoiceId })
    .from(invoiceLines).where(eq(invoiceLines.id, invoiceLineId));
  const invoiceId = rows[0]?.invoiceId;
  if (invoiceId === undefined) return false;
  const settlement = await invoiceSettlement(exec, invoiceId);
  return settlement.state === "settled";
}

/* ═══════════════════════════ DD15 — the criticals ═══════════════════════════ */

/**
 * A `red` finding pages a human. 18a-iii's Critical Chaser is the consumer that will not let it
 * rest; this phase records the fact and the clock so that ladder has history to tune against.
 */
export async function flagCritical(
  tx: Tx,
  actor: Actor,
  input: { reportId: string; category: ImagingCriticalCategory; communicatedTo?: string | null; now?: Date },
): Promise<{ criticalId: string }> {
  const rows = await (tx as unknown as Db).select().from(imagingReports)
    .where(eq(imagingReports.id, input.reportId));
  const report = rows[0];
  if (!report) throw new RadiologyError("unknown_study", `no report ${input.reportId}`);

  /**
   * F69 — IDEMPOTENT PER REPORT. `signReport` now raises the critical itself, and this route stays
   * for a category raised after the fact; two paths writing one fact must not be able to produce
   * two rows for one finding, or 18a-iii's chaser chases the same haematoma twice and the second
   * acknowledgement closes a loop nobody opened.
   */
  const already = await (tx as unknown as Db).select({ id: imagingCriticalFindings.id })
    .from(imagingCriticalFindings).where(eq(imagingCriticalFindings.reportId, report.id));
  if (already[0]) return { criticalId: already[0].id };

  /**
   * F79 — the free text a critical carries is checked against the lockout like any other report
   * text. `communicatedTo` is stored and travels in the event payload.
   */
  await assertFreeTextSignable(tx, report.studyId, input.communicatedTo ?? "");

  const criticalId = newId();
  await tx.insert(imagingCriticalFindings).values({
    id: criticalId,
    reportId: report.id,
    category: input.category,
    communicatedTo: input.communicatedTo ?? null,
    communicatedAt: input.communicatedTo === undefined || input.communicatedTo === null
      ? null : (input.now ?? new Date()),
  });
  await appendEvent(tx, imagingCriticalFlagged.make({
    actor,
    payload: {
      reportId: report.id, studyId: report.studyId, category: input.category,
      communicatedTo: input.communicatedTo ?? null,
    },
  }));
  return { criticalId };
}

/**
 * ═══ F76 (CLOSE REVIEW) — THE LOOP IS CLOSED BY THE CLINICIAN, NOT BY WHOEVER TYPED IT ═══
 *
 * The first version wrote `acknowledgedBy: actor.id` and had no field for the person who actually
 * received the call. `radiology.criticals.ack` is granted to `radiologist` alone, so
 * `acknowledged_by` was structurally always a radiologist and usually the signer — the loop closed
 * at both ends by one person, and `imaging.critical_acknowledged` told 18a-iii's chaser that the
 * finding *"reached a human"*. `reports.test.ts` pinned that as correct: it flagged and acknowledged
 * as the same radiologist and asserted the identity, so an implementation that refused a
 * self-acknowledgement would have failed the suite.
 *
 * Now: `acknowledgedByClinicianId` is REQUIRED and names the clinician who read the finding back;
 * the actor who recorded it is kept separately as `recordedBy`. **The clinician may not be the
 * report's signer** — a radiologist telephoning themselves is not a communication. The actor may
 * still be the radiologist, because at 02:10 the radiologist is who is at a keyboard.
 */
export async function acknowledgeCritical(
  tx: Tx,
  actor: Actor,
  input: {
    criticalId: string;
    /** F76 — the clinician who received the call and repeated it back. */
    acknowledgedByClinicianId: string;
    readBack?: string | null;
    now?: Date;
  },
): Promise<{ criticalId: string; acknowledgedAt: Date }> {
  const rows = await (tx as unknown as Db).select().from(imagingCriticalFindings)
    .where(eq(imagingCriticalFindings.id, input.criticalId));
  const critical = rows[0];
  if (!critical) throw new RadiologyError("unknown_study", `no critical finding ${input.criticalId}`);
  if (critical.acknowledgedAt !== null) {
    throw new RadiologyError("already_signed", `critical ${input.criticalId} is already acknowledged`);
  }
  /** DD15 — `red` demands a READ-BACK; the other two are satisfied by an acknowledgement. */
  if (critical.category === "red" && (input.readBack === undefined || input.readBack === null || input.readBack.trim() === "")) {
    throw new RadiologyError(
      "reason_required",
      "a RED critical is acknowledged with a read-back — the clinician repeats the finding in their own words",
      { criticalId: input.criticalId },
    );
  }
  /** The table hangs off the REPORT; the study comes from it, which keeps one owner for the link. */
  const reportRows = await (tx as unknown as Db)
    .select({ studyId: imagingReports.studyId, signerId: imagingReports.signerId })
    .from(imagingReports).where(eq(imagingReports.id, critical.reportId));
  const report = reportRows[0]!;

  /**
   * ═══ F76, SECOND PASS — A NAMED PERSON WHO DOES NOT EXIST IS NOT A CLINICIAN ═══
   *
   * The first fix separated WHO received the call from WHO typed it, and then validated the
   * clinician against exactly one thing: that they are not the signer. `acknowledged_by` is plain
   * `text` with no foreign key, so `{"acknowledgedByClinicianId": "x"}` wrote the row, emitted
   * `imaging.critical_acknowledged` naming `"x"`, and stopped 18a-iii's chaser — *"did this reach a
   * human"* answered by a string nobody typed a name into.
   *
   * The argument is F64's, one commit old and in this same phase: *"a named person who does not
   * exist is not a chaperone; it is a field that was filled in."* It applies with more force to the
   * person who received a red critical.
   */
  const clinician = await (tx as unknown as Db)
    .select({ id: users.id, active: users.active })
    .from(users).where(eq(users.id, input.acknowledgedByClinicianId));
  if (!clinician[0]) {
    throw new RadiologyError(
      "evidence_invalid",
      `${input.acknowledgedByClinicianId} is not a user of this hospital — a critical is read back `
      + "by a person, and the record of who has to name one",
      { acknowledgedByClinicianId: input.acknowledgedByClinicianId },
    );
  }
  if (clinician[0].active === false) {
    throw new RadiologyError(
      "evidence_invalid",
      `${input.acknowledgedByClinicianId} is not an active member of staff`,
      { acknowledgedByClinicianId: input.acknowledgedByClinicianId },
    );
  }

  /** F76 — the signer telephoning themselves is not a read-back. */
  if (input.acknowledgedByClinicianId === report.signerId) {
    throw new RadiologyError(
      "evidence_invalid",
      "the report's own signer cannot be the clinician who received the critical — a read-back is a "
      + "communication to somebody else",
      { criticalId: input.criticalId, signerId: report.signerId },
    );
  }
  /** F79 — the read-back is the likeliest place in the system for a verbatim sex disclosure. */
  await assertFreeTextSignable(tx, report.studyId, input.readBack ?? "");

  const acknowledgedAt = input.now ?? new Date();
  await tx.update(imagingCriticalFindings)
    .set({
      acknowledgedBy: input.acknowledgedByClinicianId,
      recordedBy: actor.id,
      acknowledgedAt,
      readBackText: input.readBack ?? null,
    })
    .where(eq(imagingCriticalFindings.id, input.criticalId));
  await appendEvent(tx, imagingCriticalAcknowledged.make({
    actor,
    payload: {
      reportId: critical.reportId, studyId: report.studyId,
      category: critical.category, acknowledgedBy: input.acknowledgedByClinicianId,
    },
  }));
  return { criticalId: input.criticalId, acknowledgedAt };
}
