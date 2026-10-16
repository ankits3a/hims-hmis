import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COPILOT_ANSWER_KEYS } from "@hmis/contracts";
import type { CopilotAnswerKey } from "@hmis/contracts";
import { collectCopilotIntents, helpIntentsFor } from "./catalog";
import { chooseRoute } from "./choice-route";
import { CopilotIntentError, installCopilotIntents, strongCue as S, weakCue as W } from "./intents";
import type { CopilotIntentDecl } from "./intents";
import { intentNames, kernelIntentNames, matchIntent, modelIntentNames } from "./phrasebook";
import { routeQuestion } from "./router";
import { ModuleRegistry } from "../modules/loader";
import { ALL_MANIFESTS } from "../modules/manifests";
import { rosterManifest } from "../../modules/roster";
import type { ChoiceClient, ChooseInput, CompleteInput, InferenceClient } from "../inference/types";
import type { ModuleManifest } from "../modules/manifest";
import type { CopilotToolDecl } from "./types";

/**
 * #598 (plan E0.7) — THE OPEN INTENT SEAM. A module declares its own copilot intents in its manifest
 * (`copilotIntents`): the cues the phrasebook scores, the chooser's and the chat model's menu line, the
 * answer keys it may return, and whether the "I did not understand" help offers it. The kernel collects
 * them at boot and refuses a duplicate intent, a cue another intent already owns, an answer key with no
 * sentence, and an intent outside the module's own namespace.
 */

const registryOf = (manifests: readonly ModuleManifest[]): ModuleRegistry => {
  const r = new ModuleRegistry();
  for (const m of manifests) r.install(m);
  return r;
};

const fixtureIntent = (over: Partial<CopilotIntentDecl> = {}): CopilotIntentDecl => ({
  cues: [S("ring the bell"), S("bell bajao"), W("ghanti")],
  menu: { line: "ring the ward's test bell", what: "ring the ward's TEST bell, nothing else", examples: ["test bell bajao"] },
  answerKeys: ["copilot.answer.actDone"],
  help: true,
  ...over,
});

const fixture = (intents: Record<string, CopilotIntentDecl>, key = "fixturebell"): ModuleManifest => ({
  key, title: key, menu: [], permissions: [], subscriptions: [], copilotIntents: intents,
});

afterEach(() => installCopilotIntents(null));

describe("a module owns its intent: roster.ask_cover moved out of the kernel's lists", () => {
  it("is declared in the roster's manifest and no longer held by the kernel", () => {
    expect(rosterManifest.copilotIntents?.["roster.ask_cover"]).toBeDefined();
    expect(kernelIntentNames()).not.toContain("roster.ask_cover");
    // ...and is still a known intent, on the model's menu, routed exactly as before.
    expect(intentNames()).toContain("roster.ask_cover");
    expect(modelIntentNames()).toContain("roster.ask_cover");
    expect(matchIntent("Saturday night koi le sakta hai kya?")?.intent).toBe("roster.ask_cover");
  });

  it("collects cleanly from every real manifest (the production boot)", () => {
    const got = collectCopilotIntents(registryOf(ALL_MANIFESTS));
    expect(got.map((g) => g.intent)).toContain("roster.ask_cover");
  });

  /*
    THE MENUS ARE BYTE-IDENTICAL TO BEFORE THE MOVE. The chooser's request is pinned by the frozen eval
    set (its recordings are keyed by the request's hash); the chat model's system prompt is pinned here,
    by the hash it had on main before the seam existed.
  */
  it("leaves the chat model's system prompt byte-identical", async () => {
    let system = "";
    const model: InferenceClient = {
      complete: (input: CompleteInput) => { system = input.system; return Promise.resolve({ text: "{\"tool\":\"none\"}" }); },
    };
    await routeQuestion("hello there", {}, model);
    expect(createHash("sha256").update(system).digest("hex")).toBe(SYSTEM_PROMPT_SHA);
  });
});

const SYSTEM_PROMPT_SHA = "f87e648b0c8d1996122b359dbe7b95a302907e08c14afc6155952bcb2b65766c";

