import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MEMBERSHIP_EVENTS } from "./events";

/**
 * The membership event catalog.
 *
 * ═══ WHY THIS FILE DOES NOT PIN AN EXACT NAME LIST, AND WHY THAT IS NOT A WEAKER TEST ═══
 *
 * `modules/billing/events.test.ts` pins its twenty names as a literal, and that is right for a
 * catalog whose owning task shipped all twenty. This one cannot: `events.ts` is named in T3's,
 * T4's and T5's Files lists and `events.test.ts` is named in NONE of them, so a frozen list here
 * would fail the build the moment recognition adds `instrument.recognised` — and the task that
 * added it would not be allowed to fix this file.
 *
 * So the assertion is one layer up, and it is the one that actually catches the defect a name list
 * catches: **every `defineEvent` in `events.ts` is in `MEMBERSHIP_EVENTS`, in source order, and
 * nothing else is.** A new event added without being exported on the catalog fails here; a catalog
 * entry that is not defined in that file cannot exist. §2.49 — the parser THROWS rather than
 * returning `[]` on a shape it does not recognise, and one test drives it against garbled input to
 * watch it throw, because two parsers that both return `[]` agree with each other forever.
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

describe("membership event catalog (Global Constraints: catalog discipline)", () => {
  test("every event carries module \"membership\" and a well-formed entity.verb_past name", () => {
    expect(MEMBERSHIP_EVENTS.length).toBeGreaterThan(0);
    for (const ev of MEMBERSHIP_EVENTS) {
      expect(ev.module).toBe("membership");
      // The grammar `defineEvent` itself enforces, asserted here so the catalog states it too.
      expect(ev.name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(ev.version).toBe(1);
    }
    const names = MEMBERSHIP_EVENTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("MEMBERSHIP_EVENTS is exactly what events.ts defines, in source order", () => {
    const defined = definedEvents(source, "modules/membership/events.ts");
    expect(MEMBERSHIP_EVENTS.map((e) => e.name)).toEqual(defined.map(([, name]) => name));
  });

  test("the parser THROWS on a source it does not recognise, never returns []", () => {
    expect(() => definedEvents("export const nothing = 1;\n", "synthetic")).toThrow(/this parser is stale/);
    expect(definedEvents('export const x = defineEvent(\n  "a.b",\n', "synthetic")).toEqual([["x", "a.b"]]);
  });

  test("the three names the PLAN states are present, each for its own recorded reason", () => {
    const names = MEMBERSHIP_EVENTS.map((e) => e.name);
    expect(names).toContain("instrument.grace_honored"); // O-1
    expect(names).toContain("coupon.redemption_released"); // O-4
    expect(names).toContain("instrument.lookup_refused"); // DD15
  });

  test("the payloads refuse what they must — a grace-honor with no approval, a refusal with no limit", () => {
    const graceHonored = MEMBERSHIP_EVENTS.find((e) => e.name === "instrument.grace_honored");
    const lookupRefused = MEMBERSHIP_EVENTS.find((e) => e.name === "instrument.lookup_refused");
    expect(graceHonored).toBeDefined();
    expect(lookupRefused).toBeDefined();

    // O-1's load-bearing half: an approval id is not optional. A grace honour nobody authorised
    // is the silent-honouring failure the ruling exists to refuse.
    expect(
      graceHonored!.payloadSchema.safeParse({
        instanceId: "i", cardCode: "c", patientId: "p", reason: "feed lag",
      }).success,
    ).toBe(false);
    expect(
      graceHonored!.payloadSchema.safeParse({
        instanceId: "i", cardCode: "c", patientId: "p", approvalId: "a", reason: "feed lag",
      }).success,
    ).toBe(true);

    // DD15: the refusal carries the limit and window it hit, so the event can be read without
    // joining the config that produced it.
    expect(lookupRefused!.payloadSchema.safeParse({ actorId: "u", reason: "rate_limited" }).success).toBe(false);
    expect(
      lookupRefused!.payloadSchema.safeParse({
        actorId: "u", reason: "rate_limited", limit: 120, windowSec: 60,
      }).success,
    ).toBe(true);
  });
});
