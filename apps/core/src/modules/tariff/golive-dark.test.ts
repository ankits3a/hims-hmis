import { NotFoundException } from "@nestjs/common";
import { TariffController } from "./tariff.controller";
import type { Db } from "../../kernel/db/client";

/**
 * Decision 0085 invariant 1, dark by default — the tariff's IPD go-live routes answer 404 while `ipd` is off
 * (production, `HMIS_MODULES_ON` empty), before they read or write anything: the bulk switch-on of priced IPD services
 * (`POST /tariff/services/switch-on`) and the IPD rate card (`GET /tariff/ipd-rate-card`). The jest harness switches
 * all ten on, so this test switches off.
 */
describe("decision 0085 — the tariff's IPD go-live routes are dark while ipd is off", () => {
  const saved = process.env.HMIS_MODULES_ON;
  afterEach(() => { process.env.HMIS_MODULES_ON = saved; });
  const TOUCHED = "the route touched the database while dark";
  const untouchable = new Proxy({}, { get: () => { throw new Error(TOUCHED); } }) as unknown as Db;
  const actor = { type: "user", id: "u-bm" } as const;
  const body = { serviceIds: ["s1"] };

  it("ipd off: switch-on and the rate card are 404, and nothing is touched", async () => {
    process.env.HMIS_MODULES_ON = "";
    const c = new TariffController(untouchable);
    await expect(c.switchOnRoute(actor, body)).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.ipdRateCardRoute()).rejects.toBeInstanceOf(NotFoundException);
  });

  it("ipd on: both reach the database", async () => {
    process.env.HMIS_MODULES_ON = "ipd";
    const c = new TariffController(untouchable);
    await expect(c.switchOnRoute(actor, body)).rejects.toThrow(TOUCHED);
    await expect(c.ipdRateCardRoute()).rejects.toThrow(TOUCHED);
  });
});
