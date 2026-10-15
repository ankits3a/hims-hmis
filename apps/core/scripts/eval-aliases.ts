/**
 * THE MEDICINE-ALIAS EVALUATION (decision 0051: "the measured numbers are stated first").
 *
 *   ALIAS_EVAL_DATABASE_URL=postgres://…/a_catalogue_copy HMIS_EVAL_NETWORK=1 \
 *     pnpm --filter @hmis/core exec tsx scripts/eval-aliases.ts > /path/run.json
 *   …                                           tsx scripts/eval-aliases.ts --dry     (no model, no network)
 *
 * It runs the PRODUCT's pipeline (`proposeAlias`, `modules/opd/alias-pipeline.ts`) with the kill
 * switch on IN THIS PROCESS ONLY, over the held-out set (`scripts/data/alias-eval-set.ts`), against
 * a database that holds the formulary catalogue (`formulary_medicines`, `_salts`, `_medicine_salts`,
 * `opd_lasa_pairs`). It READS that database and writes nothing — no `cds_aliases` row is saved.
 *
 * It CALLS TWO OUTSIDE APIS (TypeSafe's Jev as chooser, OpenAI's Decisions endpoint as reviewer),
 * so it refuses to run without `HMIS_EVAL_NETWORK=1` and is never part of a test run. Keys are read
 * inside this process and never printed. What is sent: the term and catalogue names. `--dry` calls
 * nothing: it prints which labels the catalogue cannot answer and whether the right product was
 * among the five a chooser would be shown.
 *
 * stdout is JSON: every item's candidates, both models' raw numbers, the rule result, the verdict,
 * latency and tokens, then the summary the write-up is computed from. A 401 from either provider
 * stops the run (a rotated key is the owner's to replace, not something to work around).
 */
import { readFileSync } from "node:fs";
import { createDb } from "../src/kernel/db/client";
import { openAiDecisionsClient } from "../src/kernel/inference/openai-decisions";
import { typesafeClient } from "../src/kernel/inference/typesafe";
import type { ChoiceClient, PredicateClient } from "../src/kernel/inference/types";
import { aliasCandidatePool } from "../src/modules/formulary";
import { ALIAS_REASON_CODES, compositionKey, proposeAlias, readTerm, shownCandidates } from "../src/modules/opd/alias-pipeline";
import type { AliasDeps, AliasProposal } from "../src/modules/opd/alias-pipeline";
import { lasaPairs } from "../src/modules/opd/consult-guards";
import { ALIAS_EVAL } from "./data/alias-eval-set";
import type { AliasEvalCategory } from "./data/alias-eval-set";

const DRY = process.argv.includes("--dry");
if (!DRY && process.env.HMIS_EVAL_NETWORK !== "1") {
  process.stderr.write("refusing: this calls two outside APIs. Set HMIS_EVAL_NETWORK=1 to run it, or pass --dry.\n");
  process.exit(2);
}
const DB_URL = process.env.ALIAS_EVAL_DATABASE_URL;
if (DB_URL === undefined || DB_URL === "") {
  process.stderr.write("refusing: ALIAS_EVAL_DATABASE_URL must name a database holding the formulary catalogue.\n");
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE_MS = Number(process.env.HMIS_EVAL_PACE_MS ?? "150");
const TIMEOUT_MS = 10_000; // generous on purpose: this MEASURES latency
const CHOOSER_LINE = Number(process.env.ALIAS_CHOOSER_MIN_CONFIDENCE ?? "0.95");
const REVIEWER_LINE = Number(process.env.ALIAS_REVIEWER_MIN_PROBABILITY ?? "0.9");
/** OpenAI's published price for the Decisions endpoint on 2026-10-07 (plan §9a): input tokens only. */
const OPENAI_USD_PER_M_INPUT = 0.1;

function typesafeKey(): string | null {
  try {
    const line = readFileSync(process.env.TYPESAFE_ENV_FILE ?? "/opt/hmis-context/secrets/typesafe.env", "utf8").split("\n").find((l) => /^(TRIAGE_TYPESAFE_API_KEY|TYPESAFE_API_KEY)=/.test(l));
    const v = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    return v === undefined || v === "" ? null : v;
  } catch { return null; }
}
function openaiKey(): string | null {
  try {
    const raw = readFileSync(process.env.HMIS_OPENAI_KEY_FILE ?? "/root/.config/hmis/openai/key.txt", "utf8").trim();
    return raw === "" ? null : raw;
  } catch { return null; }
}

type Meter = { fetchImpl: typeof fetch; calls: number; ms: number[]; inputTokens: number; statuses: Record<string, number>; take: () => { ms: number; tokens: number; calls: number } };
/** A fetch that keeps each call's time, status and reported input tokens. `take()` returns and clears what one item used. */
function meter(): Meter {
  let itemMs = 0; let itemTokens = 0; let itemCalls = 0;
  const m: Meter = {
    calls: 0, ms: [], inputTokens: 0, statuses: {},
    take: () => { const out = { ms: Math.round(itemMs), tokens: itemTokens, calls: itemCalls }; itemMs = 0; itemTokens = 0; itemCalls = 0; return out; },
    fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const t = performance.now();
      try {
        const res = await fetch(url, init);
        m.statuses[String(res.status)] = (m.statuses[String(res.status)] ?? 0) + 1;
        try {
          const usage = ((await res.clone().json()) as { usage?: { input_tokens?: number } }).usage;
          if (typeof usage?.input_tokens === "number") { m.inputTokens += usage.input_tokens; itemTokens += usage.input_tokens; }
        } catch { /* not json */ }
        return res;
      } finally {
        const took = performance.now() - t;
        m.calls += 1; m.ms.push(took); itemMs += took; itemCalls += 1;
      }
    }) as typeof fetch,
  };
  return m;
}

