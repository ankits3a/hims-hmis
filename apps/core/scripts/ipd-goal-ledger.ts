import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { IPD_GOAL_QUERIES } from "../src/modules/ipd/goals";

/**
 * E0.5 (#717) — prints every IPD goal's current value for a window (plan §6 ledger). READ-ONLY: it runs the
 * named goal queries and writes nothing. Not wired into seeds or deploy.
 *
 *   pnpm --filter @hmis/core exec tsx scripts/ipd-goal-ledger.ts [--days 28] [--from ISO --to ISO] [--json]
 *
 * Default window: the last 28 days up to now.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const to = arg("to") ? new Date(arg("to")!) : new Date();
  const days = Number(arg("days") ?? 28);
  const from = arg("from") ? new Date(arg("from")!) : new Date(to.getTime() - days * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new Error("bad window: need from < to");

  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const out = [];
    for (const q of Object.values(IPD_GOAL_QUERIES)) {
      const head = { id: q.id, title: q.title, unit: q.unit, target: q.target, window: q.window };
      try {
        const r = await q.run(db, { from, to });
        out.push({ ...head, ...r, rows: r.rows.length });
      } catch (e) {
        // One broken goal must not hide the other seventeen: report it and go on; the exit code says so.
        out.push({ ...head, status: "error" as const, error: e instanceof Error ? e.message : String(e) });
        process.exitCode = 1;
      }
    }
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ from, to, goals: out }, null, 2));
      return;
    }
    console.log(`IPD goal ledger  ${from.toISOString()} → ${to.toISOString()}`);
    for (const g of out) {
      const value = g.status === "error" ? `ERROR — ${g.error}`
        : g.status === "not_instrumented" ? `not instrumented — ${g.source}` : `${g.value ?? "no data"} ${g.unit}`;
      const extra = g.status === "measured" && g.breakdown?.length
        ? `  [${g.breakdown.map((b) => `${b.key}=${b.value ?? "—"}`).join(", ")}]`
        : "";
      console.log(`${g.id.padEnd(5)} ${g.title.padEnd(48)} ${value}${extra}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
