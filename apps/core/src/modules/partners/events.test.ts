import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PARTNERS_EVENTS } from "./events";

/**
 * The partners event catalog. Same shape, and the same reason, as
 * `modules/membership/events.test.ts`: `events.ts` is named in T6's and T7's Files lists while
 * this file is named in neither, so a frozen name list here would fail the build for a task that
 * is not allowed to fix it. What is pinned instead is the property a name list is really for —
 * **every `defineEvent` in `events.ts` is on `PARTNERS_EVENTS`, in source order, and nothing else
 * is** — plus the two names the plan itself states.
 *
 * §2.49: the parser THROWS rather than returning `[]`, and one test watches it throw.
 */
const EVENTS_SOURCE = resolve(__dirname, "events.ts");

/** `[identifier, eventName]` for every `export const … = defineEvent("…"` in a source. Throws if there are none. */
function definedEvents(source: string, label: string): [string, string][] {
  const found: [string, string][] = [];
  for (const m of source.matchAll(/export const\s+([A-Za-z_$][\w$]*)\s*=\s*defineEvent\(\s*"([^"]+)"/g)) {
    const identifier = m[1];
    const name = m[2];
    if (identifier !== undefined && name !== undefined) found.push([identifier, name]);
  }
  if (found.length === 0) {
    throw new Error(`${label}: no \`export const … = defineEvent("…"\` found at all — this parser is stale`);
  }
  return found;
}

const source = readFileSync(EVENTS_SOURCE, "utf8");

describe("partners event catalog (Global Constraints: catalog discipline)", () => {
  test("every event carries module \"partners\" and a well-formed entity.verb_past name", () => {
    expect(PARTNERS_EVENTS.length).toBeGreaterThan(0);
    for (const ev of PARTNERS_EVENTS) {
      expect(ev.module).toBe("partners");
      expect(ev.name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(ev.version).toBe(1);
    }
    const names = PARTNERS_EVENTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("PARTNERS_EVENTS is exactly what events.ts defines, in source order", () => {
    const defined = definedEvents(source, "modules/partners/events.ts");
    expect(PARTNERS_EVENTS.map((e) => e.name)).toEqual(defined.map(([, name]) => name));
  });

  test("the parser THROWS on a source it does not recognise, never returns []", () => {
    expect(() => definedEvents("const notAnEvent = 1;\n", "synthetic")).toThrow(/this parser is stale/);
    expect(definedEvents('export const y = defineEvent(\n  "c.d",\n', "synthetic")).toEqual([["y", "c.d"]]);
  });

  test("the two names the PLAN states are present, each for its own recorded reason", () => {
    const names = PARTNERS_EVENTS.map((e) => e.name);
    expect(names).toContain("payout.class_blocked"); // DD4 — the attempt path
    expect(names).toContain("expectation.written_off"); // DD13 / V5
  });

  test("`payout.class_blocked` can name every class, INCLUDING the one that can never be paid", () => {
    const blocked = PARTNERS_EVENTS.find((e) => e.name === "payout.class_blocked");
    expect(blocked).toBeDefined();
    // The event exists to record an attempt against an `external_rmp`, so its payload must be
    // able to SAY `external_rmp`. An enum that omitted it would make the one case this event is
    // for unrepresentable — which is how a guard ends up recording everything except the breach.
    expect(
      blocked!.payloadSchema.safeParse({
        counterpartyId: "c", payeeClass: "external_rmp", amountPaise: 5000, reason: "payout attempted",
      }).success,
    ).toBe(true);
    expect(
      blocked!.payloadSchema.safeParse({
        counterpartyId: "c", payeeClass: "doctor", amountPaise: 5000, reason: "payout attempted",
      }).success,
    ).toBe(false);
    // Money is integer paise. A rupee float in a payout payload is the bug §3.19 exists to refuse.
    expect(
      blocked!.payloadSchema.safeParse({
        counterpartyId: "c", payeeClass: "channel_partner", amountPaise: 50.5, reason: "x",
      }).success,
    ).toBe(false);
  });
});
