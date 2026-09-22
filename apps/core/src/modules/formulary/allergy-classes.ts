import { sql } from "drizzle-orm";
import { formularySalts } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { isAllergyClassKey } from "./allergy-vocabulary";
import { FormularyError } from "./errors";
import { saltAllergyClassesAdopted } from "./events";
import { adoptionRef, attesterId } from "./mapping";
import { isMoiety } from "./moiety";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";

/**
 * ═══ FORMULARY P22 — ALLERGY CLASS MEMBERSHIPS, ADOPTED BY RESOLUTION ═══
 *
 * The vocabulary is `allergy-vocabulary.ts` (pure, and read by the prescribing check); this is the
 * writer. Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p22-allergy-classes.md`.
 */
export { ALLERGY_CLASSES, allergyClassKeys, isAllergyClassKey, requireAllergyClasses } from "./allergy-vocabulary";
export type { AllergyClassKey } from "./allergy-vocabulary";

// ═══════════════════════════ ADOPTION BY RESOLUTION ═══════════════════════════

export type AllergyClassEntry = {
  classKey: string;
  /** The reference's rule this membership comes from, e.g. `allergy_cross_reactivity_rules#1`. */
  rule: string;
  /** Moiety names, as the national release spells them. */
  moieties: readonly string[];
};

export type AllergyClassAdoptionReport = {
  resolution: string;
  /** Moieties that gained a class. */
  assigned: number;
  /** Memberships already on the moiety, left as they are. */
  alreadyRecorded: number;
  /** Names that are not a moiety in this formulary yet, per class. */
  missing: { name: string; classKey: string }[];
};

/**
 * The owner's ruling of 2026-09-16 applies (as it did to the interaction pairs, P21): a reference is
 * adopted under one named resolution by a person. A class is ADDED to a moiety's list; nothing a
 * curator recorded is removed or replaced. A name that is not a moiety yet is reported and skipped,
 * and a later run adds it. Idempotent.
 */
export async function adoptAllergyClasses(
  tx: Tx, actor: Actor, resolution: string, book: readonly AllergyClassEntry[],
): Promise<AllergyClassAdoptionReport> {
  attesterId(actor);
  const ref = adoptionRef(resolution);
  if (ref === null) throw new FormularyError("invalid_adoption", "an adoption names its resolution");
  for (const e of book) {
    if (!isAllergyClassKey(e.classKey)) throw new FormularyError("invalid_adoption", `${e.rule}: "${e.classKey}" is not an allergy class the check knows`);
    if (e.rule.trim() === "") throw new FormularyError("invalid_adoption", `${e.classKey}: a membership names its source rule`);
    const names = e.moieties.map((n) => n.trim().toLowerCase());
    if (names.some((n) => n === "") || new Set(names).size !== names.length) {
      throw new FormularyError("invalid_adoption", `${e.rule}: ${e.classKey} names a moiety twice, or an empty name`);
    }
  }

  const names = [...new Set(book.flatMap((e) => e.moieties.map((n) => n.trim().toLowerCase())))];
  const found = names.length === 0 ? { rows: [] } : await tx.execute<{ id: string; lname: string; classes: string[] }>(sql`
    select salt.id, lower(salt.name) as lname, salt.allergy_classes as classes
      from formulary_salts salt
     where salt.active and lower(salt.name) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
       and ${isMoiety(sql`salt`)}
     for update of salt`);
  const byName = new Map(found.rows.map((r) => [r.lname, { id: r.id, classes: new Set(r.classes) }] as const));

  const report: AllergyClassAdoptionReport = { resolution: ref, assigned: 0, alreadyRecorded: 0, missing: [] };
  const additions = new Map<string, { added: string[]; rules: Set<string> }>();
  for (const e of book) {
    for (const raw of e.moieties) {
      const name = raw.trim().toLowerCase();
      const salt = byName.get(name);
      if (salt === undefined) { report.missing.push({ name, classKey: e.classKey }); continue; }
      if (salt.classes.has(e.classKey)) { report.alreadyRecorded += 1; continue; }
      salt.classes.add(e.classKey);
      const a = additions.get(salt.id) ?? { added: [], rules: new Set<string>() };
      a.added.push(e.classKey);
      a.rules.add(e.rule.trim());
      additions.set(salt.id, a);
    }
  }
  const now = new Date();
  for (const [saltId, a] of additions) {
    const salt = [...byName.values()].find((s) => s.id === saltId)!;
    const allergyClasses = [...salt.classes].sort();
    await tx.update(formularySalts)
      .set({ allergyClasses, updatedBy: attesterId(actor), updatedAt: now })
      .where(sql`${formularySalts.id} = ${saltId}`);
    await appendEvent(tx, saltAllergyClassesAdopted.make({
      actor, correlationId: saltId,
      payload: { saltId, added: a.added.sort(), allergyClasses, source: `resolution:${ref} (${[...a.rules].sort().join(", ")})`.slice(0, 300) },
    }));
    report.assigned += 1;
  }
  report.missing.sort((x, y) => x.classKey.localeCompare(y.classKey) || x.name.localeCompare(y.name));
  return report;
}
