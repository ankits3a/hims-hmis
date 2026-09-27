import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { labAnalytes, users } from "../src/kernel/db/schema";
import { createResource } from "../src/kernel/resources/registry";
import { listResourcesOfKind } from "../src/kernel/resources/read";
import { LAB_RESOURCE_KINDS } from "../src/modules/lab/kinds";
import { listInstruments, mapInstrumentCode, registerInstrument } from "../src/modules/lab/instruments";
import { listOrderables } from "../src/modules/lab";
import { assertSyntheticDataAllowed } from "./synthetic-door";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ PLAN 17-F · S — THE LABORATORY'S PHYSICAL ROOM, SYNTHETIC, FOR A NON-PRODUCTION DATABASE ═══
 *
 * `dev-lab-standup.ts` stands up the paperwork (department, pathologist of record, the definition
 * ceremony, a priced tariff). This stands up the ROOM: one `bench` resource per `bench_key` the
 * catalogue uses, and the analyser inventory from `synthetic/lab/instruments.json`, each machine's
 * codes mapped to the analytes it reports.
 *
 * **Every value here is synthetic.** The analyser list is the owner's board inventory plus invented
 * models where the real one is not yet known (roadmap owner item: "the analyser inventory"); the
 * instrument codes are the analyte codes, because a real machine's own codes come from its LIS manual
 * at commissioning. It refuses production two ways — the synthetic-data key and the prod port —
 * for the same reason `seed-lab-catalogue.ts` does: a machine registered in production is
 * a machine the bench believes exists.
 *
 * Idempotent: a bench or an instrument whose code already exists is left alone, and an instrument's
 * mappings are only written when this run registered it.
 */

export const SYNTHETIC_LAB_DIR = resolve(__dirname, "synthetic", "lab");

export type SyntheticInstrument = {
  code: string;
  name: string;
  sampleIdMode: "barcode" | "typed_id" | "run_sheet" | "plate_map";
  analytes: string[];
};

export type SyntheticLabReport = {
  benchesCreated: string[];
  benchesPresent: string[];
  instrumentsRegistered: string[];
  instrumentsPresent: string[];
  codesMapped: number;
  unknownAnalytes: string[];
};

export function readSyntheticInstruments(dir = SYNTHETIC_LAB_DIR): SyntheticInstrument[] {
  return JSON.parse(readFileSync(resolve(dir, "instruments.json"), "utf8")) as SyntheticInstrument[];
}

/**
 * The refusals, in one place so the test can hold them — the same pair `seed-lab-catalogue.ts`
 * carries. NOT `NODE_ENV` alone: UAT runs the production image, which sets `NODE_ENV=production`
 * (`test/synthetic-door.test.ts`), so the synthetic-data key is what separates a rehearsal from the
 * hospital, and the prod port is refused whatever the key says.
 */
export function assertNotProduction(script: string, env: NodeJS.ProcessEnv = process.env): void {
  const url = env.DATABASE_URL ?? "";
  if (url === "") throw new Error(`${script}: DATABASE_URL is not set`);
  assertSyntheticDataAllowed(script, env);
  if (url.includes(":5434")) {
    throw new Error(
      `${script}: REFUSED — this registers synthetic benches and analysers. Production's room is ` +
        "registered by the pathologist, through the shipped screens (docs/runbooks/lab-go-live.md §6).",
    );
  }
}

export async function seedLabSynthetic(
  db: Db, actor: Actor, instruments: readonly SyntheticInstrument[],
): Promise<SyntheticLabReport> {
  const report: SyntheticLabReport = {
    benchesCreated: [], benchesPresent: [], instrumentsRegistered: [], instrumentsPresent: [],
    codesMapped: 0, unknownAnalytes: [],
  };

  /* ── benches: one per bench_key the catalogue actually uses ─────────────────────────── */
  const wanted = [...new Set((await listOrderables(db)).map((o) => o.benchKey).filter((k): k is string => !!k))].sort();
  const have = new Set((await listResourcesOfKind(db, "bench", { includeRetired: true })).map((r) => r.code));
  for (const code of wanted) {
    if (have.has(code)) { report.benchesPresent.push(code); continue; }
    await withTx(db, (tx) => createResource(tx, actor, LAB_RESOURCE_KINDS, {
      kind: "bench", code, name: `Bench ${code}`,
      attributes: { synthetic: true },
    }));
    report.benchesCreated.push(code);
  }

  /* ── analysers, and each one's codes ─────────────────────────────────────────────────── */
  const registered = new Set((await listInstruments(db)).map((i) => i.code));
  for (const machine of instruments) {
    if (registered.has(machine.code)) { report.instrumentsPresent.push(machine.code); continue; }
    const { instrumentId } = await registerInstrument(db, actor, {
      code: machine.code, name: machine.name, sampleIdMode: machine.sampleIdMode,
    });
    report.instrumentsRegistered.push(machine.code);
    for (const analyteCode of machine.analytes) {
      const [analyte] = await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, analyteCode));
      if (!analyte) { report.unknownAnalytes.push(`${machine.code}:${analyteCode}`); continue; }
      await mapInstrumentCode(db, actor, { instrumentId, instrumentCode: analyteCode, analyteId: analyte.id });
      report.codesMapped += 1;
    }
  }
  return report;
}

async function main(): Promise<void> {
  assertNotProduction("seed-lab-synthetic");
  const { db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    /** The pathologist holds `lab.instruments.manage`; the room is registered in their name. */
    const username = process.env.SYNTHETIC_PATHOLOGIST ?? "dr.meera";
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
    if (!row) throw new Error(`seed-lab-synthetic: no user "${username}" — run seed:staff with synthetic/lab/staff.json first`);
    const report = await seedLabSynthetic(db, { type: "user", id: row.id }, readSyntheticInstruments());
    console.log(JSON.stringify({ seed: "lab-synthetic", ...report }));
    if (report.unknownAnalytes.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e); process.exit(1); });
}
