import { RESOURCE_KIND_VALUES } from "../db/schema/resources";
import type { ModuleRegistry } from "../modules/loader";
import { ResourceError } from "./errors";

/**
 * PLAN 13 T2 — the KIND SEAM: what a resource may BE, and what its status word may say.
 *
 * ═══ THE SET OF KINDS IS CLOSED; THE STATUS VOCABULARIES ARE NOT (DD4, as amended) ═══
 *
 * Read this boundary before adding anything, because it is the one Plan 15 will push on first.
 *
 *   OPEN, on the §4 manifest seam:  a module CLAIMS a kind and declares its status vocabulary.
 *   CLOSED, in this file:            the SET of kind names.
 *
 * So Plan 15 adds `theatre` and `device` on the mini-OT's own manifest, Plan 16 adds `store`,
 * Plan 17 adds `bench` and `analyzer` — and NONE of them edits kernel code, because those names are
 * already among the ten. An ELEVENTH kind is a kernel edit PLUS a migration PLUS the parity test
 * below, by design: the ten are also a CHECK constraint on the table (DD5), and a name that is
 * declarable but unstorable would fail at the INSERT with a constraint error instead of at boot
 * with a sentence.
 *
 * § 4A item 2 — "are instrument sets registry resources?" — was the first pressure on exactly this
 * boundary, and the owner RULED on 2026-08-26 that they are NOT: a CSSD set is a movable asset with
 * a sterility lifecycle (packed → sterilised → issued → used → returned → reprocessed, recalled by
 * autoclave load), not a place or a station. It would have been the first kind whose `status` was
 * not about occupancy, and DD6's triad would mean nothing for it. Recorded here because this file
 * is where the next person will come looking for permission to add one.
 */

/**
 * THE CLOSED UNION. The ten names the roadmap gives, and the ten `resources_kind_ck` enforces.
 *
 * Derived from `RESOURCE_KIND_VALUES` rather than retyped — the CHECK constraint was built from
 * that array in T1, and a second hand-written copy here would be §2.54's mechanism with the parity
 * test one commit behind it. What `kinds.test.ts` pins is the array against what POSTGRES actually
 * holds, which is the copy that can drift.
 */
export type ResourceKind = (typeof RESOURCE_KIND_VALUES)[number];

/** Re-exported so consumers name one import for the type and its values. */
export const RESOURCE_KINDS: readonly ResourceKind[] = RESOURCE_KIND_VALUES;

/**
 * DD7 — ONE CONSTANT, ONE OWNER, and it is a NUMBER rather than a rule, which is the only reason a
 * write guard and a tree reader can both be sure they mean the same thing by "too deep".
 *
 * SIX gives headroom over §11.18's four-level floor → ward/hall → room → bed without inviting a
 * hierarchy nobody can render. The write path (T3) walks ancestors to the root before every move
 * and refuses past this; the tree reader (T4) caps its own descent at the same number AND carries a
 * visited set, because a reader whose termination depends on the writer's correctness has not been
 * tested — that is A6, and it is proved against a cycle inserted by raw SQL.
 */
export const MAX_RESOURCE_DEPTH = 6;

/**
 * What a module says about a kind it owns. The `search?: SearchProvider[]` field on `ModuleManifest`
 * (Plan 11h T1 / DD1) is the same seam solving the same problem, and this follows it exactly.
 */
export type ResourceKindDecl = {
  /** A member of the closed union above. */
  kind: ResourceKind;
  /** The kind's WHOLE vocabulary. `status` has no CHECK constraint precisely because this is per-kind. */
  statuses: readonly string[];
  /** The status a newly created resource takes. */
  initial: string;
  /** The status an assignment sets; `null` ⇒ this kind is NOT ASSIGNABLE (a floor is not). */
  occupied: string | null;
  /** The status a release sets — a bed goes to CLEANING, not to available (§11.2's discharge cascade). */
  onRelease: string;
  /** The status meaning "no longer part of the hospital" (DD2 — this is what replaces `active: false`). */
  retired: string;
};

/**
 * THE FIVE STRUCTURAL KINDS, declared by the KERNEL because no module owns a floor.
 *
 * These are the vocabulary IPD and the mini-OT inherit, so they are worth getting right here rather
 * than discovering later: a status word is written into `resource_status_history` forever and a
 * rename is a data migration.
 */
