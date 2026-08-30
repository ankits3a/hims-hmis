import { ModuleRegistry } from "../../kernel/modules/loader";
import { KERNEL_RESOURCE_KINDS, collectResourceKinds, findKindDecl } from "../../kernel/resources/kinds";
import { ResourceError } from "../../kernel/resources/errors";
import { RESOURCE_KIND_VALUES } from "../../kernel/db/schema/resources";
import type { ModuleManifest } from "../../kernel/modules/manifest";
import {
  DEVICE_MODALITY_ATTRIBUTE, IMAGING_MODALITIES,
  RADIOLOGY_RESOURCE_KINDS, SCHEDULABLE_DEVICE_STATUSES,
} from "./kinds";
import { radiologyManifest } from "./manifest";

/**
 * PLAN 18a T2 — Assertion Book row **A2**, and the first test this module has ever had.
 *
 * `kinds.ts` shipped in `997ab18` typechecking and asserted by nothing. The handoff's §3 named that
 * exactly — *"eleven files that typecheck and lint and have no test of their own … treat them as
 * WRITTEN"* — so these assertions are written before anything is built on the declaration, not
 * after.
 *
 * **What is actually at stake in this file.** `collectResourceKinds` refuses a SECOND manifest
 * declaring `device`, so the declaration below is not this module's private vocabulary: it is the
 * status vocabulary the cath lab (63), biomedical engineering (29) and every future injector and
 * C-arm inherit. A wrong `onRelease` here is a wrong `onRelease` for the whole hospital, and the
 * phase that discovers it cannot fix it by declaring `device` again.
 */
