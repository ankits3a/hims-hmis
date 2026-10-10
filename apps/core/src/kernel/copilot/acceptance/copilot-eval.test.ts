import { readFileSync } from "node:fs";
import { assertNoIdentifiers } from "../mask";
import { intentNames } from "../phrasebook";
import { routeQuestion } from "../router";
import {
  ACCEPTANCE_EVAL_DIR,
  type EvalItem,
  PENDING_DIR,
  filesIn,
  loadRecorded,
  readJsonl,
  replayChooser,
  slotsFor,
} from "../eval/replay";

/**
 * ═══ E0.4 — THE FROZEN HINGLISH EVAL SET (decision 0064, goal G3c; owner approved 2026-10-11) ═══
 *
 * Spec: /opt/hmis-context/SPEC-copilot-eval-2026-10-11.md. This file and everything under
 * `acceptance/eval/` is LOCKED once merged (tools/ci/acceptance-guard.mjs): ADD new files, never edit one.
 *
 *   items-*.jsonl   the questions, masked, each with the tool that should answer it (append a new file monthly)
 *   retired-*.json  ids taken out of scoring, as a JSON array (append a new file; never delete an item)
 *   floor-*.json    the ids that routed right on the day it was written; each one must keep routing right
 *
 * "Routed right" is the production path with the chat model off: the phrasebook, then the chooser in the
 * default COPILOT_CHOOSER_ORDER (typesafe), answered from `eval/recorded.json` at the default line 0.6
 * (COPILOT_TYPESAFE_MIN_CONFIDENCE). For `none`, the right answer is that no tool is chosen.
 *
 * NONE OF THESE QUESTIONS MAY EVER BECOME AN EXAMPLE shown to a model (`choice-route.ts` CRITERIA, the
 * phrasebook's cues written from them). They are held out; an example copied from here makes the score a lie.
 */

const LINE = 0.6;
const TARGET = 0.9;

type Floor = { asOf: string; routedRightIds: string[]; phrasebookOnlyIds: string[] };

const items: EvalItem[] = filesIn(ACCEPTANCE_EVAL_DIR, "items-", ".jsonl").flatMap(readJsonl);
const retired = new Set(
  filesIn(ACCEPTANCE_EVAL_DIR, "retired-", ".json").flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as string[]),
);
const floors: Floor[] = filesIn(ACCEPTANCE_EVAL_DIR, "floor-", ".json").map((f) => JSON.parse(readFileSync(f, "utf8")) as Floor);
const pending: EvalItem[] = filesIn(PENDING_DIR, "", ".jsonl").flatMap(readJsonl);
const scored = items.filter((i) => !retired.has(i.id));

type Outcome = { item: EvalItem; phrasebook: string; routed: string };

async function run(set: EvalItem[]): Promise<{ outcomes: Outcome[]; missing: string[] }> {
  const replay = replayChooser(loadRecorded());
  const outcomes: Outcome[] = [];
  for (const item of set) {
    const slots = slotsFor(item.question);
    const floor = await routeQuestion(item.question, slots, null, null);
    const full = await routeQuestion(item.question, slots, null, replay.client, LINE);
    outcomes.push({ item, phrasebook: floor?.intent ?? "none", routed: full?.intent ?? "none" });
  }
  return { outcomes, missing: replay.missing };
}

const pct = (a: number, b: number): string => `${a}/${b} (${b === 0 ? 0 : Math.round((1000 * a) / b) / 10}%)`;

describe("E0.4 copilot eval set — the items themselves", () => {
  it("has items, and every id is unique across the set and the pending files", () => {
    expect(items.length).toBeGreaterThan(0);
    const ids = [...items, ...pending].map((i) => i.id);
    expect(ids.filter((id, n) => ids.indexOf(id) !== n)).toEqual([]);
  });

  it("expects only tools the router knows, or none", () => {
    const known = new Set<string>([...intentNames(), "none"]);
    expect([...items, ...pending].filter((i) => !known.has(i.want)).map((i) => `${i.id} ${i.want}`)).toEqual([]);
  });

  it("carries no identifier the masker's last gate would refuse", () => {
    const leaks = [...items, ...pending].filter((i) => {
      try {
        assertNoIdentifiers(i.question);
        return false;
      } catch {
        return true;
      }
    });
    expect(leaks.map((i) => i.id)).toEqual([]);
  });
});

describe("E0.4 copilot eval set — routing", () => {
  let result: { outcomes: Outcome[]; missing: string[] };
  beforeAll(async () => {
    result = await run(scored);
  });

  it("has a recorded chooser answer for every item (no network in CI)", () => {
    if (result.missing.length > 0) {
      throw new Error(`not recorded: run copilot-eval-record (apps/core/scripts/copilot-eval-record.ts)\n  ${result.missing.join("\n  ")}`);
    }
  });

  it("reports the score against G3(c)", () => {
    const n = result.outcomes.length;
    const right = result.outcomes.filter((o) => o.routed === o.item.want).length;
    const pbRight = result.outcomes.filter((o) => o.phrasebook === o.item.want).length;
    const wrong = result.outcomes.filter((o) => o.routed !== "none" && o.routed !== o.item.want).length;
    console.log(
      `routed right ${pct(right, n)} · phrasebook-only ${pct(pbRight, n)} · confident-wrong ${wrong}` +
        ` · G3(c) target ${TARGET * 100}%: ${right / n >= TARGET ? "met" : "not yet met"}`,
    );
    expect(n).toBeGreaterThan(0);
  });

  it("has a floor to hold", () => {
    expect(floors.length).toBeGreaterThan(0);
  });

  it("keeps every item a floor says routed right routing right (phrasebook + recorded chooser)", () => {
    const by = new Map(result.outcomes.map((o) => [o.item.id, o]));
    const fell = floors
      .flatMap((f) => f.routedRightIds)
      .filter((id) => !retired.has(id))
      .map((id) => by.get(id))
      .filter((o): o is Outcome => o !== undefined && o.routed !== o.item.want);
    expect(fell.map((o) => `${o.item.id} "${o.item.question}" want ${o.item.want} got ${o.routed}`)).toEqual([]);
  });

  it("keeps every item a floor says the phrasebook routed right routing right on the phrasebook alone", () => {
    const by = new Map(result.outcomes.map((o) => [o.item.id, o]));
    const fell = floors
      .flatMap((f) => f.phrasebookOnlyIds)
      .filter((id) => !retired.has(id))
      .map((id) => by.get(id))
      .filter((o): o is Outcome => o !== undefined && o.phrasebook !== o.item.want);
    expect(fell.map((o) => `${o.item.id} "${o.item.question}" want ${o.item.want} got ${o.phrasebook}`)).toEqual([]);
  });

  it("names every floor id that is not in the set (a floor cannot point at nothing)", () => {
    const ids = new Set(items.map((i) => i.id));
    expect(floors.flatMap((f) => [...f.routedRightIds, ...f.phrasebookOnlyIds]).filter((id) => !ids.has(id))).toEqual([]);
  });
});

describe("E0.4 copilot eval set — pending items (reported, not gated)", () => {
  it("reports how the pending items route today", async () => {
    const { outcomes, missing } = await run(pending);
    const n = outcomes.length;
    const pb = outcomes.filter((o) => o.phrasebook === o.item.want).length;
    const recordedRight = outcomes.filter((o) => o.routed === o.item.want).length;
    console.log(
      `pending ${n}: phrasebook-only ${pct(pb, n)} · with recordings ${pct(recordedRight, n)} · not yet recorded ${missing.length}`,
    );
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
