import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ALL_MANIFESTS } from "../modules/manifests";
import { ModuleRegistry } from "../modules/loader";
import { RESOURCE_KIND_VALUES } from "../db/schema/resources";
import {
  KERNEL_RESOURCE_KINDS, MAX_RESOURCE_DEPTH, RESOURCE_KINDS, ResourceError, collectResourceKinds,
  findKindDecl, resourcesManifest,
} from "./index";
import type { ModuleManifest } from "../modules/manifest";
import type { ResourceKindDecl } from "./kinds";
import type { Db } from "../db/client";

/**
 * PLAN 13 T2 — the kind seam: what the boot collector refuses, and the parity T1 could not own.
 *
 * ═══ THE LEG T1 HANDED HERE, AND WHY IT COULD NOT STAY THERE ═══
 *
 * The plan's T1 acceptance names one assertion T1 cannot make: **the CHECK constraint's kind list
 * equal to the `ResourceKind` union.** The union lives in `kinds.ts`, which THIS task creates, and
 * the plan says in as many words that if T1 runs first the leg lands in T2. It did, so it does.
 *
 * The parity is asserted against POSTGRES, not against the schema file — `pg_get_constraintdef`,
 * the same source `resources.test.ts` reads. Comparing `RESOURCE_KIND_VALUES` to a union DERIVED
 * from `RESOURCE_KIND_VALUES` would be a tautology; the copy that can actually drift is the one the
 * MIGRATION baked into the database, and that is the one measured here. DD5 calls this §2.54's
 * approved remedy for two copies of one fact, and the remedy only works if the test reads the
 * copies rather than one copy twice.
 */
function decl(over: Partial<ResourceKindDecl> = {}): ResourceKindDecl {
  return { kind: "bed", statuses: ["available", "occupied", "retired"], initial: "available", occupied: "occupied", onRelease: "available", retired: "retired", ...over };
}

/** A registry holding exactly the manifests given, so a boot refusal can be provoked without booting. */
function registryOf(...manifests: ModuleManifest[]): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const m of manifests) registry.install(m);
  return registry;
}

function bare(key: string, over: Partial<ModuleManifest> = {}): ModuleManifest {
  return { key, title: key, menu: [], permissions: [], subscriptions: [], ...over };
}