const pct = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number);
};

type Verdict = "right" | "wrong" | "abstained";
type Row = {
  i: number; term: string; cat: AliasEvalCategory; want: string | null;
  shown: string[]; shownKeys: string[]; wantShown: boolean | null;
  state: string; refusal: string | null; ruleResult: string; lasaGuard: boolean;
  target: string | null; targetKey: string | null; targetRight: boolean | null;
  chooser: { model: string; confidence: number } | null;
  reviewer: { model: string; answer: string; probability: number; reasonCode: string } | null;
  verdict: Verdict;
  ms: { candidates: number; chooser: number; reviewer: number; total: number };
  tokens: { chooser: number; reviewer: number };
};

function summarise(rows: Row[]): Record<string, { items: number; answered: number; abstained: number; right: number; wrong: number; precision: number | null }> {
  const cats = [...new Set(rows.map((r) => r.cat)), "ALL"];
  return Object.fromEntries(cats.map((cat) => {
    const mine = cat === "ALL" ? rows : rows.filter((r) => r.cat === cat);
    const right = mine.filter((r) => r.verdict === "right").length;
    const wrong = mine.filter((r) => r.verdict === "wrong").length;
    return [cat, { items: mine.length, answered: right + wrong, abstained: mine.length - right - wrong, right, wrong, precision: right + wrong === 0 ? null : Number((right / (right + wrong)).toFixed(4)) }];
  }));
}

/** What the pipeline WOULD have said at other lines, from the recorded numbers: no model is asked again. */
function sweep(rows: Row[]): { chooserLine: number; reviewerLine: number; answered: number; right: number; wrong: number }[] {
  const refusingReason = new Set(["ambiguous_strength", "ambiguous_form", "lookalike_risk", "not_a_medicine"]);
  const out: { chooserLine: number; reviewerLine: number; answered: number; right: number; wrong: number }[] = [];
  for (const cl of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    for (const rl of [0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99]) {
      const yes = rows.filter((r) => r.target !== null && r.chooser !== null && r.reviewer !== null && r.ruleResult === "pass"
        && r.chooser.confidence >= cl && r.reviewer.probability >= rl && !refusingReason.has(r.reviewer.reasonCode));
      const right = yes.filter((r) => r.targetRight === true).length;
      out.push({ chooserLine: cl, reviewerLine: rl, answered: yes.length, right, wrong: yes.length - right });
    }
  }
  return out;
}

