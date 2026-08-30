import { ALL_MANIFESTS } from "../modules/manifests";
import { ModuleRegistry } from "../modules/loader";
import type { ModuleManifest } from "../modules/manifest";
import { OrderError } from "./errors";
import { collectOrderKinds, findOrderKindDecl } from "./kinds";
import type { OrderKindDecl } from "./kinds";

/**
 * PLAN 17 PHASE 0 T2 — the order-kind seam's three BOOT refusals, provoked against a real
 * `ModuleRegistry` rather than against a hand-written copy of its rules. `collectOrderKinds` is
 * what runs in `app.module.ts` and `worker.module.ts`, so it is what is tested.
 *
 * No database: this seam is pure. The declarations it reads come off manifests and the permissions
 * it checks come off `registry.allPermissions()`, neither of which touches Postgres.
 */
function decl(over: Partial<OrderKindDecl> = {}): OrderKindDecl {
  return {
    kind: "lab",
    seriesKey: "lab_order",
    placePermission: "lab.orders.place",
    requiresClinician: true,
    requiresIndication: false,
    selfOrderable: false,
    ...over,
  };
}

function bare(key: string, over: Partial<ModuleManifest> = {}): ModuleManifest {
  return { key, title: key, menu: [], permissions: [], subscriptions: [], ...over };
}

/** A registry holding exactly the manifests given, so a boot refusal can be provoked without booting. */
function registryOf(...manifests: ModuleManifest[]): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const m of manifests) registry.install(m);
  return registry;
}

/** The shape a real ordering module has: it declares the kind AND the permission that kind names. */
function claimant(key: string, over: Partial<OrderKindDecl> = {}): ModuleManifest {
  const d = decl(over);
  return bare(key, { permissions: [d.placePermission], orderKinds: [d] });
}

