import { readFileSync } from "node:fs";
import { asc, eq, inArray } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { formularyMedicineSalts, formularyMedicines, formularySalts, formularySubstances } from "../src/kernel/db/schema";
import { updateMedicine } from "../src/modules/formulary";
import { argValue, hasFlag, parseCsv, resolvePerson } from "./pharmacy-shelf-common";
import {
  SCHEDULE_H, SCHEDULE_H1, SCHEDULE_H1_SOURCE, SCHEDULE_H_SOURCE, SCHEDULE_X, SCHEDULE_X_SOURCE,
} from "./data/drug-schedules";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../src/kernel/db/client";
import type { ScheduleEntry } from "./data/drug-schedules";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/set-schedule-flags.ts --as <pharmacist> [--nrces <generics.csv>] [--apply] [--overwrite]`
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `formulary_medicines.schedule_flag` is NULL on all 103,383 catalogue rows, and the counter reads
 * nothing else: `claim.ts` refuses an X line, `SCHEDULED_FLAGS` makes an H/H1 hand-over need a
 * registered pharmacist, and `REGISTER_FLAGS` writes the H1 register. With every flag NULL the
 * counter treats azithromycin, alprazolam and tramadol like paracetamol — no register, no gate.
 *
 * ═══ WHERE A FLAG COMES FROM — STATUTE, NEVER A GUESS ═══
 *
 *   X   the Drugs and Cosmetics Rules 1945, Schedule X          (`data/drug-schedules.ts`)
 *   H1  G.S.R. 588(E), 30 August 2013, Schedule H1               (`data/drug-schedules.ts`)
 *   H   the Rules' Schedule H list where it was transcribed, AND the NRCeS national drug
 *       database's own `classification_of_drug = "Schedule H"` on a single-substance generic
 *       (`/opt/hmis-context/nrces-2026-09/generics.csv`, `--nrces`). The CDS bundle carries no
 *       schedule column at all — measured, 2026-09-22 — so it contributes nothing here.
 *   OTC NEVER SET. India has no statutory OTC list (the 2022 draft was never notified), so a
 *       substance absent from H, H1 and X is "not scheduled", which is NULL — and NULL is what the
 *       counter already treats as unscheduled. Writing "OTC" would be asserting a status no
 *       instrument grants.
 *
 * A PRODUCT takes the STRICTEST schedule any of its ingredients carries (X > H1 > H): a preparation
 * containing a scheduled substance is that schedule. An ingredient no list names does not lower it.
 * A product none of whose ingredients is named stays NULL and is COUNTED, never defaulted.
 *
 * An entry the statute QUALIFIES ("… except preparations for external use") is not applied by a
 * machine: it is counted as `qualified_skipped` for a pharmacist, because the qualification is about
 * the preparation, which a salt match cannot see.
 *
 * ═══ HOW IT WRITES ═══
 *
 * Dry run by default. `--apply` writes every `set` row through `updateMedicine` — the curation
 * surface's own writer, which emits `medicine.updated` per row — in ONE transaction, so a failure
 * leaves nothing half-flagged. A flag somebody already set that DIFFERS is reported and left alone
 * unless `--overwrite`: a pharmacist's decision outranks this derivation. Rerunning changes nothing.
 * `--as` must hold `formulary.manage`, the permission the formulary screen writes a flag under.
 */

export type ScheduleFlag = "X" | "H1" | "H";
const RANK: Record<ScheduleFlag, number> = { X: 3, H1: 2, H: 1 };

/** Counter-ions, esters and hydrates. A schedule names the MOIETY; the salt a brand uses does not change it. */
const SALT_WORDS = new Set([
  "hydrochloride", "dihydrochloride", "hcl", "hydrobromide", "hyclate", "sodium", "disodium", "potassium",
  "calcium", "magnesium", "sulfate", "sulphate", "bisulfate", "bisulphate", "maleate", "dimaleate", "fumarate",
  "hemifumarate", "succinate", "tartrate", "bitartrate", "citrate", "mesylate", "mesilate", "dimesylate",
  "besylate", "besilate", "acetate", "phosphate", "diphosphate", "dipropionate", "propionate", "valerate",
  "butyrate", "hemihydrate", "monohydrate", "dihydrate", "trihydrate", "sesquihydrate", "anhydrous", "axetil",
  "proxetil", "pivoxil", "lactate", "gluconate", "bromide", "nitrate", "oxalate", "decanoate", "enanthate",
  "palmitate", "stearate", "estolate", "ethylsuccinate", "tosylate", "napsylate", "embonate", "pamoate",
  "salicylate", "hydrate", "base", "free", "as",
]);

/** A substance name reduced to its moiety: lowercase, parenthetical and salt words dropped, sulph→sulf. */
export function moietyKey(name: string): string {
  const words = name.toLowerCase().replace(/\(.*?\)/g, " ").replace(/sulph/g, "sulf")
    .replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((w) => w !== "");
  const kept = words.filter((w) => !SALT_WORDS.has(w));
  return (kept.length > 0 ? kept : words).join(" ");
}

export type ScheduleSource = { flag: ScheduleFlag; basis: string; qualified: boolean };

/** The statutory lists as one lookup, keyed by moiety. A name on two lists keeps the stricter. */
export function statutoryIndex(
  lists: { flag: ScheduleFlag; basis: string; entries: readonly ScheduleEntry[] }[] = [
    { flag: "X", basis: `Schedule X — ${SCHEDULE_X_SOURCE.instrument}`, entries: SCHEDULE_X },
    { flag: "H1", basis: `Schedule H1 — ${SCHEDULE_H1_SOURCE.instrument}`, entries: SCHEDULE_H1 },
    { flag: "H", basis: `Schedule H — ${SCHEDULE_H_SOURCE.instrument}`, entries: SCHEDULE_H },
  ],
): Map<string, ScheduleSource> {
  const index = new Map<string, ScheduleSource>();
  for (const list of lists) {
    for (const e of list.entries) {
      for (const n of [e.name, ...(e.aliases ?? [])]) {
        const key = moietyKey(n);
        const prev = index.get(key);
        if (prev === undefined || RANK[list.flag] > RANK[prev.flag]) {
          index.set(key, { flag: list.flag, basis: list.basis, qualified: e.qualified === true });
        }
      }
    }
  }
  return index;
}

/** The strictest flag among these ingredients' flags, or null when none carries one. */
export function strictest(flags: readonly (ScheduleFlag | null)[]): ScheduleFlag | null {
  let best: ScheduleFlag | null = null;
  for (const f of flags) if (f !== null && (best === null || RANK[f] > RANK[best])) best = f;
  return best;
}

/** What NRCeS says about one SNOMED substance, and on which ground. */
export type NrcesVerdict = { flag: ScheduleFlag; basis: string };

const NRCES_CLASSIFIED = "Schedule H — NRCeS national drug database classification (2026-09)";
/**
 * THE TWO CLASS ENTRIES A NAME MATCH CANNOT REACH, reached through the source's own class column.
 * Schedule H serial 32 is "Antibiotics" and serial 134 "Corticosteroids" — every member is Schedule
 * H by statute, and no list of names says who the members are. NRCeS's `drug_type` does, per generic,
 * so a single-substance generic it types as an antibiotic/antibacterial or a corticosteroid takes H
 * with that basis named. (The formulary's `atc_code` would be the better key; it is empty on all
 * 3,705 salts — measured 2026-09-22.)
 */
const NRCES_CLASS_RULES: { test: RegExp; basis: string }[] = [
  { test: /antibiotic|antibacterial/i, basis: "Schedule H serial 32 \"Antibiotics\" — class membership from NRCeS drug_type" },
  { test: /corticosteroid/i, basis: "Schedule H serial 134 \"Corticosteroids\" — class membership from NRCeS drug_type" },
];

/**
 * The single-substance generics NRCeS classifies as Schedule H/H1, or types as a member of one of
 * Schedule H's class entries, keyed by SNOMED substance id. A combination's classification cannot be
 * attributed to one of its substances, so it is not used.
 */
export function nrcesScheduledSubstances(csvText: string): Map<string, NrcesVerdict> {
  const out = new Map<string, NrcesVerdict>();
  const put = (id: string, v: NrcesVerdict): void => {
    const prev = out.get(id);
    if (prev === undefined || RANK[v.flag] > RANK[prev.flag]) out.set(id, v);
  };
  for (const row of parseCsv(csvText).rows) {
    const ids = (row.cells.substance_sctids ?? "").split("|").map((x) => x.trim()).filter((x) => x !== "");
    if (ids.length !== 1) continue;
    const id = ids[0]!;
    const cls = (row.cells.classification_of_drug ?? "").trim();
    if (cls === "Schedule H1") put(id, { flag: "H1", basis: NRCES_CLASSIFIED.replace("Schedule H ", "Schedule H1 ") });
    if (cls === "Schedule H") put(id, { flag: "H", basis: NRCES_CLASSIFIED });
    const type = row.cells.drug_type ?? "";
    for (const rule of NRCES_CLASS_RULES) if (rule.test.test(type)) put(id, { flag: "H", basis: rule.basis });
  }
  return out;
}

export type SaltVerdict = { saltId: string; name: string; flag: ScheduleFlag | null; basis: string | null; qualifiedSkipped: boolean };

/** Each salt's own flag, from the statute first and NRCeS second. Read-only. */
export async function classifySalts(db: Db | Tx, nrces: Map<string, NrcesVerdict>, index = statutoryIndex()): Promise<Map<string, SaltVerdict>> {
  const salts = await db.select({ id: formularySalts.id, name: formularySalts.name, aliases: formularySalts.aliases }).from(formularySalts);
  const nrcesBySalt = new Map<string, NrcesVerdict>();
  if (nrces.size > 0) {
    const subs = await db.select({ sctid: formularySubstances.sctid, saltId: formularySubstances.saltId })
      .from(formularySubstances).where(inArray(formularySubstances.sctid, [...nrces.keys()]));
    for (const s of subs) {
      if (s.saltId === null) continue;
      const f = nrces.get(s.sctid);
      const prev = nrcesBySalt.get(s.saltId);
      if (f !== undefined && (prev === undefined || RANK[f.flag] > RANK[prev.flag])) nrcesBySalt.set(s.saltId, f);
    }
  }
  const out = new Map<string, SaltVerdict>();
  for (const s of salts) {
    const hits = [s.name, ...((s.aliases as string[] | null) ?? [])].map((n) => index.get(moietyKey(n))).filter((h): h is ScheduleSource => h !== undefined);
    const usable = hits.filter((h) => !h.qualified);
    const statutory = usable.reduce<ScheduleSource | undefined>((b, h) => (b === undefined || RANK[h.flag] > RANK[b.flag] ? h : b), undefined);
    const fromNrces = nrcesBySalt.get(s.id);
    const flag = strictest([statutory?.flag ?? null, fromNrces?.flag ?? null]);
    const basis = flag === null ? null
      : statutory !== undefined && statutory.flag === flag ? statutory.basis
        : fromNrces?.basis ?? null;
    out.set(s.id, { saltId: s.id, name: s.name, flag, basis, qualifiedSkipped: flag === null && hits.length > 0 });
  }
  return out;
}

/**
 * THE SCOPE NOTES, applied as the Rules print them (`*_SCOPE` in `data/drug-schedules.ts`): Schedule H
 * and H1 cover preparations of their substances "excluding those intended for topical or external
 * use (except ophthalmic and ear/nose preparations)". So a cream of a Schedule H substance is not
 * Schedule H by that entry — while Schedule X covers every preparation, and Schedule H note 4 keeps
 * topical hydroquinone (and steroids, a class this derivation does not match) inside H.
 */
export function isExternalPreparation(routeClass: string, form: string): boolean {
  if (routeClass !== "topical") return false;
  return !/eye|ophthalm|ear|otic|aural|nasal|nose/i.test(form);
}
const TOPICAL_STILL_H = new Set(["hydroquinone"]);

/** One product's flag: the strictest of its ingredients', after the scope note. */
export function medicineFlag(verdicts: readonly SaltVerdict[], routeClass: string, form: string): ScheduleFlag | null {
  const external = isExternalPreparation(routeClass, form);
  return strictest(verdicts.map((v) => (external && v.flag !== "X" && !TOPICAL_STILL_H.has(moietyKey(v.name)) ? null : v.flag)));
}

export type SchedulePlanRow = {
  medicineId: string; brandName: string; current: string | null; derived: ScheduleFlag | null;
  verdict: "set" | "ok" | "differs" | "unclassified";
};

export type SchedulePlan = {
  rows: SchedulePlanRow[];
  counts: { set: number; ok: number; differs: number; unclassified: number; qualifiedSkipped: number; externalExcluded: number };
  byFlag: Record<ScheduleFlag, number>;
  byBasis: Record<string, number>;
  salts: { total: number; flagged: number };
};

/** Every active medicine, judged. Read-only. */
export async function schedulePlan(db: Db | Tx, nrces: Map<string, NrcesVerdict>): Promise<SchedulePlan> {
  const salts = await classifySalts(db, nrces);
  const meds = await db.select({
    id: formularyMedicines.id, brandName: formularyMedicines.brandName, flag: formularyMedicines.scheduleFlag,
    routeClass: formularyMedicines.routeClass, form: formularyMedicines.form,
  })
    .from(formularyMedicines).where(eq(formularyMedicines.active, true)).orderBy(asc(formularyMedicines.id));
  const links = await db.select({ medicineId: formularyMedicineSalts.medicineId, saltId: formularyMedicineSalts.saltId }).from(formularyMedicineSalts);
  const saltsOf = new Map<string, string[]>();
  for (const l of links) {
    const list = saltsOf.get(l.medicineId);
    if (list === undefined) saltsOf.set(l.medicineId, [l.saltId]); else list.push(l.saltId);
  }
  const plan: SchedulePlan = {
    rows: [], counts: { set: 0, ok: 0, differs: 0, unclassified: 0, qualifiedSkipped: 0, externalExcluded: 0 },
    byFlag: { X: 0, H1: 0, H: 0 }, byBasis: {},
    salts: { total: salts.size, flagged: [...salts.values()].filter((s) => s.flag !== null).length },
  };
  for (const m of meds) {
    const verdicts = (saltsOf.get(m.id) ?? []).map((id) => salts.get(id)).filter((v): v is SaltVerdict => v !== undefined);
    const derived = medicineFlag(verdicts, m.routeClass, m.form);
    if (isExternalPreparation(m.routeClass, m.form) && derived === null && verdicts.some((v) => v.flag !== null)) plan.counts.externalExcluded += 1;
    const verdict: SchedulePlanRow["verdict"] = derived === null ? "unclassified"
      : m.flag === null ? "set" : m.flag === derived ? "ok" : "differs";
    plan.counts[verdict] += 1;
    if (derived === null && verdicts.some((v) => v.qualifiedSkipped)) plan.counts.qualifiedSkipped += 1;
    if (derived !== null) {
      plan.byFlag[derived] += 1;
      const basis = verdicts.find((v) => v.flag === derived)?.basis ?? "?";
      plan.byBasis[basis] = (plan.byBasis[basis] ?? 0) + 1;
    }
    plan.rows.push({ medicineId: m.id, brandName: m.brandName, current: m.flag, derived, verdict });
  }
  return plan;
}

/** Writes every `set` row (and `differs` with overwrite) in one transaction. Returns how many moved. */
export async function applySchedulePlan(db: Db, actor: Actor, plan: SchedulePlan, opts: { overwrite?: boolean } = {}): Promise<{ written: number }> {
  return withTx(db, async (tx) => {
    let written = 0;
    for (const r of plan.rows) {
      if (r.derived === null) continue;
      if (r.verdict === "set" || (r.verdict === "differs" && opts.overwrite === true)) {
        await updateMedicine(tx, actor, r.medicineId, { scheduleFlag: r.derived });
        written += 1;
      }
    }
    return { written };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "--apply");
  const nrcesPath = argValue(argv, "--nrces") ?? "/opt/hmis-context/nrces-2026-09/generics.csv";
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const person = await resolvePerson(db, argValue(argv, "--as"), "formulary.manage", "--as");
    let nrces = new Map<string, NrcesVerdict>();
    try { nrces = nrcesScheduledSubstances(readFileSync(nrcesPath, "utf8")); } catch {
      process.stdout.write(`  NOTE: ${nrcesPath} not readable — the NRCeS Schedule H source is skipped; statute only.\n`);
    }
    const plan = await schedulePlan(db, nrces);
    const c = plan.counts;
    process.stdout.write(
      `schedule flags · ${String(plan.rows.length)} active medicines · ${String(plan.salts.flagged)}/${String(plan.salts.total)} salts carry a schedule\n` +
      `  lists: X ${String(SCHEDULE_X.length)} · H1 ${String(SCHEDULE_H1.length)} · H ${String(SCHEDULE_H.length)} · NRCeS single-substance H/H1 or class member ${String(nrces.size)}\n` +
      `  derived: X ${String(plan.byFlag.X)} · H1 ${String(plan.byFlag.H1)} · H ${String(plan.byFlag.H)} · unclassified (stays NULL) ${String(c.unclassified)}\n` +
      `  verdicts: set ${String(c.set)} · ok ${String(c.ok)} · differs ${String(c.differs)} (left alone${hasFlag(argv, "--overwrite") ? " — OVERWRITTEN" : ""}) · qualified entries skipped ${String(c.qualifiedSkipped)} · external preparations excluded by the scope note ${String(c.externalExcluded)}\n`,
    );
    for (const [basis, n] of Object.entries(plan.byBasis).sort((a, b) => b[1] - a[1])) process.stdout.write(`    ${String(n).padStart(6)}  ${basis}\n`);
    for (const r of plan.rows.filter((x) => x.verdict === "differs").slice(0, 50)) {
      process.stdout.write(`    differs  ${r.current ?? "-"} → ${r.derived ?? "-"}  ${r.brandName}\n`);
    }
    if (!apply) { process.stdout.write("\nDRY RUN — nothing written. Re-run with --apply.\n"); return; }
    const done = await applySchedulePlan(db, person, plan, { overwrite: hasFlag(argv, "--overwrite") });
    process.stdout.write(`\nAPPLIED as ${person.username} (${person.fullName}): ${String(done.written)} medicine(s) flagged, one transaction.\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
