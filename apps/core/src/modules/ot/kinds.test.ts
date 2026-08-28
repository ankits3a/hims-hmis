import { ModuleRegistry } from "../../kernel/modules/loader";
import { KERNEL_RESOURCE_KINDS, collectResourceKinds, findKindDecl } from "../../kernel/resources/kinds";
import { ResourceError } from "../../kernel/resources/errors";
import { OT_RESOURCE_KINDS, DAYCARE_RECOVERY_BAY_CLASS } from "./kinds";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * PLAN 15 T1 / DD3 — the `theatre` declaration, proved against the KERNEL's own collector rather
 * than against a hand-written copy of its rules. `collectResourceKinds` is what runs at boot, so it
 * is what these legs run: a declaration that satisfies a test's idea of `ResourceKindDecl` and
 * throws at boot has been proved by nothing.
 */
function manifestWith(kinds: readonly (typeof OT_RESOURCE_KINDS)[number][]): ModuleManifest {
  return { key: "ot", title: "OT", menu: [], permissions: [], subscriptions: [], resourceKinds: kinds };
}

function kernelManifest(): ModuleManifest {
  return { key: "kernel-fixture", title: "kernel", menu: [], permissions: [], subscriptions: [], resourceKinds: KERNEL_RESOURCE_KINDS };
}

function registryOf(...manifests: ModuleManifest[]): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const m of manifests) registry.install(m);
  return registry;
}

describe("the OT resource kinds (Plan 15 T1 / DD3)", () => {
  it("declares exactly ONE kind, `theatre`", () => {
    expect(OT_RESOURCE_KINDS.map((k) => k.kind)).toEqual(["theatre"]);
  });

  /**
   * F1 — THE FINDING THIS DECLARATION EXISTS BECAUSE OF. The brainstorm proposed claiming `bed` for
   * the two recovery bays; `bed` is already a KERNEL kind, and a second declaration is a BOOT error.
   * Both halves are asserted: this manifest does not claim it, and claiming it would throw.
   */
  it("does NOT claim `bed` — the kernel already does, and a second claim is duplicate_kind (F1)", () => {
    expect(OT_RESOURCE_KINDS.map((k) => k.kind)).not.toContain("bed");
    expect(KERNEL_RESOURCE_KINDS.map((k) => k.kind)).toContain("bed");

    // The refusal itself, executed — not predicted. This is what would have happened at boot.
    const bedDecl = KERNEL_RESOURCE_KINDS.find((k) => k.kind === "bed")!;
    const clashing = registryOf(kernelManifest(), manifestWith([bedDecl]));
    let thrown: unknown;
    try { collectResourceKinds(clashing); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ResourceError);
    expect((thrown as ResourceError).code).toBe("duplicate_kind");
    expect(String(thrown)).toContain("bed");
  });

  it("validates against the kernel's collector, and `theatre` ends up in the collected set", () => {
    const decls = collectResourceKinds(registryOf(kernelManifest(), manifestWith(OT_RESOURCE_KINDS)));
    const theatre = findKindDecl(decls, "theatre");
    expect(theatre).toBeDefined();
    expect({
      statuses: theatre!.statuses,
      initial: theatre!.initial,
      occupied: theatre!.occupied,
      onRelease: theatre!.onRelease,
      retired: theatre!.retired,
    }).toEqual({
      statuses: ["available", "reserved", "in_use", "turnover", "blocked", "retired"],
      initial: "available",
      occupied: "in_use",
      onRelease: "turnover",
      retired: "retired",
    });
  });

  /**
   * The two boot refusals Plan 13's close pass added *specifically* because "Plan 15 is the first
   * phase to write a declaration this file did not". Running them against near-misses of THIS
   * declaration is the only way to know the shipped one passes for a reason.
   */
  it("would be refused at boot if `initial` were the occupied status, or a status were off-vocabulary", () => {
    const theatre = OT_RESOURCE_KINDS[0]!;

    const initialIsOccupied = registryOf(manifestWith([{ ...theatre, initial: "in_use" }]));
    expect(() => collectResourceKinds(initialIsOccupied)).toThrow(/occupied/);

    const offVocabulary = registryOf(manifestWith([{ ...theatre, onRelease: "cleaning" }]));
    expect(() => collectResourceKinds(offVocabulary)).toThrow(/not among its own/);
  });

  /**
   * `onRelease: "turnover"` is the safety property, so it is asserted as a DIFFERENCE from the two
   * vocabularies it would otherwise be confused with, not merely as a string.
   */
  it("releases a theatre into TURNOVER, where a room would go to cleaning and a floor to available", () => {
    const room = KERNEL_RESOURCE_KINDS.find((k) => k.kind === "room")!;
    const floor = KERNEL_RESOURCE_KINDS.find((k) => k.kind === "floor")!;
    expect({
      theatre: OT_RESOURCE_KINDS[0]!.onRelease, room: room.onRelease, floor: floor.onRelease,
    }).toEqual({ theatre: "turnover", room: "cleaning", floor: "available" });
    // `turnover` exists in NO other kind's vocabulary — that is why the theatre needed its own.
    expect(KERNEL_RESOURCE_KINDS.filter((k) => k.statuses.includes("turnover"))).toEqual([]);
  });

  /** F22 — ONE `blocked`, with the reason in `attributes.blockReason`, not three statuses. */
  it("carries exactly one blocked status, not a split vocabulary (F22)", () => {
    const statuses = OT_RESOURCE_KINDS[0]!.statuses;
    expect(statuses.filter((s) => s.startsWith("blocked"))).toEqual(["blocked"]);
  });

  /** 15c's autoclave and 15d's C-arm: `device` stays unclaimed by this phase. */
  it("leaves `device` unclaimed — 15c owns the autoclave", () => {
    expect(OT_RESOURCE_KINDS.map((k) => k.kind)).not.toContain("device");
  });

  it("names the recovery bay class once, for the seed and the reader to share", () => {
    expect(DAYCARE_RECOVERY_BAY_CLASS).toBe("daycare_recovery");
  });
});
