import { and, eq } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { enqueueNotification } from "../../kernel/notify/enqueue";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { secondFactorFresh } from "../../kernel/auth/totp";
import { transition } from "../../kernel/workflow/instances";
import {
  imagingCriticalFindings, imagingReports, imagingStudies, imagingTeleReads,
} from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { invoiceLines } from "../../kernel/db/schema/billing";
import { patients } from "../../kernel/db/schema/patients";
import { invoiceSettlement } from "../billing";
import { assertMachineRegistered, assertPersonRegistered, findLockoutHits } from "../pcpndt";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { istDayString } from "../../kernel/approvals/cumulative";
import { RadiologyError } from "./errors";
import { imagingReportPublished } from "./events";
import { requireStudyType } from "./study-types";
import { activeDefinitionRow, parseDefinitionBody } from "./definitions";
import { PRE_SIGN_CHECKS, runPreSignChecks } from "./checks";
import { residentSignature, signerSnapshot } from "./signer";
import {
  assertNoFoetalSexDisclosure, isObstetricReport, normaliseReportBody, reportText, scanDayOf, withDeclaration,
} from "./obstetric-report";
import { openFollowupsAtSignature, reconcileFollowupsAtAmendment } from "./followups";
import { openAmendmentReview } from "./peer-review";
import { assertNotTeleReader, overRead } from "./tele";
import {
  defaultTemplateKey, draftReport, insertVersion, latestSigned, loadStudy, lockoutTierFor,
} from "./report-authoring";
import { flagCritical } from "./criticals";
import type { ReportContent, ReportRow } from "./report-authoring";
import type { PreSignContext, PreSignFinding } from "./checks";
import type { ResidentSignature, SignerBlock } from "./signer";
import type { ImagingCriticalCategory } from "../../kernel/db/schema/radiology";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { OrderKindDecl } from "../../kernel/orders/kinds";

/**
 * PLAN 18a T8 — **THE SIGNATURE: under a fresh second factor, checked before the insert, then published.**
 *
 * ═══ THREE THINGS ARE CHECKED AT SIGN, AND ALL THREE ARE CHECKED BEFORE THE INSERT ═══
 *
 *   · **the second factor is FRESH** (A1) — §11.19-D-27. A signature is an identity claim, and one
 *     made on a session that authenticated this morning is a claim about the morning.
 *   · **the lockout** (A3) — on EVERY report, not only the PCPNDT-applicable ones. A3's mutant
 *     applies it only when `form_f_required`, and N9 is what slips through: the pregnant trauma
 *     patient's CT, which is not an obstetric scan and can still disclose a foetal sex.
 *   · **the laterality** (A4) — against the ORDER ITEM's, on types where a side exists at all.
 *
 * #1077 — split out of `reports.ts` (see `report-authoring.ts`): the signature, the resident's
 * signature and the consultant's co-sign, the pre-sign checks, the amendment, publication and the
 * patient's notice, and the morning over-read of a night prelim. A critical these acts carry is
 * raised in `criticals.ts`.
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
    /** 18-S RS8a — the warning codes the signer has seen and acknowledges (`checks.ts`). */
    acknowledgedWarnings?: readonly string[];
    now?: Date;
  },
): Promise<{ reportId: string; version: number; awaitingCosign?: boolean }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);
  /** 18-S RS8c — a night-read partner's radiologist issues prelims; the hospital's consultant signs. */
  await assertNotTeleReader(tx, actor, "sign");

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
  await assertSignerRegistered(tx, actor, study, now);
  const obstetric = await isObstetricReport(tx, study, source.templateKey);

  const content = {
    templateKey: source.templateKey,
    /** 18-S RS7 T2 — the obstetric report's fixed PCPNDT declaration, in the server's words. */
    body: withDeclaration(source.body as Record<string, unknown>, obstetric),
    impression: source.impression, laterality: source.laterality,
  };
  /** 18-S RS8a — the deterministic checks, then the signer block: both before the insert. */
  const checks = enforcePreSign(
    await preSignFindings(tx, study, content, category), input.acknowledgedWarnings ?? [], actor.id, now,
  );

  /** 18-S RS8b — a resident's signature waits for a consultant; it is not the hospital's report yet. */
  if (await signsAsResident(tx, actor)) {
    return await signForCosign(tx, actor, study, content, category, {
      factorAt, checks, now, lockoutOverride: input.lockoutOverride ?? null, communicatedTo: input.communicatedTo ?? null,
    });
  }

  const block = await signerSnapshot(tx, { userId: actor.id, now, secondFactorAt: factorAt, content });

  let created: { reportId: string; version: number };
  try {
    created = await insertVersion(
      tx, study, "signed",
      content,
      {
        actorId: actor.id, signedAt: now, secondFactorAt: factorAt, lockoutOverride: input.lockoutOverride ?? null,
        block, checks,
      },
      category,
    );
  } catch (e) {
    throw asAlreadySigned(e, study.id);
  }
  /**
   * 18-S RS8b — a consultant who signs their OWN version while a resident's waits has replaced it:
   * the resident's text is no longer the one anybody will co-sign.
   */
  await tx.update(imagingReports).set({ status: "superseded" })
    .where(and(eq(imagingReports.studyId, study.id), eq(imagingReports.status, "awaiting_cosign")));
  /** 18-S RS8c T1 — the recommendations this signature carries become follow-up rows. */
  await openFollowupsAtSignature(tx, actor, study, { reportId: created.reportId, body: content.body }, now);

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

