import { ALL_MANIFESTS } from "../modules/manifests";
import { ModuleRegistry } from "../modules/loader";
import { EPISODE_SERIES } from "../episodes/series";
import { ORDER_EVENT_NAMES } from "./events";
import { collectOrderKinds } from "./kinds";
import { ORDER_ITEM_TRANSITIONS } from "./transitions";

/**
 * PLAN 17 PHASE 0 T6 — the pins. Three facts this phase FREEZES (§8), each asserted against the
 * shipped artefact rather than against a restatement of it.
 *
 * No database: all three are pure.
 */
describe("the order envelope's parity pins", () => {
  /**
   * ═══ THE CLAIMED SET IS EMPTY, AND THAT IS THE STATE THIS PHASE SHIPS IN ═══
   *
   * The envelope has ZERO consumers on the day it lands: `placeOrder` refuses every kind with
   * `unknown_kind` and none of the six events can fire. **This assertion is where a reviewer SEES a
   * kind arrive** — Plan 17 claims `lab`, 18a claims `imaging`, 26 claims `package`, and each of
   * them must edit this line in the commit that does it.
   *
   * It is also where the CONTRACT's two RESERVED names are enforced in the only way a reservation
   * can be: `medication` belongs to Plan 16 (DD9 — `prescriptions.ts` is live and printing e-Rx
   * today, and whether it becomes an order is 16's decision on 16's evidence) and `package` to Plan
   * 26. Nothing in the code forbids claiming them; this list is what makes claiming them visible.
   */
  /**
   * AMENDED BY PLAN 17 T2 — **THE SECOND CLAIMED-KIND CENSUS, AND THE PHASE DOCUMENT NAMED ONLY THE
   * FIRST** (finding F5). `kinds.test.ts:140` was in T2's Files list; this one was not, and it pins
   * the same fact. It was found by the §2.138 list-grep (`ALL_MANIFESTS`), which is exactly the
   * search that rule exists for: no grep for a SIBLING's name could have found either, because
   * both derive from the list instead of naming a member of it.
   *
   * `medication` (Plan 16) and `package` (Plan 26) stay reserved by name and claimed by nobody;
   * 18a appends `imaging` and rebases if it lands second.
   */
  it("exactly one installed manifest claims an order kind today: the lab's", () => {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    expect(collectOrderKinds(registry).map((d) => d.kind)).toEqual(["lab"]);
  });

  /**
   * ═══ FOUR EDGES, AND NO FIFTH STATE ═══
   *
   * §8.2 freezes this table for 18a, 24a, 26 and 22c-F. A fifth state added here would silently
   * change what `completed` means to four plans that have already been written against it.
   */
  it("the transition table is exactly the four DD4 edges", () => {
    expect(ORDER_ITEM_TRANSITIONS.map((t) => [t.from, t.to])).toEqual([
      ["placed", "in_progress"],
      ["in_progress", "completed"],
      ["placed", "cancelled"],
      ["in_progress", "cancelled"],
    ]);
  });

  /**
   * ═══ THE EVENT NAMES ═══
   *
   * `defineEvent` runs the `entity.verb_past` lint (`NAME_RE`, contracts/envelope.ts:64) at module
   * load, so an illegal name is an import-time throw and this file could not even be collected.
   * That makes the assertion below about the SET and its SHAPE rather than about the regex: §8.10
   * freezes these six strings, and a consumer's `subscriptions` entry is matched against them by
   * name.
   */
  it("the six event names are the ones §4.2 freezes, in entity.verb_past form", () => {
    expect(ORDER_EVENT_NAMES).toEqual([
      "order.placed",
      "order_item.started", "order_item.completed", "order_item.cancelled",
      "order.closed", "order.cancelled",
    ]);
    for (const name of ORDER_EVENT_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });

  /**
   * ═══ THIS PHASE ADDS NO SERIES, AND THE TWO IT USES WERE RESERVED IN 2026-08-25 ═══
   *
   * §8.5. `S` stays the lab SPECIMEN's letter and `P` the dispense document's; neither is an order
   * number, and `series.ts`'s own header is the reason — one order yields several tubes and one
   * tube serves several tests, so a single number cannot express a haemolysed sample being redrawn
   * without cancelling the whole order.
   */
  it("the letters an order kind may mint from already exist, and this phase added none", () => {
    expect(EPISODE_SERIES.lab_order).toBe("L");
    expect(EPISODE_SERIES.radiology_order).toBe("R");
    expect(Object.keys(EPISODE_SERIES).sort()).toEqual([
      "appointment", "daycare", "grn", "lab_order", "lab_specimen", "pharmacy_dispense",
      "radiology_order", "visit",
    ]);
  });
});
