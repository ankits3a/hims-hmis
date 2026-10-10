/**
 * E0.4 — RECORD THE CHOOSER'S ANSWERS FOR THE COPILOT EVAL SET, OR WRITE A NEW FLOOR.
 *
 *   HMIS_EVAL_NETWORK=1 pnpm --filter @hmis/core exec tsx scripts/copilot-eval-record.ts          # record what is missing
 *   HMIS_EVAL_NETWORK=1 pnpm --filter @hmis/core exec tsx scripts/copilot-eval-record.ts --all    # re-record everything
 *   pnpm --filter @hmis/core exec tsx scripts/copilot-eval-record.ts --floor                      # offline: write acceptance/eval/floor-<today>.json
 *
 * Recording CALLS THE OPENAI DECISIONS API (owner 2026-10-11: "Use OpenAI decision API for this"), so it
 * refuses to run without `HMIS_EVAL_NETWORK=1`. It runs on the dev box and never in CI. The key is read
 * by the product's own `openAiKeyFromFile` from `HMIS_OPENAI_KEY_FILE` and is never printed. Recording
 * OpenAI alone is deliberate: it is the copilot's first chooser (`COPILOT_CHOOSER_ORDER` default
 * `openai,typesafe`), and the TypeSafe fallback is not replayed, so the score is a floor under production.
 * Every question goes through the product's own
 * `chooseRoute`, so the request recorded is byte for byte the one the test replays. That covers the items
 * under `acceptance/eval/` and the pending ones under `eval/pending/`.
 *
 * `--floor` is offline. It replays the recordings through `routeQuestion`, exactly as the locked test does,
 * and writes the ids that route right today. It refuses if any item is unrecorded. Add the file it writes;
 * never edit an older floor file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chooseRoute } from "../src/kernel/copilot/choice-route";
import {
  ACCEPTANCE_EVAL_DIR,
  PENDING_DIR,
  RECORDED_PATH,
  type EvalItem,
  filesIn,
  loadRecorded,
  readJsonl,
  replayChooser,
  requestKey,
  slotsFor,
} from "../src/kernel/copilot/eval/replay";
import { assertNoIdentifiers } from "../src/kernel/copilot/mask";
import { routeQuestion } from "../src/kernel/copilot/router";
import { openAiDecisionsClient } from "../src/kernel/inference/openai-decisions";
import { openAiKeyFromFile } from "../src/kernel/inference/openai-speech";

const LINE = 0.6;
const accepted: EvalItem[] = filesIn(ACCEPTANCE_EVAL_DIR, "items-", ".jsonl").flatMap(readJsonl);
const pending: EvalItem[] = filesIn(PENDING_DIR, "", ".jsonl").flatMap(readJsonl);
const retired = new Set(
  filesIn(ACCEPTANCE_EVAL_DIR, "retired-", ".json").flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as string[]),
);

/** A fetch that adds up what each response says it used, so a run can report its own size. */
const usage = { input: 0, output: 0 };
const meteredFetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const res = await fetch(url, init);
  try {
    const u = ((await res.clone().json()) as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    usage.input += u?.input_tokens ?? 0;
    usage.output += u?.output_tokens ?? 0;
  } catch {
    /* not json */
  }
  return res;
}) as typeof fetch;

async function record(all: boolean): Promise<void> {
  if (process.env.HMIS_EVAL_NETWORK !== "1") {
    process.stderr.write("refusing: recording calls the OpenAI Decisions API. Set HMIS_EVAL_NETWORK=1 to run it.\n");
    process.exit(2);
  }
  const keyFile = process.env.HMIS_OPENAI_KEY_FILE ?? "/root/.config/hmis/openai/key.txt";
  const model = process.env.OPENAI_DECISIONS_MODEL ?? "gpt-6-luna";
  const live = openAiDecisionsClient(
    { baseUrl: process.env.OPENAI_DECISIONS_BASE_URL ?? "https://api.openai.com/v1", model, timeoutMs: 10_000 },
    () => openAiKeyFromFile(keyFile),
    meteredFetch,
  );
  if (live === null) {
    process.stderr.write("no OpenAI key could be read (HMIS_OPENAI_KEY_FILE) — nothing recorded\n");
    process.exit(2);
  }
  const file = loadRecorded();
  if (file.provider !== "openai") file.recordings = {};
  let made = 0;
  let failed = 0;
  for (const item of [...accepted, ...pending]) {
    await chooseRoute(item.question, slotsFor(item.question), {
      choose: async (input) => {
        assertNoIdentifiers(JSON.stringify(input));
        const key = requestKey(input);
        if (!all && file.recordings[key] !== undefined) throw new Error("already recorded");
        const base = { question: item.question, model, at: new Date().toISOString(), source: "copilot-eval-record.ts" };
        try {
          const out = await live.choose(input);
          file.recordings[key] = { ...base, model: out.model, answers: out.answers };
          made += 1;
          return out;
        } catch (e) {
          file.recordings[key] = { ...base, error: e instanceof Error ? e.message : String(e) };
          failed += 1;
          throw e;
        }
      },
    }, LINE);
    await new Promise((r) => setTimeout(r, 250));
  }
  const sorted = Object.fromEntries(Object.entries(file.recordings).sort(([, a], [, b]) => a.question.localeCompare(b.question)));
  writeFileSync(RECORDED_PATH, `${JSON.stringify({ provider: "openai", recordings: sorted }, null, 1)}\n`);
  process.stderr.write(
    `recorded ${String(made)}, failed ${String(failed)}; ${String(Object.keys(sorted).length)} in ${RECORDED_PATH}; ` +
      `usage: ${String(usage.input)} input tokens, ${String(usage.output)} output tokens\n`,
  );
}

async function floor(): Promise<void> {
  const replay = replayChooser(loadRecorded());
  const routedRightIds: string[] = [];
  const phrasebookOnlyIds: string[] = [];
  const scored = accepted.filter((i) => !retired.has(i.id));
  for (const item of scored) {
    const slots = slotsFor(item.question);
    const pb = await routeQuestion(item.question, slots, null, null);
    const full = await routeQuestion(item.question, slots, null, replay.client, LINE);
    if ((pb?.intent ?? "none") === item.want) phrasebookOnlyIds.push(item.id);
    if ((full?.intent ?? "none") === item.want) routedRightIds.push(item.id);
  }
  if (replay.missing.length > 0) {
    process.stderr.write(`refusing: ${String(replay.missing.length)} item(s) not recorded — record first\n`);
    process.exit(1);
  }
  const asOf = new Date().toISOString().slice(0, 10);
  /*
    A second floor on the same day (#672: a cue fix landed the day the set was frozen) takes the next free
    suffix, `floor-<day>-2.json`, rather than refusing: the older file is never touched either way.
  */
  let path = join(ACCEPTANCE_EVAL_DIR, `floor-${asOf}.json`);
  for (let n = 2; existsSync(path); n += 1) path = join(ACCEPTANCE_EVAL_DIR, `floor-${asOf}-${String(n)}.json`);
  const body = { asOf, n: scored.length, routedRight: routedRightIds.length, phrasebookOnly: phrasebookOnlyIds.length, routedRightIds, phrasebookOnlyIds };
  writeFileSync(path, `${JSON.stringify(body, null, 1)}\n`, { flag: "wx" }); // never overwrite a floor
  process.stderr.write(`wrote ${path}: routed right ${String(body.routedRight)}/${String(body.n)}, phrasebook-only ${String(body.phrasebookOnly)}/${String(body.n)}\n`);
}

(process.argv.includes("--floor") ? floor() : record(process.argv.includes("--all"))).catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
