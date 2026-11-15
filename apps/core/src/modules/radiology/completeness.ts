import { and, eq, gte, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { raiseNotice } from "../../kernel/alerts/notices";
import { istDayString } from "../../kernel/approvals/cumulative";
import { doseRegister } from "../../kernel/db/schema/aerb";
import { pcpndtFormF, pcpndtRegistrations } from "../../kernel/db/schema/pcpndt";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { formFMissingFields } from "../pcpndt";
import {
  activeUsers, addIstDays, automationEnabled, istStart, permissionHolders, runOnce,
} from "./automation";
import { RadiologyError } from "./errors";
import type { FormFField } from "../pcpndt";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ #1085 (IM6c) — YESTERDAY'S REGISTERS, CHECKED EVERY MORNING. NOTHING IS CORRECTED. ═══
 *
 * PCPNDT and AERB gaps used to be found by somebody looking. For one IST day this lists, by accession:
 *
 *   · every study acquired that day which the Act covers (`form_f_required`) and whose Form F is not on
 *     record, not recorded, recorded with a field missing, or recorded and not counter-signed by the
 *     in-charge (`verified`) — `pcpndt-books.ts`'s own states and `formFMissingFields`, the register's rule;
 *   · every IONISING study acquired here that day with no row in the AERB dose register, and every row
 *     above its reference level with no reason. An outside study (`image_source = 'outside'`) writes no dose
 *     against our machine by design (18a-iii T4) and is not a gap.
 *
 * The read is live (a gap fixed at 10:00 leaves the list), so the HOD's Quality view reads it rather than
 * a stored copy. The morning run stores the COUNTS and rings two bells with a count each: the PCPNDT
 * in-charge for Form F gaps, the RSO for dose gaps. Accessions only — no name, no UHID.
 */

export type RegisterGapKind =
  | "form_f_missing" | "form_f_not_recorded" | "form_f_incomplete" | "form_f_unverified"
  | "dose_missing" | "drl_reason_missing";

export type RegisterGap = {
  kind: RegisterGapKind;
  register: "pcpndt" | "aerb";
  studyId: string;
  accessionNo: string;
  /** `form_f_incomplete` — which fields the form lacks. */
  missing?: FormFField[];
};

export type RegisterCompleteness = { day: string; gaps: RegisterGap[]; counts: { pcpndt: number; aerb: number } };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIMIT = 2000;

export async function registerCompleteness(db: Db | Tx, input: { day: string }): Promise<RegisterCompleteness> {
  if (!DAY_RE.test(input.day)) throw new RadiologyError("invalid_date", "day is a calendar day, YYYY-MM-DD");
  const exec = db as Db;
  const lo = istStart(input.day);
  const hi = istStart(addIstDays(input.day, 1));
  const acquiredThatDay = and(isNotNull(imagingStudies.acquiredAt), gte(imagingStudies.acquiredAt, lo), lt(imagingStudies.acquiredAt, hi));
  const gaps: RegisterGap[] = [];

  /* ── PCPNDT: every covered scan has a recorded, complete, verified Form F ── */
  const covered = await exec.select({ id: imagingStudies.id, accessionNo: imagingStudies.accessionNo }).from(imagingStudies)
    .where(and(acquiredThatDay, eq(imagingStudies.formFRequired, true)))
    .orderBy(imagingStudies.acquiredAt).limit(LIMIT);
  const forms = covered.length === 0 ? [] : await exec.select().from(pcpndtFormF)
    .where(inArray(pcpndtFormF.studyId, covered.map((s) => s.id)));
  for (const s of covered) {
    const form = forms.filter((f) => f.studyId === s.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const base = { register: "pcpndt" as const, studyId: s.id, accessionNo: s.accessionNo };
    if (form === undefined) { gaps.push({ kind: "form_f_missing", ...base }); continue; }
    if (form.status !== "recorded") { gaps.push({ kind: "form_f_not_recorded", ...base }); continue; }
    const missing = formFMissingFields(form);
    if (missing.length > 0) gaps.push({ kind: "form_f_incomplete", ...base, missing });
    else if (form.verifiedAt === null) gaps.push({ kind: "form_f_unverified", ...base });
  }

  /* ── AERB: every ionising scan made here has a dose row; every dose above the level has a reason ── */
  const ionising = await exec.select({ id: imagingStudies.id, accessionNo: imagingStudies.accessionNo }).from(imagingStudies)
    .where(and(acquiredThatDay, eq(imagingStudies.ionising, true), ne(imagingStudies.imageSource, "outside")))
    .orderBy(imagingStudies.acquiredAt).limit(LIMIT);
  const doses = ionising.length === 0 ? [] : await exec.select({
    sourceRef: doseRegister.sourceRef, overDrl: doseRegister.overDrl, drlReason: doseRegister.drlReason,
  }).from(doseRegister)
    .where(and(eq(doseRegister.source, "imaging"), inArray(doseRegister.sourceRef, ionising.map((s) => s.id))));
  for (const s of ionising) {
    const dose = doses.find((d) => d.sourceRef === s.id);
    const base = { register: "aerb" as const, studyId: s.id, accessionNo: s.accessionNo };
    if (dose === undefined) gaps.push({ kind: "dose_missing", ...base });
    else if (dose.overDrl === true && (dose.drlReason === null || dose.drlReason.trim() === "")) gaps.push({ kind: "drl_reason_missing", ...base });
  }

  return {
    day: input.day, gaps,
    counts: { pcpndt: gaps.filter((g) => g.register === "pcpndt").length, aerb: gaps.filter((g) => g.register === "aerb").length },
  };
}

/** The PCPNDT in-charge(s): named on an active registration, else whoever may verify a Form F. */
async function pcpndtIncharges(exec: Db | Tx): Promise<string[]> {
  const named = (await (exec as Db).select({ id: pcpndtRegistrations.inchargeUserId }).from(pcpndtRegistrations)
    .where(and(eq(pcpndtRegistrations.status, "active"), isNotNull(pcpndtRegistrations.inchargeUserId))))
    .map((r) => r.id).filter((x): x is string => x !== null);
  const people = await activeUsers(exec, named);
  return people.length > 0 ? people : permissionHolders(exec, "pcpndt.form_f.verify");
}

export const REGISTER_GAPS_ALERT_KIND = "imaging_register_gaps";

export type CompletenessSweep = { ran: boolean; enabled: boolean; counts: { pcpndt: number; aerb: number } | null; bells: number };

/**
 * The morning run: yesterday's gaps, counted and stored, and a bell with a count to each register's keeper
 * (only when that register has a gap). The bell's source key is the register and the day, so a second
 * run rings nothing even before the run row stops it.
 */
export async function sweepRegisterCompleteness(db: Db, now: Date): Promise<CompletenessSweep> {
  if (!(await automationEnabled(db, "register_completeness"))) return { ran: false, enabled: false, counts: null, bells: 0 };
  const day = istDayString(now);
  const yesterday = addIstDays(day, -1);
  const found = await registerCompleteness(db, { day: yesterday });
  let bells = 0;
  const run = await runOnce(db, "register_completeness", day, now, async (tx, runId) => {
    const ring = async (register: "pcpndt" | "aerb", count: number, to: string[]): Promise<void> => {
      if (count === 0) return;
      const title = register === "pcpndt" ? `PCPNDT register · ${yesterday}` : `AERB dose register · ${yesterday}`;
      const body = `${String(count)} gap${count === 1 ? "" : "s"} in yesterday's ${register === "pcpndt" ? "Form F register" : "dose register"}. `
        + "Open the HOD's Quality view for the accessions. Nothing was corrected automatically.";
      for (const userId of to) {
        if (await raiseNotice(tx as unknown as Db, {
          userId, kind: REGISTER_GAPS_ALERT_KIND, title, body, refType: "imaging_automation_run", refId: runId,
          sourceKey: `imaging-register-gaps:${register}:${yesterday}`, at: now,
        })) bells += 1;
      }
    };
    await ring("pcpndt", found.counts.pcpndt, await pcpndtIncharges(tx));
    await ring("aerb", found.counts.aerb, await activeUsers(tx, await usersHoldingRole(tx, "radiation_safety_officer")));
    const byKind: Record<string, number> = {};
    for (const g of found.gaps) byKind[g.kind] = (byKind[g.kind] ?? 0) + 1;
    return { reportDay: yesterday, pcpndt: found.counts.pcpndt, aerb: found.counts.aerb, byKind, bells };
  });
  return run.ran ? { ran: true, enabled: true, counts: found.counts, bells } : { ran: false, enabled: true, counts: null, bells: 0 };
}
