import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { formularyInteractions, formularySalts } from "../src/kernel/db/schema";
import { addInteraction, addSalt } from "../src/modules/formulary";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 16a T9 — THE SEVERE-PAIR STARTER SEED.
 *
 * ═══ WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT ═══
 *
 * It is a floor, not a formulary. Twenty-six classically dangerous pairs so that the check suite
 * has something true to say on day one, each carrying `source: 'seed-2026-08'` so a curator can
 * always tell what the hospital decided from what arrived in this file. **The DTC owns expansion**
 * (its clock has been running since 2026-08-23) and a licensed interaction dataset arrives, when it
 * arrives, through `formulary_staging` like any other mined data — never as a bulk table load
 * (spec D2: seed is never authority).
 *
 * ═══ IT SEEDS SALTS TOO, AND ONLY THE ONES THE PAIRS NEED ═══
 *
 * A pair references two moieties, so the moieties have to exist. Each is created with its
 * `drugClass` **only where the class is load-bearing for the allergy check** — `nsaid`, `statin`,
 * `ssri` — because a class is what lets an allergy recorded as "NSAIDs" catch ibuprofen. Inventing
 * a class for a moiety that does not need one would put a fact into the master that nobody checked.
 *
 * ═══ EVERY NOTE IS ONE CLINICAL LINE, AND IT IS WHAT THE DOCTOR READS ═══
 *
 * `formulary_interactions.note` IS the alert text at the point of prescribing. It says what the
 * risk is, not that there is one: "avoid or monitor INR closely" is actionable, "interaction" is
 * not. **These were reviewed at execution against the hospital's real prescribing vocabulary and
 * that review found ONE drug in the entire production book (`Paracetamol`)** — so the set ships as
 * written and the DTC prunes it against real traffic rather than this session guessing (§3 Q1).
 *
 * ═══ IDEMPOTENT, AND THE TEST PROVES IT BY RUNNING IT TWICE ═══
 *
 * A second run creates nothing. Both halves matter: a salt that exists is reused by name (the
 * schema's case-insensitive unique index is the authority), and a pair that exists is left alone
 * rather than updated — a curator may have DOWNGRADED it (spec §1.4's calibration loop), and a
 * re-run that silently restored `severe` would undo a clinical decision with a deploy.
 */

/** `drugClass` is set ONLY where the allergy check's class path needs it. */
type SeedSalt = { name: string; drugClass?: string };

const SALTS: SeedSalt[] = [
  { name: "warfarin" },
  { name: "aspirin", drugClass: "nsaid" },
  { name: "ibuprofen", drugClass: "nsaid" },
  { name: "diclofenac", drugClass: "nsaid" },
  { name: "metronidazole" },
  { name: "fluconazole" },
  { name: "methotrexate" },
  { name: "trimethoprim" },
  { name: "sildenafil" },
  { name: "isosorbide dinitrate", drugClass: "nitrate" },
  { name: "glyceryl trinitrate", drugClass: "nitrate" },
  { name: "clarithromycin", drugClass: "macrolide" },
  { name: "erythromycin", drugClass: "macrolide" },
  { name: "simvastatin", drugClass: "statin" },
  { name: "atorvastatin", drugClass: "statin" },
  { name: "tramadol" },
  { name: "fluoxetine", drugClass: "ssri" },
  { name: "sertraline", drugClass: "ssri" },
  { name: "selegiline", drugClass: "maoi" },
  { name: "spironolactone" },
  { name: "potassium chloride" },
  { name: "enalapril", drugClass: "ace_inhibitor" },
  { name: "ramipril", drugClass: "ace_inhibitor" },
  { name: "digoxin" },
  { name: "verapamil" },
  { name: "amiodarone" },
  { name: "theophylline" },
  { name: "ciprofloxacin" },
  { name: "lithium" },
];

export const SEED_SOURCE = "seed-2026-08";

/** Twenty-six pairs. Every one is a documented, clinically severe interaction. */
const PAIRS: { a: string; b: string; note: string }[] = [
  // ── warfarin: the anticoagulant every one of these pushes into bleeding ──
  { a: "warfarin", b: "aspirin", note: "Additive bleeding risk — avoid, or monitor INR and for bleeding closely." },
  { a: "warfarin", b: "ibuprofen", note: "NSAID adds antiplatelet effect and GI erosion to anticoagulation — avoid." },
  { a: "warfarin", b: "diclofenac", note: "NSAID adds antiplatelet effect and GI erosion to anticoagulation — avoid." },
  { a: "warfarin", b: "metronidazole", note: "Metronidazole inhibits warfarin metabolism — INR can rise sharply within days." },
  { a: "warfarin", b: "fluconazole", note: "Fluconazole inhibits warfarin metabolism — INR can rise sharply; reduce dose and monitor." },
  // ── methotrexate: renal clearance and marrow ──
  { a: "methotrexate", b: "trimethoprim", note: "Both antifolates — additive marrow suppression, can be fatal. Avoid." },
  { a: "methotrexate", b: "ibuprofen", note: "NSAID reduces methotrexate clearance — toxicity risk at any dose." },
  // ── nitrate × PDE5: the classic profound hypotension ──
  { a: "sildenafil", b: "isosorbide dinitrate", note: "Profound hypotension — contraindicated. Separate by at least 24 hours." },
  { a: "sildenafil", b: "glyceryl trinitrate", note: "Profound hypotension — contraindicated. Separate by at least 24 hours." },
  // ── macrolide × statin: rhabdomyolysis ──
  { a: "clarithromycin", b: "simvastatin", note: "CYP3A4 inhibition raises statin levels — rhabdomyolysis risk. Suspend the statin." },
  { a: "clarithromycin", b: "atorvastatin", note: "CYP3A4 inhibition raises statin levels — rhabdomyolysis risk. Reduce or suspend." },
  { a: "erythromycin", b: "simvastatin", note: "CYP3A4 inhibition raises statin levels — rhabdomyolysis risk. Suspend the statin." },
  { a: "erythromycin", b: "atorvastatin", note: "CYP3A4 inhibition raises statin levels — rhabdomyolysis risk. Reduce or suspend." },
  // ── serotonin syndrome ──
  { a: "tramadol", b: "fluoxetine", note: "Serotonin syndrome risk, and fluoxetine lowers the seizure threshold with tramadol." },
  { a: "tramadol", b: "sertraline", note: "Serotonin syndrome risk — monitor, or choose a different analgesic." },
  { a: "selegiline", b: "fluoxetine", note: "MAOI with an SSRI — serotonin syndrome, potentially fatal. Contraindicated." },
  { a: "selegiline", b: "sertraline", note: "MAOI with an SSRI — serotonin syndrome, potentially fatal. Contraindicated." },
  { a: "selegiline", b: "tramadol", note: "MAOI with tramadol — serotonin syndrome and seizures. Contraindicated." },
  // ── potassium ──
  { a: "spironolactone", b: "potassium chloride", note: "Additive hyperkalaemia — avoid the supplement, or check potassium frequently." },
  { a: "enalapril", b: "spironolactone", note: "ACE inhibitor with a potassium-sparing diuretic — hyperkalaemia. Monitor potassium." },
  { a: "ramipril", b: "spironolactone", note: "ACE inhibitor with a potassium-sparing diuretic — hyperkalaemia. Monitor potassium." },
  // ── digoxin: a narrow window either of these narrows further ──
  { a: "digoxin", b: "verapamil", note: "Verapamil raises digoxin levels and slows conduction — halve the digoxin, monitor." },
  { a: "digoxin", b: "amiodarone", note: "Amiodarone raises digoxin levels substantially — halve the digoxin, monitor levels." },
  // ── theophylline ──
  { a: "theophylline", b: "ciprofloxacin", note: "Ciprofloxacin inhibits theophylline clearance — toxicity and seizures." },
  // ── lithium: also a narrow window ──
  { a: "lithium", b: "ibuprofen", note: "NSAID reduces lithium clearance — toxicity. Avoid, or monitor lithium levels." },
  { a: "lithium", b: "enalapril", note: "ACE inhibitor reduces lithium clearance — toxicity. Monitor lithium levels." },
];

export type SeedReport = { saltsCreated: number; saltsExisting: number; pairsCreated: number; pairsExisting: number };

const SEED_ACTOR: Actor = { type: "system", id: "seed:formulary-interactions" };

/**
 * Idempotent. Salts are matched case-insensitively (the schema's own unique index decides), pairs
 * by their canonical ordered key — and an EXISTING pair is left exactly as it is, downgrade and
 * all.
 */
export async function seedFormularyInteractions(db: Db): Promise<SeedReport> {
  const report: SeedReport = { saltsCreated: 0, saltsExisting: 0, pairsCreated: 0, pairsExisting: 0 };

  const idByName = new Map<string, string>();
  for (const salt of SALTS) {
    const existing = await db
      .select({ id: formularySalts.id })
      .from(formularySalts)
      .where(eq(formularySalts.name, salt.name));
    const found = existing[0];
    if (found !== undefined) {
      idByName.set(salt.name, found.id);
      report.saltsExisting += 1;
      continue;
    }
    const { saltId } = await withTx(db, (tx) => addSalt(tx, SEED_ACTOR, {
      name: salt.name, drugClass: salt.drugClass ?? null,
    }));
    idByName.set(salt.name, saltId);
    report.saltsCreated += 1;
  }

  const pairs = await db.select({
    saltAId: formularyInteractions.saltAId, saltBId: formularyInteractions.saltBId,
  }).from(formularyInteractions);
  const have = new Set(pairs.map((p) => `${p.saltAId}|${p.saltBId}`));

  for (const pair of PAIRS) {
    const a = idByName.get(pair.a);
    const b = idByName.get(pair.b);
    if (a === undefined || b === undefined) {
      throw new Error(`seed:formulary — pair "${pair.a}" x "${pair.b}" names a moiety this seed does not create`);
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (have.has(key)) {
      report.pairsExisting += 1;
      continue;
    }
    await withTx(db, (tx) => addInteraction(tx, SEED_ACTOR, {
      saltAId: a, saltBId: b, severity: "severe", note: pair.note, source: SEED_SOURCE,
    }));
    have.add(key);
    report.pairsCreated += 1;
  }
  return report;
}

/** The census this seed is expected to produce on an empty formulary. */
export const SEED_CENSUS = { salts: SALTS.length, pairs: PAIRS.length };

export function formatReport(report: SeedReport): string[] {
  return [
    `seed:formulary — moieties: ${String(report.saltsCreated)} created, ${String(report.saltsExisting)} already present`,
    `seed:formulary — severe pairs: ${String(report.pairsCreated)} created, ${String(report.pairsExisting)} already present`,
    `seed:formulary — a starter floor (source "${SEED_SOURCE}"), not a formulary. The DTC owns expansion.`,
  ];
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const report = await seedFormularyInteractions(db);
    for (const line of formatReport(report)) console.log(line);
  } finally {
    await pool.end();
  }
}

// Guarded so the test can import the seeder without the script running itself on import.
if (require.main === module) {
  void main();
}
