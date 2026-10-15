/**
 * THE CHOOSER EVALUATION — TypeSafe's Jev beside OpenAI's Decisions API, on the product's own
 * questions (owner, 2026-10-07: "let's try OpenAI Decision API").
 *
 *   HMIS_EVAL_NETWORK=1 pnpm --filter @hmis/core exec tsx scripts/eval-choosers.ts > /path/out.json
 *
 * It CALLS BOTH PROVIDERS, so it refuses to run without `HMIS_EVAL_NETWORK=1` and is never part of
 * a test run. Keys are read inside this process (`HMIS_OPENAI_KEY_FILE`, and a `TYPESAFE_ENV_FILE`
 * of `NAME=value` lines) and are never printed. It writes JSON on stdout: per provider and set, each
 * item's choice, confidence, latency and usage, on two passes — everything the write-up
 * (`docs/superpowers/plans/2026-10-07-chooser-evaluation.md`) is computed from.
 *
 * Every question goes through the PRODUCT's own functions (`chooseDepartments`, `chooseRoute`), so
 * the instructions, the option set and its descriptions are the ones a clerk's question meets; a
 * recorder wrapped round each client keeps what the model actually returned. Input is checked by
 * `assertNoIdentifiers` exactly as the product's wire is.
 */
import { readFileSync } from "node:fs";
import { chooseRoute } from "../src/kernel/copilot/choice-route";
import { assertNoIdentifiers } from "../src/kernel/copilot/mask";
import { openAiDecisionsClient } from "../src/kernel/inference/openai-decisions";
import { typesafeClient } from "../src/kernel/inference/typesafe";
import type { ChoiceClient, ChooseResult } from "../src/kernel/inference/types";
import { chooseDepartments } from "../src/modules/opd/triage-choice";
import { TRIAGE_EVAL_CASES, TRIAGE_EVAL_DEPTS } from "../src/modules/opd/triage-eval-cases";
import { COPILOT_EVAL, HINGLISH_TRIAGE_EVAL } from "./data/chooser-eval-sets";

