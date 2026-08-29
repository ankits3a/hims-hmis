import type { ResourceKindDecl } from "../../kernel/resources/kinds";

/**
 * PLAN 17 T2 / DD17 — **THE LAB DECLARES `bench` AND `analyzer`, AND USES ONLY `bench`.**
 *
 * Both names are already among the ten in `kernel/resources/kinds.ts` and its `resources_kind_ck`
 * CHECK — Plan 13 DD4 reserved them for this plan in as many words — so this file adds no kernel
 * kind and no migration. What it adds is each kind's STATUS VOCABULARY, which is per-kind, written
 * into `resource_status_history` for ever, and therefore the thing worth getting right once.
 *
 * ═══ WHY `analyzer` IS DECLARED HERE WHEN NOTHING IN THIS PHASE WRITES ONE ═══
 *
 * This is the one place the OT's `kinds.ts` reasoning is deliberately NOT copied. That file leaves
 * `device` unclaimed and says why: *"claiming `device` here to hold a row nothing writes would put
 * the kind's vocabulary in the module that does not own the tables keyed on it."* The lab is the
 * opposite case on exactly that test — **17-E's analyzer drivers write `lab_results.analyzer_id`,
 * which is a column in THIS module's tables** (T1), so the module that owns the rows is this one,
 * whichever plan ships the driver. Declaring it now means 17-E adds drivers and no vocabulary; the
 * alternative is 17-E declaring a vocabulary for a column it inherited, which is the trap the OT's
 * header names, arriving from the other side.
 *
 * ═══ `qc_locked` AND `calibration_due` ARE STATUSES, NOT FLAGS, AND 17-E DEPENDS ON IT ═══
 *
 * A machine whose QC has failed is not "available with a warning": the whole point of a QC lockout
 * is that a result cannot be released from it, and a status word is what the worklist reads and
 * what `resource_status_history` keeps. `interface_down` is separate from `maintenance` because the
 * machine is fine and the LINK is not — a bench can still run it manually and key the printout
 * (`entry_mode = 'manual_from_printout'`, T1), which is E19's whole answer to a core-lab outage.
 *
 * ═══ `initial` MUST NOT EQUAL `occupied`, AND THE COLLECTOR CHECKS IT ═══
 *
 * `collectResourceKinds` refuses a declaration whose `initial` IS its `occupied` — every resource
 * would be created occupied with no occupant. `available` / `in_use` satisfies it for the analyzer;
 * `available` / `occupied` for the bench, and `kinds.test.ts` proves it by RUNNING the collector
 * rather than by reading these literals.
 */
export const LAB_RESOURCE_KINDS: readonly ResourceKindDecl[] = [
  /**
   * A BENCH — the haematology counter, the biochemistry bay. `lab_orderables.bench_key` names one,
   * and the bench worklist (T8) is keyed on it. `closed` is the night bench that is not retired:
   * a lab runs three benches by day and one at 02:00, and a status that could only say "retired"
   * would make the night shift look like a decommissioned department.
   */
  {
    kind: "bench",
    statuses: ["available", "occupied", "closed", "retired"],
    initial: "available",
    occupied: "occupied",
    /** Straight back to available: a bench needs no cleaning interval the way a bed or theatre does. */
    onRelease: "available",
    retired: "retired",
  },
  /**
   * AN ANALYZER — declared, and written by nobody until 17-E. Every status after `in_use` exists
   * because 17-E's driver will need to say it: QC failed, calibration is overdue, the engineer has
   * it, the link is down.
   */
  {
    kind: "analyzer",
    statuses: [
      "available", "in_use", "qc_locked", "calibration_due", "maintenance", "interface_down", "retired",
    ],
    initial: "available",
    occupied: "in_use",
    /**
     * `available`, and the reasoning is the opposite of `bed`'s `cleaning` rather than a copy of
     * it. A bed ALWAYS needs a human step between two occupants; an analyzer needs one only when
     * its QC failed, which is a fact 17-E's driver reads from the run and writes as `qc_locked`
     * directly. Setting `qc_locked` on every release would make the safe state unreachable without
     * a QC module — every analyzer would sit locked from its first run, in a phase that ships no
     * way to unlock one. **17-E owns the release rule and this is the honest default until it does.**
     */
    onRelease: "available",
    retired: "retired",
  },
];
