import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChoiceAnswer, ChoiceClient, ChooseInput, ChooseResult } from "../../inference/types";

/**
 * E0.4 — THE COPILOT EVAL SET'S PLUMBING (decision 0064, spec /opt/hmis-context/SPEC-copilot-eval-2026-10-11.md).
 *
 * Shared by the locked test (`../acceptance/copilot-eval.test.ts`) and the recorder
 * (`apps/core/scripts/copilot-eval-record.ts`), so the two cannot disagree about what a recording is
 * keyed by. Nothing here touches the network: the replay chooser only reads `recorded.json`.
 *
 * A RECORDING IS KEYED BY THE EXACT REQUEST. The key is a hash of the `ChooseInput` that `chooseRoute`
 * builds: the masked question, the instructions, and every tool's description. So if a tool's description
 * changes, or a tool is added, every key changes. The test then says "not recorded" and does not replay
 * an answer that was given to a different question.
 *
 * PENDING ITEMS (`pending/*.jsonl`, NOT locked; none today) are for the steward's monthly refresh.
 * The test reports them and does not gate them. To promote one: record it (`copilot-eval-record.ts`),
 * copy it into a NEW `acceptance/eval/items-*.jsonl`, delete it here, and write a new floor with `--floor`.
 */

export type EvalItem = {
  id: string;
  question: string;
  /** A `CopilotIntent`, or `none` when no tool should answer. */
  want: string;
  script: "en" | "hi-latn" | "hi-deva" | "mixed";
  typo: boolean;
  source: string;
};

export type Recording = {
  /** The masked question, for a person reading the file; the key is what matches. */
  question: string;
  model: string;
  at: string;
  source: string;
  /** What the provider answered. Absent when the call failed (`error`), which replays as a failure. */
  answers?: Record<string, ChoiceAnswer>;
  error?: string;
};

export type RecordedFile = { provider: string; recordings: Record<string, Recording> };

export const COPILOT_DIR = join(__dirname, "..");
export const ACCEPTANCE_EVAL_DIR = join(COPILOT_DIR, "acceptance", "eval");
export const PENDING_DIR = join(__dirname, "pending");
export const RECORDED_PATH = join(__dirname, "recorded.json");

/**
 * The placeholders a question contains, each bound to a dummy value. That is how the request looked when
 * it was recorded, and it is why a question naming two patients also carries the "which patient" question.
 * No real value is ever involved: the set is masked text only.
 */
export function slotsFor(question: string): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const m of question.matchAll(/<<P\d+>>/g)) slots[m[0]] = "x";
  return slots;
}

export function requestKey(input: ChooseInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function readJsonl(path: string): EvalItem[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as EvalItem);
}

/** Every `<prefix>*.<ext>` file in a folder, by name, so the order is stable. */
export function filesIn(dir: string, prefix: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort()
    .map((f) => join(dir, f));
}

export function loadRecorded(): RecordedFile {
  if (!existsSync(RECORDED_PATH)) return { provider: "typesafe", recordings: {} };
  return JSON.parse(readFileSync(RECORDED_PATH, "utf8")) as RecordedFile;
}

/**
 * A chooser that answers from the recordings. A request with no recording is NOT turned into a miss:
 * `chooseRoute` swallows every chooser error as "unsure", so a throw alone would quietly lower the
 * score. The missing key is written to `missing`, and the test fails on it.
 */
export function replayChooser(recorded: RecordedFile): { client: ChoiceClient; missing: string[] } {
  const missing: string[] = [];
  const client: ChoiceClient = {
    choose(input: ChooseInput): Promise<ChooseResult> {
      const hit = recorded.recordings[requestKey(input)];
      if (hit === undefined) {
        missing.push(input.state.question ?? "(no question)");
        return Promise.reject(new Error("not recorded"));
      }
      if (hit.answers === undefined) return Promise.reject(new Error(hit.error ?? "recorded failure"));
      return Promise.resolve({ answers: hit.answers, model: hit.model });
    },
  };
  return { client, missing };
}
