import {
  IMAGING_GATE_DEF_KEY, IMAGING_STUDY_DEF_KEY,
  RADIOLOGY_WORKFLOW_DEFINITIONS, imagingGateDefinition, imagingStudyDefinition,
} from "./workflow-def";
import { radiologyManifest } from "./manifest";

/**
 * PLAN 18a T2 — Assertion Book row **A4**, plus the separation A3 pins in the SEED and this file
 * pins in the ENGINE.
 *
 * ═══ WHY THIS FILE CARRIES A SEPARATION ASSERTION AT ALL ═══
 *
 * A3 asserts that `radiology_receptionist` does not hold `radiology.gates.satisfy`. That is a claim
 * about the PERMISSION registry, and it is not the plane a gate transition is actually enforced on.
 * `advanceInstance` (`kernel/workflow/instances.ts:115`) calls `actorHoldsAnyRole` against
 * `role_assignments` / `temp_role_grants` and **consults no permission at any point** — the same
 * two-planes fact Plan 17b booked as F39, where fifteen `lab.*` permissions and no lab role key
 * produced a login that reached every route and could not draw blood.
 *
 * So a separation stated only in the seed is a separation the gate does not have. If a transition
 * names `radiology_receptionist`, a receptionist drives that gate to `satisfied` no matter what the
 * permission registry says. Both planes have to agree, and only a test that reads the DEFINITION
 * can say the second one does.
 */
