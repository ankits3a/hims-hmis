import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { formularyDrugDisease } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { drugDiseaseAdded } from "./events";
import { FormularyError } from "./errors";
import { adoptionRef, attesterId } from "./mapping";
import { isMoiety } from "./moiety";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { DrugDiseaseAlternative } from "../../kernel/db/schema";
import type { Severity } from "./masters";

/**
 * ═══ WHAT A DIAGNOSIS FORBIDS, ADOPTED UNDER ONE NAMED RESOLUTION (formulary P24) ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p24-drug-disease.md`.
 *
 * The owner's ruling of 2026-09-16 applies here as it did to substances and to interaction pairs: a
 * reference is ADOPTED by resolution, not reviewed row by row. A person adopts (`attester_not_user`
 * otherwise), and every row's `source` names the resolution and the source rule, so an adopted row
 * can never be read as a pharmacist's own ruling about this patient's disease.
 *
 * WHAT IT NEVER DOES, the sibling's list unchanged:
 * - Touch a row already recorded. A curator may have downgraded it, and a resolution does not undo
 *   a clinical decision.
 * - Create a moiety. A rule names moieties BY NAME; a name this formulary does not hold as a moiety
 *   (absent, or a release entry nobody has decided) is reported and skipped. The adoption is re-run
 *   after the substances are decided, and only then does the row appear.
 *
 * ═══ AND ONE THING THE SIBLING DID NOT HAVE TO DO: CHECK THE OFFER ═══
 *
 * A rule may carry alternatives — the safer drug the alert offers in place of the one refused. An
 * alternative names a moiety, and a name that is not a moiety HERE would become a button that can
 * never resolve: an offer the doctor taps and nothing happens. Those are reported in
 * `alternativesUnknown` rather than silently stored, because the failure is invisible at the
 * counter and obvious here.
 *
 * The offers are NOT re-checked for clinical safety at adoption, and must not be: whether
 * carvedilol is safe is a question about a PATIENT, and the book's own rows disagree with each
 * other by design (`I50` offers carvedilol, `J45` forbids it). That check belongs at prescribing,
 * where there is a patient to ask about.
 *
 * One transaction, owned by the caller: the script runs it, and rolls back for a dry run.
 */
export type DrugDiseaseRule = {
  /** The reference's rule this row comes from, e.g. `icd10_contraindications#0`. */
  rule: string;
  /** Uppercase and dotted, 3-7 characters: `J45`, `N18.4`. Matched as a PREFIX of a diagnosis code. */
  prefix: string;
  /** The catalogue's words for that prefix, copied into every row it makes. */
  title: string;
  /** Moiety names in THIS formulary — the drugs the diagnosis forbids. */
  moieties: readonly string[];
  severity: Severity;
  /** One clinical line: the alert a doctor reads. */
  note: string;
  /** The safer drugs offered in its place. Absent is ordinary — not every hazard has a substitute. */
  alternatives?: readonly DrugDiseaseAlternative[];
  routeScope?: "systemic_only" | null;
};

export type DrugDiseaseAdoptionReport = {
  resolution: string;
  created: { severe: number; moderate: number };
  alreadyRecorded: number;
  /** Moiety names this formulary does not hold as a moiety yet, with how many rows wait on each. */
  missing: { name: string; rows: number }[];
  /** Rows skipped because their moiety is missing. */
  skipped: number;
  /** Alternatives named by an ADOPTED rule that are not moieties here: a button that cannot resolve. */
  alternativesUnknown: string[];
};

/** The column's CHECK, in TypeScript, so a bad prefix is refused before Postgres has to. */
const PREFIX = /^[A-Z][A-Z0-9]{2}([.][A-Z0-9]{1,3})?$/;

const lower = (s: string) => s.trim().toLowerCase();

