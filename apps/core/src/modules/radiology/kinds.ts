import type { ResourceKindDecl } from "../../kernel/resources/kinds";

/**
 * PLAN 18a T2 / DD6 — **THIS MANIFEST DECLARES `device` FOR THE WHOLE HOSPITAL.**
 *
 * ═══ WHY THAT SENTENCE MATTERS MORE THAN THE SIX WORDS BELOW ═══
 *
 * `resources_kind_ck` has admitted `device` since Plan 13 and **nobody has claimed it** (measured at
 * kickoff: `grep -rn 'kind: "device"' apps/core/src --include=*.ts | grep -v test` → 0).
 * `collectResourceKinds` refuses a SECOND manifest declaring the same kind at BOOT with
 * `duplicate_kind`, because *"two vocabularies for one kind means `onRelease` for a bed depends on
 * which module's declaration a reader happened to find"*.
 *
 * So the FIRST module to declare `device` fixes the status vocabulary for the cath lab (63), for
 * biomedical engineering (29), and for every injector, portable and C-arm that comes after. That is
 * radiology, here, now — and the consequence is stated in this phase's CONTRACT (§6.4) so a later
 * plan does not arrive wanting `commissioning` and find a closed door.
 *
 * **IT IS NOT A CLOSED DOOR.** A later phase widens THIS declaration by a disclosed edit to this
 * file — exactly as `0036` widened the OT's incident kinds — and does NOT declare `device` again.
 * The vocabulary is one list with one owner; the owner is this constant.
 *
 * ═══ THE SIX STATUSES, AND WHY EACH IS HERE ═══
 *
 *   · `available` — `initial` AND `onRelease`. A CT that finishes a scan is immediately bookable;
 *     there is no cleaning cascade for a gantry the way there is for a bed (`bed`'s `onRelease` is
 *     `cleaning`, and that difference is the whole reason the field is per-kind).
 *   · `in_use` — `occupied`. Written by `assignResource` at `startAcquisition`, cleared by
 *     `releaseResource` at `recordAcquired` (DD8). "Which study is on the CT right now" is then a
 *     registry read rather than a radiology join.
 *   · `down` — the tube failed (G1). Refuses scheduling and, through the registry's own check,
 *     refuses assignment.
 *   · `qa_blocked` — G2, the mammography QA failure. **The status EXISTS in this phase's vocabulary
 *     and this phase only HONOURS it**; the workflow that puts a device into it and takes it out is
 *     18c's. Declaring it now is what lets 18c ship without a migration or a vocabulary edit.
 *   · `maintenance` — planned, unlike `down`.
 *   · `retired` — DD2's replacement for an `active` flag. A sold machine keeps its history, its
 *     Form F serial series and every study that names it.
 *
 * `initial` differs from `occupied`, which the collector checks at boot (its m4 rule): a kind whose
 * `initial` IS its `occupied` would create every device occupied with no occupant.
 *
 * ═══ WHAT THIS BUYS T4 AND T7 FOR FREE, MEASURED AT KICKOFF (spike S3) ═══
 *
 * `assignResource` refuses any resource whose status is neither `initial` nor `onRelease`
 * (`registry.ts:475`). With both set to `available`, **a device in `down`, `qa_blocked`,
 * `maintenance`, `retired` or `in_use` is refused `already_occupied` by the KERNEL** — so G2 at
 * acquisition start costs this module no code of its own. Scheduling still needs its own check
 * (T4 A2), because booking a slot for Thursday assigns nothing today.
 */
export const RADIOLOGY_RESOURCE_KINDS: readonly ResourceKindDecl[] = [
  {
    kind: "device",
    statuses: ["available", "in_use", "down", "qa_blocked", "maintenance", "retired"],
    initial: "available",
    occupied: "in_use",
    onRelease: "available",
    retired: "retired",
  },
];

/**
 * The statuses that admit a NEW BOOKING (T4 A2). Deliberately narrower than "not retired" and
 * deliberately WIDER than "available":
 *
 *   · `in_use` is bookable — the CT is scanning someone now and is free at 15:00. A check that
 *     refused `in_use` would make a busy machine unbookable, which is the opposite of a scheduler.
 *   · `down`, `qa_blocked`, `maintenance` and `retired` are not. G1/G2: the Monday-09:00 CT with a
 *     failed tube must stop taking bookings the moment somebody says the tube failed, or the
 *     rebooking cascade starts on Monday morning with a waiting room full of people.
 *
 * One constant with one owner (16a DD5): the scheduler and the console must not answer this
 * question two ways.
 */
export const SCHEDULABLE_DEVICE_STATUSES: readonly string[] = ["available", "in_use"];

/** The `attributes.modality` key every `device` resource carries — one constant, one owner. */
export const DEVICE_MODALITY_ATTRIBUTE = "modality";

/**
 * 18a-iii T3 / D4 — the `attributes.portable` key that marks a MOBILE unit: the ward X-ray trolley,
 * the portable ultrasound, the C-arm. Declared beside `modality` because this file owns the device
 * attribute vocabulary, and `resources.attributes` is free jsonb — so marking a machine portable
 * takes no migration and no schema edit, only a registry entry.
 *
 * **The rule it backs is deliberately ONE-DIRECTIONAL.** A bedside location may only be recorded on
 * a portable device; a portable device may perfectly well be used in the department, wheeled into a
 * room, and demanding a bedside location for it would make the rule false in an ordinary case. So
 * "is this a portable study" is answered by whether it has a PLACE, not by which machine it used.
 */
export const DEVICE_PORTABLE_ATTRIBUTE = "portable";

/**
 * The modalities this slice ships study types for. `attributes.modality` on a `device` resource is
 * matched against a study type's `modality` (T4 A3), so a spelling that drifts between the seed and
 * the scheduler produces a machine nothing can be booked on — 16a's DD5 again, and the reason both
 * read this list.
 */
export const IMAGING_MODALITIES = ["xray", "usg", "ct", "mri", "mammography"] as const;

export type ImagingModality = (typeof IMAGING_MODALITIES)[number];
