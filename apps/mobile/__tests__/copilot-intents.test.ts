import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";
import { translate } from "../src/i18n";
import { sayParams } from "../src/copilot/model";
import { COPILOT_ANSWER_KEYS, COPILOT_ANSWER_VOICE } from "../../../packages/contracts/src/copilot";

/**
 * #866 (follow-up to #598) — THE PHONE'S COPILOT WORDS COME FROM THE DECLARED SET, not from a list of its own.
 *
 * A module declares its intents (`ModuleManifest.copilotIntents`): their answer keys must be members of
 * `COPILOT_ANSWER_KEYS`, and an intent with `help: true` is named in "I did not understand — you can ask…".
 * The phone renders `t(answer.key)` from a response body, so nothing in its source names those keys. This
 * holds the app's locales to the contract, the param voice to the contract's map, and each module help
 * intent to a word in both languages. (`copilot.test.tsx` keeps the web↔phone sentence parity.)
 */
const lookup = (bundle: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>(
  (node, part) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined), bundle);
const holes = (s: unknown): string[] => (typeof s === "string" ? [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? "").sort() : []);
const t = (lang: "en" | "hi") => (k: string, v?: Record<string, string | number>) => translate(lang, k, v);

describe("#866 — the phone reads the contract's answer keys", () => {
  it("found the contract's key list at all (an empty list would check nothing)", () => {
    expect(COPILOT_ANSWER_KEYS.length).toBeGreaterThan(15);
  });

  it("every contract key has a sentence on the phone in English and Hindi, with the same placeholders", () => {
    const missing = COPILOT_ANSWER_KEYS.filter((k) => typeof lookup(en, k) !== "string" || typeof lookup(hi, k) !== "string");
    expect(missing).toEqual([]);
    const differ = COPILOT_ANSWER_KEYS.filter((k) => holes(lookup(en, k)).join() !== holes(lookup(hi, k)).join());
    expect(differ).toEqual([]);
  });

  it("the phone carries no answer key the contract does not name", () => {
    const declared = new Set<string>(COPILOT_ANSWER_KEYS);
    for (const bundle of [en, hi]) {
      const stray = Object.keys(bundle.copilot.answer).map((k) => `copilot.answer.${k}`).filter((k) => !declared.has(k));
      expect(stray).toEqual([]);
    }
  });
});

describe("#866 — params are said by the contract's voice map", () => {
  it("model.ts holds no answer-key prefix list", () => {
    const src = readFileSync(join(__dirname, "..", "src", "copilot", "model.ts"), "utf8");
    expect(src).not.toMatch(/startsWith\("copilot\.answer\./);
  });

  it("the voice map names only contract keys, and at least the roster's", () => {
    const declared = new Set<string>(COPILOT_ANSWER_KEYS);
    const keys = Object.keys(COPILOT_ANSWER_VOICE);
    expect(keys.filter((k) => !declared.has(k))).toEqual([]);
    expect(keys).toContain("copilot.answer.rosterMyNext");
  });

  it("every key in the map says a day as the boards do; a leave's kind is said as My leave says it", () => {
    for (const [key, voice] of Object.entries(COPILOT_ANSWER_VOICE)) {
      expect([key, sayParams(key, { day: "2026-10-17" }, t("en"), "en").day]).toEqual([key, "Saturday 17 Oct"]);
      expect([key, sayParams(key, { why: "2026-10-17" }, t("en"), "en").why]).toEqual([key, "2026-10-17"]);
      const kind = sayParams(key, { kind: "CL" }, t("en"), "en").kind;
      expect([key, kind]).toEqual([key, voice === "leave" ? translate("en", "myLeave.kind.CL") : "CL"]);
    }
  });

  it("a key outside the map passes its params through untouched", () => {
    // `notUnderstoodCan` has its own rule (the help list), pinned below and in copilot.test.tsx.
    const outside = COPILOT_ANSWER_KEYS.filter((k) => !(k in COPILOT_ANSWER_VOICE) && k !== "copilot.answer.notUnderstoodCan");
    expect(outside.length).toBeGreaterThan(0);
    for (const key of outside) expect(sayParams(key, { day: "2026-10-17", who: "" }, t("en"), "en")).toEqual({ day: "2026-10-17", who: "" });
  });
});

describe("#866 — the help word of every module intent", () => {
  /** Each module's `copilot-intents.ts` entries: `"<module>.<name>": { … help: true … }`. */
  const modulesDir = join(__dirname, "..", "..", "core", "src", "modules");
  const declared = readdirSync(modulesDir)
    .map((m) => join(modulesDir, m, "copilot-intents.ts"))
    .filter((f) => existsSync(f))
    .flatMap((f) => {
      const src = readFileSync(f, "utf8");
      const heads = [...src.matchAll(/^\s+"([a-z_]+\.[a-z_]+)":\s*\{/gm)];
      return heads.map((h, i) => ({ intent: h[1]!, help: /\bhelp:\s*true\b/.test(src.slice(h.index, heads[i + 1]?.index ?? src.length)) }));
    });

  it("found the declarations at all", () => {
    expect(declared.map((d) => d.intent)).toContain("roster.ask_cover");
  });

  it("an intent offered in the help has its word on the phone in both languages, and it is said in the list", () => {
    for (const { intent } of declared.filter((d) => d.help)) {
      for (const lang of ["en", "hi"] as const) {
        const word = translate(lang, `copilot.can.${intent}`);
        expect([intent, lang, word === `copilot.can.${intent}`]).toEqual([intent, lang, false]);
        expect(sayParams("copilot.answer.notUnderstoodCan", { can: `my_day_report,${intent}` }, t(lang), lang).can).toContain(word);
      }
    }
  });
});