describe("the order kind seam (Plan 17 phase 0 T2)", () => {
  describe("A1 — a kind two manifests claim is refused at BOOT", () => {
    it("throws duplicate_kind, naming the kind", () => {
      const registry = registryOf(claimant("lab"), claimant("lab-legacy"));
      expect(() => collectOrderKinds(registry)).toThrow(OrderError);
      expect(() => collectOrderKinds(registry)).toThrow(/two manifests declare the order kind "lab"/);
    });

    it("carries the duplicate_kind code, not a neighbouring one", () => {
      let thrown: unknown;
      try { collectOrderKinds(registryOf(claimant("a"), claimant("b"))); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(OrderError);
      expect((thrown as OrderError).code).toBe("duplicate_kind");
    });

    /**
     * TWO DIFFERENT kinds from two manifests is the NORMAL case and must not be caught by the same
     * check — `lab` and `imaging` are exactly what Plans 17 and 18a will install side by side.
     * Without this leg the assertion above passes for an implementation that refuses any second
     * declaration at all.
     */
    it("does NOT refuse two manifests declaring DIFFERENT kinds — 17 and 18a side by side", () => {
      const imaging = bare("radiology", {
        permissions: ["radiology.orders.place"],
        orderKinds: [decl({ kind: "imaging", seriesKey: "radiology_order", placePermission: "radiology.orders.place" })],
      });
      const kinds = collectOrderKinds(registryOf(claimant("lab"), imaging)).map((d) => d.kind);
      expect(kinds).toEqual(["lab", "imaging"]);
    });
  });

  describe("A2 — a seriesKey EPISODE_SERIES does not carry is refused at BOOT", () => {
    it("throws unknown_series rather than letting nextEpisodeNo throw mid-transaction", () => {
      const registry = registryOf(
        bare("lab", {
          permissions: ["lab.orders.place"],
          orderKinds: [decl({ seriesKey: "histopath_order" as OrderKindDecl["seriesKey"] })],
        }),
      );
      expect(() => collectOrderKinds(registry)).toThrow(/unknown_series|EPISODE_SERIES does not carry/);
      let thrown: unknown;
      try { collectOrderKinds(registry); } catch (error) { thrown = error; }
      expect((thrown as OrderError).code).toBe("unknown_series");
    });

    /**
     * The other side of the same check, and it is the leg that stops the assertion passing for an
     * implementation that refuses EVERY series: `lab_order` and `radiology_order` are the two keys
     * this seam exists to admit, and `series.ts` has reserved them since 2026-08-25.
     */
    it.each(["lab_order", "radiology_order", "pharmacy_dispense"] as const)(
      "admits the reserved series key %s",
      (seriesKey) => {
        const registry = registryOf(bare("m", { permissions: ["lab.orders.place"], orderKinds: [decl({ seriesKey })] }));
        expect(collectOrderKinds(registry)[0]!.seriesKey).toBe(seriesKey);
      },
    );
  });

  describe("A3 — a placePermission no manifest declares is refused at BOOT", () => {
    it("throws undeclared_permission — a kind no role could ever place", () => {
      // The declaring manifest names the permission on its kind and does NOT declare it in
      // `permissions`, which is exactly the shape of the mistake: one line forgotten.
      const registry = registryOf(bare("lab", { orderKinds: [decl()] }));
      expect(() => collectOrderKinds(registry)).toThrow(/no manifest\s+declares|declares placePermission/);
      let thrown: unknown;
      try { collectOrderKinds(registry); } catch (error) { thrown = error; }
      expect((thrown as OrderError).code).toBe("undeclared_permission");
    });

    /**
     * THE PERMISSION MAY BE DECLARED BY A **DIFFERENT** MANIFEST, and that must not be refused: the
     * check is against `registry.allPermissions()`, the whole installed catalog, exactly as
     * `collectProviders` is. A rule that demanded self-declaration would forbid a kernel-declared
     * permission being used by a module — which is `orders.place` itself.
     */
    it("accepts a placePermission another installed manifest declares", () => {
      const declarer = bare("auth-ish", { permissions: ["lab.orders.place"] });
      const user = bare("lab", { orderKinds: [decl()] });
      expect(collectOrderKinds(registryOf(declarer, user))).toHaveLength(1);
    });
  });

  describe("A4 — the field is OPTIONAL, and today's claimed set is empty", () => {
    it("collects [] from a registry whose manifests declare no orderKinds", () => {
      expect(collectOrderKinds(registryOf(bare("a"), bare("b")))).toEqual([]);
    });

    /**
     * THE PIN THE PHASE'S OWN CONTRACT DEPENDS ON. Until a manifest claims a kind, no order can be
     * placed and none of the `order.*` events can fire — so an empty claimed set is what "this
     * envelope has no consumers yet" MEANS, and the day it stops being empty a reviewer sees which
     * plan claimed what. `medication` (Plan 16) and `package` (Plan 26) are reserved by NAME in the
     * contract and by nobody in code; this is where that becomes checkable.
     *
     * ═══ PLAN 17 T2 — **KERNEL EDIT 3 OF 4: THE DAY IT STOPPED BEING EMPTY.** ═══
     *
     * `labManifest` claims `lab`, and this line is the whole visible consequence of phase 0's
     * "ONE manifest field" contract being taken up. The DECLARATION is asserted rather than just
     * the name, because the four booleans are what a placing caller is bound by: a `requiresClinician`
     * that silently flipped would let a walk-in be ordered with no doctor answerable for it.
     *
     * **18a appends `imaging` here and rebases if it lands second** (phase document §5 T2). The
     * order is manifest INSTALL order, so a second claimant lands after `lab` rather than anywhere
     * else. `medication` and `package` stay unclaimed.
     */
    it("ALL_MANIFESTS claims exactly two order kinds today: the lab's and radiology's", () => {
      const registry = new ModuleRegistry();
      for (const m of ALL_MANIFESTS) registry.install(m);
      expect(collectOrderKinds(registry)).toEqual([{
        kind: "lab",
        seriesKey: "lab_order",
        placePermission: "lab.orders.place",
        requiresClinician: true,
        requiresIndication: false,
        selfOrderable: false,
      }, {
        /**
         * PLAN 18a T2 — the second claimant, appended in manifest INSTALL order as the header
         * above said it would be.
         *
         * **`requiresIndication: true` is the one field that differs from the lab's, and it is the
         * radiation-justification rule expressed as a DECLARATION.** `placeOrder` refuses an
         * imaging order carrying no reason and this module writes no guard of its own for it — a
         * CT with no stated indication is a dose nobody can justify to an AERB inspector. A silent
         * flip to `false` would make that refusal disappear with nothing else changing, which is
         * why the whole declaration is asserted rather than just the kind name.
         */
        kind: "imaging",
        seriesKey: "radiology_order",
        placePermission: "radiology.orders.place",
        requiresClinician: true,
        requiresIndication: true,
        selfOrderable: false,
      }]);
    });
  });

  describe("findOrderKindDecl", () => {
    it("returns the declaration for a claimed kind and undefined for one nobody claimed", () => {
      const decls = collectOrderKinds(registryOf(claimant("lab")));
      expect(findOrderKindDecl(decls, "lab")?.seriesKey).toBe("lab_order");
      // `imaging` is absent from THIS registry, which holds one synthetic `lab` claimant — the
      // point being that the collector answers about what is INSTALLED, not about what is legal.
      // (18a has since claimed `imaging` in `ALL_MANIFESTS`; this fixture deliberately does not
      // use `ALL_MANIFESTS`.) `placeOrder` turns this `undefined` into `unknown_kind`.
      expect(findOrderKindDecl(decls, "imaging")).toBeUndefined();
    });
  });
});
