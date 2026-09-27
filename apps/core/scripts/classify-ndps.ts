import { eq } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { users } from "../src/kernel/db/schema";
import { classifyControlledDrugs } from "../src/modules/pharmacy";

/**
 * PHARMACY P6 — `classify-ndps --as <username> [--apply]`. Writes the cited NDPS list onto the catalogue's
 * moieties, stores every controlled drug's item as `narcotic` (so the ledger keeps it in the cabinet), and
 * reports the moieties a pharmacist must rule on and the controlled stock still outside the cabinet.
 * A dry run first, always: the report is what the pharmacist in charge reads before `--apply`.
 * Brief: docs/superpowers/plans/2026-09-26-pharmacy-p6-ndps-schedule-x-law.md; runbook §16.
 */
function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const username = arg(args, "--as");
  if (username === undefined) throw new Error("usage: --as <username> [--apply]");
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  void (async () => {
    try {
      const [person] = await db.select({ id: users.id, fullName: users.fullName, active: users.active }).from(users).where(eq(users.username, username));
      if (person === undefined || !person.active) throw new Error(`no active account "${username}"`);
      const r = await classifyControlledDrugs(db, { type: "user", id: person.id }, { apply });
      console.log(`NDPS moieties · ${String(r.salts.classified.length)} to classify, ${String(r.salts.unchanged)} already classified`);
      for (const c of r.salts.classified) console.log(`  ${c.name.padEnd(18)} ${String(c.was ?? "—")} → ${c.ndpsClass}${c.essential ? " (essential narcotic drug)" : ""}  [${c.source}]`);
      if (r.salts.notInCatalogue.length > 0) console.log(`  not in this catalogue: ${r.salts.notInCatalogue.join(", ")}`);
      console.log(`\nLOOK CONTROLLED, NOT ON THE CITED LIST — a pharmacist rules on each (left unclassified): ${String(r.salts.unknown.length)}`);
      for (const u of r.salts.unknown.slice(0, 300)) console.log(`  ${u.name}${u.ndpsClass === null ? "" : ` (already ${u.ndpsClass})`}`);
      console.log(`\nControlled items not stored as narcotic: ${String(r.items.length)}`);
      for (const i of r.items) console.log(`  ${i.code.padEnd(14)} ${i.was} → narcotic  ${i.name}${i.scheduleX ? " [Schedule X]" : ""}${i.ndpsClass === null ? "" : ` [${i.ndpsClass}]`}`);
      console.log(`\nControlled stock OUTSIDE the cabinet (move it into PHARM-NDPS under two keys): ${String(r.outsideCabinet.length)}`);
      for (const o of r.outsideCabinet) console.log(`  ${o.storeCode.padEnd(14)} ${o.itemCode.padEnd(14)} ${String(o.qtyOnHand).padStart(6)}  ${o.itemName} (batch ${o.batchId})`);
      console.log(apply ? `\nAPPLIED as ${username} (${person.fullName}).` : "\nDRY RUN — nothing written. Re-run with --apply.");
    } finally {
      await pool.end();
    }
  })().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}

if (require.main === module) main();