if (process.env.HMIS_EVAL_NETWORK !== "1") {
  process.stderr.write("refusing: this calls two outside APIs. Set HMIS_EVAL_NETWORK=1 to run it.\n");
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE_MS = Number(process.env.HMIS_EVAL_PACE_MS ?? "250");
const TIMEOUT_MS = 10_000; // generous on purpose: this MEASURES latency, the product's own timeout would hide the tail

function typesafeKey(): string | null {
  const file = process.env.TYPESAFE_ENV_FILE ?? "/opt/hmis-context/secrets/typesafe.env";
  try {
    const line = readFileSync(file, "utf8").split("\n").find((l) => /^(TRIAGE_TYPESAFE_API_KEY|TYPESAFE_API_KEY)=/.test(l));
    const v = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    return v === undefined || v === "" ? null : v;
  } catch {
    return null;
  }
}
function openaiKey(): string | null {
  try {
    const raw = readFileSync(process.env.HMIS_OPENAI_KEY_FILE ?? "/root/.config/hmis/openai/key.txt", "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

type Usage = { input_tokens?: number };
type Row = { set: string; pass: number; i: number; q: string; want: string[]; choice: string | null; confidence: number | null; top2: [string, number][]; ms: number; error: string | null; inputTokens: number | null; subject?: string | null; wantSubject?: string };

/** A fetch that remembers how long the last call took and what it said it used. */
function meteredFetch(): { fetchImpl: typeof fetch; last: { ms: number; usage: Usage | null; status: number | null } } {
  const last: { ms: number; usage: Usage | null; status: number | null } = { ms: 0, usage: null, status: null };
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const t = performance.now();
    last.usage = null; last.status = null;
    try {
      const res = await fetch(url, init);
      last.status = res.status;
      const clone = res.clone();
      try { last.usage = ((await clone.json()) as { usage?: Usage }).usage ?? null; } catch { /* not json */ }
      return res;
    } finally {
      last.ms = performance.now() - t;
    }
  }) as typeof fetch;
  return { fetchImpl, last };
}

/** Wraps a client so the raw answer survives the product function's own thresholding. */
function recording(client: ChoiceClient): { client: ChoiceClient; taken: () => ChooseResult | null; failed: () => string | null } {
  let kept: ChooseResult | null = null;
  let err: string | null = null;
  return {
    client: {
      choose: async (input) => {
        kept = null; err = null;
        assertNoIdentifiers(JSON.stringify(input));
        try {
          kept = await client.choose(input);
          return kept;
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
          throw e;
        }
      },
    },
    taken: () => kept,
    failed: () => err,
  };
}

const top2 = (p: Record<string, number> | undefined): [string, number][] =>
  Object.entries(p ?? {}).sort(([, a], [, b]) => b - a).slice(0, 2);

async function run(): Promise<void> {
  const providers: { name: string; make: (f: typeof fetch) => ChoiceClient | null }[] = [
    { name: "typesafe", make: (f) => typesafeClient({ baseUrl: "https://api.typesafe.ai/v1", apiKey: typesafeKey(), model: process.env.TYPESAFE_MODEL ?? "jev-1.13.0", timeoutMs: TIMEOUT_MS }, f) },
    { name: "openai", make: (f) => openAiDecisionsClient({ baseUrl: "https://api.openai.com/v1", model: process.env.OPENAI_DECISIONS_MODEL ?? "gpt-6-luna", timeoutMs: TIMEOUT_MS }, openaiKey, f) },
  ];
  const deptName = new Map(TRIAGE_EVAL_DEPTS.map((d) => [d.name, d.id]));
  const triageSets: [string, [string, string[]][]][] = [["triage46", TRIAGE_EVAL_CASES], ["hinglish", HINGLISH_TRIAGE_EVAL]];
  const out: Record<string, Row[]> = {};

  for (const p of providers) {
    const meter = meteredFetch();
    const raw = p.make(meter.fetchImpl);
    if (raw === null) { process.stderr.write(`${p.name}: no key — skipped\n`); continue; }
    const rec = recording(raw);
    const rows: Row[] = [];
    // one throwaway call so the first measured item does not carry the TLS handshake
    try { await rec.client.choose({ state: { complaint: "bukhar" }, questions: { department: { instructions: "Which department?", options: { A: "fever", B: "bones" } } } }); } catch { /* warm-up only */ }

    for (const pass of [1, 2]) {
      for (const [set, cases] of triageSets) {
        for (let i = 0; i < cases.length; i += 1) {
          const [q, want] = cases[i] as [string, string[]];
          await chooseDepartments(q, TRIAGE_EVAL_DEPTS, rec.client, 0);
          const a = rec.taken()?.answers.department;
          rows.push({
            set, pass, i, q, want,
            choice: a === undefined ? null : (deptName.get(a.choice) ?? "NONE"),
            confidence: a?.confidence ?? null,
            top2: top2(a?.probabilities).map(([k, v]) => [deptName.get(k) ?? "NONE", v]),
            ms: Math.round(meter.last.ms), error: rec.failed(), inputTokens: meter.last.usage?.input_tokens ?? null,
          });
          await sleep(PACE_MS);
        }
      }
      for (let i = 0; i < COPILOT_EVAL.length; i += 1) {
        const c = COPILOT_EVAL[i] as (typeof COPILOT_EVAL)[number];
        const slots: Record<string, string> = {};
        for (const m of c.q.matchAll(/<<P\d+>>/g)) slots[m[0]] = "x";
        await chooseRoute(c.q, slots, rec.client, 0);
        const got = rec.taken();
        const a = got?.answers.tool;
        const subject = got?.answers.subject;
        rows.push({
          set: "copilot", pass, i, q: c.q, want: [c.want],
          choice: a?.choice ?? null, confidence: a?.confidence ?? null, top2: top2(a?.probabilities),
          ms: Math.round(meter.last.ms), error: rec.failed(), inputTokens: meter.last.usage?.input_tokens ?? null,
          ...(c.subject === undefined ? {} : { wantSubject: c.subject, subject: subject === undefined || subject.confidence < 0.6 ? null : subject.choice }),
        });
        await sleep(PACE_MS);
      }
    }
    out[p.name] = rows;
    process.stderr.write(`${p.name}: ${String(rows.length)} calls, ${String(rows.filter((r) => r.error !== null).length)} failed\n`);
  }
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), paceMs: PACE_MS, results: out }));
}

run().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
