import { EventRegistry } from "../src/registry";
import { defineEvent } from "../src/envelope";
import { z } from "zod";

describe("EventRegistry", () => {
  it("registers and lists event names", () => {
    const r = new EventRegistry();
    r.register(defineEvent("visit.opened", "opd", z.object({ visitId: z.string() })));
    expect(r.names()).toEqual(["visit.opened"]);
    expect(r.get("visit.opened")?.module).toBe("opd");
  });

  it("throws on duplicate registration", () => {
    const r = new EventRegistry();
    const d = defineEvent("visit.opened", "opd", z.object({}));
    r.register(d);
    expect(() => r.register(d)).toThrow(/duplicate/i);
  });
});