describe("the two radiology workflow definitions (18a T2 A4)", () => {
  it("A4: both round-trip `defineWorkflow` and are governed Class A", () => {
    expect(imagingStudyDefinition.key).toBe(IMAGING_STUDY_DEF_KEY);
    expect(imagingGateDefinition.key).toBe(IMAGING_GATE_DEF_KEY);
    for (const def of RADIOLOGY_WORKFLOW_DEFINITIONS) {
      expect(def.changeClass).toBe("A");
      expect(def.states.length).toBeGreaterThan(0);
      expect(def.transitions.length).toBeGreaterThan(0);
    }
  });

  it("the catalogue is exactly these two, and neither key is declared twice", () => {
    expect(RADIOLOGY_WORKFLOW_DEFINITIONS.map((d) => d.key)).toEqual(
      [IMAGING_STUDY_DEF_KEY, IMAGING_GATE_DEF_KEY],
    );
    expect(new Set(RADIOLOGY_WORKFLOW_DEFINITIONS.map((d) => d.key)).size).toBe(2);
  });

  /**
   * ═══ A4's OWN ASSERTION: the gate's three exits are ALL terminal ═══
   *
   * The mutant the Assertion Book names is `overridden` left non-terminal, and the consequence it
   * names is that *"is this gate still open?"* acquires two answers. `evaluateReadiness` (T5 A6) is
   * defined as "every opened gate is terminal-and-not-open", so a non-terminal exit does not merely
   * read oddly — it makes a study with an overridden renal gate permanently un-ready.
   */
  it("A4: `open` is the only non-terminal state, and satisfied/waived/overridden are all terminal", () => {
    const terminal = (name: string) =>
      imagingGateDefinition.states.find((s) => s.name === name)?.terminal === true;
    expect(terminal("open")).toBe(false);
    for (const exit of ["satisfied", "waived", "overridden"]) {
      expect([exit, terminal(exit)]).toEqual([exit, true]);
    }
    expect(imagingGateDefinition.states.map((s) => s.name).sort()).toEqual(
      ["open", "overridden", "satisfied", "waived"],
    );
    expect(imagingGateDefinition.initialState).toBe("open");
  });

  it("every gate transition leaves `open` — a gate never moves between two exits", () => {
    for (const t of imagingGateDefinition.transitions) {
      expect([`${t.from}→${t.to}`, t.from]).toEqual([`${t.from}→${t.to}`, "open"]);
    }
  });

  /**
   * ═══ THE SEPARATION, ON THE PLANE IT IS ENFORCED ON ═══
   *
   * The plan says it in as many words twice — §5 T2's *"Three separations the reviewer checks: the
   * receptionist cannot satisfy a gate"*, and `manifest.ts`'s own header: *"The person who books
   * the scan and takes the money does not get to record that the patient is not pregnant."*
   *
   * The gate set includes `pregnancy_screen`, `form_f` and `mri_safety`. One workflow definition
   * covers every gate KIND, so a role named on this transition can satisfy ALL of them — there is
   * no per-kind role list to fall back on. That is why the receptionist cannot be on it even though
   * an administrative gate would be harmless: the definition cannot express "this kind only".
   */
  it("A3/A4: the gate's `open → satisfied` does NOT admit `radiology_receptionist`", () => {
    const satisfy = imagingGateDefinition.transitions.find(
      (t) => t.from === "open" && t.to === "satisfied",
    );
    expect(satisfy).toBeDefined();
    expect(satisfy!.roles).not.toContain("radiology_receptionist");
  });

  it("A3/A4: neither may the receptionist waive or override a gate", () => {
    for (const to of ["waived", "overridden"]) {
      const t = imagingGateDefinition.transitions.find((x) => x.from === "open" && x.to === to);
      expect([to, t?.roles]).toEqual([to, ["radiologist"]]);
    }
  });

  /**
   * The second of the three separations, on the same plane. The technologist acquires; the
   * radiologist reports. A `radiographer` on either edge into `reported` or `published` would put a
   * signature the department exists to separate onto the technologist's own work.
   */
  it("A3/A4: `radiographer` cannot reach `reported` or `published` on the study machine", () => {
    for (const t of imagingStudyDefinition.transitions) {
      if (t.to === "reported" || t.to === "published") {
        expect([`${t.from}→${t.to}`, t.roles.includes("radiographer")])
          .toEqual([`${t.from}→${t.to}`, false]);
      }
    }
  });

  /**
   * ═══ THE MATRIX WALK — every declared pair enumerated, the lab's A8 technique ═══
   *
   * Read off the whole transition table rather than off the edges a reader remembered, so an edge
   * added later shows up here as a diff instead of passing unnoticed.
   */
  it("A4: the study machine's declared pairs are exactly these sixteen", () => {
    const declared = imagingStudyDefinition.transitions
      .map((t) => `${t.from}→${t.to}`)
      .sort();
    expect(declared).toEqual([
      "checked_in→cancelled",
      "checked_in→no_show",
      "checked_in→ready",
      "checked_in→rescheduled",
      "in_acquisition→acquired",
      "in_acquisition→cancelled",
      "in_acquisition→ready",
      "ready→cancelled",
      "ready→in_acquisition",
      "reported→published",
      /**
       * ═══ 18a-iii T4 — THE SIXTEENTH, AND THIS CENSUS IS WHY IT IS DEFENDED IN WRITING ═══
       *
       * This list is friction on purpose, and the friction worked: the edge was added in
       * `workflow-def.ts` and this test reddened before any suite of T4's ran, forcing the argument
       * to be made HERE rather than noticed in a review six commits later.
       *
       * `scheduled → acquired` is how a film from another centre reaches a reportable state. It has
       * no check-in, no gates, no machine and no exposure — and routing it through the ordinary arc
       * would have reached `recordAcquired`, which for an ionising study type demands a dose and
       * writes the AERB radiation dose register **against one of our machines**, for an exposure
       * another hospital delivered.
       *
       * **It is also, unavoidably, a route past the machine, the gates and the dose** — the workflow
       * engine cannot see which caller is using an edge. Three things hold it: the roles exclude
       * `radiographer` (registering somebody else's film is a reception act); `registerOutsideStudy`
       * refuses any study carrying a device, a slot or an acquisition start; and `outside.test.ts`
       * pins the edge to ONE caller by grep, because a revert pair cannot prove an absence.
       */
      "scheduled→acquired",
      "scheduled→cancelled",
      "scheduled→checked_in",
      "scheduled→no_show",
      "scheduled→rescheduled",
      "acquired→reported",
    ].sort());
  });

  it("A4: the four terminal states are the four a study can end in, and `published` is one", () => {
    const terminals = imagingStudyDefinition.states
      .filter((s) => s.terminal === true).map((s) => s.name).sort();
    expect(terminals).toEqual(["cancelled", "no_show", "published", "rescheduled"]);
    expect(imagingStudyDefinition.initialState).toBe("scheduled");
  });

  it("no transition leaves a terminal state — an ended study does not restart", () => {
    const terminal = new Set(
      imagingStudyDefinition.states.filter((s) => s.terminal === true).map((s) => s.name),
    );
    for (const t of imagingStudyDefinition.transitions) {
      expect([`${t.from}→${t.to}`, terminal.has(t.from)]).toEqual([`${t.from}→${t.to}`, false]);
    }
  });

  /**
   * Every role named on any transition of either definition is either a role this phase declares,
   * or `doctor`/`system` which predate it. A typo in a role key is otherwise invisible: the
   * transition simply never fires for anybody, and the first person to find out is a radiographer
   * at a console at two in the morning.
   */
  it("every role named on a transition is a real role key, not a typo", () => {
    const declaredByThisPhase = ["radiologist", "radiographer", "radiology_receptionist"];
    const preexisting = ["doctor", "system"];
    const allowed = new Set([...declaredByThisPhase, ...preexisting]);
    for (const def of RADIOLOGY_WORKFLOW_DEFINITIONS) {
      for (const t of def.transitions) {
        expect(t.roles.length).toBeGreaterThan(0);
        for (const role of t.roles) {
          expect([`${def.key}:${t.from}→${t.to}`, role, allowed.has(role)])
            .toEqual([`${def.key}:${t.from}→${t.to}`, role, true]);
        }
      }
    }
  });

  /**
   * The two definition keys are the ones T4 governs and T5 drives. Pinning them against the
   * manifest's own key keeps the module tag and the definition namespace from drifting apart.
   */
  it("the definitions belong to the radiology manifest's module", () => {
    expect(radiologyManifest.key).toBe("radiology");
    expect(IMAGING_STUDY_DEF_KEY).toBe("imaging_study");
    expect(IMAGING_GATE_DEF_KEY).toBe("imaging_gate");
  });
});
