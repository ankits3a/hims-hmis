import {
  LAB_ITEM_DEFINITION_JSON, LAB_ITEM_DEF_KEY, LAB_ITEM_STATES,
  LAB_SPECIMEN_DEFINITION_JSON, LAB_SPECIMEN_DEF_KEY, LAB_SPECIMEN_STATES,
  labItemDefinition, labSpecimenDefinition,
} from "./workflow-def";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineWorkflow, WorkflowValidationError } from "../../kernel/workflow/definition";

/**
 * PLAN 17a T4 — Assertion Book row **A8**, as a matrix walk over every declared pair.
 *
 * The two facts under test are not tidiness. `ordered → resulted` would make "a result exists for a
 * specimen nobody accessioned" representable (E43), and a second edge into `verified` would put a
 * pathologist's signature on a stage that never produced a number.
 */
describe("the two lab workflow definitions (17a T4 A8)", () => {
  it("both validate under defineWorkflow", () => {
    expect(labItemDefinition().key).toBe(LAB_ITEM_DEF_KEY);
    expect(labSpecimenDefinition().key).toBe(LAB_SPECIMEN_DEF_KEY);
  });

  /**
   * ═══ A DERIVED CENSUS, BECAUSE THE ONE F15 PROMISED WAS NOT ONE (pass 1, MAJOR 8) ═══
   *
   * `lab_specimens` carries no `instance_id`, so the tube's machine IS `lab_specimens.status` and
   * the definition is documentation of it. F15 said this test pinned the two together; it pinned the
   * definition against a constant in its own file, which is a claim a file makes about itself. This
   * reads the CHECK constraint out of the schema SOURCE — the `ist-clock-parity.test.ts` technique,
   * which is the only kind of census that has caught anything in this phase.
   */
  it("MAJOR 8: the specimen states ARE the lab_specimens_status_ck vocabulary, read from the schema", () => {
    const schema = readFileSync(
      resolve(__dirname, "..", "..", "kernel", "db", "schema", "lab.ts"), "utf8",
    );
    const check = /lab_specimens_status_ck[\s\S]*?in \(([^)]*)\)/.exec(schema);
    expect(check).not.toBeNull();
    const fromSchema = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(fromSchema.length).toBeGreaterThan(0);
    expect([...LAB_SPECIMEN_STATES].sort()).toEqual(fromSchema.sort());
  });

  it("MAJOR 8: the specimen definition's initial state is the status printLabels actually writes", () => {
    expect(labSpecimenDefinition().initialState).toBe("labelled");
  });

  it("the declared state lists and the definitions agree, in both directions", () => {
    expect(labItemDefinition().states.map((s) => s.name).sort()).toEqual([...LAB_ITEM_STATES].sort());
    expect(labSpecimenDefinition().states.map((s) => s.name).sort()).toEqual([...LAB_SPECIMEN_STATES].sort());
  });

  /**
   * THE MATRIX WALK. Every ordered pair of states is either declared or it is not, and the two
   * claims below are read off the whole matrix rather than off the edges a reader remembered.
   */
  const declared = (def: { transitions: { from: string; to: string }[] }) =>
    new Set(def.transitions.map((t) => `${t.from}→${t.to}`));

  it("A8: the matrix walk — every declared pair is enumerated, and `ordered → resulted` is not one", () => {
    const def = labItemDefinition();
    const edges = declared(def);
    /** Every ordered pair, walked: 11 x 11 = 121 cells, of which exactly the declared ones are true. */
    const cells = LAB_ITEM_STATES.flatMap((from) =>
      LAB_ITEM_STATES.map((to) => ({ pair: `${from}\u2192${to}`, declared: edges.has(`${from}\u2192${to}`) })));
    expect(cells).toHaveLength(LAB_ITEM_STATES.length ** 2);
    expect(cells.filter((c) => c.declared).map((c) => c.pair).sort())
      .toEqual([...edges].sort());
    /** THE ABSENCE UNDER TEST, read off the matrix rather than off a remembered edge. */
    expect(cells.find((c) => c.pair === "ordered\u2192resulted")!.declared).toBe(false);
    /** And nothing skips collection either: `ordered` reaches only `awaiting_collection` and `cancelled`. */
    expect(def.transitions.filter((t) => t.from === "ordered").map((t) => t.to).sort())
      .toEqual(["awaiting_collection", "cancelled"]);
  });

  it("A8: nothing reaches `verified` except `resulted`, and `verify` declares `pathologist`", () => {
    const def = labItemDefinition();
    const into = def.transitions.filter((t) => t.to === "verified");
    expect(into.map((t) => t.from)).toEqual(["resulted"]);
    /** S4 — the ENGINE checks a `user` actor's roles, so the role half of DD11 lives HERE. */
    expect(into[0]!.roles).toEqual(["pathologist"]);
  });

  it("A8: the rerun loop exists and `published`/`cancelled` are the item's only terminals", () => {
    const def = labItemDefinition();
    expect(declared(def).has("resulted→in_analysis")).toBe(true);
    expect(def.states.filter((s) => s.terminal === true).map((s) => s.name).sort())
      .toEqual(["cancelled", "published"]);
  });

  it("A8: a rejected specimen is TERMINAL — a new tube is a new row, never an un-rejection (DD5)", () => {
    const def = labSpecimenDefinition();
    expect(def.states.find((s) => s.name === "rejected")?.terminal).toBe(true);
    expect(def.transitions.filter((t) => t.from === "rejected")).toEqual([]);
  });

  /**
   * THE MUTANT'S OWN SHAPE, asserted so the row discriminates by CONSTRUCTION: a shortcut
   * transition is not merely absent from the shipped definition, it is one `defineWorkflow` would
   * accept — which is exactly why nothing but this test stands between it and the tree.
   */
  it("A8: defineWorkflow itself would ACCEPT the shortcut — the definition is the only guard", () => {
    const shortcut = {
      ...LAB_ITEM_DEFINITION_JSON,
      transitions: [...LAB_ITEM_DEFINITION_JSON.transitions, { from: "ordered", to: "resulted", roles: ["lab_technician"] }],
    };
    expect(() => defineWorkflow(shortcut)).not.toThrow();
  });

  it("a definition with a state that cannot reach a terminal is refused (the guard that IS structural)", () => {
    const dangling = {
      ...LAB_SPECIMEN_DEFINITION_JSON,
      states: [...LAB_SPECIMEN_DEFINITION_JSON.states, { name: "limbo", sla: { minutes: 1, alerting: "record_only" } }],
      transitions: [...LAB_SPECIMEN_DEFINITION_JSON.transitions, { from: "collected", to: "limbo", roles: ["lab_technician"] }],
    };
    expect(() => defineWorkflow(dangling)).toThrow(WorkflowValidationError);
  });
});
