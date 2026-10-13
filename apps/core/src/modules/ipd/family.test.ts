import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cookieSecure, familyCookie } from "./family.controller";
import { familyOtpSender } from "./family-otp";
import { FamilyAddressThrottle } from "./family-throttle";
import type { AppConfig } from "../../kernel/config";

/** E3.3 review #764 — the family link's pure guards (no database). */
const CFG = { notifyProvider: "console", notifyPushProvider: "console", webPushVapid: null, notifySms: null, notifyWhatsapp: null } as unknown as AppConfig;

describe("family link — review #764 units", () => {
  it("B14: a production process with IPD_FAMILY_OTP_TO_LOG set refuses to start; staging may opt in; production without it starts", () => {
    expect(() => familyOtpSender(CFG, { NODE_ENV: "production", IPD_FAMILY_OTP_TO_LOG: "true" })).toThrow(/IPD_FAMILY_OTP_TO_LOG/);
    expect(familyOtpSender(CFG, { NODE_ENV: "development", IPD_FAMILY_OTP_TO_LOG: "true" }).name).toMatch(/logging/);
    expect(familyOtpSender(CFG, { NODE_ENV: "production" }).name).toMatch(/logging/);
  });

  it("B11: the cookie is Secure in production whatever the request says; dev over plain HTTP follows the request", () => {
    const plain = { headers: {} };
    expect(cookieSecure(plain, { NODE_ENV: "production" })).toBe(true);
    expect(cookieSecure(plain, { NODE_ENV: "development" })).toBe(false);
    expect(cookieSecure({ headers: {}, secure: true }, { NODE_ENV: "development" })).toBe(true);
    expect(familyCookie("hmis_fses", "abc", 60, true)).toBe("hmis_fses=abc; Path=/api/ipd/family; Max-Age=60; HttpOnly; SameSite=Strict; Secure");
  });

  it("Y10: one address is capped per window on the public routes; another address is not affected; the window slides", () => {
    const t = new FamilyAddressThrottle(3, 1_000);
    expect([t.allow("a", 0), t.allow("a", 1), t.allow("a", 2), t.allow("a", 3)]).toEqual([true, true, true, false]);
    expect(t.allow("b", 3)).toBe(true);
    expect(t.allow("a", 1_001)).toBe(true);
  });

  it("Y9: no family route carries the link token in its path (the edge logs paths); every public route is POST with a body token", () => {
    const src = readFileSync(join(__dirname, "family.controller.ts"), "utf8");
    expect(src).not.toMatch(/:token\b/);
    const publics = [...src.matchAll(/@Public\(\)\s*\n\s*@(Get|Post)\("([^"]+)"\)/g)].map((m) => [m[1], m[2]]);
    expect(publics).toEqual([["Post", "family/gate"], ["Post", "family/otp"], ["Post", "family/verify"], ["Post", "family/view"], ["Post", "family/bill-details"], ["Post", "family/callback"]]);
    expect(src.match(/this\.admit\(req\)/g)).toHaveLength(6);
  });
});