/* ═══════════════════════ 18-S RS8b — the resident signs, the consultant co-signs ═══════════════════════ */

/**
 * PLAN 18-S RS8b T1 — **CO-SIGN.** DECIDED (the Indian teaching-hospital standard): a DNB/MD
 * resident drafts and may issue a PRELIM to the treating doctor for ER/STAT work, but a FINAL report
 * needs a consultant's signature. So a resident's Sign produces `awaiting_cosign` — the checks ran,
 * the resident signed under their own second factor — and `publishReport` refuses `cosign_required`
 * until a consultant (`radiologist`) co-signs under THEIR second factor, with the same pre-sign
 * checks and their own signer block, which names the resident as `draftedBy`.
 *
 * A user holding BOTH roles is a consultant: the resident role adds no restriction to a consultant.
 */
export const RESIDENT_ROLE = "radiology_resident";
export const CONSULTANT_ROLE = "radiologist";

export async function signsAsResident(tx: Tx, actor: Actor): Promise<boolean> {
  if (actor.type !== "user") return false;
  if (!(await actorHoldsAnyRole(tx, actor.id, [RESIDENT_ROLE]))) return false;
  return !(await actorHoldsAnyRole(tx, actor.id, [CONSULTANT_ROLE]));
}

async function signForCosign(
  tx: Tx,
  actor: Actor,
  study: typeof imagingStudies.$inferSelect,
  content: { templateKey: string; body: Record<string, unknown>; impression: string | null; laterality: string | null },
  category: ImagingCriticalCategory | null,
  at: {
    factorAt: Date; checks: SignChecksRecord; now: Date;
    lockoutOverride: { approvedBy: string; reason: string } | null; communicatedTo: string | null;
  },
): Promise<{ reportId: string; version: number; awaitingCosign: true }> {
  if (await latestSigned(tx, study.id)) {
    throw new RadiologyError(
      "already_signed",
      `study ${study.accessionNo} already has a signed report — a consultant amends it; a resident does not sign a second`,
      { studyId: study.id },
    );
  }
  const block = await residentSignature(tx, { userId: actor.id, now: at.now, secondFactorAt: at.factorAt, content });
  let created: { reportId: string; version: number };
  try {
    created = await insertVersion(tx, study, "awaiting_cosign", content, {
      actorId: actor.id, signedAt: at.now, secondFactorAt: at.factorAt, lockoutOverride: at.lockoutOverride,
      block, checks: at.checks,
    }, category);
  } catch (e) {
    const constraint = String((e as { constraint?: unknown })?.constraint ?? "");
    if (constraint.includes("imaging_reports_one_awaiting_ux")) {
      throw new RadiologyError(
        "already_signed",
        `study ${study.accessionNo} already has a resident's report waiting for a consultant's co-sign`,
        { studyId: study.id },
      );
    }
    throw e;
  }
  /**
   * A critical found by the resident is COMMUNICATED NOW — the ladder does not wait for the
   * co-sign (the board's J2: the ER hears about the bleed from whoever read it). The call hangs off
   * this version; the co-sign does not raise a second one.
   */
  if (category !== null) {
    await flagCritical(tx, actor, { reportId: created.reportId, category, communicatedTo: at.communicatedTo });
  }
  return { ...created, awaitingCosign: true };
}

