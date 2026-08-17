import { opdTopicRouter, opdTopicsFor } from "./realtime";

describe("opd topic router", () => {
  it("topics a doctor-day event at the queue, the room display and the encounter", () => {
    expect(
      opdTopicsFor({
        name: "queue.called",
        payload: { doctorId: "D", serviceDate: "2026-08-17", sessionId: "S", roomId: "R", tokenNo: 4, encounterId: "E" },
      }),
    ).toEqual(["queue:D:2026-08-17", "display:R", "encounter:E"]);
  });

  it("omits the display topic when the doctor-day has no room", () => {
    expect(
      opdTopicsFor({
        name: "vitals.danger_flagged",
        payload: { doctorId: "D", serviceDate: "2026-08-17", roomId: null, encounterId: "E" },
      }),
    ).toEqual(["queue:D:2026-08-17", "encounter:E"]);
  });

  it("topics visit.transferred at BOTH doctors' queues", () => {
    expect(
      opdTopicsFor({
        name: "visit.transferred",
        payload: { fromDoctorId: "A", toDoctorId: "B", serviceDate: "2026-08-17", roomId: "R2", encounterId: "E" },
      }),
    ).toEqual(["queue:A:2026-08-17", "queue:B:2026-08-17", "display:R2", "encounter:E"]);
  });

  it("topics nothing for a payload carrying no ids", () => {
    expect(opdTopicsFor({ name: "visit.opened", payload: {} })).toEqual([]);
    expect(
      opdTopicRouter.topicsFor({
        seq: 1, eventId: "EV1", name: "queue.called", occurredAt: new Date("2026-08-17T04:00:00.000Z"),
        patientId: null, encounterId: null, payload: null,
      }),
    ).toEqual([]);
  });
});
