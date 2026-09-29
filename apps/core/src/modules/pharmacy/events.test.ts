import { PHARMACY_EVENTS, dispenseClaimed, dispenseHandedOver } from "./events";

describe("the pharmacy event catalog (16c T1)", () => {
  it("is thirty-eight events, all module pharmacy, names unique (stage D4 the trays' four, stage D3 the fridge log's three, stage D2 the incident log's two, stage D1 the ADR register's two, P6 the controlled cabinet's five, P2 added the register's two, P6 the return, P19 the walk-in sale's two, P19b its return, PD-5b the resolution, PD-D18 the shelf label, PD-9 the authorisation's two, 2026-09-23 the salt match, P1 the short book's two)", () => {
    expect(PHARMACY_EVENTS).toHaveLength(38); // stage D4: +4, trays.tray_saved, .template_saved, .checked and .restocked; stage D3: +3, coldchain.unit_saved, .reading_recorded and .excursion_closed; stage D2: +2, incident.recorded and incident.event_recorded; stage D1: +2, adr.reported and adr.event_recorded; P6 (law): +5, the controlled licence, the trained doctor's two, the balance check, the act under two keys; P1 (parity): +2, short_book.noted/resolved; 2026-09-23: +1, dispense.line_matched; P2: +2, the register of pharmacists; P6: +1, dispense.line_returned; P19: +2; P19b: +1, retail.line_returned; PD-5b: +1, dispense.line_resolved; PD-D18: +1, shelf.location_set
    for (const e of PHARMACY_EVENTS) expect(e.module).toBe("pharmacy");
    expect(new Set(PHARMACY_EVENTS.map((e) => e.name)).size).toBe(38);
    expect(PHARMACY_EVENTS.map((e) => e.name).sort()).toEqual([
      "adr.event_recorded", "adr.reported", "authorisation.decided", "authorisation.requested", "coldchain.excursion_closed", "coldchain.reading_recorded", "coldchain.unit_saved", "controlled.act_witnessed", "controlled.checked", "controlled.licence_recorded",
      "controlled.prescriber_ended", "controlled.prescriber_recorded", "dispense.billed", "dispense.cancelled", "dispense.claimed", "dispense.handed_over", "dispense.line_declined",
      "dispense.line_matched", "dispense.line_resolved", "dispense.line_returned", "dispense.picked", "dispense.queued", "dispense.verified", "incident.event_recorded", "incident.recorded", "pharmacist.registered", "pharmacist.registration_ended",
      "retail.licence_recorded", "retail.line_returned", "retail.sold", "shelf.location_set", "short_book.noted", "short_book.resolved", "substitution.recorded",
      "trays.checked", "trays.restocked", "trays.template_saved", "trays.tray_saved",
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