describe("a fixture module's new intent is routed, menued and offered", () => {
  const install = (): void => {
    installCopilotIntents(collectCopilotIntents(registryOf([...ALL_MANIFESTS, fixture({ "fixturebell.ring": fixtureIntent() })])));
  };

  it("the phrasebook routes it, and every existing intent still routes", () => {
    install();
    expect(matchIntent("test bell bajao abhi")?.intent).toBe("fixturebell.ring");
    expect(matchIntent("Saturday night koi le sakta hai kya?")?.intent).toBe("roster.ask_cover");
    expect(matchIntent("kitna wait hai")?.intent).toBe("queue_depth");
    expect(intentNames()).toContain("fixturebell.ring");
  });

  it("appears in the chooser's menu with its description, before `none`, and can be chosen", async () => {
    install();
    let sent: ChooseInput | null = null;
    const chooser: ChoiceClient = {
      choose: (input) => {
        sent = input;
        return Promise.resolve({ answers: { tool: { choice: "fixturebell.ring", confidence: 0.9, probabilities: {} } }, model: "fake" });
      },
    };
    const picked = await chooseRoute("something unusual", {}, chooser, 0.6);
    expect(picked).toMatchObject({ intent: "fixturebell.ring", via: "chooser" });
    const options = Object.keys((sent as ChooseInput | null)?.questions.tool?.options ?? {});
    expect(options.slice(-2)).toEqual(["fixturebell.ring", "none"]);
    expect((sent as ChooseInput | null)?.questions.tool?.options["fixturebell.ring"])
      .toEqual({ what: "ring the ward's TEST bell, nothing else", examples: ["test bell bajao"] });
  });

  it("appears in the chat model's menu and is accepted from it", async () => {
    install();
    let system = "";
    const model: InferenceClient = {
      complete: (input: CompleteInput) => { system = input.system; return Promise.resolve({ text: "{\"tool\":\"fixturebell.ring\"}" }); },
    };
    expect((await routeQuestion("something unusual", {}, model))?.intent).toBe("fixturebell.ring");
    expect(system).toContain("fixturebell.ring — ring the ward's test bell");
  });

  it("a declared intent with no menu is floor-only: never offered to a model", () => {
    installCopilotIntents(collectCopilotIntents(registryOf([...ALL_MANIFESTS, fixture({ "fixturebell.ring": fixtureIntent({ menu: undefined }) })])));
    expect(intentNames()).toContain("fixturebell.ring");
    expect(modelIntentNames()).not.toContain("fixturebell.ring");
  });

  it("the help sentence offers it after the kernel's own, to an asker its tool admits", async () => {
    install();
    const tools = ["visit_status", "fixturebell.ring"].map((intent) => ({ intent, permission: null, needsSubject: false } as unknown as CopilotToolDecl));
    expect(await helpIntentsFor(tools, () => Promise.resolve(true))).toEqual(["visit_status", "fixturebell.ring"]);
  });
});

describe("every real module intent is said in both of the web's languages", () => {
  /*
    The boot check's witness is the contract's closed set (the core image carries no locale files);
    this is the same fact read from the sentences themselves, plus the help word a `help` intent needs.
  */
  const bundle = (lang: string): unknown => JSON.parse(readFileSync(join(__dirname, `../../../../web/src/locales/${lang}.json`), "utf8"));
  const lookup = (b: unknown, dotted: string): unknown =>
    dotted.split(".").reduce<unknown>((n, p) => (typeof n === "object" && n !== null ? (n as Record<string, unknown>)[p] : undefined), b);
  const collected = collectCopilotIntents(registryOf(ALL_MANIFESTS));
  const keys = collected.flatMap((c) => [...c.decl.answerKeys]);
  const helpWords = collected.filter((c) => c.decl.help === true).map((c) => `copilot.can.${c.intent}`);

  it("found the declared answer keys at all", () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it.each(["en", "hi"])("%s carries every declared answer key and help word", (lang) => {
    const b = bundle(lang);
    expect([...keys, ...helpWords].filter((k) => typeof lookup(b, k) !== "string")).toEqual([]);
  });
});

describe("boot refuses a bad intent declaration", () => {
  const refuses = (manifests: ModuleManifest[], code: string, msg: RegExp): void => {
    const reg = registryOf([...ALL_MANIFESTS.filter((m) => manifests.every((f) => f.key !== m.key)), ...manifests]);
    let err: unknown = null;
    try { collectCopilotIntents(reg); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CopilotIntentError);
    expect((err as CopilotIntentError).code).toBe(code);
    expect((err as Error).message).toMatch(msg);
  };

  it("a duplicate intent key — one the kernel already holds", () => {
    refuses([{ ...rosterManifest, copilotIntents: { ...rosterManifest.copilotIntents, "roster.who_is_on": fixtureIntent() } }], "duplicate_intent", /roster\.who_is_on/);
  });

  it("a cue another intent already owns — the kernel's or another module's", () => {
    refuses([fixture({ "fixturebell.ring": fixtureIntent({ cues: [S("payment run")] }) })], "cue_collision", /payment run/);
    refuses([
      fixture({ "fixturebell.ring": fixtureIntent() }),
      fixture({ "fixturegong.ring": fixtureIntent({ cues: [S("gong"), W("Bell  Bajao")] }) }, "fixturegong"),
    ], "cue_collision", /bell bajao/);
  });

  it("an answer key with no sentence", () => {
    refuses([fixture({ "fixturebell.ring": fixtureIntent({ answerKeys: ["copilot.answer.fixtureBellRang" as CopilotAnswerKey] }) })],
      "untranslated_answer_key", /copilot\.answer\.fixtureBellRang/);
    expect(COPILOT_ANSWER_KEYS as readonly string[]).not.toContain("copilot.answer.fixtureBellRang");
  });

  it("an intent outside the module's own namespace", () => {
    refuses([fixture({ ring_bell: fixtureIntent() })], "intent_namespace", /ring_bell/);
  });
});
