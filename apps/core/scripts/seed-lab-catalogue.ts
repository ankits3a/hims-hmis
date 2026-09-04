import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { createDb } from "../src/kernel/db/client";
import { labAnalytes, labOrderables, labReferenceRanges, labReflexRules, services } from "../src/kernel/db/schema";
import { upsertAnalyte, upsertOrderable } from "../src/modules/lab/catalogue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 17a T3 — SEED THE GOLDEN LAB CATALOGUE.
 *
 * ═══ WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT ═══
 *
 * It is the catalogue that makes the phase EXECUTABLE: 17b has to result against something, and a
 * lab with no orderables cannot be tested at all. Its ranges are standard kit-insert values.
 *
 * **It is NOT the hospital's catalogue.** §4A item 3 of Plan 17 routes the real one to the owner —
 * the existing lab's codes, names, containers, TATs, its own range book with its own source, and
 * the price list mapped to tariff — and §9.9 makes loading it a runbook act on the owner's
 * spreadsheet, exactly as 07d's formulary was. **Running this against production would put invented
 * reference ranges behind real reports**, so it refuses to run there (below) rather than trusting
 * an operator to notice.
 *
 * ═══ IT CREATES THE `services` ROWS, BECAUSE NOBODY ELSE DOES ═══
 *
 * Ground truth row 10: no seed script in this repository creates a `services` row of category
 * `investigation`, and production has exactly one (a synthetic CBC). An orderable is keyed BY its
 * `services` row (DD1), so seeding the catalogue means seeding the tariff side of it first. The
 * service ids are DERIVED from the code, deterministically, so a second run updates rather than
 * duplicates — the same idempotence `seed-roles` and `seed-ot` promise.
 */

type Fixture = {
  analytes: {
    code: string; nameEn: string; nameHi?: string | null; resultType: "numeric" | "text" | "coded" | "formula";
    unit?: string | null; decimals?: number; formula?: string | null; formulaGuard?: string | null;
    absurdLow?: string | null; absurdHigh?: string | null; criticalLow?: string | null; criticalHigh?: string | null;
    deltaAbs?: string | null; deltaPct?: string | null; deltaWindowHours?: number | null;
    /** 17d T1 — who the analyte is for. Absent = everybody, which is nearly every row. */
    appliesToSex?: "male" | "female" | null;
    appliesMinAgeDays?: number | null; appliesMaxAgeDays?: number | null;
  }[];
  orderables: {
    code: string; nameEn: string; discipline: string; specimenType: string; container: string;
    tatMinutesRoutine: number; tatMinutesStat?: number | null; benchKey?: string | null;
    requiresFasting?: boolean; consentRequired?: boolean; sensitive?: boolean; notifiable?: boolean;
    analyteCodes: string[];
  }[];
  referenceRanges: {
    analyteCode: string; sex: string; ageMinDays: number; ageMaxDays: number;
    low: string | null; high: string | null; text: string | null;
    criticalLow: string | null; criticalHigh: string | null; source: string; effectiveFrom: string;
  }[];
  reflexRules: { analyteCode: string; comparator: string; threshold: string; addsOrderableCode: string; active: boolean }[];
};

export const LAB_CATALOGUE_FIXTURE = resolve(__dirname, "..", "test", "fixtures", "lab-catalogue.json");

/** Deterministic, so a re-run UPDATES the same rows instead of minting a parallel catalogue. */
export function serviceIdForLabCode(code: string): string {
  return `LABSVC-${code}`;
}

