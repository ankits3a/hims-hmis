import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  couponDefinitions, couponRedemptions, entitlementCounters, invoices, membershipInstances,
  membershipPlans, registrationConfig,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerPatient } from "../patients";
import { membershipSchemesDeskProvider } from "./desk-provider";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-11 — THE SCHEME COUNTS ARE REAL, AND EACH ONE MEANS WHAT ITS TILE SAYS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The tiles shipped blank first, on the rule that a plausible number at a cash counter is the worst
 * kind. The owner asked for the real ones, so what has to be true is not "a number appears" but
 * that the number is the thing the word above it claims. Each case below is a row the count must
 * EXCLUDE — an expired card, a released coupon, a lapsed entitlement, yesterday's redemption —
 * because a count that includes them is exactly the plausible-looking lie the blank tile avoided.
 */
const clerk: Actor = { type: "user", id: "clerk-1" };
const DAY = "2026-09-04";
/** Mid-morning IST on DAY, as the instant the provider is called with. */
const NOW = new Date("2026-09-04T04:30:00.000Z");

describe("the dashboard's scheme counts", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    const reg = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Scheme Tester", sex: "male", ageYears: 40 }));
    patientId = reg.patient.id;
    await db.insert(membershipPlans).values({
      id: "plan-1", code: "SCHEME-TEST", title: "Scheme test plan", kind: "card",
      benefits: [], entitlements: {}, validityDays: 365, createdBy: "test",
    });
  });

  const load = async (): Promise<Record<string, string>> => {
    const cards = await membershipSchemesDeskProvider.load({ db, actor: clerk, reader: clerk, date: DAY, now: NOW });
    return Object.fromEntries((cards[0]?.stats ?? []).map((s) => [s.key, s.value]));
  };

  const card = async (id: string, status: string, from: string, to: string): Promise<void> => {
    await db.insert(membershipInstances).values({
      id, planId: "plan-1", cardCode: id, holderName: "H", patientId: null,
      validFrom: new Date(from), validTo: new Date(to), status, origin: "import",
    });
  };

  it("counts cards that are ACTIVE and in force, and neither an expired nor a cancelled one", async () => {
    await card("in-force", "active", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
    await card("also-in-force", "active", "2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z");
    // status says active, but its window closed in August — `status` alone would count it
    await card("lapsed-window", "active", "2025-01-01T00:00:00Z", "2026-08-31T00:00:00Z");
    // inside its window, but cancelled
    await card("cancelled", "cancelled", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
    // its window has not opened yet
    await card("not-yet", "active", "2026-10-01T00:00:00Z", "2027-01-01T00:00:00Z");

    expect((await load())["desk.schemes.membership.n"]).toBe("2");
  });

  it("counts coupons REDEEMED today, and neither a released one nor yesterday's", async () => {
    /*
      A redemption is FK'd to a real invoice and a real patient — a coupon is a thing that happened
      on a bill, not a free-standing row. The invoice is the minimum the schema will accept: the
      count under test never reads a rupee of it.
    */
    await db.insert(invoices).values({
      id: "inv-1", invoiceNo: "SCHEME-INV-1", patientId, tariffVersionId: "tv-1",
      grossPaise: 0, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0,
      rawTotalPaise: 0, roundingPaise: 0, netPayablePaise: 0,
      issuedBy: clerk.id, issuedAt: NOW, serviceDay: DAY,
    });
    await db.insert(couponDefinitions).values({
      id: "c-1", code: "SCHEME-CPN", title: "Scheme test coupon", planId: "plan-1",
      benefit: { kind: "percent_bps", value: 500, title: "Scheme test coupon" },
      scope: { serviceCategories: ["consultation"], serviceIds: null },
      minBillPaise: 0, capPaise: null, singleUse: true,
      validFrom: new Date("2026-01-01T00:00:00Z"), validTo: new Date("2027-01-01T00:00:00Z"),
      weekdayMask: 127, createdBy: "test",
    });
    /*
      `singleUse: false` and a distinct cycle each: the single-use uniqueness index is what stops one
      coupon being redeemed twice, and this test is about COUNTING redemptions rather than about that
      rule. Four rows on one coupon is a repeat-use coupon, which is a real shape.
    */
    let cycle = 0;
    const redemption = async (id: string, state: string, at: string): Promise<void> => {
      cycle += 1;
      await db.insert(couponRedemptions).values({
        id, couponId: "c-1", cycleNo: cycle, state, singleUse: false,
        patientId, invoiceId: "inv-1", instanceId: null, amountPaise: 0,
        releasedOfId: null, reason: null, actorId: "u1", at: new Date(at),
      });
    };
    await redemption("today-1", "redeemed", "2026-09-04T05:00:00Z");
    await redemption("today-2", "redeemed", "2026-09-03T19:00:00Z"); // 00:30 IST on the 4th
    // presented and then given back — it is not in play
    await redemption("released", "released", "2026-09-04T05:30:00Z");
    // 18:29Z on the 3rd is 23:59 IST on the 3rd: yesterday, by one minute
    await redemption("yesterday", "redeemed", "2026-09-03T18:29:00Z");
    /*
      AND THE OTHER EDGE, which a surviving mutant found was untested: 18:30Z on the 4th is 00:00
      IST on the 5th. Without an upper bound the count is "everything from midnight onwards" and
      every future redemption inflates today — invisible until a hospital runs past midnight, which
      a hospital does every night.
    */
    await redemption("tomorrow", "redeemed", "2026-09-04T18:30:00Z");

    expect((await load())["desk.schemes.coupons.n"]).toBe("2");
  });

  it("counts entitlements in force, which is what a sold package actually is", async () => {
    await card("holder", "active", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
    const counter = async (id: string, state: string, from: string, to: string): Promise<void> => {
      await db.insert(entitlementCounters).values({
        id, instanceId: "holder", benefitKey: id, unit: "count", grantedQty: 3,
        validFrom: new Date(from), validTo: new Date(to), state,
      });
    };
    await counter("live", "active", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
    /*
      CLOSE REVIEW, FD-23 — THIS ROW USED TO SAY `"expired"`, WHICH IS NOT A VALUE THE DOMAIN HAS.
      `entitlement_counters.state` is `'active' | 'void'`. A fixture in a state nothing writes made
      this row pass against a predicate (`ne(state, "expired")`) that excluded nothing, so a VOIDED
      package counted as in force on the dashboard. `"void"` is the real cancelled state and turns
      this assertion into the guard it was always meant to be.
    */
    await counter("void-state", "void", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
    await counter("out-of-window", "active", "2025-01-01T00:00:00Z", "2026-08-01T00:00:00Z");

    expect((await load())["desk.schemes.packages.n"]).toBe("1");
  });

  /*
    A hospital with nothing in play gets THREE ZEROS, not three blanks. The screen draws the
    difference: a zero is a fact the provider asserts, a blank is "you hold no permission that
    counts this". A provider that returned nothing here would turn the first into the second.
  */
  it("answers zero rather than nothing when there is genuinely nothing in play", async () => {
    const stats = await load();
    expect(stats).toEqual({
      "desk.schemes.membership.n": "0",
      "desk.schemes.coupons.n": "0",
      "desk.schemes.packages.n": "0",
    });
  });

  it("is gated on the permission that already lets the counter read an instrument", () => {
    expect(membershipSchemesDeskProvider.permission).toBe("membership.instrument.read");
  });
});