export const KERNEL_RESOURCE_KINDS: readonly ResourceKindDecl[] = [
  /**
   * `floor`, `ward` and `hall` are CONTAINERS. `occupied: null` says a floor is not assignable —
   * and it is a stronger statement than "nobody assigns one today": `assignResource` refuses on it
   * with `not_assignable` (T3), so a module that tries has an error rather than a floor with an
   * occupant.
   */
  { kind: "floor", statuses: ["available", "blocked", "retired"], initial: "available", occupied: null, onRelease: "available", retired: "retired" },
  { kind: "ward", statuses: ["available", "blocked", "retired"], initial: "available", occupied: null, onRelease: "available", retired: "retired" },
  { kind: "hall", statuses: ["available", "blocked", "retired"], initial: "available", occupied: null, onRelease: "available", retired: "retired" },
  /**
   * `room` — the kind OPD's rooms become in T6. `active: true → available` and `active: false →
   * retired` is the whole of DD2's mapping, and `0032` writes it in SQL.
   */
  { kind: "room", statuses: ["available", "occupied", "cleaning", "blocked", "retired"], initial: "available", occupied: "occupied", onRelease: "cleaning", retired: "retired" },
  /**
   * `bed` — and **`onRelease: "cleaning"` IS §11.2's DISCHARGE CASCADE IN ONE FIELD**: bed released
   * → housekeeping task → cleaned → verified → available. A bed that returned straight to
   * `available` would put the next patient in an uncleaned bed. It is a one-WORD defect with a
   * patient on the other end of it, which is why it is spelled out here and asserted in the tests
   * rather than left to whoever writes the IPD discharge path.
   */
  { kind: "bed", statuses: ["available", "occupied", "cleaning", "blocked", "retired"], initial: "available", occupied: "occupied", onRelease: "cleaning", retired: "retired" },
];

/**
 * Every kind declaration every INSTALLED manifest makes, collected at boot.
 *
 * THERE IS NO SECOND LIST — `ALL_MANIFESTS` already answers "which modules exist" (Plan 11d D2),
 * and `collectProviders` (kernel/search/registry.ts) is the shipped precedent for reading kind
 * declarations off it rather than growing a registry of one's own. §2.54 applied before the drift
 * instead of after it.
 *
 * TWO REFUSALS, and both are BOOT errors rather than write-time ones on purpose — a hospital that
 * boots with two modules claiming `bed` has already lost the argument about which vocabulary is
 * real, and finding out at the first admission is worse than finding out at startup:
 *
 *   · **A kind declared by TWO manifests throws** (`duplicate_kind`, the `duplicate_provider`
 *     precedent). Two vocabularies for one kind means `onRelease` for a bed depends on which
 *     module's declaration a reader happened to find.
 *   · **A declaration whose `initial` / `occupied` / `onRelease` / `retired` is not among its own
 *     `statuses` throws** (`unknown_status`). That row would put a resource into a status its own
 *     kind does not admit, and every board filtering on the vocabulary would then silently omit it.
 *
 * A kind NO installed manifest declares is not an error here — it is simply absent, and
 * `createResource` refuses it with `unknown_kind` (T3, A4). That is the distinction A4 exists to
 * prove: `theatre` is a legal STRING (the CHECK admits it) and not a kind THIS HOSPITAL HAS until
 * Plan 15 installs the manifest that claims it.
 */
export function collectResourceKinds(registry: ModuleRegistry): ResourceKindDecl[] {
  const decls = registry.all().flatMap((m) => m.resourceKinds ?? []);
  const seen = new Map<string, ResourceKindDecl>();
  for (const d of decls) {
    if (seen.has(d.kind)) {
      throw new ResourceError(
        "duplicate_kind",
        `two manifests declare the resource kind "${d.kind}" — one kind has one vocabulary, and a ` +
          "second declaration makes onRelease depend on which one a reader happened to find",
      );
    }
    for (const [field, value] of [["initial", d.initial], ["occupied", d.occupied], ["onRelease", d.onRelease], ["retired", d.retired]] as const) {
      // `occupied: null` is the "not assignable" declaration and is legal by construction.
      if (value === null) continue;
      if (!d.statuses.includes(value)) {
        throw new ResourceError(
          "unknown_status",
          `resource kind "${d.kind}" declares ${field}="${value}", which is not among its own ` +
            `statuses [${d.statuses.join(", ")}] — a resource cannot hold a status its kind does not admit`,
        );
      }
    }
    seen.set(d.kind, d);
  }
  return [...seen.values()];
}

/** The declaration for one kind, or `undefined` when no installed manifest claims it. */
export function findKindDecl(decls: readonly ResourceKindDecl[], kind: string): ResourceKindDecl | undefined {
  return decls.find((d) => d.kind === kind);
}
