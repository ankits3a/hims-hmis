import { ModuleRegistry } from "../../kernel/modules/loader";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { collectResourceKinds } from "../../kernel/resources/kinds";
import { ordersManifest } from "../../kernel/orders/manifest";
import { resourcesManifest } from "../../kernel/resources/manifest";
import { LAB_RESOURCE_KINDS } from "./kinds";
import { labManifest } from "./manifest";

/**
 * PLAN 17 T2 — THE MANIFEST, AND THE CLAIM THAT MAKES THE LAB AN ORDERING DEPARTMENT.
 *
 * Phase 0's `envelope.e2e.test.ts` placed, worked and closed an order through a FAKE manifest and
 * said: *"if the seam is right, THIS is the entire diff Plan 17 needs in order to become an
 * ordering department, and that claim is checkable here rather than in six weeks."* This file is
 * where the claim is checked against the SHIPPED manifest, and the first assertion is deliberately
 * a byte-for-byte comparison with that fake — a declaration that drifted from the one phase 0
 * proved would be a seam nobody has exercised end to end.
 */
describe("the lab manifest (Plan 17 T2)", () => {
  it("claims the `lab` order kind exactly as phase 0's e2e fake declared it (§6.8)", () => {
    expect(labManifest.orderKinds).toEqual([{
      kind: "lab",
      seriesKey: "lab_order",
      placePermission: "lab.orders.place",
      requiresClinician: true,
      requiresIndication: false,
      selfOrderable: false,
    }]);
  });

  /**
   * `S` IS A TUBE AND NOT AN ORDER NUMBER. `series.ts`'s own header names this as the entry most
   * likely to be "simplified" away by whoever writes the lab plan, and `collectOrderKinds` would
   * accept `lab_specimen` here without complaint — it is a real `EPISODE_SERIES` key. Nothing but
   * this assertion stands between the two.
   */
  it("mints its order numbers from `lab_order` (`L`), never from `lab_specimen` (`S`)", () => {
    expect(labManifest.orderKinds?.[0]?.seriesKey).toBe("lab_order");
    expect(labManifest.orderKinds?.[0]?.seriesKey).not.toBe("lab_specimen");
  });

  it("declares the eighteen permissions of DD16 plus 17-E's register, bridge read, interface write and inbox operate, and its own place permission among them", () => {
    expect([...labManifest.permissions].sort()).toEqual([
      "lab.accession.operate", "lab.catalogue.manage", "lab.catalogue.read", "lab.collection.operate",
      "lab.criticals.close", "lab.desk.operate", "lab.instruments.manage",
      /** 17-E T6 — the interface inbox: naming a parked result's tube, or discarding it with a reason. */
      "lab.instruments.operate", "lab.instruments.read",
      "lab.orders.place",
      "lab.reports.amend",
      "lab.reports.print", "lab.reports.publish", "lab.reports.release_unpaid", "lab.results.enter", "lab.results.interface",
      "lab.results.read", "lab.results.verify", "lab.worklist.read",
    ]);
    // `collectOrderKinds` refuses a `placePermission` no manifest declares — the refusal that stops
    // a kind being gated on a string `grantPermissionToRole` could never accept.
    expect(labManifest.permissions).toContain(labManifest.orderKinds?.[0]?.placePermission);
    // Every string is namespaced to this module: a manifest declaring another module's permission
    // would put two owners on one authority.
    for (const p of labManifest.permissions) expect(p.startsWith("lab.")).toBe(true);
  });

  /**
   * `subscriptions: []` IS A DECISION, NOT AN OMISSION — see `events.ts`. The one a reader looks
   * for is `patient.merged`, which the OT and materials both take; the lab's tables key by
   * `order_item_id`, `specimen_id` and `result_id`, and the one `patient_id` it holds follows the
   * envelope's own re-link. A consumer here would be a second answer to one question.
   */
  it("consumes nothing, and every menu entry is gated on a permission it declares", () => {
    expect(labManifest.subscriptions).toEqual([]);
    expect(labManifest.menu.map((m) => m.path)).toEqual([
      "/lab/desk", "/lab/collection", "/lab/bench", "/lab/verify",
      "/lab/reports", // PLAN 17c T5 — the report centre, on the counter's `lab.reports.print`
    ]);
    for (const entry of labManifest.menu) {
      expect([entry.path, labManifest.permissions.includes(entry.permission)]).toEqual([entry.path, true]);
    }
  });

  /**
   * DD17 — THE TWO RESOURCE KINDS, COLLECTED THROUGH THE REAL COLLECTOR rather than read off the
   * literal. `collectResourceKinds` is what refuses a kind outside the closed ten, a duplicate
   * claim, and — the leg that matters here — a declaration whose `initial` IS its `occupied`, which
   * would create every bench and analyzer already occupied by nobody.
   */
  it("claims `bench` and `analyzer` through the collector, adding no kernel kind", () => {
    const registry = new ModuleRegistry();
    registry.install(resourcesManifest);
    registry.install(labManifest);
    const kinds = collectResourceKinds(registry).map((d) => d.kind);
    expect(kinds).toEqual(["floor", "ward", "hall", "room", "bed", "bench", "analyzer"]);
    for (const decl of LAB_RESOURCE_KINDS) {
      expect([decl.kind, decl.initial === decl.occupied]).toEqual([decl.kind, false]);
      expect(decl.statuses).toContain(decl.initial);
      expect(decl.statuses).toContain(decl.onRelease);
      expect(decl.statuses).toContain(decl.retired);
      if (decl.occupied !== null) expect(decl.statuses).toContain(decl.occupied);
    }
  });

  it("`analyzer` carries the four states 17-E needs and `bench` does not pretend to", () => {
    const analyzer = LAB_RESOURCE_KINDS.find((d) => d.kind === "analyzer");
    expect(analyzer?.statuses).toEqual([
      "available", "in_use", "qc_locked", "calibration_due", "maintenance", "interface_down", "retired",
    ]);
    const bench = LAB_RESOURCE_KINDS.find((d) => d.kind === "bench");
    expect(bench?.statuses).toEqual(["available", "occupied", "closed", "retired"]);
    // `closed` is the night bench that is not retired — a lab runs three by day and one at 02:00.
    expect(bench?.statuses).toContain("closed");
  });

  /**
   * THE BOOT REFUSAL, EXERCISED. A second manifest claiming `lab` stops the process rather than the
   * first order of the day — and the reason phase 0 made it a boot error is that a hospital booting
   * with two claimants has already lost the argument about who owns the collection queue.
   */
  it("a second manifest claiming `lab` is a boot error, not a write-time one", () => {
    const registry = new ModuleRegistry();
    registry.install(ordersManifest);
    registry.install(labManifest);
    expect(collectOrderKinds(registry).map((d) => d.kind)).toEqual(["lab"]);
    registry.install({ ...labManifest, key: "lab-legacy" });
    expect(() => collectOrderKinds(registry)).toThrow(/two manifests declare the order kind "lab"/);
  });
});