describe("the radiology module's resource-kind declaration (18a T2 A2)", () => {
  const registryWith = (...manifests: ModuleManifest[]) => {
    const registry = new ModuleRegistry();
    for (const m of manifests) registry.install(m);
    return registry;
  };

  it("A2: the manifest declares `device`, and it is the ONE kind this module claims", () => {
    const decls = collectResourceKinds(registryWith(radiologyManifest));
    expect(decls.map((d) => d.kind)).toEqual(["device"]);
  });

  it("A2: `device` carries initial=available, occupied=in_use, onRelease=available, retired=retired", () => {
    const device = findKindDecl(collectResourceKinds(registryWith(radiologyManifest)), "device");
    expect(device).toBeDefined();
    expect({
      initial: device!.initial,
      occupied: device!.occupied,
      onRelease: device!.onRelease,
      retired: device!.retired,
    }).toEqual({
      initial: "available",
      occupied: "in_use",
      onRelease: "available",
      retired: "retired",
    });
  });

  /**
   * ═══ THE onRelease FACT, STATED AS A DIFFERENCE RATHER THAN AS A VALUE ═══
   *
   * A bed's `onRelease` is `cleaning`; a gantry's is `available`. That difference is the entire
   * reason the field is per-kind rather than a constant, and asserting the two side by side is what
   * makes the assertion mean something — `available` on its own could be a copy of the default.
   */
  it("a device releases straight to `available`, unlike a bed, which releases to `cleaning`", () => {
    const device = findKindDecl(collectResourceKinds(registryWith(radiologyManifest)), "device")!;
    /**
     * The kernel's five kinds are NOT reachable through `collectResourceKinds`, which reads
     * manifests only — they live in `KERNEL_RESOURCE_KINDS`. Written the wrong way first, and the
     * failure (`bed` → `undefined`) is the useful kind: it says the two vocabularies are assembled
     * from different places, which is worth a reader knowing.
     */
    const bed = findKindDecl(KERNEL_RESOURCE_KINDS, "bed");
    expect(bed?.onRelease).toBe("cleaning");
    expect(device.onRelease).toBe("available");
  });

  /**
   * The six statuses, pinned as a set. `qa_blocked` is the one a reader is most likely to think
   * unused and delete: 18c's mammography QA workflow is what puts a device INTO it, and this phase
   * only honours it. Deleting it here would make 18c a vocabulary edit on a kind it does not own.
   */
  it("the six statuses are exactly the declared vocabulary, `qa_blocked` included", () => {
    const device = findKindDecl(collectResourceKinds(registryWith(radiologyManifest)), "device")!;
    expect([...device.statuses].sort()).toEqual(
      ["available", "down", "in_use", "maintenance", "qa_blocked", "retired"],
    );
  });

  /**
   * ═══ THE KIND IS ADMITTED BY THE DATABASE, READ FROM THE SCHEMA'S OWN LIST ═══
   *
   * Not `expect("device").toBe("device")`. `RESOURCE_KIND_VALUES` is what builds
   * `resources_kind_ck`, so a declaration of a kind the CHECK does not admit would insert nothing —
   * and this reads the kernel's list rather than restating it.
   */
  it("`device` is a kind the resources CHECK constraint admits", () => {
    expect(RESOURCE_KIND_VALUES).toContain("device");
  });

  /**
   * ═══ A2's MUTANT, AND IT PROVES THE KERNEL'S GUARD RATHER THAN OURS — recorded as such ═══
   *
   * The Assertion Book says: *"Declare `initial:'in_use'` → refused by the collector's own m4
   * check (this mutant proves the kernel guard, not ours — record it as such)."* Written here as a
   * synthetic manifest rather than by editing `kinds.ts`, because the fact under test is that the
   * COLLECTOR refuses it, and that is checkable without mutating shipped code.
   */
  it("A2 mutant: a device whose `initial` IS its `occupied` is refused at boot", () => {
    const broken: ModuleManifest = {
      key: "broken_device_owner",
      title: "broken",
      menu: [],
      permissions: [],
      subscriptions: [],
      resourceKinds: [{
        kind: "device",
        statuses: ["available", "in_use"],
        initial: "in_use",
        occupied: "in_use",
        onRelease: "available",
        retired: "available",
      }],
    };
    expect(() => collectResourceKinds(registryWith(broken))).toThrow(ResourceError);
    expect(() => collectResourceKinds(registryWith(broken))).toThrow(/every resource of that kind would be created occupied/);
  });

  it("A2: a SECOND manifest declaring `device` is refused `duplicate_kind` at boot", () => {
    const second: ModuleManifest = {
      key: "second_device_owner",
      title: "second",
      menu: [],
      permissions: [],
      subscriptions: [],
      resourceKinds: RADIOLOGY_RESOURCE_KINDS,
    };
    expect(() => collectResourceKinds(registryWith(radiologyManifest, second))).toThrow(ResourceError);
    expect(() => collectResourceKinds(registryWith(radiologyManifest, second))).toThrow(/duplicate_kind|two manifests declare/);
  });

  /**
   * ═══ THE SCHEDULABLE SET — the one constant two future callers must not answer differently ═══
   *
   * T4's scheduler and T7's console both read this. The assertion is written as a partition of the
   * declared statuses rather than as a list, so a status added to `device` later cannot quietly
   * default into "bookable" without this test naming it.
   */
  it("the schedulable statuses are a strict subset of the kind's own vocabulary", () => {
    const device = findKindDecl(collectResourceKinds(registryWith(radiologyManifest)), "device")!;
    for (const status of SCHEDULABLE_DEVICE_STATUSES) {
      expect(device.statuses).toContain(status);
    }
    expect(SCHEDULABLE_DEVICE_STATUSES.length).toBeLessThan(device.statuses.length);
  });

  it("`in_use` IS bookable and `down`/`qa_blocked`/`maintenance`/`retired` are not", () => {
    expect([...SCHEDULABLE_DEVICE_STATUSES].sort()).toEqual(["available", "in_use"]);
    for (const blocked of ["down", "qa_blocked", "maintenance", "retired"]) {
      expect(SCHEDULABLE_DEVICE_STATUSES).not.toContain(blocked);
    }
  });

  it("the modality vocabulary and its attribute key are one list with one owner", () => {
    expect([...IMAGING_MODALITIES]).toEqual(["xray", "usg", "ct", "mri", "mammography"]);
    expect(new Set(IMAGING_MODALITIES).size).toBe(IMAGING_MODALITIES.length);
    expect(DEVICE_MODALITY_ATTRIBUTE).toBe("modality");
  });
});