async function run(): Promise<void> {
  const { db, pool } = createDb(DB_URL as string);
  try {
    if (DRY) {
      let labelled = 0; let inShown = 0; const missing: string[] = [];
      for (const item of ALIAS_EVAL) {
        if (item.want === null) continue;
        labelled += 1;
        const reading = readTerm(item.term);
        const shown = shownCandidates(reading, await aliasCandidatePool(db, reading.words, reading.numbers.map((n) => String(n.value))));
        const keys = shown.map(compositionKey);
        if (keys.includes(item.want)) { inShown += 1; continue; }
        /* Is the label itself answerable? Ask the catalogue by the label's first moiety. */
        const byMoiety = await aliasCandidatePool(db, (item.want.split("|")[0] as string).split("+")[0] as string, [], 500);
        const exists = byMoiety.some((r) => compositionKey(r) === item.want);
        missing.push(`${exists ? "NOT SHOWN" : "NO SUCH PRODUCT"}  ${item.cat}  "${item.term}"  want ${item.want}\n      shown: ${keys.join("  ;  ") || "(nothing)"}`);
      }
      process.stdout.write(`${missing.join("\n")}\n\nlabelled ${String(labelled)} · right product among the shown five: ${String(inShown)} · not: ${String(missing.length)}\nitems ${String(ALIAS_EVAL.length)} · duplicates ${String(ALIAS_EVAL.length - new Set(ALIAS_EVAL.map((x) => x.term)).size)}\n`);
      return;
    }

    const jev = meter(); const luna = meter(); const dbMs: number[] = [];
    const chooser: ChoiceClient | null = typesafeClient({ baseUrl: "https://api.typesafe.ai/v1", apiKey: typesafeKey(), model: process.env.TYPESAFE_MODEL ?? "jev-1.13.0", timeoutMs: TIMEOUT_MS }, jev.fetchImpl);
    const reviewer: (ChoiceClient & PredicateClient) | null = openAiDecisionsClient({ baseUrl: "https://api.openai.com/v1", model: process.env.OPENAI_DECISIONS_MODEL ?? "gpt-6-luna", timeoutMs: TIMEOUT_MS }, openaiKey, luna.fetchImpl);
    if (chooser === null || reviewer === null) { process.stderr.write(`no key for ${chooser === null ? "typesafe" : "openai"} — nothing measured\n`); process.exit(3); }

    const pairs = await lasaPairs(db);
    let lastDb = 0;
    const deps: AliasDeps = {
      enabled: true, // in this process only: the server's setting is untouched and stays off
      candidates: async (words, numbers) => { const t = performance.now(); try { return await aliasCandidatePool(db, words, numbers); } finally { lastDb = performance.now() - t; dbMs.push(lastDb); } },
      lasa: () => Promise.resolve(pairs),
      chooser, reviewer, chooserLine: CHOOSER_LINE, reviewerLine: REVIEWER_LINE,
    };
    // one throwaway call each so the first measured item does not carry the TLS handshake
    try { await chooser.choose({ state: { term: "x" }, questions: { q: { instructions: "Which?", options: { a: "a", b: "b" } } } }); } catch { /* warm-up */ }
    try { await reviewer.predicate({ state: { term: "x" }, instructions: "Is `term` a letter?" }); } catch { /* warm-up */ }
    jev.take(); luna.take();
    const warm = { jev: jev.calls, luna: luna.calls, jevTokens: jev.inputTokens, lunaTokens: luna.inputTokens };

    const rows: Row[] = [];
    for (let i = 0; i < ALIAS_EVAL.length; i += 1) {
      const item = ALIAS_EVAL[i] as (typeof ALIAS_EVAL)[number];
      lastDb = 0;
      const t = performance.now();
      const p = (await proposeAlias(deps, item.term)) as Extract<AliasProposal, { outcome: "ran" }>;
      const total = performance.now() - t;
      const c = jev.take(); const r = luna.take();
      if ((jev.statuses["401"] ?? 0) > 0 || (luna.statuses["401"] ?? 0) > 0) {
        process.stderr.write(`STOPPED at item ${String(i)}: ${(jev.statuses["401"] ?? 0) > 0 ? "typesafe" : "openai"} answered 401 — the key was refused. Nothing below this line was measured.\n`);
        process.exit(4);
      }
      const target = p.medicineId === null ? undefined : p.shown.find((s) => s.id === p.medicineId);
      const targetKey = target === undefined ? null : compositionKey(target);
      const targetRight = target === undefined ? null : item.want !== null && targetKey === item.want;
      const verdict: Verdict = p.state !== "suggestion" ? "abstained" : targetRight === true ? "right" : "wrong";
      const shownKeys = p.shown.map(compositionKey);
      rows.push({
        i, term: item.term, cat: item.cat, want: item.want,
        shown: p.shown.map((s) => s.name), shownKeys, wantShown: item.want === null ? null : shownKeys.includes(item.want),
        state: p.state, refusal: p.refusal, ruleResult: p.ruleResult, lasaGuard: p.lasaGuard,
        target: target?.name ?? null, targetKey, targetRight, chooser: p.chooser, reviewer: p.reviewer, verdict,
        ms: { candidates: Math.round(lastDb), chooser: c.ms, reviewer: r.ms, total: Math.round(total) },
        tokens: { chooser: c.tokens, reviewer: r.tokens },
      });
      if (p.reviewer !== null && !(ALIAS_REASON_CODES as readonly string[]).includes(p.reviewer.reasonCode)) throw new Error("a reason code outside the closed set reached the result");
      await sleep(PACE_MS);
    }

    const summary = summarise(rows);
    const lines = sweep(rows);
    const zeroWrong = lines.filter((l) => l.wrong === 0).sort((a, b) => b.answered - a.answered)[0] ?? null;
    const refusals: Record<string, number> = {};
    for (const r of rows) if (r.refusal !== null) refusals[r.refusal] = (refusals[r.refusal] ?? 0) + 1;
    const lunaTokens = luna.inputTokens - warm.lunaTokens;
    const out = {
      at: new Date().toISOString(), paceMs: PACE_MS, lines: { chooser: CHOOSER_LINE, reviewer: REVIEWER_LINE },
      models: { chooser: rows.find((r) => r.chooser !== null)?.chooser?.model ?? null, reviewer: rows.find((r) => r.reviewer !== null)?.reviewer?.model ?? null },
      summary, refusals,
      candidateRecall: { labelled: rows.filter((r) => r.want !== null).length, wantAmongShown: rows.filter((r) => r.wantShown === true).length },
      modelsAlone: {
        note: "what chooser and reviewer said above their lines BEFORE the rules, among items whose chooser picked a product",
        agreed: rows.filter((r) => r.chooser !== null && r.reviewer !== null && r.chooser.confidence >= CHOOSER_LINE && r.reviewer.answer === "yes").length,
        agreedWrong: rows.filter((r) => r.chooser !== null && r.reviewer !== null && r.chooser.confidence >= CHOOSER_LINE && r.reviewer.answer === "yes" && r.targetRight !== true).length,
        chooserPicked: rows.filter((r) => r.target !== null).length,
        chooserPickedWrong: rows.filter((r) => r.target !== null && r.targetRight !== true).length,
      },
      sweep: lines, bestZeroWrongLine: zeroWrong,
      latencyMs: {
        perItem: { p50: pct(rows.map((r) => r.ms.total), 50), p90: pct(rows.map((r) => r.ms.total), 90) },
        candidates: { p50: pct(dbMs, 50), p90: pct(dbMs, 90) },
        chooserCall: { p50: pct(jev.ms.slice(warm.jev), 50), p90: pct(jev.ms.slice(warm.jev), 90) },
        reviewerCall: { p50: pct(luna.ms.slice(warm.luna), 50), p90: pct(luna.ms.slice(warm.luna), 90) },
      },
      cost: {
        chooser: { calls: jev.calls - warm.jev, inputTokens: jev.inputTokens - warm.jevTokens, statuses: jev.statuses },
        reviewer: {
          calls: luna.calls - warm.luna, inputTokens: lunaTokens, statuses: luna.statuses,
          usd: Number(((lunaTokens / 1e6) * OPENAI_USD_PER_M_INPUT).toFixed(5)),
          usdPer1000Terms: Number((((lunaTokens / 1e6) * OPENAI_USD_PER_M_INPUT / rows.length) * 1000).toFixed(4)),
        },
      },
      rows,
    };
    process.stdout.write(JSON.stringify(out));
    process.stderr.write(`${JSON.stringify({ summary, refusals, bestZeroWrongLine: zeroWrong, latencyMs: out.latencyMs, cost: out.cost, modelsAlone: out.modelsAlone, candidateRecall: out.candidateRecall }, null, 1)}\n`);
  } finally {
    await pool.end();
  }
}

run().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
