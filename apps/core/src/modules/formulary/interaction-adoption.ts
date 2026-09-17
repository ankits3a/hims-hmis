import { sql } from "drizzle-orm";
import { formularyInteractions } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import { addInteraction } from "./masters";
import { adoptionRef, attesterId } from "./mapping";
import { isMoiety } from "./moiety";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { Severity } from "./masters";

/**
 * ═══ INTERACTION PAIRS ADOPTED FROM A REFERENCE, UNDER ONE NAMED RESOLUTION (formulary P21) ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p21-interaction-adoption.md`.
 *
 * The owner's ruling of 2026-09-16 applies to interactions as it did to substances: a reference is
 * ADOPTED by resolution, not reviewed pair by pair. A person adopts (`attester_not_user`
 * otherwise), and every pair's `source` names the resolution, so an adopted pair can never be read
 * as a pharmacist's own ruling.
 *
 * WHAT IT NEVER DOES:
 * - Touch a pair already recorded. A curator may have downgraded it, and a resolution does not
 *   undo a clinical decision (the starter seed's rule).
 * - Create a moiety. A pair names two moieties by name. A name that is not a moiety in this
 *   formulary yet (absent, or a release entry nobody has decided) is reported and skipped. The
 *   adoption is re-run after the substances are decided, and only then does the pair appear.
 * - Pair a moiety with itself.
 *
 * One transaction, owned by the caller: the script runs it, and rolls back for a dry run.
 */
export type InteractionRule = {
  /** The reference's rule this pair comes from, e.g. `ddi_rules#4`. */
  rule: string;
  a: string;
  b: string;
  severity: Severity;
  /** One clinical line: the alert a doctor reads. */
  note: string;
  routeScope?: "systemic_only" | null;
};

export type InteractionAdoptionReport = {
  resolution: string;
  created: { severe: number; moderate: number };
  alreadyRecorded: number;
  /** Moiety names this formulary does not hold as a moiety yet, with how many pairs wait on each. */
  missing: { name: string; pairs: number }[];
  /** Pairs skipped because a name is missing. */
  skipped: number;
};

export async function adoptInteractions(
  tx: Tx, actor: Actor, resolution: string, rules: readonly InteractionRule[],
): Promise<InteractionAdoptionReport> {
  attesterId(actor);
  const ref = adoptionRef(resolution);
  if (ref === null) throw new FormularyError("invalid_adoption", "an adoption names its resolution");
  const keys = new Set<string>();
  for (const r of rules) {
    const a = r.a.trim().toLowerCase();
    const b = r.b.trim().toLowerCase();
    if (a === "" || b === "" || a === b) throw new FormularyError("invalid_adoption", `${r.rule}: a pair names two different moieties`);
    if (r.note.trim() === "") throw new FormularyError("invalid_adoption", `${r.rule}: ${r.a} × ${r.b} has no note`);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (keys.has(key)) throw new FormularyError("invalid_adoption", `${r.rule}: ${r.a} × ${r.b} appears twice`);
    keys.add(key);
  }

  const names = [...new Set(rules.flatMap((r) => [r.a.trim().toLowerCase(), r.b.trim().toLowerCase()]))];
  const found = names.length === 0 ? { rows: [] } : await tx.execute<{ id: string; lname: string }>(sql`
    select salt.id, lower(salt.name) as lname
      from formulary_salts salt
     where salt.active and lower(salt.name) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
       and ${isMoiety(sql`salt`)}`);
  const idOf = new Map(found.rows.map((r) => [r.lname, r.id] as const));
  const recorded = await tx.select({ a: formularyInteractions.saltAId, b: formularyInteractions.saltBId }).from(formularyInteractions);
  const have = new Set(recorded.map((p) => `${p.a}|${p.b}`));

  const report: InteractionAdoptionReport = { resolution: ref, created: { severe: 0, moderate: 0 }, alreadyRecorded: 0, missing: [], skipped: 0 };
  const missing = new Map<string, number>();
  for (const r of rules) {
    const a = idOf.get(r.a.trim().toLowerCase());
    const b = idOf.get(r.b.trim().toLowerCase());
    if (a === undefined || b === undefined) {
      for (const [name, id] of [[r.a, a], [r.b, b]] as const) {
        if (id === undefined) missing.set(name.trim().toLowerCase(), (missing.get(name.trim().toLowerCase()) ?? 0) + 1);
      }
      report.skipped += 1;
      continue;
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (have.has(key)) { report.alreadyRecorded += 1; continue; }
    await addInteraction(tx, actor, {
      saltAId: a, saltBId: b, severity: r.severity, note: r.note.trim(),
      source: `resolution:${ref} (${r.rule})`.slice(0, 300), routeScope: r.routeScope ?? null,
    });
    have.add(key);
    report.created[r.severity] += 1;
  }
  report.missing = [...missing.entries()].map(([name, pairs]) => ({ name, pairs })).sort((x, y) => y.pairs - x.pairs || x.name.localeCompare(y.name));
  return report;
}