/**
 * The consultant's co-signature: the resident's text, unchanged, signed by the consultant. To
 * change the text the consultant saves their own draft and signs THAT (which supersedes the
 * resident's version) — co-signing is agreeing, not editing.
 */
export async function cosignReport(
  tx: Tx,
  actor: Actor,
  input: {
    studyId: string;
    /** The resident's `awaiting_cosign` version. */
    reportId: string;
    secondFactorAt: Date | null;
    windowMinutes?: number;
    acknowledgedWarnings?: readonly string[];
    now?: Date;
  },
): Promise<{ reportId: string; version: number; cosignedId: string }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);
  await assertNotTeleReader(tx, actor, "co-sign");
  const windowMinutes = input.windowMinutes ?? SECOND_FACTOR_WINDOW_MINUTES;
  const factorAt = input.secondFactorAt;
  if (factorAt === null || !secondFactorFresh({ secondFactorAt: factorAt }, windowMinutes, now)) {
    throw new RadiologyError(
      "second_factor_required",
      `co-signing a report needs your own second factor, no older than ${String(windowMinutes)} minutes — the `
      + "resident's does not stand in for yours",
      { studyId: input.studyId, windowMinutes },
    );
  }
  if (actor.type !== "user" || !(await actorHoldsAnyRole(tx, actor.id, [CONSULTANT_ROLE]))) {
    throw new RadiologyError(
      "cosign_not_consultant",
      "only a consultant radiologist co-signs a resident's report — ask the consultant on the list to co-sign it",
      { studyId: input.studyId },
    );
  }
  const [awaiting] = await (tx as unknown as Db).select().from(imagingReports)
    .where(eq(imagingReports.id, input.reportId));
  if (!awaiting || awaiting.studyId !== study.id) {
    throw new RadiologyError("unknown_study", `no report ${input.reportId} on study ${study.accessionNo}`);
  }
  if (awaiting.status !== "awaiting_cosign") {
    throw new RadiologyError(
      "stale_state",
      `this version is ${awaiting.status}, not waiting for a co-sign — reload the study`,
      { reportId: awaiting.id, status: awaiting.status },
    );
  }
  if (awaiting.signerId === actor.id) {
    throw new RadiologyError(
      "cosign_own_report",
      "you signed this report as the resident — a second consultant co-signs it; nobody co-signs their own",
      { reportId: awaiting.id },
    );
  }

  const category = awaiting.criticalCategory as ImagingCriticalCategory | null;
  const content = {
    templateKey: awaiting.templateKey,
    body: awaiting.body as Record<string, unknown>,
    impression: awaiting.impression, laterality: awaiting.laterality,
  };
  await assertSignable(tx, study, content, category, (awaiting.lockoutOverride ?? null) as { approvedBy: string; reason: string } | null, now);
  await assertSignerRegistered(tx, actor, study, now);
  /** The pre-sign checks run again, and the CONSULTANT acknowledges the warnings, in their own name. */
  const checks = enforcePreSign(
    await preSignFindings(tx, study, content, category), input.acknowledgedWarnings ?? [], actor.id, now,
  );
  const consultant = await signerSnapshot(tx, { userId: actor.id, now, secondFactorAt: factorAt, content });
  const resident = awaiting.signer as ResidentSignature | null;
  const block: SignerBlock = resident === null ? consultant : { ...consultant, draftedBy: { ...resident, reportId: awaiting.id } };

  /** Compare-and-set: two consultants co-signing one report produce one signature. */
  const flipped = await tx.update(imagingReports).set({ status: "cosigned" })
    .where(and(eq(imagingReports.id, awaiting.id), eq(imagingReports.status, "awaiting_cosign")))
    .returning({ id: imagingReports.id });
  if (flipped.length === 0) {
    throw new RadiologyError("stale_state", "another consultant co-signed this report a moment ago — reload the study", { reportId: awaiting.id });
  }
  let created: { reportId: string; version: number };
  try {
    created = await insertVersion(tx, study, "signed", content, {
      actorId: actor.id, signedAt: now, secondFactorAt: factorAt,
      lockoutOverride: (awaiting.lockoutOverride ?? null) as { approvedBy: string; reason: string } | null,
      block, checks,
    }, category);
  } catch (e) {
    throw asAlreadySigned(e, study.id);
  }
  /** 18-S RS8c T1 — the co-signed report is the hospital's: its recommendations become follow-ups. */
  await openFollowupsAtSignature(tx, actor, study, { reportId: created.reportId, body: content.body }, now);

  /** The critical, if any, was raised at the resident's signature; only a category with no call gets one now. */
  if (category !== null) {
    const raised = await (tx as unknown as Db).select({ id: imagingCriticalFindings.id })
      .from(imagingCriticalFindings).where(eq(imagingCriticalFindings.reportId, awaiting.id));
    if (raised.length === 0) await flagCritical(tx, actor, { reportId: created.reportId, category, communicatedTo: null });
  }
  return { ...created, cosignedId: awaiting.id };
}

