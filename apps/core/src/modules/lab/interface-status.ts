import { eq } from "drizzle-orm";
import { labInstruments, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { interfaceDown, interfaceRestored } from "../../kernel/ops/events";
import { changeResourceStatus } from "../../kernel/resources/registry";
import { LAB_RESOURCE_KINDS } from "./kinds";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

/**
 * ═══ 17-E T7b — THE FIRST WRITER OF `interface_down`, AND IT IS A BRIDGE, NOT A MECHANISM ═══
 *
 * `lab/kinds.ts` has declared `interface_down` on the `analyzer` kind since 17-E T1, with its own
 * note that the status is *"separate from `maintenance`"* because *"the machine is fine and the LINK
 * is not"*. **Nothing has ever written it.** ROADMAP v2 §1 Q5 rules how it must be written:
 *
 *     "`interface_down` is written only by the bridge's own heartbeat lapse, never by idleness."
 *
 * ═══ THE KERNEL ALREADY ENFORCES THE HARD HALF, SO THIS FILE DOES NOT RE-DECIDE IT ═══
 *
 * `kernel/ops/interfaces.ts` (Plan 11c D6) is the heartbeat framework, and its Book V10 rule IS Q5's
 * rule already: *"A REGISTERED-BUT-NEVER-SEEN INTERFACE IS NEVER DOWNED. `last_seen_at IS NULL` means
 * `unknown`, and `unknown` is not `down`."* The tenth worker job judges each device against **its
 * own** `stale_after_ms` rather than a global constant, downs only rows currently `up`, and appends
 * `interface.down` / `interface.restored` on the two edges.
 *
 * **So T7b adds no heartbeat column and no second sweep.** A second sweep would be a second answer to
 * a question the kernel already answers, which is the shape §2.54 exists to stop — the same sentence
 * `lab/events.ts` uses to refuse a `patient.merged` consumer. What was missing was never the
 * mechanism; it was the **join**: no row anywhere said which `interfaces` row an analyser's bridge
 * heartbeats on, so the two edges the kernel has been emitting since Plan 11c had nowhere to land.
 *
 * ═══ AND THE HEARTBEAT MUST BE SEPARATE FROM SENDING RESULTS ═══
 *
 * If the arrival of results were the liveness signal, an analyser with nothing to run at 03:00 would
 * read as a dead link — which is precisely the idleness Q5 forbids. The bridge pings on a timer
 * whether or not it has anything to say, so **the distinction between "quiet" and "gone" is enforced
 * by the timer's existence rather than by anyone deciding what counts as idle.**
 */
export const LAB_INTERFACE_CONSUMER = "lab.interface_status";

/**
 * The `system` identity the status change is made as, and it is deliberately not a person.
 *
 * A bridge going quiet is observed by a sweep; `resource_status_history` keeps `updated_by` for ever,
 * and putting the name of whoever last touched the machine on that row would attribute an act nobody
 * performed. The kernel's own sweep uses the same shape (`SWEEP_ACTOR` in `kernel/ops/interfaces.ts`).
 */
export const LAB_INTERFACE_ACTOR: Actor = { type: "system", id: "lab-interface-status" };

/**
 * ═══ THE LINK OUTAGE IS THE WEAKEST OUT-OF-SERVICE REASON, AND BOTH EDGES YIELD TO A STRONGER ONE ═══
 *
 * The `analyzer` vocabulary has seven statuses and five of them mean the machine is unavailable:
 * `qc_locked`, `calibration_due`, `maintenance`, `interface_down`, `retired`. Only one of them is
 * about the CABLE. So both directions are conditional, and they are conditional symmetrically:
 *
 *   down    — writes `interface_down` **only over `available`**. A machine whose QC has failed, whose
 *             calibration is overdue, that the engineer has, or that is decommissioned is already
 *             out of service for a truer reason, and overwriting it with "the link is down" would
 *             lose the reason a technician needs in order to act.
 *   restore — writes `available` **only over `interface_down`**. It must never PROMOTE a machine out
 *             of a state it did not put it in: an analyser under `maintenance` when its bridge came
 *             back is still under maintenance, and a consumer that wrote `available` unconditionally
 *             would silently clear an engineer's lockout — a status change nobody asked for, made by
 *             a heartbeat.
 *
 * **NOTHING IS LOST WHEN THE PROJECTION YIELDS.** `interfaces.status` is the truth about the link and
 * the kernel keeps it either way; `resources.status` is a PROJECTION of that truth onto the estate
 * board, and a projection that overwrote a stronger fact would be worse than one that defers.
 *
 * `in_use` is the case that reads like a hole and is not one today: **nothing in the tree assigns an
 * `analyzer` resource** (the lab writes no `assignResource`; radiology, the OT, materials and OPD own
 * every call site), so an analyser is never occupied. When a later task makes one occupied it will
 * own reconciling on release — `onRelease: "available"` is already the analyser's declared landing
 * status, and `changeResourceStatus` refuses to move a resource off its `occupied` status without
 * `releaseResource` (DD6), which is why this consumer must not attempt it: the throw would park a
 * delivery in `event_dead_letters` over an ordinary state.
 */
export function labInterfaceConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    const down = e.name === interfaceDown.name;
    if (!down && e.name !== interfaceRestored.name) return;

    const payload = e.payload as { interfaceId?: unknown } | null;
    const interfaceId = typeof payload?.interfaceId === "string" ? payload.interfaceId : null;
    if (interfaceId === null) return;

    /**
     * NO LINKED INSTRUMENT IS THE ORDINARY CASE, NOT AN ERROR. Every printer and scanner registered
     * anywhere in the hospital raises these two names, and the laboratory has an opinion about
     * exactly the ones a registered analyser bridge sits on. This is the `kind !== "imaging"` line of
     * `radiology/consumers.ts`, asked of a join instead of a payload field.
     */
    const [instrument] = await db
      .select({ resourceId: labInstruments.resourceId, active: labInstruments.active })
      .from(labInstruments)
      .where(eq(labInstruments.interfaceId, interfaceId));
    if (instrument === undefined || !instrument.active) return;

    await withTx(db, async (tx) => {
      /**
       * READ THE STATUS IN THE SAME TRANSACTION THAT WRITES IT, `FOR UPDATE`. Two sweeps in the same
       * second — the shape `kernel/ops/interfaces.ts`'s header refuses to let correctness rest on the
       * scheduler's advisory lock for — would otherwise both read `available` and both append a
       * `resource.status_changed`, so the board would carry two identical transitions for one outage.
       */
      const [current] = await tx
        .select({ status: resources.status })
        .from(resources)
        .where(eq(resources.id, instrument.resourceId))
        .for("update");
      if (current === undefined) return;

      const from = down ? "available" : "interface_down";
      if (current.status !== from) return;

      await changeResourceStatus(
        tx, LAB_INTERFACE_ACTOR, LAB_RESOURCE_KINDS, instrument.resourceId,
        down ? "interface_down" : "available",
        {
          reason: down
            ? "the bridge stopped heartbeating (kernel interface sweep)"
            : "the bridge is heartbeating again",
          /**
           * THE EVENT'S OWN INSTANT, NEVER THE DISPATCHER'S CLOCK (Plan 10 D5). A delivery retried an
           * hour later records the outage at the minute it happened rather than at the minute the
           * worker caught up, so `resource_status_history` reads the same either way.
           */
          at: e.occurredAt,
        },
      );
    });
  };
}