describe("the resource kind seam (Plan 13 T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  // ───────────── the parity leg T1 deferred: the union against what Postgres holds ─────────────

  it("the ten-kind union and the resources_kind_ck CHECK are the same ten strings, in the same order", async () => {
    const rows = (await db.execute(sql`
      select pg_get_constraintdef(oid) as "def" from pg_constraint where conname = 'resources_kind_ck'
    `)).rows as { def: string }[];
    expect(rows).toHaveLength(1);
    const inPostgres = [...rows[0]!.def.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(inPostgres).toEqual([...RESOURCE_KINDS]);
    expect(inPostgres).toEqual([...RESOURCE_KIND_VALUES]);
    expect(inPostgres).toHaveLength(10);
  });

  it("MAX_RESOURCE_DEPTH is six, in one file, and both the write guard and the tree reader read it from here", () => {
    expect(MAX_RESOURCE_DEPTH).toBe(6);
  });

  // ─────────────────────────── what the kernel declares, and its shape ───────────────────────────

  it("the kernel declares the five structural kinds, because no module owns a floor", () => {
    expect(KERNEL_RESOURCE_KINDS.map((d) => d.kind)).toEqual(["floor", "ward", "hall", "room", "bed"]);
    expect(resourcesManifest.resourceKinds).toBe(KERNEL_RESOURCE_KINDS);
  });

  /**
   * `onRelease: "cleaning"` on a bed IS §11.2's discharge cascade, in one field. Asserted by name
   * rather than left to the declaration table, because it is a one-WORD defect with a patient on
   * the other end of it: a bed that returned straight to `available` would be offered to the next
   * admission uncleaned.
   */
  it("a released bed goes to CLEANING and not to available — the discharge cascade in one field", () => {
    const bed = findKindDecl(KERNEL_RESOURCE_KINDS, "bed");
    expect(bed?.onRelease).toBe("cleaning");
    expect(findKindDecl(KERNEL_RESOURCE_KINDS, "room")?.onRelease).toBe("cleaning");
  });

  it("a floor is not assignable, and `occupied: null` is how a kind says so", () => {
    for (const kind of ["floor", "ward", "hall"]) {
      expect({ kind, occupied: findKindDecl(KERNEL_RESOURCE_KINDS, kind)?.occupied }).toEqual({ kind, occupied: null });
    }
    for (const kind of ["room", "bed"]) {
      expect({ kind, occupied: findKindDecl(KERNEL_RESOURCE_KINDS, kind)?.occupied }).toEqual({ kind, occupied: "occupied" });
    }
  });

  it("every declared initial/occupied/onRelease/retired is a member of its own kind's statuses", () => {
    for (const d of KERNEL_RESOURCE_KINDS) {
      const named = [d.initial, d.onRelease, d.retired, ...(d.occupied === null ? [] : [d.occupied])];
      expect({ kind: d.kind, outside: named.filter((s) => !d.statuses.includes(s)) }).toEqual({ kind: d.kind, outside: [] });
    }
  });

  // ────────────────────────────── what the boot collector REFUSES ──────────────────────────────

  /**
   * PLAN 14 T2 / DD2 — **THIS LEG MOVED, AND THE MOVE IS THE SEAM WORKING AS DESIGNED.**
   *
   * The kernel five became six when `materialsManifest` claimed `store`. That is exactly what
   * `kinds.ts`'s header promises — *"a module CLAIMS a kind and declares its status vocabulary,
   * with NO kernel edit"* — and `store` was already among the ten `RESOURCE_KIND_VALUES`, so no
   * migration was needed either. The only kernel-side cost of the claim is this line, which is the
   * friction the census exists to create: a kind cannot join the running system without somebody
   * editing an assertion that names it.
   *
   * The order is APPEND: the collector walks `registry.all()` in `ALL_MANIFESTS` order and
   * `materialsManifest` is the fourteenth and last, so `store` lands after `bed` rather than
   * anywhere else.
   *
   * **This file was NOT in Plan 14 T2's Files list** and it pins a number that task moves — the
   * shape 16a hit four times, recorded here and in the phase document's CLOSE as finding F6 rather
   * than fixed silently (AGENT-RULES: disclose-don't-work-around).
   */
  it("collects every installed manifest's declarations: the kernel five plus materials' `store`", () => {
    expect(collectResourceKinds(registryOf(...ALL_MANIFESTS)).map((d) => d.kind))
      .toEqual(["floor", "ward", "hall", "room", "bed", "store"]);
  });

  /**
   * A BOOT ERROR, not a write-time one. Two vocabularies for one kind means `onRelease` for a bed
   * depends on which module's declaration a reader happened to find — and finding that out at the
   * first discharge is worse than finding it out at startup.
   */
  it("two manifests claiming one kind is a boot error", () => {
    const registry = registryOf(
      bare("a", { resourceKinds: [decl({ kind: "bed" })] }),
      bare("b", { resourceKinds: [decl({ kind: "bed", onRelease: "retired" })] }),
    );
    expect(() => collectResourceKinds(registry)).toThrow(ResourceError);
    expect(() => collectResourceKinds(registry)).toThrow(/two manifests declare the resource kind "bed"/);
  });

  it("a declaration naming a status outside its own vocabulary is a boot error, for each of the four fields", () => {
    for (const field of ["initial", "occupied", "onRelease", "retired"] as const) {
      const registry = registryOf(bare("a", { resourceKinds: [decl({ [field]: "sterilising" })] }));
      expect(() => collectResourceKinds(registry)).toThrow(new RegExp(`${field}="sterilising"`));
    }
  });

  /**
   * `occupied: null` must NOT be caught by the membership check above — it is the "not assignable"
   * declaration, and a collector that rejected it would make a floor undeclarable. The leg is here
   * because `null` is the one value in that loop that is legal by construction, and a reader
   * tightening the check would break exactly three of the five kernel kinds.
   */
  it("`occupied: null` is legal and is not mistaken for a status outside the vocabulary", () => {
    const registry = registryOf(bare("a", { resourceKinds: [decl({ kind: "floor", statuses: ["available", "retired"], occupied: null, onRelease: "available", retired: "retired" })] }));
    expect(collectResourceKinds(registry).map((d) => d.occupied)).toEqual([null]);
  });

  /**
   * A kind no installed manifest declares is NOT an error here — it is simply absent, and the write
   * path refuses it (T3, A4). This leg pins the distinction, because it is the whole difference
   * between "a legal string" and "a kind this hospital has": `theatre` is in the CHECK, so Postgres
   * would store it, and Plan 15 is what makes it declarable.
   */
  it("an undeclared kind is absent rather than refused — `theatre` is legal in the table and not yet a kind this hospital has", () => {
    const decls = collectResourceKinds(registryOf(...ALL_MANIFESTS));
    expect(findKindDecl(decls, "theatre")).toBeUndefined();
    expect(RESOURCE_KINDS).toContain("theatre");
  });

  /**
   * CLOSE PASS 2 / m4 — a kind whose `initial` IS its `occupied` would make every `createResource`
   * for it default to the occupied status with no occupant: R1's state, produced by DECLARATION
   * rather than by a caller. Refused at boot, where the collector refuses every other declaration
   * error, because Plan 15 writes the first declaration this file did not.
   */
  it("a kind whose `initial` is also its `occupied` is a boot error — it would create every resource occupied", () => {
    const registry = registryOf(bare("a", { resourceKinds: [decl({ initial: "occupied" })] }));
    expect(() => collectResourceKinds(registry)).toThrow(/which is also its occupied/);
    // The SHIPPED declarations do not trip it — the guard is real, not vacuous. Six since Plan 14
    // T2 added `store`, whose `initial` is `available` and whose `occupied` is null: a store is not
    // assignable at all, so it could not trip this guard even in principle.
    expect(collectResourceKinds(registryOf(...ALL_MANIFESTS))).toHaveLength(6);
  });

  it("a manifest with no resourceKinds contributes nothing and is not an error", () => {
    expect(collectResourceKinds(registryOf(bare("a"), bare("b")))).toEqual([]);
  });
});
