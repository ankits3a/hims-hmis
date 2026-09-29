import {
  PCPNDT_REPORT_DECLARATION_EN, PCPNDT_REPORT_DECLARATION_HI, deriveObstetric, obstetricBiometryInputSchema,
} from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { RadiologyError } from "./errors";
import { findFoetalSexDisclosures } from "../pcpndt";
import { requireStudyType } from "./study-types";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 18-S RS7 T1/T2 — **the obstetric report's three server-owned rules**, in one place so the
 * draft, prelim, sign, amend and publish paths in `reports.ts` cannot each spell them differently.
 *
 *   1. **Is this an obstetric report?** The study is PCPNDT-applicable (`form_f_required`), or its
 *      type's body part is obstetric, or the report uses the `usg_obstetric` template.
 *   2. **The foetal-sex guard** (`pcpndt/foetal-sex.ts`) — `foetal_sex_disclosure`, no override lane.
 *   3. **The structured biometry and the fixed declaration.** `body.obstetric_biometry` carries what
 *      the sonologist measured; the derived block (GA, EFW, EDD, liquor) is RECOMPUTED here on
 *      every save from the inputs and the scan's IST day, whatever the caller sent. The declaration
 *      (`body.pcpndt_declaration`) is written by the server into the SIGNED version and stripped
 *      from anything a caller sends — the one line on the report nobody can edit.
 */

export const BIOMETRY_KEY = "obstetric_biometry";
export const DECLARATION_KEY = "pcpndt_declaration";

export const PCPNDT_REPORT_DECLARATION = {
  en: PCPNDT_REPORT_DECLARATION_EN,
  hi: PCPNDT_REPORT_DECLARATION_HI,
} as const;

type Study = typeof imagingStudies.$inferSelect;

export async function isObstetricReport(exec: Db | Tx, study: Study, templateKey?: string | null): Promise<boolean> {
  if (study.formFRequired) return true;
  if (templateKey === "usg_obstetric") return true;
  const type = await requireStudyType(exec, study.studyTypeCode);
  return type.body_part.toLowerCase().includes("obstetric");
}

/** Every string a report version carries, joined so that one field's end never runs into the next's start. */
export function reportText(parts: readonly unknown[]): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  parts.forEach(walk);
  return out.join(" . ");
}

/**
 * T1 — refuse, never edit. Checked BEFORE the lexical lockout on every path that makes text
 * readable outside the author's draft, and `lockoutOverride` is never consulted: §5(2) has no
 * approver.
 */
export function assertNoFoetalSexDisclosure(text: string, obstetric: boolean, act: string): void {
  const hits = findFoetalSexDisclosures(text, { obstetric });
  if (hits.length === 0) return;
  const quoted = [...new Set(hits.map((h) => `"${h.matched}"`))].join(", ");
  throw new RadiologyError(
    "foetal_sex_disclosure",
    `this ${act} states the sex of a foetus (${quoted}). The PCPNDT Act forbids recording or `
    + "communicating it in any manner, and nobody — not the medical superintendent, not the owner — "
    + "can approve it. Remove those words and write the finding without them.",
    { matched: hits.map((h) => h.matched), rules: [...new Set(hits.map((h) => h.rule))], obstetric },
  );
}

/**
 * T2 — the body as the server will store it: the declaration key removed (only the server writes
 * it), and the biometry validated and its derived block recomputed. A biometry block on a report
 * that is not obstetric is refused: those numbers mean nothing on a gall bladder.
 */
export function normaliseReportBody(
  body: Record<string, unknown>, obstetric: boolean, scanDay: string,
): Record<string, unknown> {
  const { [DECLARATION_KEY]: _dropped, ...rest } = body;
  void _dropped;
  const raw = rest[BIOMETRY_KEY];
  if (raw === undefined || raw === null) return rest;
  if (!obstetric) {
    throw new RadiologyError(
      "invalid_biometry",
      "obstetric biometry belongs on an obstetric ultrasound report, and this study is not one",
    );
  }
  const { derived: _ignored, ...input } = (typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  void _ignored;
  const parsed = obstetricBiometryInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RadiologyError(
      "invalid_biometry",
      `the biometry cannot be stored as typed: ${parsed.error.issues.map((i) => `${i.path.join(".") || "biometry"} — ${i.message}`).join("; ")}`,
      { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    );
  }
  return { ...rest, [BIOMETRY_KEY]: { ...parsed.data, derived: deriveObstetric(parsed.data, scanDay) } };
}

/** The IST calendar day the scan happened on (acquisition), or today while it has not. */
export function scanDayOf(study: Study, now: Date): string {
  return istDayString(study.acquiredAt ?? now);
}

/** The signed body of an obstetric report always carries the declaration, in the server's words. */
export function withDeclaration(body: Record<string, unknown>, obstetric: boolean): Record<string, unknown> {
  const { [DECLARATION_KEY]: _dropped, ...rest } = body;
  void _dropped;
  return obstetric ? { ...rest, [DECLARATION_KEY]: { ...PCPNDT_REPORT_DECLARATION } } : rest;
}