export async function adoptDrugDisease(
  tx: Tx, actor: Actor, resolution: string, rules: readonly DrugDiseaseRule[],
): Promise<DrugDiseaseAdoptionReport> {
  attesterId(actor);
  const ref = adoptionRef(resolution);
  if (ref === null) throw new FormularyError("invalid_adoption", "an adoption names its resolution");

  const keys = new Set<string>();
  for (const r of rules) {
    if (!PREFIX.test(r.prefix)) {
      throw new FormularyError("invalid_adoption", `${r.rule}: ${r.prefix} is not an ICD-10 code prefix`);
    }
    if (r.title.trim() === "") throw new FormularyError("invalid_adoption", `${r.rule}: ${r.prefix} has no title`);
    if (r.note.trim() === "") throw new FormularyError("invalid_adoption", `${r.rule}: ${r.prefix} has no note`);
    if (r.moieties.length === 0) throw new FormularyError("invalid_adoption", `${r.rule}: ${r.prefix} names no moiety`);
    for (const m of r.moieties) {
      if (lower(m) === "") throw new FormularyError("invalid_adoption", `${r.rule}: ${r.prefix} names an empty moiety`);
      const key = `${lower(m)}|${r.prefix}`;
      if (keys.has(key)) {
        throw new FormularyError("invalid_adoption", `${r.rule}: ${m} × ${r.prefix} appears twice`);
      }
      keys.add(key);
    }
    for (const a of r.alternatives ?? []) {
      if (lower(a.moiety) === "" || a.label.trim() === "") {
        throw new FormularyError("invalid_adoption", `${r.rule}: ${r.prefix} offers an alternative with no name`);
      }
      if (r.moieties.some((m) => lower(m) === lower(a.moiety))) {
        throw new FormularyError(
          "invalid_adoption", `${r.rule}: ${r.prefix} offers ${a.moiety}, which the same rule forbids`,
        );
      }
    }
  }

  const names = [...new Set([
    ...rules.flatMap((r) => r.moieties.map(lower)),
    ...rules.flatMap((r) => (r.alternatives ?? []).map((a) => lower(a.moiety))),
  ])];
  const found = names.length === 0 ? { rows: [] } : await tx.execute<{ id: string; lname: string }>(sql`
    select salt.id, lower(salt.name) as lname
      from formulary_salts salt
     where salt.active and lower(salt.name) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
       and ${isMoiety(sql`salt`)}`);
  const idOf = new Map(found.rows.map((r) => [r.lname, r.id] as const));
  const recorded = await tx
    .select({ saltId: formularyDrugDisease.saltId, prefix: formularyDrugDisease.icd10Prefix })
    .from(formularyDrugDisease);
  const have = new Set(recorded.map((p) => `${p.saltId}|${p.prefix}`));

  const report: DrugDiseaseAdoptionReport = {
    resolution: ref, created: { severe: 0, moderate: 0 }, alreadyRecorded: 0,
    missing: [], skipped: 0, alternativesUnknown: [],
  };
  const missing = new Map<string, number>();
  const unknownOffers = new Set<string>();

  for (const r of rules) {
    const alternatives: DrugDiseaseAlternative[] = [];
    for (const a of r.alternatives ?? []) {
      if (idOf.has(lower(a.moiety))) alternatives.push({ moiety: lower(a.moiety), label: a.label.trim() });
      else unknownOffers.add(lower(a.moiety));
    }
    for (const name of r.moieties) {
      const saltId = idOf.get(lower(name));
      if (saltId === undefined) {
        missing.set(lower(name), (missing.get(lower(name)) ?? 0) + 1);
        report.skipped += 1;
        continue;
      }
      if (have.has(`${saltId}|${r.prefix}`)) { report.alreadyRecorded += 1; continue; }

      const drugDiseaseId = newId();
      const source = `resolution:${ref} (${r.rule})`.slice(0, 300);
      const routeScope = r.routeScope ?? null;
      await tx.insert(formularyDrugDisease).values({
        id: drugDiseaseId, saltId, icd10Prefix: r.prefix, icd10Title: r.title.trim(),
        severity: r.severity, note: r.note.trim(), alternatives, source, routeScope,
        createdBy: actor.id, updatedBy: actor.id,
      });
      await appendEvent(tx, drugDiseaseAdded.make({
        payload: { drugDiseaseId, saltId, icd10Prefix: r.prefix, severity: r.severity, source, routeScope },
        actor, correlationId: drugDiseaseId,
      }));
      have.add(`${saltId}|${r.prefix}`);
      report.created[r.severity] += 1;
    }
  }

  report.missing = [...missing.entries()]
    .map(([name, rows]) => ({ name, rows }))
    .sort((x, y) => y.rows - x.rows || x.name.localeCompare(y.name));
  report.alternativesUnknown = [...unknownOffers].sort();
  return report;
}