export function loadLabCatalogue(path: string = LAB_CATALOGUE_FIXTURE): Fixture {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

export type SeedLabCatalogueReport = {
  services: number;
  analytes: number;
  orderables: number;
  referenceRanges: number;
  reflexRules: number;
  activeReflexRules: number;
};

/**
 * Seeds the whole fixture. IDEMPOTENT in every table, and `seed-lab-catalogue.test.ts` proves it by
 * running twice and comparing counts rather than by asserting the code looks idempotent.
 *
 * The actor must hold `lab.catalogue.manage` — the seed goes through `upsertOrderable` and
 * `upsertAnalyte` rather than around them, so **the PCPNDT refusal and the formula parser guard the
 * seed exactly as they guard a curator at a screen** (E33, T3 A9). A fixture that could bypass them
 * would be a way to load a catalogue no screen would accept.
 */
export async function seedLabCatalogue(db: Db, actor: Actor, fixture: Fixture = loadLabCatalogue()): Promise<SeedLabCatalogueReport> {
  // ── (1) the tariff side: one `services` row per orderable ──
  for (const o of fixture.orderables) {
    const id = serviceIdForLabCode(o.code);
    const existing = (await db.select({ id: services.id }).from(services).where(eq(services.id, id)))[0];
    if (existing) {
      await db.update(services).set({ name: o.nameEn, updatedBy: actor.id, updatedAt: new Date() })
        .where(eq(services.id, id));
    } else {
      await db.insert(services).values({
        id, code: `LAB-${o.code}`, name: o.nameEn, category: "investigation",
        createdBy: actor.id, updatedBy: actor.id,
      });
    }
  }

  // ── (2) analytes, before the orderables that name them ──
  for (const a of fixture.analytes) await upsertAnalyte(db, actor, a);

  // ── (3) orderables, which resolve their analyte codes and write the report order ──
  for (const o of fixture.orderables) {
    await upsertOrderable(db, actor, { ...o, serviceId: serviceIdForLabCode(o.code) });
  }

  // ── (4) the range book ──
  const analyteByCode = new Map(
    (await db.select({ id: labAnalytes.id, code: labAnalytes.code }).from(labAnalytes)).map((r) => [r.code, r.id] as const),
  );
  // Replaced wholesale rather than merged: a range row has no natural key a curator would recognise
  // (analyte + sex + band + effective date is four columns), and a merge would leave orphans from a
  // previous fixture behind — which is a range book nobody edited saying something nobody chose.
  await db.delete(labReferenceRanges);
  for (const r of fixture.referenceRanges) {
    const analyteId = analyteByCode.get(r.analyteCode);
    if (analyteId === undefined) throw new Error(`seed:lab-catalogue: unknown analyte ${r.analyteCode}`);
    await db.insert(labReferenceRanges).values({
      id: newId(), analyteId, sex: r.sex, ageMinDays: r.ageMinDays, ageMaxDays: r.ageMaxDays,
      low: r.low, high: r.high, text: r.text, criticalLow: r.criticalLow, criticalHigh: r.criticalHigh,
      source: r.source, effectiveFrom: r.effectiveFrom, createdBy: actor.id,
    });
  }

  // ── (5) the reflex rules, and they ship INACTIVE ──
  await db.delete(labReflexRules);
  for (const rule of fixture.reflexRules) {
    const analyteId = analyteByCode.get(rule.analyteCode);
    if (analyteId === undefined) throw new Error(`seed:lab-catalogue: unknown analyte ${rule.analyteCode}`);
    await db.insert(labReflexRules).values({
      id: newId(), analyteId, comparator: rule.comparator, threshold: rule.threshold,
      addsServiceId: serviceIdForLabCode(rule.addsOrderableCode),
      /**
       * **`active` COMES FROM THE FIXTURE AND THE FIXTURE SAYS FALSE, ALL THREE.** A reflex is an
       * order the system places and the patient pays for; switching one on is a clinical and a
       * commercial decision per hospital, and a seed that shipped them enabled would make that
       * decision for every deployment silently (DD8, T3 A7).
       */
      active: rule.active, version: 1, createdBy: actor.id, updatedBy: actor.id,
    });
  }

  return {
    services: fixture.orderables.length,
    analytes: (await db.select({ id: labAnalytes.id }).from(labAnalytes)).length,
    orderables: (await db.select({ id: labOrderables.serviceId }).from(labOrderables)).length,
    referenceRanges: (await db.select({ id: labReferenceRanges.id }).from(labReferenceRanges)).length,
    reflexRules: (await db.select({ id: labReflexRules.id }).from(labReflexRules)).length,
    activeReflexRules: (await db.select({ id: labReflexRules.id }).from(labReflexRules)
      .where(eq(labReflexRules.active, true))).length,
  };
}

/* ─────────────────────────── the CLI half ─────────────────────────── */

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("seed:lab-catalogue: DATABASE_URL is not set");
  /**
   * IT REFUSES PRODUCTION, and the refusal is the point rather than a courtesy. These ranges are
   * INVENTED — standard kit-insert values, not this hospital's book — and a production report
   * carrying them would be signed by a pathologist against numbers nobody chose. §9.9's runbook
   * loads the owner's own catalogue; this script exists for dev and for the suite.
   */
  if (url.includes(":5434") || (process.env.NODE_ENV === "production")) {
    throw new Error(
      "seed:lab-catalogue: REFUSED — this fixture's reference ranges are invented and must never " +
        "back a real report. The hospital's own catalogue is a runbook act (17a §9.9).",
    );
  }
  const { db, pool } = createDb(url);
  const actor: Actor = { type: "user", id: process.env.SEED_ACTOR_ID ?? "seed-lab-catalogue" };
  try {
    const report = await seedLabCatalogue(db, actor);
    console.log(`seed:lab-catalogue — ${JSON.stringify(report)}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e); process.exit(1); });
}
