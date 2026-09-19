import { PHARMACY_EVENTS, dispenseClaimed, dispenseHandedOver } from "./events";

describe("the pharmacy event catalog (16c T1)", () => {
  it("is nineteen events, all module pharmacy, names unique (P2 added the register's two, P6 the return, P19 the walk-in sale's two, P19b its return, PD-5b the resolution, PD-D18 the shelf label, PD-9 the authorisation's two)", () => {
    expect(PHARMACY_EVENTS).toHaveLength(19); // P2: +2, the register of pharmacists; P6: +1, dispense.line_returned; P19: +2; P19b: +1, retail.line_returned; PD-5b: +1, dispense.line_resolved; PD-D18: +1, shelf.location_set
    for (const e of PHARMACY_EVENTS) expect(e.module).toBe("pharmacy");
    expect(new Set(PHARMACY_EVENTS.map((e) => e.name)).size).toBe(19);
    expect(PHARMACY_EVENTS.map((e) => e.name).sort()).toEqual([
      "authorisation.decided", "authorisation.requested", "dispense.billed", "dispense.cancelled", "dispense.claimed", "dispense.handed_over", "dispense.line_declined",
      "dispense.line_resolved", "dispense.line_returned", "dispense.picked", "dispense.queued", "dispense.verified", "pharmacist.registered", "pharmacist.registration_ended",
      "retail.licence_recorded", "retail.line_returned", "retail.sold", "shelf.location_set", "substitution.recorded",
    ]);
  });

  it("the claim carries the door; the hand-over carries the ledger rows", () => {
    expect(dispenseClaimed.payloadSchema.safeParse({
      dispenseId: "d", patientId: "p", encounterId: "e", prescriptionId: "rx", lineCount: 2, door: "rx_qr",
    }).success).toBe(true);
    expect(dispenseClaimed.payloadSchema.safeParse({ dispenseId: "d", door: "window" }).success).toBe(false);
    expect(dispenseHandedOver.payloadSchema.safeParse({
      dispenseId: "d", dispenseNo: "P-1", patientId: "p", encounterId: "e", handedOverBy: "u",
      ledgerEntryIds: [], h1RegisterRows: 0, identityConfirmedVia: null,
    }).success).toBe(false); // a hand-over with no ledger row is not a hand-over
  });
});
