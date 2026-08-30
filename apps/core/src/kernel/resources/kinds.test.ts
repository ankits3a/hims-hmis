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
  it("collects every installed manifest's declarations: the kernel five, materials' `store` and the OT's `theatre`", () => {
    // PLAN 15 T2 / DD3 — SEVEN. The OT claims exactly ONE kind, and the order is manifest install
    // order: `resources` (the kernel five) then `materials` then `ot`. **THIS FILE IS NOT IN PLAN 15
    // T2's FILES LIST** — it pins a census that task moves, recorded as finding T2-f rather than
    // fixed silently, exactly as Plan 14 recorded its own F11 against `worker-runtime.e2e.test.ts`.
    // PLAN 17 T2 / DD17 — NINE. The lab claims TWO (`bench`, `analyzer`), both already among the
    // ten names this file closes and the `resources_kind_ck` CHECK enforces — Plan 13 DD4 reserved
    // them for this plan — so the lab adds two VOCABULARIES and no kind, and edits neither
    // `kinds.ts` nor `schema/resources.ts`. `analyzer` is written by nobody until 17-E;
    // `modules/lab/kinds.ts` carries the argument for declaring it here anyway, which is the exact
    // inverse of the OT's argument for leaving `device` unclaimed. **THIS FILE IS NOT IN PLAN 17
    // T2's FILES LIST** — it pins a census that task moves, recorded as finding F6 rather than
    // fixed silently, exactly as Plan 15 recorded T2-f and Plan 14 recorded F11.
    // PLAN 18a T2 — TEN, and `device` is the LAST of the ten names `resources_kind_ck` admits to
    // find a declarer. Radiology claims it for the whole hospital: `collectResourceKinds` refuses a
    // SECOND declaration, so the cath lab (63) and biomedical engineering (29) inherit this
    // vocabulary rather than writing their own. THIS FILE IS NOT IN 18a T2's FILES LIST either — it
    // pins a census that task moves, recorded as finding F11 rather than fixed silently, the same
    // way Plan 17 recorded F6 and Plan 15 recorded T2-f.
    expect(collectResourceKinds(registryOf(...ALL_MANIFESTS)).map((d) => d.kind))
      .toEqual(["floor", "ward", "hall", "room", "bed", "store", "theatre", "bench", "analyzer", "device"]);
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
   * between "a legal string" and "a kind this hospital has".
   *
   * **PLAN 15 T2 — `theatre` HAS NOW BEEN CLAIMED, so this leg moves to `device`.** The property is
   * unchanged and is the point of the kind seam; what changed is which kind demonstrates it. `device`
   * is in the CHECK (Postgres would store it) and no installed manifest declares it — the autoclave
   * is 15c's and the C-arm 15d's. The `theatre` half of the old assertion is now the leg above, and
   * both directions are still pinned: `theatre` present, `device` absent, both legal strings.
   */
  it("the collected set is what manifests DECLARE, not what the CHECK admits — now that the two coincide", () => {
    const decls = collectResourceKinds(registryOf(...ALL_MANIFESTS));

    /**
     * ═══ PLAN 18a T2 — THIS ASSERTION LOST ITS SUBJECT, AND IS REWRITTEN RATHER THAN DELETED ═══
     *
     * It used to read *"`device` is legal in the table and not yet a kind this hospital has"*.
     * `device` was the last of the ten unclaimed names, and radiology claims it — so there is no
     * legal-but-undeclared kind left to point at, and the old assertion would now be pinning a
     * falsehood.
     *
     * The PROPERTY it existed for is untouched and is what this asserts instead: the collector
     * reads MANIFESTS, never `RESOURCE_KIND_VALUES`. Proved by removing manifests and watching the
     * collected set shrink while the CHECK vocabulary does not move — which is the same fact the
     * old test made with `device`, stated in a way that survives every kind being claimed.
     *
     * If a future migration widens `resources_kind_ck` with an eleventh name, that name is legal
     * and undeclared on the day it lands, and the first leg below starts failing usefully again.
     */
    expect(decls.map((d) => d.kind).sort()).toEqual([...RESOURCE_KINDS].sort());

    const withoutOt = collectResourceKinds(registryOf(...ALL_MANIFESTS.filter((m) => m.key !== "ot")));
    expect(findKindDecl(withoutOt, "theatre")).toBeUndefined();
    expect(RESOURCE_KINDS).toContain("theatre");

    const withoutRadiology = collectResourceKinds(
      registryOf(...ALL_MANIFESTS.filter((m) => m.key !== "radiology")),
    );
    expect(findKindDecl(withoutRadiology, "device")).toBeUndefined();
    expect(RESOURCE_KINDS).toContain("device");

    // …and the kind Plan 15 claimed is present with the vocabulary the mini-OT declared: the seam
    // let a module add a kind with no kernel edit, which is what Plan 13 built it for.
    expect(findKindDecl(decls, "theatre")?.onRelease).toBe("turnover");
    // Radiology's, for the same reason and with the difference that matters: a gantry releases to
    // `available` where a theatre releases to `turnover`.
    expect(findKindDecl(decls, "device")?.onRelease).toBe("available");
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
    //
    // SEVEN since Plan 15 T2 added `theatre` — and this is the FIRST shipped declaration that could
    // have tripped it, which is why the guard was written. A theatre IS assignable (`occupied:
    // "in_use"`), so an author who had picked `in_use` as the initial status — a plausible mistake
    // for a kind whose whole vocabulary is about being in use — would have created every theatre
    // occupied with no occupant. The close pass that added this guard said in as many words that
    // "Plan 15 is the first phase to write a declaration this file did not"; it was right.
    // NINE since Plan 17 T2 added `bench` and `analyzer`. `analyzer` is the SECOND shipped
    // declaration that could have tripped this guard — its vocabulary is `in_use`-centred exactly
    // as the theatre's is — and the third if you count that `bench`'s own `occupied` is the word
    // `occupied`, which is the most natural thing to have written as an initial status.
    expect(collectResourceKinds(registryOf(...ALL_MANIFESTS))).toHaveLength(10);
  });

  it("a manifest with no resourceKinds contributes nothing and is not an error", () => {
    expect(collectResourceKinds(registryOf(bare("a"), bare("b")))).toEqual([]);
  });
});
