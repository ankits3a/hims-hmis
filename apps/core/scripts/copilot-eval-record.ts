/**
 * E0.4 — RECORD THE CHOOSER'S ANSWERS FOR THE COPILOT EVAL SET, OR WRITE A NEW FLOOR.
 *
 *   HMIS_EVAL_NETWORK=1 pnpm --filter @hmis/core exec tsx scripts/copilot-eval-record.ts          # record what is missing
 *   HMIS_EVAL_NETWORK=1 pnpm --filter @hmis/core exec tsx scripts/copilot-eval-record.ts --all    # re-record everything
 *   pnpm --filter @hmis/core exec tsx scripts/copilot-eval-record.ts --floor                      # offline: write acceptance/eval/floor-<today>.json
 *
 * Recording CALLS TYPESAFE, so it refuses to run without `HMIS_EVAL_NETWORK=1`. It runs on the dev box
 * and never in CI. The key is read in this process from `TYPESAFE_ENV_FILE` (a `NAME=value` file, as
 * `eval-choosers.ts` reads it) and is never printed. Every question goes through the product's own
 * `chooseRoute`, so the request recorded is byte for byte the one the test replays. That covers the items
 * under `acceptance/eval/` and the pending ones under `eval/pending/`.
 *
 * `--floor` is offline. It replays the recordings through `routeQuestion`, exactly as the locked test does,
 * and writes the ids that route right today. It refuses if any item is unrecorded. Add the file it writes;
 * never edit an older floor file.
 */
import { readFileSync, writeFileSync } from "node:fs";
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
import { typesafeClient } from "../src/kernel/inference/typesafe";

const LINE = 0.6;
const accepted: EvalItem[] = filesIn(ACCEPTANCE_EVAL_DIR, "items-", ".jsonl").flatMap(readJsonl);
const pending: EvalItem[] = filesIn(PENDING_DIR, "", ".jsonl").flatMap(readJsonl);
const retired = new Set(
  filesIn(ACCEPTANCE_EVAL_DIR, "retired-", ".json").flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as string[]),
);

function typesafeKey(): string | null {
  const file = process.env.TYPESAFE_ENV_FILE ?? "/opt/hmis-context/secrets/typesafe.env";
  try {
    const line = readFileSync(file, "utf8").split("\n").find((l) => /^(COPILOT_TYPESAFE_API_KEY|TRIAGE_TYPESAFE_API_KEY|TYPESAFE_API_KEY)=/.test(l));
    const v = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    return v === undefined || v === "" ? null : v;
  } catch {
    return null;
  }
}

async function record(all: boolean): Promise<void> {
  if (process.env.HMIS_EVAL_NETWORK !== "1") {
    process.stderr.write("refusing: recording calls TypeSafe. Set HMIS_EVAL_NETWORK=1 to run it.\n");
    process.exit(2);
  }
  const model = process.env.COPILOT_TYPESAFE_MODEL ?? "jev-1.13.0";
  const live = typesafeClient({ baseUrl: "https://api.typesafe.ai/v1", apiKey: typesafeKey(), model, timeoutMs: 10_000 });
  if (live === null) {
    process.stderr.write("no TypeSafe key found (TYPESAFE_ENV_FILE) — nothing recorded\n");
    process.exit(2);
  }
  const file = loadRecorded();
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
  writeFileSync(RECORDED_PATH, `${JSON.stringify({ provider: "typesafe", recordings: sorted }, null, 1)}\n`);
  process.stderr.write(`recorded ${String(made)}, failed ${String(failed)}; ${String(Object.keys(sorted).length)} in ${RECORDED_PATH}\n`);
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
  const path = join(ACCEPTANCE_EVAL_DIR, `floor-${asOf}.json`);
  const body = { asOf, n: scored.length, routedRight: routedRightIds.length, phrasebookOnly: phrasebookOnlyIds.length, routedRightIds, phrasebookOnlyIds };
  writeFileSync(path, `${JSON.stringify(body, null, 1)}\n`, { flag: "wx" }); // never overwrite a floor
  process.stderr.write(`wrote ${path}: routed right ${String(body.routedRight)}/${String(body.n)}, phrasebook-only ${String(body.phrasebookOnly)}/${String(body.n)}\n`);
}

(process.argv.includes("--floor") ? floor() : record(process.argv.includes("--all"))).catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
