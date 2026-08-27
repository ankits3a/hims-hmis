import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { RESOURCE_KIND_VALUES } from "../../kernel/db/schema/resources";
import { collectResourceKinds, findKindDecl } from "../../kernel/resources/kinds";
import { ResourceError } from "../../kernel/resources/errors";
import { MATERIALS_RESOURCE_KINDS } from "./kinds";
import { materialsManifest } from "./manifest";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * PLAN 14 T2 / DD2 — the `store` kind claim, and the boot refusal that now exists in BOTH processes.
 *
 * ═══ THIS FILE IS ALSO SPIKE Q6's HOME ═══
 *
 * The plan's Q6 asks: *"Does the worker boot with a kind-declaring manifest installed?"* — once with
 * the materials manifest, once with a scratch duplicate `store` declaration, and the second must
 * REFUSE. Plan 13's close left `collectResourceKinds` with no caller in `worker.module.ts`, so a
 * manifest declaring `resourceKinds` booted the worker with neither of the seam's two refusals
 * active. **`materialsManifest` is the first manifest that would have hit that gap** — the registry
 * itself declares kernel kinds through `resourcesManifest`, which is NOT installed in the worker.
 *
 * The refusal is proved here at the level it actually lives — `collectResourceKinds` over a registry
 * built exactly as each process builds one — and at the process level by
 * `worker-runtime.e2e.test.ts`, which boots a real `WorkerModule`. Neither alone is enough: a unit
 * test proves the collector refuses, and only the boot proves the collector is CALLED.
 */
function bare(key: string, over: Partial<ModuleManifest> = {}): ModuleManifest {
  return { key, title: key, menu: [], permissions: [], subscriptions: [], ...over };
}

describe("the materials store kind (Plan 14 T2 / DD2)", () => {
  // ─────────────────────────── the declaration, field by field ───────────────────────────

  it("claims exactly one kind, `store`, and it is one of the ten the CHECK admits", () => {
    expect(MATERIALS_RESOURCE_KINDS.map((d) => d.kind)).toEqual(["store"]);
    // A kind outside `RESOURCE_KIND_VALUES` is declarable but UNSTORABLE — it would fail at the
    // INSERT with a constraint name instead of at boot with a sentence. `store` is among the ten
    // Plan 13 baked into `resources_kind_ck`, which is why this claim needs no kernel edit and no
    // migration (DD2).
    expect(RESOURCE_KIND_VALUES).toContain("store");
    expect(materialsManifest.resourceKinds).toBe(MATERIALS_RESOURCE_KINDS);
  });

  /**
   * **`occupied: null` IS THE DECISION IN THIS DECLARATION AND IT IS ASSERTED BY NAME.**
   *
   * A store is NOT ASSIGNABLE: `assignResource` refuses it with `not_assignable` rather than
   * setting an occupant. A store's contents are `stock_balances` rows per `(resource, batch)` — a
   * SET of batches with quantities — and `occupant_ref` holds ONE id. Giving a store an occupant
   * would be a second, weaker answer to "what is in here", and the weaker one is the one a board
   * would render. The plan names this field explicitly in T2's acceptance ("`kinds.test.ts` pins
   * `store`'s declaration and that `occupied` is null"), so it is a leg rather than a table row.
   */
  it("a store is NOT assignable — `occupied` is null, and that is why", () => {
    const store = MATERIALS_RESOURCE_KINDS[0]!;
    expect(store.occupied).toBeNull();
  });

  it("the vocabulary is available|blocked|retired, and every named status is inside it", () => {
    const store = MATERIALS_RESOURCE_KINDS[0]!;
    expect(store.statuses).toEqual(["available", "blocked", "retired"]);
    expect(store.initial).toBe("available");
    expect(store.onRelease).toBe("available");
    // DD2 of Plan 13: `retired` is what replaces an `active: false` boolean — one state column
    // cannot disagree with itself. A retired store keeps its ledger history.
    expect(store.retired).toBe("retired");
    // The collector refuses a declaration naming a status outside its own vocabulary; this leg is
    // the shipped declaration satisfying that rule rather than relying on the refusal to catch it.
    for (const s of [store.initial, store.onRelease, store.retired]) {
      expect({ status: s, inVocabulary: store.statuses.includes(s) }).toEqual({ status: s, inVocabulary: true });
    }
  });

  // ─────────────────────── the installed registry, and Spike Q6's refusal ───────────────────────

  it("`store` is collected from the real ALL_MANIFESTS registry — the API's own boot path", () => {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    const decls = collectResourceKinds(registry);
    expect(decls.map((d) => d.kind)).toContain("store");
    expect(findKindDecl(decls, "store")?.occupied).toBeNull();
  });

  /**
   * SPIKE Q6, second half. A scratch manifest claiming `store` a second time must make the boot
   * REFUSE — two vocabularies for one kind means `onRelease` depends on which declaration a reader
   * happened to find. This is the assertion that was TRUE IN THE API AND FALSE IN THE WORKER until
   * this task added `collectResourceKinds(registry)` to `worker.module.ts`.
   */
  it("a SECOND manifest claiming `store` is a BOOT refusal, not a write-time one", () => {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    registry.install(bare("scratch-stores", {
      resourceKinds: [{
        kind: "store", statuses: ["available", "retired"], initial: "available",
        occupied: "occupied", onRelease: "available", retired: "retired",
      }],
    }));
    expect(() => collectResourceKinds(registry)).toThrow(ResourceError);
    expect(() => collectResourceKinds(registry)).toThrow(/duplicate_kind|store/);
  });

  /**
   * The other refusal, on THIS module's own shape: a declaration whose `occupied` names a status
   * outside its own `statuses`. Proved against a scratch copy of the materials declaration rather
   * than the shipped one, so nothing here can be read as the shipped declaration being wrong.
   */
  it("a store declaration naming a status outside its own vocabulary is refused at boot", () => {
    const registry = new ModuleRegistry();
    registry.install(bare("scratch-bad-store", {
      resourceKinds: [{
        kind: "store", statuses: ["available", "blocked", "retired"], initial: "available",
        occupied: null, onRelease: "available", retired: "decommissioned",
      }],
    }));
    expect(() => collectResourceKinds(registry)).toThrow(ResourceError);
  });
});