/**
 * ═══ 18-S RS7 — THE ACT'S MEMBERSHIP RULE, AT THE SIGNATURE ═══
 *
 * `startAcquisition` already refuses a PCPNDT scan performed by a person who is not on the machine's
 * registration. The SIGNATURE had no such check, so a radiologist registered nowhere could sign the
 * obstetric report of a scan somebody else performed on a registered machine — the report being the
 * statutory record of what was found. Only a person registered on THAT machine's registration, on the
 * signing day (IST), signs a `form_f_required` study. Studies outside the Act are untouched.
 */
async function assertSignerRegistered(
  tx: Tx, actor: Actor, study: typeof imagingStudies.$inferSelect, now: Date,
): Promise<void> {
  if (!study.formFRequired) return;
  if (study.deviceResourceId === null) {
    throw new RadiologyError(
      "machine_not_registered",
      `study ${study.accessionNo} names no machine, so nobody can be checked against its PCPNDT registration`,
      { studyId: study.id },
    );
  }
  const { registrationId } = await assertMachineRegistered(tx, study.deviceResourceId, istDayString(now));
  await assertPersonRegistered(tx, actor.id, registrationId);
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

/** A3 and A4, in the order a reader would check them: the statute, then the side. */
async function assertSignable(
  tx: Tx,
  study: typeof imagingStudies.$inferSelect,
  content: {
    body: unknown; impression?: string | null; laterality?: string | null;
    /** 18-S RS7 — the template the version uses (an obstetric template is an obstetric report). */
    templateKey?: string | null;
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
  /**
   * ═══ 18-S RS7 T1 — THE FOETAL-SEX GUARD RUNS FIRST, AND `lockoutOverride` NEVER REACHES IT ═══
   *
   * A sentence that states the sex of a foetus is `foetal_sex_disclosure`, which the medical
   * superintendent's F66 lane below cannot lift. Checked before the word list so the refusal names
   * the Act's harm rather than a word (see `pcpndt/foetal-sex.ts`).
   */
  const obstetric = await isObstetricReport(tx, study, content.templateKey ?? null);
  assertNoFoetalSexDisclosure(
    reportText([content.body, content.impression ?? "", content.reason ?? ""]), obstetric, "report",
  );
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

/* ═══════════════════════ 18-S RS8a — the pre-sign checks, gathered and enforced ═══════════════════════ */

/** What `sign_checks` records on a signed version. */
export type SignChecksRecord = {
  ran: string[];
  warnings: { code: string; words: string }[];
  acknowledgedBy: string;
  acknowledgedAt: string;
};

/**
 * The facts `checks.ts` reads, gathered once: the study type's name, the study's side, the
 * patient's registered sex, the governed template the report names (null for a built-in skeleton)
 * and the body split into its text sections and its `coded` block.
 */
async function preSignContextOf(
  tx: Tx,
  study: typeof imagingStudies.$inferSelect,
  content: { templateKey: string; body: unknown; impression: string | null },
  criticalCategory: string | null,
): Promise<PreSignContext> {
  const type = await requireStudyType(tx, study.studyTypeCode);
  const [patient] = await (tx as unknown as Db).select({ sex: patients.sex })
    .from(patients).where(eq(patients.id, study.patientId));
  const body = (typeof content.body === "object" && content.body !== null ? content.body : {}) as Record<string, unknown>;
  const sections: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") sections[k] = v;
  const coded = typeof body.coded === "object" && body.coded !== null ? body.coded as Record<string, unknown> : {};
  const bookRow = await activeDefinitionRow(tx, "report_templates");
  const template = bookRow === undefined
    ? null
    : parseDefinitionBody("report_templates", bookRow.body).templates.find((t) => t.key === content.templateKey) ?? null;
  return {
    studyTypeCode: type.code, studyTypeName: type.name, studyLaterality: study.laterality,
    patientSex: patient?.sex ?? "unknown", sections,
    impression: content.impression ?? (typeof body.impression === "string" ? body.impression : ""),
    coded, template, criticalCategory,
  };
}

async function preSignFindings(
  tx: Tx,
  study: typeof imagingStudies.$inferSelect,
  content: { templateKey: string; body: unknown; impression: string | null },
  criticalCategory: string | null,
): Promise<PreSignFinding[]> {
  return runPreSignChecks(await preSignContextOf(tx, study, content, criticalCategory));
}

/**
 * A refusal stops the signature with ITS OWN code (the first, with every refusal in the detail so
 * the screen can list them). Warnings pass only when every one is acknowledged, and the record of
 * which were raised and acknowledged is what the signed row stores.
 */
function enforcePreSign(
  findings: readonly PreSignFinding[], acknowledged: readonly string[], actorId: string, now: Date,
): SignChecksRecord {
  const refusals = findings.filter((f) => f.level === "refuse");
  if (refusals.length > 0) {
    const first = refusals[0]!;
    throw new RadiologyError(
      first.code as "impression_required",
      refusals.map((r) => r.words).join(" "),
      { refusals: refusals.map((r) => ({ code: r.code, words: r.words })), ...first.detail },
    );
  }
  const warnings = findings.filter((f) => f.level === "warn");
  const unacknowledged = warnings.filter((w) => !acknowledged.includes(w.code));
  if (unacknowledged.length > 0) {
    throw new RadiologyError(
      "checks_unacknowledged",
      `before signing, acknowledge: ${unacknowledged.map((w) => w.words).join(" ")}`,
      { warnings: unacknowledged.map((w) => ({ code: w.code, words: w.words })) },
    );
  }
  return {
    ran: PRE_SIGN_CHECKS.map((c) => c.code),
    warnings: warnings.map((w) => ({ code: w.code, words: w.words })),
    acknowledgedBy: actorId,
    acknowledgedAt: now.toISOString(),
  };
}

/**
 * The screen's DRY RUN: the same checks on the text in front of the radiologist, before any save.
 * Nothing is written and no PHI row is logged beyond the study read the screen already made — the
 * text is the caller's own.
 */
export async function dryRunPreSign(
  tx: Tx,
  actor: Actor,
  input: { studyId: string; templateKey?: string; body: Record<string, unknown>; impression?: string | null; criticalCategory?: string | null },
): Promise<{ findings: PreSignFinding[]; signable: boolean }> {
  if (actor.type !== "user") throw new RadiologyError("forbidden", `a ${actor.type} actor does not write reports`);
  const study = await loadStudy(tx, input.studyId);
  const templateKey = input.templateKey ?? await defaultTemplateKey(tx, study.studyTypeCode);
  const findings = await preSignFindings(
    tx, study, { templateKey, body: input.body, impression: input.impression ?? null }, input.criticalCategory ?? null,
  );
  return { findings, signable: !findings.some((f) => f.level === "refuse") };
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
    /** 18-S RS8a — the warning codes the signer acknowledges; the checks run on the amendment too. */
    acknowledgedWarnings?: readonly string[];
    now?: Date;
  } & ReportContent,
): Promise<{ reportId: string; version: number; supersededId: string }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);
  await assertNotTeleReader(tx, actor, "amend");

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
  /** 18-S RS7 — the amended body normalised exactly as a draft's is, and the declaration re-written. */
  const amendTemplate = input.templateKey ?? previous.templateKey;
  const amendObstetric = await isObstetricReport(tx, study, amendTemplate);
  const amendBody = normaliseReportBody(input.body, amendObstetric, scanDayOf(study, now));
  await assertSignable(tx, study, { ...input, templateKey: amendTemplate, body: amendBody }, category, input.lockoutOverride ?? null, now);
  await assertSignerRegistered(tx, actor, study, now);

  /**
   * 18-S RS8a — an amendment IS a signature, so it meets the same checks and carries the same
   * block. Checking only the first signature would make "amend" the way round every check.
   */
  const amendContent = {
    templateKey: amendTemplate,
    /** 18-S RS7 — the amended body normalised as a draft's is, with the declaration re-written. */
    body: withDeclaration(amendBody, amendObstetric),
    impression: input.impression ?? null, laterality: input.laterality ?? null,
  };
  const amendChecks = enforcePreSign(
    await preSignFindings(tx, study, amendContent, category), input.acknowledgedWarnings ?? [], actor.id, now,
  );
  const amendBlock = await signerSnapshot(tx, { userId: actor.id, now, secondFactorAt: amendFactorAt, content: amendContent });

  /**
   * THE FLIP COMES FIRST, and it has to: `imaging_reports_one_signed_ux` is a partial unique on
   * `status = 'signed'`, so inserting v2 while v1 is still signed collides with the constraint that
   * exists to stop exactly that. Superseding first, in the same transaction, is what makes the pair
   * atomic — a reader between the two statements is impossible.
   */
  await tx.update(imagingReports).set({ status: "superseded" })
    .where(eq(imagingReports.id, previous.id));

  const created = await insertVersion(
    tx, study, "signed", amendContent,
    {
      actorId: actor.id, signedAt: now, secondFactorAt: amendFactorAt,
      amendmentReason: input.reason.trim(), supersedesId: previous.id,
      lockoutOverride: input.lockoutOverride ?? null,
      block: amendBlock, checks: amendChecks,
    },
    category,
  );
  /**
   * 18-S RS8c — the amendment decides what is still recommended (T1), and the version it superseded
   * goes to blind peer review, read by whoever signed it (T2: "every amendment").
   */
  await reconcileFollowupsAtAmendment(tx, actor, study, { reportId: created.reportId, body: amendContent.body }, now);
  await openAmendmentReview(tx, previous);

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
    /** 18-S RS8b — a resident's signature is not the hospital's report until a consultant co-signs. */
    const awaiting = await (tx as unknown as Db).select({ id: imagingReports.id })
      .from(imagingReports)
      .where(and(eq(imagingReports.studyId, study.id), eq(imagingReports.status, "awaiting_cosign")));
    if (awaiting.length > 0) {
      throw new RadiologyError(
        "cosign_required",
        `study ${study.accessionNo} has a resident's report waiting for a consultant's co-sign — a consultant `
        + "co-signs it in the reading room before it leaves the department",
        { studyId: study.id, reportId: awaiting[0]!.id },
      );
    }
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
   * 18-S RS7 T1 — the SIGNED text is read again before it leaves the department. A version signed
   * before the guard existed (or by any path that bypassed it) is not published: publication is the
   * communication §5(2) is about.
   */
  assertNoFoetalSexDisclosure(
    reportText([signed.body, signed.impression ?? "", signed.amendmentReason ?? ""]),
    await isObstetricReport(tx, study, signed.templateKey), "report",
  );

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
  /** A `free` study (imaging fee switch off, decision 0067) has no bill to wait for. */
  const free = study.authorisedBy === "free";
  if (!isRedCritical && !free && !(await invoiceIsSettled(tx, study.invoiceLineId))) return false;
  return (await enqueueReportReady(tx, study, signed.id, now)) !== "failed";
}

