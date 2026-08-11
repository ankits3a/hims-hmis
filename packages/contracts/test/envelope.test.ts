import { defineEvent } from "../src/envelope";
import { z } from "zod";

const patientRegistered = defineEvent(
  "patient.registered",
  "registration",
  z.object({ uhid: z.string(), phone: z.string() }),
);

describe("defineEvent", () => {
  it("builds a valid EventInput with defaults", () => {
    const e = patientRegistered.make({
      actor: { type: "user", id: "u1" },
      payload: { uhid: "H0001", phone: "9999999999" },
    });
    expect(e.name).toBe("patient.registered");
    expect(e.module).toBe("registration");
    expect(e.version).toBe(1);
    expect(e.siteId).toBe("main");
    expect(e.occurredAt).toBeInstanceOf(Date);
  });

  it("rejects a payload that fails the schema", () => {
    expect(() =>
      patientRegistered.make({
        actor: { type: "user", id: "u1" },
        payload: { uhid: 42 } as unknown,
      }),
    ).toThrow();
  });

  it("rejects event names that are not entity.verb_past lowercase", () => {
    expect(() => defineEvent("PatientRegistered", "registration", z.object({}))).toThrow();
    expect(() => defineEvent("patient.Registered", "registration", z.object({}))).toThrow();
  });
});
