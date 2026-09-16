import {
  agentFileSchema, agentProposals, parseBasisStatements, planReleaseDrafts, sharesStem, stripSemanticTag,
} from "../scripts/draft-substance-mappings";

/**
 * THE DRAFTER'S RELEASE HALF, OVER NAMES COPIED FROM `nrces-2026-09`.
 *
 * Every clinical-drug string below is verbatim from the national release (its sctid is beside it).
 * The parser's job is to read what the release says, and the release says it in two grammars (the
 * SNOMED fully specified name and a shorter trade form), and sometimes says it wrong.
 */
describe("parseBasisStatements — reading \"BASE (as INGREDIENT)\" out of a release name", () => {
  const cases: [string, string, { base: string; ingredient: string; droppedWord: string | null }[]][] = [
    [
      "2826761000189105 · a fully specified name, two components",
      "Product containing precisely amoxicillin (as amoxicillin trihydrate) 500 milligram and clavulanic acid (as clavulanate potassium) 125 milligram/1 each conventional release oral tablet (clinical drug)",
      [
        { base: "amoxicillin", ingredient: "amoxicillin trihydrate", droppedWord: null },
        { base: "clavulanic acid", ingredient: "clavulanate potassium", droppedWord: null },
      ],
    ],
    [
      "2310621000189100 · the base after an ' and ', with plain components between",
      "Product containing precisely bromhexine (as bromhexine hydrochloride) 4 milligram/5 milliliter and Guaifenesin 50 milligram/5 milliliter and Terbutaline (as terbutaline sulfate) 1.25 milligram/5 milliliter conventional release oral solution (clinical drug)",
      [
        { base: "bromhexine", ingredient: "bromhexine hydrochloride", droppedWord: null },
        { base: "terbutaline", ingredient: "terbutaline sulfate", droppedWord: null },
      ],
    ],
    [
      "2484551000189108 · the release's short form: the base starts the name",
      "Amlodipine (as amlodipine besylate) 5 mg and Bisoprolol fumarate 5 mg oral tablet",
      [{ base: "amlodipine", ingredient: "amlodipine besylate", droppedWord: null }],
    ],
    [
      "2500751000189102 · plain components before the statement are not part of its base",
      "Product containing precisely camphor 10 microgram/1 milliliter and Menthol 50 microgram/1 milliliter and Naphazoline (as naphazoline hydrochloride) 500 microgram/1 milliliter and Phenylephrine hydrochloride 1200 microgram/1 milliliter",
      [{ base: "naphazoline", ingredient: "naphazoline hydrochloride", droppedWord: null }],
    ],
    [
      "786023002 · a hydrate word dropped leaves the base equal to its ingredient: not a statement",
      "Product containing precisely levofloxacin anhydrous (as levofloxacin) 5 milligram/1 milliliter conventional release eye solution (clinical drug)",
      [],
    ],
    [
      "2737941000189108 · one real statement, one reversed",
      "Avibactam (as avibactam sodium) 250 mg and Ceftazidime anhydrous (as ceftazidime) 1 g powder for solution for injection vial",
      [{ base: "avibactam", ingredient: "avibactam sodium", droppedWord: null }],
    ],
    [
      "1240358000 · a parenthesised base is skipped, not guessed",
      "Levamlodipine (as levamlodipine besilate) 2.5 mg and (S)-metoprolol tartrate (as (S)-metoprolol succinate) 25 mg conventional release and prolonged-release oral tablet",
      [{ base: "levamlodipine", ingredient: "levamlodipine besilate", droppedWord: null }],
    ],
  ];

  it.each(cases)("%s", (_label, name, expected) => {
    expect(parseBasisStatements(name)).toEqual(expected);
  });

  it("drops a hydrate word from a base that differs from its ingredient, and says which", () => {
    expect(parseBasisStatements("Ceftriaxone anhydrous (as ceftriaxone sodium) 1 g powder for injection vial"))
      .toEqual([{ base: "ceftriaxone", ingredient: "ceftriaxone sodium", droppedWord: "anhydrous" }]);
  });
});

