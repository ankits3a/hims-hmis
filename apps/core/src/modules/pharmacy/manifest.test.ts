import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { collectOrderKinds, findOrderKindDecl } from "../../kernel/orders/kinds";
import { pharmacyManifest } from "./manifest";

/**
 * PLAN 16c T1 — the seam, as a boot fact.
 *
 * A1: with every installed manifest, `medication` is claimed EXACTLY as declared — series `P`
 * (`pharmacy_dispense`), the counter's own place permission, clinician required. The mutant is a
 * declaration on `lab_order`: it boots (the kernel refuses a duplicate KIND, not a shared series)
 * and would number a dispense `L…`; only the equality below catches it.
 */
describe("the pharmacy manifest claims the medication order kind (16c T1)", () => {
  function installed(): ModuleRegistry {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    return registry;
  }

  it("A1 — medication is claimed on the pharmacy_dispense (P) series, and only once", () => {
    const decls = collectOrderKinds(installed());
    expect(findOrderKindDecl(decls, "medication")).toEqual({
      kind: "medication",
      seriesKey: "pharmacy_dispense",
      placePermission: "pharmacy.dispense.place",
      requiresClinician: true,
      requiresIndication: false,
      selfOrderable: false,
    });
    expect(decls.filter((d) => d.kind === "medication")).toHaveLength(1);
    expect(findOrderKindDecl(decls, "package")).toBeUndefined(); // Plan 26's stays reserved
  });

  it("declares the four counter permissions, the Rx-issued subscription (T3), and the two menu entries (T5)", () => {
    expect(pharmacyManifest.key).toBe("pharmacy");
    expect(pharmacyManifest.permissions).toEqual([
      "pharmacy.dispense.place", "pharmacy.dispense.read", "pharmacy.dispense.scheduled", "pharmacy.sale_items.manage",
    ]);
    expect(pharmacyManifest.menu.map((e) => e.path)).toEqual(["/pharmacy/counter", "/pharmacy/items"]);
    expect(pharmacyManifest.subscriptions).toEqual([{ event: "prescription.issued", consumer: "pharmacy.rx_issued" }]);
    const all = installed().allPermissions();
    for (const p of pharmacyManifest.permissions) expect(all).toContain(p);
  });
});
