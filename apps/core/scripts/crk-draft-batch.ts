/**
 * ═══ DRAFT CRK FORMULARY ENTRIES FOR STOCKED GENERICS (#883, decision 0053) ═══
 *
 *   DATABASE_URL=… FORMULARY_DRAFT_MODEL=<model> HMIS_OPENAI_KEY_FILE=<file> \
 *     tsx scripts/crk-draft-batch.ts --as <username> [--limit 20] [--out <dir>] [--price-in <usd/M> --price-out <usd/M>]
 *
 * Fetches each stocked generic's public sources (openFDA labels; PubChem's LiverTox, LactMed, MeSH and FDA class
 * annotations) and drafts it through the #618 drafter. Drafts are PENDING entries on the Pharmacology worklist: nothing
 * is signed or shown to a doctor. 20 a run by default, at most 50. `--out` writes outcomes.json (per generic: status,
 * sources with their licences, statements, tokens) and cost.json (at the given list prices). The key is read from the
 * file and never printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { hasPermission } from "../src/kernel/auth/permissions";
import { users } from "../src/kernel/db/schema";
import { openAiCompatibleClient } from "../src/kernel/inference/openai-compatible";
import { openAiKeyFromFile } from "../src/kernel/inference/openai-speech";
import { crkCostReport, runCrkDraftBatch } from "../src/modules/formulary/crk-batch";
import { fetchCrkSources, lookupNamesFor } from "../src/modules/formulary/crk-sources";

const arg = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  const v = i < 0 ? undefined : args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
};

function main(): void {
  const args = process.argv.slice(2);
  const username = arg(args, "--as");
  if (username === undefined) throw new Error("usage: --as <username> [--limit 20] [--out <dir>] [--price-in <usd/M> --price-out <usd/M>]");
  const limit = Number(arg(args, "--limit") ?? "20");
  const out = arg(args, "--out");
  const priceIn = Number(arg(args, "--price-in") ?? "NaN");
  const priceOut = Number(arg(args, "--price-out") ?? "NaN");
  const modelId = (process.env.FORMULARY_DRAFT_MODEL ?? "").trim();
  const client = modelId === "" ? null : openAiCompatibleClient({
    baseUrl: process.env.FORMULARY_DRAFT_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: openAiKeyFromFile(process.env.HMIS_OPENAI_KEY_FILE ?? null),
    model: modelId, timeoutMs: Number(process.env.FORMULARY_DRAFT_TIMEOUT_MS ?? "120000"),
  });
  const retrievedOn = new Date().toISOString().slice(0, 10);
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  void (async () => {
    try {
      const person = (await db.select({ id: users.id, active: users.active }).from(users).where(eq(users.username, username)))[0];
      if (person === undefined || !person.active) throw new Error(`no active account "${username}"`);
      const may = (await hasPermission(db, person.id, "formulary.manage", "hospital")) || (await hasPermission(db, person.id, "formulary.crk.sign", "hospital"));
      if (!may) throw new Error(`"${username}" holds neither formulary.manage nor formulary.crk.sign`);
      const outcomes = await runCrkDraftBatch(db, { type: "user", id: person.id }, {
        limit,
        model: { client, id: client === null ? null : modelId },
        sourcesFor: (g) => fetchCrkSources(lookupNamesFor(g.name, g.substances), { fetch: (u) => fetch(u), retrievedOn }),
        onOutcome: (o) => {
          const t = o.usage === undefined || o.usage === null ? "" : ` · ${String(o.usage.inputTokens)} in / ${String(o.usage.outputTokens)} out`;
          console.log(`${o.status.padEnd(9)} ${o.name} · ${String(o.sources.length)} sources${o.statements === undefined ? "" : ` · ${String(o.statements)} kept, ${String(o.dropped)} dropped`}${t}${o.error === undefined ? "" : ` · ${o.error}`}`);
        },
      });
      const cost = Number.isFinite(priceIn) && Number.isFinite(priceOut)
        ? crkCostReport(outcomes.filter((o) => o.status === "drafted"), { inputPerMillionUsd: priceIn, outputPerMillionUsd: priceOut }, 300)
        : null;
      if (cost !== null) console.log(`total ${String(cost.total.drafts)} drafts · ${String(cost.total.inputTokens)} in / ${String(cost.total.outputTokens)} out · $${cost.total.usd.toFixed(4)} · ~300: $${cost.projected.usd.toFixed(2)}`);
      if (out !== undefined) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "outcomes.json"), `${JSON.stringify({ model: modelId, retrievedOn, outcomes }, null, 2)}\n`);
        if (cost !== null) writeFileSync(join(out, "cost.json"), `${JSON.stringify({ model: modelId, price: { inputPerMillionUsd: priceIn, outputPerMillionUsd: priceOut }, ...cost }, null, 2)}\n`);
      }
    } finally {
      await pool.end();
    }
  })().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}

if (require.main === module) main();
