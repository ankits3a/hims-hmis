import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { cdsDeskRoutingFeeds, cdsDeskRoutingOutcomes, opdEncounters } from "../../kernel/db/schema";
import { OpdVisitsController } from "./opd-visits.controller";
import {
  activeRoutingFeed, buildFeed, clearRoutingFeedCache, EXAMPLES_MAX, feedFingerprint, holdoutCases, isHoldoutSentence,
  runDeskRoutingLearning, TAIL_MAX, TAIL_MIN_N,
} from "./desk-routing-feed";
import type { LearnRow } from "./desk-routing-feed";
import { applyRouting } from "./desk-routing";
import { departmentOptions } from "./triage-choice";
import type { RoutingFeed } from "./triage-choice";
import { triageCacheKey, createTriageCache } from "./triage-cache";
import { suggestDepartments } from "./triage";
import type { TriageDepartment } from "./triage";
import { TRIAGE_EVAL_CASES } from "./triage-eval-cases";
import type { ChoiceClient, ChooseInput } from "../../kernel/inference/types";
import type { Db } from "../../kernel/db/client";

/**
 * #614 (plan P3), channels 2 and 3 and the growing held-out set. The desk's model is fed two things
 * learned from completed visits — a vocabulary TAIL after each hand-written description, and a few
 * EXAMPLES mined from corrections — and neither goes live until a nightly evaluation over the
 * held-out visits and the 46 fixed cases says it did not make things worse.
 */

const DEPTS: TriageDepartment[] = [
  { id: "MED", name: "General Medicine" }, { id: "ENT", name: "ENT" }, { id: "PED", name: "Paediatrics" },
  { id: "SUR", name: "General Surgery" },
];

/** The first sentence of `cands` that is NOT held out — the tests need to know which side each lands on. */
function live(cands: string[]): string {
  const s = cands.find((c) => !isHoldoutSentence(c));
  if (s === undefined) throw new Error("no live sentence among the candidates");
  return s;
}
function held(cands: string[]): string {
  const s = cands.find((c) => isHoldoutSentence(c));
  if (s === undefined) throw new Error("no held-out sentence among the candidates");
  return s;
}
const variants = (base: string) => [base, `${base} hai`, `${base} ho rahi`, `${base} bahut`, `${base} kal se`, `abhi ${base}`, `${base} raat ko`, `${base} subah`];

let pid = 0;
function rows(text: string, dept: string, count: number, extra: Partial<LearnRow> = {}): LearnRow[] {
  return Array.from({ length: count }, () => {
    pid += 1;
    return { patientId: `p${String(pid)}`, patientName: "Sita Devi", text, finalDepartmentId: dept, suggested: [dept], holdout: false, ...extra };
  });
}

describe("buildFeed — the vocabulary tail (channel 2)", () => {
  const jalan = live(variants("pet me jalan"));

  it(`a word seen in >= ${String(TAIL_MIN_N)} completed visits, >= 0.8 in one department, joins that department's tail`, () => {
    const feed = buildFeed(rows(jalan, "MED", TAIL_MIN_N), DEPTS);
    expect(feed.tail.MED).toContain("jalan");
    expect(feed.tail.MED).toContain("pet");
    expect(feed.tail.ENT).toBeUndefined();
  });

  it("too few visits, a split word, or too few different patients: nothing", () => {
    expect(buildFeed(rows(jalan, "MED", TAIL_MIN_N - 1), DEPTS).tail.MED).toBeUndefined();
    const split = [...rows(jalan, "MED", 7), ...rows(jalan, "SUR", 3)];
    expect(buildFeed(split, DEPTS).tail.MED).toBeUndefined();
    const onePatient = rows(jalan, "MED", TAIL_MIN_N).map((r) => ({ ...r, patientId: "same" }));
    expect(buildFeed(onePatient, DEPTS).tail.MED).toBeUndefined();
  });

  it("never repeats or rewrites a hand-written word, and never learns filler, numbers or a negated sentence", () => {
    const fever = live(variants("fever aur jalan 3 din"));
    const feed = buildFeed(rows(fever, "MED", TAIL_MIN_N), DEPTS);
    expect(feed.tail.MED).not.toContain("fever"); // already in General Medicine's description
    expect(feed.tail.MED).not.toContain("aur");
    expect(feed.tail.MED).not.toContain("3");
    const negated = live(variants("jalan nahi"));
    expect(buildFeed(rows(negated, "MED", TAIL_MIN_N), DEPTS).tail.MED).toBeUndefined();
  });

  it("the patient's own name never becomes a word, and a held-out sentence never feeds", () => {
    const named = live(variants("Ramesh ko pet me jalan"));
    const feed = buildFeed(rows(named, "MED", TAIL_MIN_N, { patientName: "Ramesh Kumar" }), DEPTS);
    expect(JSON.stringify(feed)).not.toMatch(/ramesh/i);
    const h = held(variants("pet me jalan"));
    expect(buildFeed(rows(h, "MED", TAIL_MIN_N), DEPTS).tail.MED).toBeUndefined();
    // the triage-time flag counts too, even when the visit's words hash to the live side
    expect(buildFeed(rows(jalan, "MED", TAIL_MIN_N, { holdout: true }), DEPTS).tail.MED).toBeUndefined();
  });

  it(`a department's tail is capped at ${String(TAIL_MAX)}`, () => {
    const many = Array.from({ length: TAIL_MAX + 5 }, (_, i) => `zz${String.fromCharCode(97 + i)}word`);
    const all = many.flatMap((w) => rows(live(variants(w)), "MED", TAIL_MIN_N));
    expect(buildFeed(all, DEPTS).tail.MED).toHaveLength(TAIL_MAX);
  });
});

