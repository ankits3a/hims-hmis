import { LAB_EVENTS, labOrderDesked, labReportPublished, labSpecimenReceived } from "./events";
import { labManifest } from "./manifest";

/**
 * PLAN 17 T2 / DD18 — the event catalogue: the grammar, the module tag, and the two properties a
 * consumer written against these names depends on.
 *
 * The grammar is `entity.verb_past` with the module carried SEPARATELY (`defineEvent` enforces the
 * shape and this file enforces that every one of ours is in the lab's namespace) — the `opd`,
 * `materials`, `membership`, `formulary` and `ot` convention, unchanged.
 */
describe("the lab's event catalogue (Plan 17 T2)", () => {
  it("declares twenty-seven events, every one `lab.*`, in the lab's module namespace", () => {
    expect(LAB_EVENTS).toHaveLength(27); // 17d: `tube_swap_suspected`, `specimen_relabelled`. 17-E T7: `result_chosen`. DD11: `night_release_reviewed`. F44: `reflex_refused`
    for (const event of LAB_EVENTS) {
      expect([event.name, event.module]).toEqual([event.name, "lab"]);
      expect(event.name.startsWith("lab.")).toBe(true);
      expect(event.version).toBe(1);
    }
  });

  it("the names are exactly DD18's list, plus the one this phase had to add", () => {
    expect(LAB_EVENTS.map((e) => e.name).sort()).toEqual([
      /**
       * FINDING F1 — `attribution.unverified_flagged` DOES NOT EXIST. DD15 said the desk emits it;
       * `modules/partners/events.ts` declares seven events and that is not one of them, and a module
       * may not emit a fact it never declared. It is declared in the LAB's namespace instead:
       * putting a `partners.*` name on this manifest would be a reach into another module's surface.
       */
      "lab.attribution_unverified_flagged",
      "lab.critical_acknowledged",
      "lab.label_printed",
      /**
       * DD11's compensating control. Night mode relaxes separation of duties; this is the record
       * that the second pair of hands arrived in the morning, naming BOTH people.
       */
      "lab.night_release_reviewed",
      "lab.notifiable_flagged",
      "lab.order_desked",
      "lab.recollection_requested",
      "lab.reflex_added",
      /** §9.2 F44 — a rule that fired and could not be acted on. Owed since 17b, paid at DD11. */
      "lab.reflex_refused",
      "lab.report_amended",
      "lab.report_print_blocked",
      "lab.report_printed",
      "lab.report_published",
      "lab.report_released_unpaid",
      /**
       * 17-E T7 — which of an analyser's two runs the report carries, and why. It is NOT in
       * `LAB_REALTIME_NAMES` and that is a decision, not an omission: the payload carries a
       * technologist's free-text reason, and 17c's rule for `lab:bench` is that a payload is
       * STRUCTURAL — no value crosses it. A sentence a human typed at a bench can contain one.
       */
      "lab.result_chosen",
      "lab.result_critical_flagged",
      "lab.result_delta_flagged",
      "lab.result_entered",
      "lab.result_verified",
      "lab.sla_breached",
      "lab.sod_violation_blocked",
      "lab.specimen_collected",
      "lab.specimen_received",
      "lab.specimen_rejected",
      /** 17d T2 — the smudged label re-typed at the bench, witnessed (design EdgeCases #12). */
      "lab.specimen_relabelled",
      "lab.tube_mismatch_flagged",
      /** 17d T1 — the near-miss the applicability rule exists to record (design EdgeCases #15). */
      "lab.tube_swap_suspected",
    ]);
  });

  it("no name is declared twice — a duplicate would make two payload schemas for one fact", () => {
    const names = LAB_EVENTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * THE MANIFEST CONSUMES NOTHING, AND `buildSubscriptionBus` IS WHY THAT MATTERS. A declared
   * subscription with no handler is a BOOT ERROR by design, so an empty array here is the honest
   * state of a module whose only cross-module inputs are function calls.
   *
   * `lab.notifiable_flagged` is EMITTED and consumed by nobody: 28a subscribes when the
   * notifiable-disease register exists. An event with no consumer is not a defect.
   */
  it("declares no subscription, so no handler can be missing", () => {
    expect(labManifest.subscriptions).toEqual([]);
  });

  /** The payloads a downstream plan is written against — validated by `make`, not by inspection. */
  it("the three load-bearing payloads validate, and refuse what they must", () => {
    const actor = { type: "user", id: "01USER0000000000000000001" } as const;
    // 24a reads `lab.order_desked` for the home-collection hand-off and IGNORES the invoice ids;
    // they are nullable because a lab-issued credit line has none at the moment of the event.
    expect(labOrderDesked.make({
      payload: {
        orderId: "o-1", orderNo: "L2608290001", orderGroupId: "g-1", patientId: "p-1",
        encounterNo: "V2608290001", itemIds: ["i-1"], invoiceId: null, invoiceNo: null,
        chargeReason: "lab_desk",
      },
      actor,
    }).payload).toMatchObject({ orderNo: "L2608290001", invoiceId: null });

    // An order desked with NO items is an order asking a department to do nothing — `placeOrder`
    // refuses it (`no_items`) and the event schema refuses to describe it either.
    expect(() => labOrderDesked.make({
      payload: {
        orderId: "o-1", orderNo: "L2608290001", orderGroupId: "g-1", patientId: "p-1",
        encounterNo: "V2608290001", itemIds: [], invoiceId: null, invoiceNo: null,
        chargeReason: "lab_desk",
      },
      actor,
    })).toThrow();

    // THE TAT CLOCK'S EVENT. `itemIds` may be empty here and that is deliberate: a tube received
    // whose every item was cancelled meanwhile is a real occurrence (CONTRACT 2's quarantine).
    expect(labSpecimenReceived.make({
      payload: { specimenId: "s-1", specimenNo: "S2608290001", orderGroupId: "g-1", itemIds: [], receivedBy: "u-1", at: "2026-08-29T10:00:00Z" },
      actor,
    }).payload).toMatchObject({ specimenNo: "S2608290001" });

    expect(labReportPublished.make({
      payload: {
        reportId: "r-1", orderId: "o-1", patientId: "p-1", version: 1, partial: false,
        channels: ["in_person"], signedBy: "u-9",
      },
      actor,
    }).payload).toMatchObject({ version: 1, partial: false });
    // Version 0 is not a version.
    expect(() => labReportPublished.make({
      payload: {
        reportId: "r-1", orderId: "o-1", patientId: "p-1", version: 0, partial: false,
        channels: [], signedBy: "u-9",
      },
      actor,
    })).toThrow();
  });
});