/**
 * The ONE writer of the `imaging_report_ready` message — the publish path above and, 18-S RS9b T2,
 * the settlement consumer (`ready-on-payment.ts`) for a bill paid after release. The dedupe key is
 * per REPORT VERSION, so whichever path runs first queues it and the other queues nothing: exactly
 * once per version. Consent is the pump's (a STOP or a deceased patient suppresses at send), the
 * same for both paths. A7's swallow is kept: a failed enqueue never fails the caller.
 */
export async function enqueueReportReady(
  tx: Tx,
  study: Pick<typeof imagingStudies.$inferSelect, "orderId" | "accessionNo" | "patientId">,
  reportId: string,
  now: Date,
): Promise<"queued" | "already" | "failed"> {
  try {
    const orderRows = await (tx as unknown as Db).select({ orderNo: orders.orderNo })
      .from(orders).where(eq(orders.id, study.orderId));
    const row = await enqueueNotification(tx, {
      templateKey: "imaging_report_ready",
      params: { orderNo: orderRows[0]?.orderNo ?? study.accessionNo },
      dedupeKey: `imaging_report_ready:${reportId}`,
      occurredAt: now,
      patientId: study.patientId,
    });
    return row === null ? "already" : "queued";
  } catch {
    /** A7 — deliberately swallowed. See the header; the read is the priority, not the message. */
    return "failed";
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

/* ═══════════════════════ 18-S RS8c T3 — the morning over-read of a night prelim ═══════════════════════ */

/**
 * `tele.ts` `overRead` with this file's signing acts: draft, sign (every check a signature meets,
 * the signer block, the follow-ups), amend, publish — all in the caller's transaction and under the
 * consultant's own fresh second factor.
 */
export async function overReadNightPrelim(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: {
    teleReadId: string; grade: string; note?: string | null; findings?: string | null; impression?: string | null;
    secondFactorAt: Date | null; windowMinutes?: number; acknowledgedWarnings?: readonly string[]; now?: Date;
  },
): Promise<{ teleReadId: string; grade: "concur" | "minor" | "major"; finalReportId: string }> {
  const now = input.now ?? new Date();
  const [tele] = await (tx as unknown as Db).select({ studyId: imagingTeleReads.studyId }).from(imagingTeleReads)
    .where(eq(imagingTeleReads.id, input.teleReadId));
  const studyId = tele?.studyId ?? "";
  const factor = { secondFactorAt: input.secondFactorAt, windowMinutes: input.windowMinutes, acknowledgedWarnings: input.acknowledgedWarnings ?? [], now };
  return await overRead(tx, actor, { ...input, now }, {
    latestSigned: (t, id) => latestSigned(t, id),
    draft: async (content) => await draftReport(tx, actor, { studyId, ...content }),
    sign: async (reportId) => await signReport(tx, actor, { studyId, reportId, ...factor }),
    amend: async (content) => await amendReport(tx, actor, { studyId, ...content, ...factor }),
    publish: async () => await publishReport(tx, actor, decls, { studyId, now }),
  });
}