describe("buildFeed — examples mined from corrections (channel 3)", () => {
  const moved = live(variants("gale me kharash"));

  it("a sentence the desk got wrong, corrected the same way at two patients, becomes an example", () => {
    const feed = buildFeed(rows(moved, "ENT", 2, { suggested: ["MED"] }), DEPTS);
    expect(feed.examples.ENT).toEqual([moved]);
  });

  it("a sentence the desk got right, seen once, or a fixed evaluation case is never an example", () => {
    expect(buildFeed(rows(moved, "ENT", 5), DEPTS).examples.ENT).toBeUndefined();
    expect(buildFeed(rows(moved, "ENT", 1, { suggested: ["MED"] }), DEPTS).examples.ENT).toBeUndefined();
    const evalCase = TRIAGE_EVAL_CASES.map(([t]) => t).find((t) => !isHoldoutSentence(t))!;
    expect(buildFeed(rows(evalCase, "ENT", 3, { suggested: ["MED"] }), DEPTS).examples.ENT).toBeUndefined();
  });

  it("a sentence that carried an identifier or more than twelve words is never an example", () => {
    const phone = live(variants("gale me kharash 9876543210"));
    expect(buildFeed(rows(phone, "ENT", 3, { suggested: ["MED"] }), DEPTS).examples.ENT).toBeUndefined();
    const long = live(variants("gale me kharash hai aur khana nigalne me bahut dikkat ho rahi hai kal se"));
    expect(buildFeed(rows(long, "ENT", 3, { suggested: ["MED"] }), DEPTS).examples.ENT).toBeUndefined();
  });

  it(`at most ${String(EXAMPLES_MAX)} examples a department`, () => {
    const all = variants("gale me kharash").filter((s) => !isHoldoutSentence(s)).slice(0, EXAMPLES_MAX + 1);
    expect(all.length).toBe(EXAMPLES_MAX + 1);
    const feed = buildFeed(all.flatMap((s) => rows(s, "ENT", 2, { suggested: ["MED"] })), DEPTS);
    expect(feed.examples.ENT).toHaveLength(EXAMPLES_MAX);
  });
});

