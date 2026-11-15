import { radiologyTopicRouter } from "../realtime";
import type { TailedEvent } from "../../../kernel/realtime/tail";

/**
 * ACCEPTANCE — issue #1083, spec docs/specs/1083-imaging-live-lists.md (owner APPROVED 2026-11-14), the
 * router half: which imaging lists an event wakes.
 *
 * `route` applies the gateway's own fan-out rule for one router (`gateway.ts` `fanOut`): a router is asked
 * for topics only for the names it declares, so an event outside `names` reaches nothing however
 * `topicsFor` would answer it.
 */
const route = (name: string, payload: Record<string, unknown>): string[] => {
  if (!radiologyTopicRouter.names.includes(name)) return [];
  const e: TailedEvent = { seq: 1, eventId: "e-1", name, occurredAt: new Date(0), patientId: "P1", encounterId: "V1", payload };
  return [...radiologyTopicRouter.topicsFor(e)].sort();
};

describe("imaging lists go live (spec #1083)", () => {
  it("spec #1083 D1 — an acquisition reaches imaging:floor and imaging:read; a lab event reaches nothing", () => {
    expect(route("imaging.study_acquired", {
      studyId: "S1", accessionNo: "X2611140001", orderItemId: "OI1", serviceId: "SV1", contrastGiven: false,
      repeatOfStudyId: null, imageSource: "modality", deviceResourceId: "D-CT", studyInstanceUid: null,
    })).toEqual(["imaging:floor", "imaging:read"]);

    expect(route("lab.report_published", { orderGroupId: "G1", orderId: "O1", reportId: "R1" })).toEqual([]);
    expect(route("lab.result_critical_flagged", { orderGroupId: "G1", orderId: "O1" })).toEqual([]);
    expect(route("lab.specimen_collected", { orderGroupId: "G1", specimenId: "SP1" })).toEqual([]);
  });

  it("spec #1083 D3 — an imaging order.placed reaches imaging:floor; a lab one reaches nothing", () => {
    const placed = (kind: string): Record<string, unknown> => ({
      orderId: "O1", orderNo: "ORD-1", kind, patientId: "P1", encounterNo: "V1", groupId: "G1", itemIds: ["I1", "I2"],
    });
    expect(route("order.placed", placed("imaging"))).toEqual(["imaging:floor"]);
    expect(route("order.placed", placed("lab"))).toEqual([]);
  });
});