describe("sharesStem — the check that catches the release misaligning its own components", () => {
  it.each([
    ["amoxicillin", "amoxicillin trihydrate", true],
    ["clavulanic acid", "clavulanate potassium", true],
    ["clavulanic acid", "potassium clavulanate", true],
    ["amoxycillin", "amoxicillin trihydrate", true],
    ["menthol", "guaifenesin", false],
    ["terbutaline", "menthol", false],
  ])("%s / %s → %s", (base, ingredient, expected) => {
    expect(sharesStem(base, ingredient)).toBe(expected);
  });
});

describe("planReleaseDrafts", () => {
  const amox = { sctid: "372687004", name: "Amoxicillin", synonyms: ["Amoxicillin (substance)"] };
  const amoxTri = { sctid: "96068000", name: "Amoxicillin trihydrate (substance)", synonyms: ["Amoxicillin trihydrate"] };
  const clav = { sctid: "395938000", name: "Clavulanate potassium (substance)", synonyms: ["Potassium clavulanate", "Clavulanate potassium"] };
  const warfNa = { sctid: "63167009", name: "Warfarin sodium (substance)", synonyms: ["Warfarin sodium"] };
  const guaif = { sctid: "87174009", name: "Guaifenesin (substance)", synonyms: ["Guaifenesin"] };
  const menthol = { sctid: "34165005", name: "Menthol", synonyms: [] };
  const augmentin = (sctid: string) => ({
    sctid,
    name: "Product containing precisely amoxicillin (as amoxicillin trihydrate) 500 milligram and clavulanic acid (as clavulanate potassium) 125 milligram/1 each conventional release oral tablet (clinical drug)",
    substanceSctids: [amoxTri.sctid, clav.sctid],
  });

  it("drafts the base the release names, and treats a named base as its own moiety", () => {
    const plan = planReleaseDrafts([amox, amoxTri, clav, warfNa], [
      augmentin("2826761000189105"),
      { sctid: "374646004", name: "Amoxicillin 500 mg oral capsule", substanceSctids: [amox.sctid] },
      {
        sctid: "375377009",
        name: "Product containing precisely warfarin sodium 5 milligram/1 each conventional release oral tablet (clinical drug)",
        substanceSctids: [warfNa.sctid],
      },
    ]);

    expect(plan.proposals.map((p) => [p.sctid, p.moietyName, p.basis])).toEqual([
      [amox.sctid, "Amoxicillin", "release_base"],
      [amoxTri.sctid, "amoxicillin", "release_boss"],
      [clav.sctid, "clavulanic acid", "release_boss"],
      // Warfarin sodium: strength stated AS the salt is not evidence of being a moiety. No draft.
    ]);
    expect(plan.report).toMatchObject({ releaseBoss: 2, releaseBase: 1, contested: 0 });
  });

  it("takes the majority where the release disagrees with itself, and carries the dissent", () => {
    const plan = planReleaseDrafts([amoxTri, clav], [
      augmentin("A1"),
      augmentin("A2"),
      {
        sctid: "A3",
        name: "Amoxycillin (as amoxicillin trihydrate) 250 mg oral capsule",
        substanceSctids: [amoxTri.sctid],
      },
    ]);

    const draft = plan.proposals.find((p) => p.sctid === amoxTri.sctid);
    expect(draft?.moietyName).toBe("amoxicillin");
    expect(draft?.evidence).toMatchObject({ support: 2, alternatives: [{ name: "amoxycillin", support: 1 }] });
    expect(draft?.evidence.generics?.map((g) => g.sctid)).toEqual(["A1", "A2"]);
    expect(plan.report.contested).toBe(1);
  });

  it("ignores a statement naming a substance its own generic does not contain, and one the release misaligned", () => {
    const plan = planReleaseDrafts([amoxTri, guaif, menthol], [
      { sctid: "X1", name: "Amoxicillin (as amoxicillin trihydrate) 250 mg oral capsule", substanceSctids: [] },
      {
        sctid: "1621000189106",
        name: "Bromhexine (as bromhexine hydrochloride) 4 mg/10 mL and Menthol (as guaifenesin) 50 mg/10 mL and Terbutaline (as menthol) 2 mg/10 mL and Terbutaline sulfate 1.25 mg/10 mL oral syrup",
        substanceSctids: [guaif.sctid, menthol.sctid],
      },
    ]);

    expect(plan.proposals).toEqual([]);
    // bromhexine hydrochloride is not among that generic's (fixture) substances: unmatched.
    expect(plan.report).toMatchObject({ statements: 4, unmatchedStatements: 2, dissonantStatements: 2 });
  });

  /**
   * FOUND IN A BROWSER WALK, ON THE REAL RELEASE. 38 clinical drugs say "clavulanic acid (as
   * clavulanate potassium)", and one says the reverse, "Clavulanate potassium (as clavulanic
   * acid)". The one reversed statement drafted the SALT as the moiety of the BASE, and the two
   * cards then each told the pharmacist to decide the other first.
   */
  it("keeps only the direction most generics state when the release states a pair both ways", () => {
    const clavAcid = { sctid: "395939008", name: "Clavulanic acid (substance)", synonyms: ["Clavulanate"] };
    const reversed = {
      sctid: "R1",
      name: "Product containing precisely amoxicillin 200 milligram/5 milliliter and Clavulanate potassium (as clavulanic acid) 28.5 milligram/5 milliliter powder for conventional release oral suspension (clinical drug)",
      substanceSctids: [clavAcid.sctid],
    };
    const plan = planReleaseDrafts([clav, clavAcid], [augmentin("A1"), augmentin("A2"), reversed]);

    expect(plan.proposals.map((p) => [p.sctid, p.moietyName, p.basis])).toEqual([
      [clav.sctid, "clavulanic acid", "release_boss"],
      [clavAcid.sctid, "Clavulanic acid", "release_base"],
    ]);
    expect(plan.report.reversedStatements).toBe(1);
  });

  it("drops both directions of a pair the release states equally often", () => {
    const clavAcid = { sctid: "395939008", name: "Clavulanic acid (substance)", synonyms: [] };
    const one = { sctid: "F1", name: "Clavulanic acid (as clavulanate potassium) 125 mg", substanceSctids: [clav.sctid] };
    const other = { sctid: "F2", name: "Clavulanate potassium (as clavulanic acid) 125 mg", substanceSctids: [clavAcid.sctid] };

    const plan = planReleaseDrafts([clav, clavAcid], [one, other]);

    expect(plan.proposals).toEqual([]);
    expect(plan.report.reversedStatements).toBe(2);
  });

  it("is deterministic: a tie goes to the alphabetically first base", () => {
    const one = { sctid: "T1", name: "Amoxicillin (as amoxicillin trihydrate) 250 mg", substanceSctids: [amoxTri.sctid] };
    const two = { sctid: "T2", name: "Amoxycillin (as amoxicillin trihydrate) 250 mg", substanceSctids: [amoxTri.sctid] };
    expect(planReleaseDrafts([amoxTri], [two, one]).proposals[0]?.moietyName).toBe("amoxicillin");
    expect(planReleaseDrafts([amoxTri], [one, two]).proposals[0]?.moietyName).toBe("amoxicillin");
  });

  it("strips only SNOMED's semantic tag", () => {
    expect(stripSemanticTag("Paracetamol (substance)")).toBe("Paracetamol");
    expect(stripSemanticTag("Vitamin B12 (cyanocobalamin)")).toBe("Vitamin B12 (cyanocobalamin)");
  });
});

describe("the agent file", () => {
  const good = {
    model: "claude-opus-5", release: "nrces-2026-09",
    items: [{ sctid: "300937009", moietyName: "chlorphenamine", rationale: "maleate salt of chlorphenamine" }],
  };

  it("becomes agent drafts that carry the model and the rationale", () => {
    expect(agentProposals(agentFileSchema.parse(good))).toEqual([{
      sctid: "300937009", moietyName: "chlorphenamine", basis: "agent",
      evidence: { model: "claude-opus-5", rationale: "maleate salt of chlorphenamine" },
    }]);
  });

  it.each([
    ["no model", { ...good, model: "" }],
    ["no rationale", { ...good, items: [{ sctid: "300937009", moietyName: "chlorphenamine", rationale: " " }] }],
    ["no items", { ...good, items: [] }],
    ["an unknown field", { ...good, items: [{ ...good.items[0], saltId: "x" }] }],
  ])("refuses a file with %s", (_label, file) => {
    expect(() => agentFileSchema.parse(file)).toThrow();
  });
});