describe("the feed reaches the chooser, and only the chooser", () => {
  const feed: RoutingFeed = { tail: { ENT: ["kharash"] }, examples: { ENT: ["gale me kharash"] } };

  it("the hand-written description stays first and whole; the tail is appended; the reason stays hand-written", () => {
    const plain = departmentOptions(DEPTS).options;
    const fed = departmentOptions(DEPTS, feed);
    expect(typeof plain.ENT).toBe("string");
    const ent = fed.options.ENT as { what: string; examples: string[] };
    expect(ent.what.startsWith(plain.ENT as string)).toBe(true);
    expect(ent.what).toContain("kharash");
    expect(ent.examples).toEqual(["gale me kharash"]);
    expect(fed.options["General Medicine"]).toBe(plain["General Medicine"]); // nothing learned for it: unchanged
    expect(fed.reasonOf.get("ENT")).toBe(plain.ENT);
  });

  it("the cache key carries the feed's fingerprint", () => {
    expect(triageCacheKey("x", DEPTS)).toBe(triageCacheKey("x", DEPTS, ""));
    expect(triageCacheKey("x", DEPTS, feedFingerprint(feed))).not.toBe(triageCacheKey("x", DEPTS));
    expect(feedFingerprint({ tail: {}, examples: {} })).toBe("");
  });

  it("a red flag still answers before the chooser is asked; a child still goes to Paediatrics first", async () => {
    const seen: ChooseInput[] = [];
    const client: ChoiceClient = {
      choose: async (input) => {
        seen.push(input);
        return { model: "fake", answers: { department: { choice: "General Medicine", confidence: 0.99, probabilities: { "General Medicine": 0.99 } } } };
      },
    };
    const config = { baseUrl: null, apiKey: null, model: "none", timeoutMs: 1 };
    const flag = await suggestDepartments("saans nahi aa rahi", DEPTS, config, undefined, createTriageCache(), { ageYears: 50 }, { client, minConfidence: 0.6, feed });
    expect(flag.redFlag).toBeDefined();
    expect(seen).toHaveLength(0);
    const ranked = await suggestDepartments("gale me kharash", DEPTS, config, undefined, createTriageCache(), { ageYears: 6 }, { client, minConfidence: 0.6, feed });
    expect(JSON.stringify(seen[0]!.questions)).toContain("kharash");
    const child = applyRouting(ranked, { departments: DEPTS, ageYears: 6, prior: null });
    expect(child.suggestions[0]!.departmentId).toBe("PED");
  });
});

describe("holdoutCases — the growing held-out set", () => {
  it("only held-out visits, masked, deduplicated, each with every department it completed in", () => {
    const h = held(variants("pet me jalan"));
    const l = live(variants("pet me jalan"));
    const cases = holdoutCases([
      ...rows(h, "MED", 2), ...rows(h, "SUR", 1), ...rows(l, "MED", 3),
      ...rows(l, "ENT", 1, { holdout: true }),
    ]);
    const byText = new Map(cases.map((c) => [c.text, c.accept.sort()]));
    expect(byText.get(h)).toEqual(["MED", "SUR"]);
    expect(byText.get(l)).toEqual(["ENT"]);
    expect(cases).toHaveLength(2);
  });
});

/* ═══ the nightly run, against the database ═══ */

const CONFIG = {
  triage: { baseUrl: null, apiKey: null, model: "none", timeoutMs: 1 },
  triageChooserOrder: [],
  triageChoice: { minConfidence: 0.8, model: "none" },
  decisions: { model: "none" },
  openaiKeyFile: null,
  deskRouting: { learningEnabled: true },
} as never;

