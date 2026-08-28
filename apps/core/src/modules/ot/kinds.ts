import type { ResourceKindDecl } from "../../kernel/resources/kinds";

/**
 * PLAN 15 T1 / DD3 — **ONE KIND, `theatre`, AND THE BAYS ARE THE KERNEL'S `bed`.**
 *
 * ═══ THE FINDING THIS FILE IS BUILT AROUND (adversarial pass F1) ═══
 *
 * The brainstorm record said *"nobody has claimed `bed`"* and proposed that this module claim
 * `theatre` **and** `bed` for the two recovery bays. It is wrong, and it is wrong at BOOT rather
 * than at the first admission: `KERNEL_RESOURCE_KINDS` (kernel/resources/kinds.ts) already declares
 * `floor, ward, hall, room, bed`, and `collectResourceKinds` throws `duplicate_kind` on a second
 * declaration of any of them — deliberately, because "one kind has one vocabulary, and a second
 * declaration makes onRelease depend on which one a reader happened to find".
 *
 * So the two day-care recovery bays are KERNEL `bed` rows. They inherit the kernel's vocabulary
 * unchanged — including **`onRelease: "cleaning"`, which is §11.2's discharge cascade in one
 * field**: a bay released by `dischargeDaycare` goes to housekeeping, never straight back to
 * `available` for the next patient. That is a better outcome than a private OT vocabulary would
 * have been, and it is the seam working as designed rather than a concession.
 *
 * What distinguishes a day-care bay from a future ward bed is `attributes.class = "daycare_recovery"`
 * (R-3.9 — a CODE, with no tariff link: day-care bills by procedure package, never by bed-hours,
 * per Plan 13 §4A-1) and `parent_id` = the theatre. Containment is legal in the registry.
 *
 * ═══ WHY `theatre` NEEDS ITS OWN VOCABULARY ═══
 *
 * A theatre is not a room. `turnover` — the interval between wheel-out and the next wheel-in, when
 * the theatre is neither free nor occupied — has no equivalent in the kernel's `room` vocabulary,
 * and it is the status the whole day's list scheduling reads. `onRelease: "turnover"` is therefore
 * the same kind of one-word safety property `bed`'s `cleaning` is: a theatre that returned straight
 * to `available` would let the list screen offer a slot in a room still holding the last case's
 * instruments.
 *
 * **`blocked` is ONE status with the reason in `attributes.blockReason`** (`env | equipment |
 * incident`), not three statuses (adversarial finding F22). Death on the table sets
 * `incident` (R-3.22). A status word is written into `resource_status_history` for ever, so the
 * split — if 15d's telemetry ever needs it — is a vocabulary migration, and doing it now on
 * speculation would be three words nobody can retire.
 *
 * ═══ `initial` MUST NOT EQUAL `occupied`, AND THE KERNEL CHECKS IT ═══
 *
 * `collectResourceKinds` refuses a declaration whose `initial` is its `occupied` — every resource
 * would be created occupied with no occupant. Plan 13's own close pass added that refusal
 * specifically because *"Plan 15 is the first phase to write a declaration this file did not"*.
 * `available` / `in_use` satisfies it; `kinds.test.ts` proves it by running the collector.
 *
 * ═══ `device` STAYS UNCLAIMED ═══
 *
 * The autoclave is 15c's (CSSD-lite) and the C-arm is 15d's. Claiming `device` here to hold a row
 * nothing writes would put the kind's vocabulary in the module that does not own the tables keyed
 * on it — materials' `kinds.ts` header states that trap and this file does not spring it.
 */
export const OT_RESOURCE_KINDS: readonly ResourceKindDecl[] = [
  {
    kind: "theatre",
    statuses: ["available", "reserved", "in_use", "turnover", "blocked", "retired"],
    initial: "available",
    /** `signIn` assigns the theatre to the case; the registry's own occupancy check is B1's lock. */
    occupied: "in_use",
    /** NOT `available` — see the header. Wheel-out releases into turnover, and a human clears it. */
    onRelease: "turnover",
    retired: "retired",
  },
];

/**
 * `attributes.class` on the two recovery bays (R-3.9). Exported so `seed-ot.ts` and the recovery
 * reader name the same string — one constant, one owner (16a DD5).
 */
export const DAYCARE_RECOVERY_BAY_CLASS = "daycare_recovery";
