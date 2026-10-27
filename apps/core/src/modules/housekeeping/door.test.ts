import { IS_PUBLIC, PERMISSION_KEY } from "../../kernel/auth/decorators";
import { DoorAddressThrottle } from "./door-throttle";
import { HousekeepingController } from "./housekeeping.controller";

/**
 * HK-1 (#973) — the public door: the ONE housekeeping route without a staff session, and its per-address cap. Every other
 * route carries a permission (a route that forgot one would answer anybody).
 */
describe("housekeeping — the public door", () => {
  const proto = HousekeepingController.prototype as unknown as Record<string, object>;
  const routes = Object.getOwnPropertyNames(HousekeepingController.prototype).filter((k) => k !== "constructor");

  it("only `door` is public; every other route requires a permission", () => {
    const pub = routes.filter((k) => Reflect.getMetadata(IS_PUBLIC, proto[k]!) === true);
    expect(pub).toEqual(["door"]);
    for (const k of routes.filter((r) => r !== "door")) expect(Reflect.getMetadata(PERMISSION_KEY, proto[k]!)).toBeDefined();
  });

  it("caps one address inside the window and lets it back in after", () => {
    const t = new DoorAddressThrottle(3, 60_000);
    const t0 = Date.now();
    for (let i = 0; i < 3; i += 1) expect(t.allow("198.51.100.7", t0 + i)).toBe(true);
    expect(t.allow("198.51.100.7", t0 + 10)).toBe(false);
    expect(t.allow("198.51.100.8", t0 + 10)).toBe(true);
    expect(t.allow("198.51.100.7", t0 + 60_001)).toBe(true);
  });
});
