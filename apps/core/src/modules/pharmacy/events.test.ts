import { PHARMACY_EVENTS, dispenseClaimed, dispenseHandedOver } from "./events";

describe("the pharmacy event catalog (16c T1)", () => {
  it("is nine events, all module pharmacy, names unique", () => {
    expect(PHARMACY_EVENTS).toHaveLength(9);
    for (const e of PHARMACY_EVENTS) expect(e.module).toBe("pharmacy");
    expect(new Set(PHARMACY_EVENTS.map((e) => e.name)).size).toBe(9);
    expect(PHARMACY_EVENTS.map((e) => e.name).sort()).toEqual([
      "dispense.billed", "dispense.cancelled", "dispense.claimed", "dispense.handed_over", "dispense.line_declined",
      "dispense.picked", "dispense.queued", "dispense.verified", "substitution.recorded",
    ]);
  });

  it("the claim carries the P number and the door; the hand-over carries the ledger rows", () => {
    expect(dispenseClaimed.payloadSchema.safeParse({
      dispenseId: "d", dispenseNo: "P-1", orderId: "o", patientId: "p", encounterId: "e", prescriptionId: "rx",
      lineCount: 2, scheduled: true, door: "rx_qr",
    }).success).toBe(true);
    expect(dispenseClaimed.payloadSchema.safeParse({ dispenseId: "d", door: "window" }).success).toBe(false);
    expect(dispenseHandedOver.payloadSchema.safeParse({
      dispenseId: "d", dispenseNo: "P-1", patientId: "p", encounterId: "e", handedOverBy: "u",
      ledgerEntryIds: [], h1RegisterRows: 0, identityConfirmedVia: null,
    }).success).toBe(false); // a hand-over with no ledger row is not a hand-over
  });
});
