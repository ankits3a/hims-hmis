import { sql } from "drizzle-orm";
import { formularySalts } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { FormularyError } from "./errors";
import { saltTherapeuticClassAdopted } from "./events";
import { adoptionRef, attesterId } from "./mapping";
import { isMoiety } from "./moiety";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";

/**
 * ═══ FORMULARY P23 — THERAPEUTIC CLASSES FOR DUPLICATE-THERAPY NOTICES ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p23-duplicate-classes.md`.
 *
 * The owner's clinical master (`therapeutic_subclass_groups`) names five classes of which a patient
 * should be on one agent: PPIs, ACE inhibitors, ARBs, statins and systemic NSAIDs. A moiety's class
 * is its `drug_class`, a single value, and the prescribing check (`opd/rx-checks.ts`
 * `checkDuplicateClass`) reads it. These are the keys it knows; the starter seed already uses three.
 */
export const THERAPEUTIC_DUPLICATE_CLASSES = ["ppi", "ace_inhibitor", "arb", "statin", "nsaid"] as const;

export type TherapeuticClassEntry = {
  drugClass: string;
  /** The reference's group, e.g. `therapeutic_subclass_groups#SUB_PPI`. */
  rule: string;
  /** Moiety names, as the national release spells them. */
  moieties: readonly string[];
};

export type TherapeuticClassAdoptionReport = {
  resolution: string;
  assigned: number;
  alreadyRecorded: number;
  /** A moiety a curator already put in a different class: left as it is, for a person to decide. */
  conflicts: { name: string; current: string; wanted: string }[];
  missing: { name: string; drugClass: string }[];
};

/**
 * Under one named resolution, by a person (the owner's 2026-09-16 ruling, as for P21 and P22). Sets
 * `drug_class` only where none is recorded; a different recorded class is reported, never replaced.
 * A name that is not a moiety yet is reported and skipped. Idempotent.
 */
export async function adoptTherapeuticClasses(
  tx: Tx, actor: Actor, resolution: string, book: readonly TherapeuticClassEntry[],
): Promise<TherapeuticClassAdoptionReport> {
  const userId = attesterId(actor);
  const ref = adoptionRef(resolution);
  if (ref === null) throw new FormularyError("invalid_adoption", "an adoption names its resolution");
  const wantedBy = new Map<string, { drugClass: string; rule: string }>();
  for (const e of book) {
    if (!(THERAPEUTIC_DUPLICATE_CLASSES as readonly string[]).includes(e.drugClass)) {
      throw new FormularyError("invalid_adoption", `${e.rule}: "${e.drugClass}" is not a class the duplicate check knows`);
    }
    if (e.rule.trim() === "") throw new FormularyError("invalid_adoption", `${e.drugClass}: a membership names its source rule`);
    for (const raw of e.moieties) {
      const name = raw.trim().toLowerCase();
      if (name === "" || wantedBy.has(name)) {
        throw new FormularyError("invalid_adoption", `${e.rule}: "${raw}" is empty or named twice — a moiety has one therapeutic class`);
      }
      wantedBy.set(name, { drugClass: e.drugClass, rule: e.rule.trim() });
    }
  }

  const names = [...wantedBy.keys()];
  const found = names.length === 0 ? { rows: [] } : await tx.execute<{ id: string; lname: string; drug_class: string | null }>(sql`
    select salt.id, lower(salt.name) as lname, salt.drug_class
      from formulary_salts salt
     where salt.active and lower(salt.name) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
       and ${isMoiety(sql`salt`)}
     for update of salt`);
  const byName = new Map(found.rows.map((r) => [r.lname, r] as const));

  const report: TherapeuticClassAdoptionReport = { resolution: ref, assigned: 0, alreadyRecorded: 0, conflicts: [], missing: [] };
  const now = new Date();
  for (const [name, want] of wantedBy) {
    const salt = byName.get(name);
    if (salt === undefined) { report.missing.push({ name, drugClass: want.drugClass }); continue; }
    if (salt.drug_class === want.drugClass) { report.alreadyRecorded += 1; continue; }
    if (salt.drug_class !== null) { report.conflicts.push({ name, current: salt.drug_class, wanted: want.drugClass }); continue; }
    await tx.update(formularySalts).set({ drugClass: want.drugClass, updatedBy: userId, updatedAt: now })
      .where(sql`${formularySalts.id} = ${salt.id}`);
    await appendEvent(tx, saltTherapeuticClassAdopted.make({
      actor, correlationId: salt.id,
      payload: { saltId: salt.id, drugClass: want.drugClass, source: `resolution:${ref} (${want.rule})`.slice(0, 300) },
    }));
    report.assigned += 1;
  }
  report.missing.sort((x, y) => x.drugClass.localeCompare(y.drugClass) || x.name.localeCompare(y.name));
  report.conflicts.sort((x, y) => x.name.localeCompare(y.name));
  return report;
}