describe("runDeskRoutingLearning", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let medId: string;
  let ctl: OpdVisitsController;
  const NOW = new Date();

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    clearRoutingFeedCache();
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    medId = m.deptId;
    dra = await mkDoctor(db, { username: "dra", departmentId: medId, roomId: m.roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    ctl = new OpdVisitsController(db, CONFIG);
  });

  /** `count` completed adult visits, each a different patient, whose desk heard `text`. */
  async function visits(text: string, count: number, opts: { holdout?: boolean } = {}) {
    for (let i = 0; i < count; i++) {
      const patientId = (await mkPatient(db, clerk.actor)).id;
      const res = await ctl.walkInRoute(clerk.actor, { patient: { existingId: patientId }, departmentId: medId, doctorId: dra.doctorId }) as { encounter: { id: string } };
      await db.update(opdEncounters).set({ status: "completed", deskComplaint: text, deskComplaintBy: clerk.actor.id, deskComplaintAt: new Date() })
        .where(eq(opdEncounters.id, res.encounter.id));
      await db.insert(cdsDeskRoutingOutcomes).values({
        id: `o-${res.encounter.id}`, triageId: `t-${res.encounter.id}`, encounterId: res.encounter.id, conceptKey: null,
        band: "adult", holdout: opts.holdout ?? false, suggested: [medId], source: "keywords", pickedDepartmentId: medId,
      });
    }
  }

  /** A chooser that answers General Medicine for everything, or by a rule the test gives it. */
  function chooser(answer: (input: ChooseInput) => string | Error = () => "General Medicine") {
    const calls: ChooseInput[] = [];
    const client: ChoiceClient = {
      choose: async (input) => {
        calls.push(input);
        const a = answer(input);
        if (a instanceof Error) throw a;
        return { model: "fake", answers: { department: { choice: a, confidence: 0.99, probabilities: { [a]: 0.99 } } } };
      },
    };
    return { calls, choice: { client, minConfidence: 0.6 } };
  }

  it("nothing learned: an empty version, and not one model call", async () => {
    const c = chooser();
    const report = await runDeskRoutingLearning(db, { enabled: true, chooser: c.choice, now: NOW });
    expect(report.status).toBe("empty");
    expect(c.calls).toHaveLength(0);
    expect(await activeRoutingFeed(db, true)).toBeNull();
  });

  it("switched off: nothing runs and nothing is served", async () => {
    await visits(live(variants("pet me jalan")), TAIL_MIN_N);
    const report = await runDeskRoutingLearning(db, { enabled: false, chooser: chooser().choice, now: NOW });
    expect(report.status).toBe("off");
    expect(await db.select().from(cdsDeskRoutingFeeds)).toHaveLength(0);
  });

  it("learned, evaluated, no worse: it goes live and the desk's chooser is handed it", async () => {
    await visits(live(variants("pet me jalan")), TAIL_MIN_N);
    const c = chooser();
    const report = await runDeskRoutingLearning(db, { enabled: true, chooser: c.choice, now: NOW });
    expect(report.status).toBe("live");
    expect(c.calls.length).toBeGreaterThan(0);
    // every call carried masked text only
    for (const call of c.calls) expect(JSON.stringify(call.state)).not.toMatch(/\d{10}/);
    const served = await activeRoutingFeed(db, true);
    expect(served?.tail[medId]).toContain("jalan");
    clearRoutingFeedCache();
    expect(await activeRoutingFeed(db, false)).toBeNull();
  });

  it("a provider failure promotes nothing; what was live stays live", async () => {
    await visits(live(variants("pet me jalan")), TAIL_MIN_N);
    await runDeskRoutingLearning(db, { enabled: true, chooser: chooser().choice, now: NOW });
    await visits(live(variants("seene me jalan")), TAIL_MIN_N);
    const report = await runDeskRoutingLearning(db, { enabled: true, chooser: chooser(() => new Error("down")).choice, now: NOW });
    expect(report.status).toBe("failed");
    clearRoutingFeedCache();
    const served = await activeRoutingFeed(db, true);
    expect(served?.tail[medId]).toContain("pet");
    expect(served?.tail[medId]).not.toContain("seene");
    const none = await runDeskRoutingLearning(db, { enabled: true, chooser: null, now: NOW });
    expect(none.status).toBe("failed");
  });

  it("worse than the hand-written descriptions on the fixed cases: refused, and the desk falls back to them", async () => {
    await visits(live(variants("pet me jalan")), TAIL_MIN_N);
    // right on the fixed cases only when nothing learned is in the options
    const c = chooser((input) => (JSON.stringify(input.questions).includes("jalan") ? "none of these" : "General Medicine"));
    const report = await runDeskRoutingLearning(db, { enabled: true, chooser: c.choice, now: NOW });
    expect(report.status).toBe("refused");
    expect(report.reason).toBe("floor");
    expect(await activeRoutingFeed(db, true)).toBeNull();
  });

  it("a drop of more than five points against the week's best freezes the learned channels", async () => {
    const jalan = live(variants("pet me jalan"));
    await visits(jalan, TAIL_MIN_N);
    const heldOut = held(variants("pet me jalan"));
    await visits(heldOut, 20, { holdout: true });
    await runDeskRoutingLearning(db, { enabled: true, chooser: chooser().choice, now: new Date(NOW.getTime() - 24 * 3600 * 1000) });
    // tonight the held-out visits are answered wrongly while the fixed cases are unchanged
    const c = chooser((input) => (input.state.complaint === heldOut ? "none of these" : "General Medicine"));
    const report = await runDeskRoutingLearning(db, { enabled: true, chooser: c.choice, now: NOW });
    expect(report.status).toBe("refused");
    expect(report.reason).toBe("weekly_drop");
    clearRoutingFeedCache();
    expect(await activeRoutingFeed(db, true)).toBeNull();
  });
});
