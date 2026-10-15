import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  breakGlassUsed, emergencyElevationUsed, sodViolationBlocked,
} from "../src/kernel/auth/events";
import * as authEvents from "../src/kernel/auth/events";

/**
 * Watching the security-relevant events: the exporter counts each over the last ten minutes and the rule file pages on
 * any self-elevation, break-glass or blocked segregation-of-duty attempt, and on a burst of failed sign-ins or second
 * factors. Both files are read as shipped; every event name must be one the kernel really appends, or a rule would
 * watch a series that never exists and stay silent for ever.
 */
const ROOT = resolve(__dirname, "..", "..", "..");
const RULES = readFileSync(resolve(ROOT, "docker/prod/prometheus/alerts-security.yml"), "utf8");
const QUERIES = readFileSync(resolve(ROOT, "docker/prod/postgres-exporter/queries.yml"), "utf8");
const PROM = readFileSync(resolve(ROOT, "docker/prod/prometheus/prometheus.yml"), "utf8");

const known = new Set(Object.values(authEvents).flatMap((e) => (typeof e === "object" && e !== null && "name" in e ? [String((e as { name: unknown }).name)] : [])));
const ruleNames = [...RULES.matchAll(/hmis_security_events_recent\{name="([a-z_.]+)"\}/g)].map((m) => m[1]!);
const queryBlock = QUERIES.slice(QUERIES.indexOf("hmis_security_events:"));
const queryNames = [...queryBlock.slice(0, queryBlock.indexOf("metrics:")).matchAll(/\('([a-z_.]+)'\)/g)].map((m) => m[1]!);

describe("security-event alerts", () => {
  it("pages on every self-elevation, break-glass and blocked segregation-of-duty attempt", () => {
    for (const e of [emergencyElevationUsed, breakGlassUsed, sodViolationBlocked]) expect(ruleNames).toContain(e.name);
  });

  it("pages on bursts of failed sign-ins and failed second factors", () => {
    expect(ruleNames).toEqual(expect.arrayContaining(["auth.login_failed", "auth.totp_failed"]));
  });

  it("every watched name is an event the kernel appends, and the exporter counts exactly the names the rules read", () => {
    expect(ruleNames.length).toBeGreaterThanOrEqual(5);
    for (const n of ruleNames) expect([n, known.has(n)]).toEqual([n, true]);
    expect([...new Set(queryNames)].sort()).toEqual([...new Set(ruleNames)].sort());
  });

  it("prometheus loads the rule file", () => {
    expect(PROM).toMatch(/^\s+- \/etc\/prometheus\/alerts-security\.yml$/m);
  });
});
