import { ipdRateServiceCode } from "@hmis/contracts";
import { ipdNonPayableDepositCode, quoteDeposit } from "./deposit";
import type { PriceBook } from "./deposit";

/** E1.2 — decision 0072's deposit rules as a pure function over the active tariff's prices (synthetic paise). */
const book = (entries: [string, number][]): PriceBook => new Map(entries);
const general: [string, number][] = [
  [ipdRateServiceCode("general", "room"), 100_000], [ipdRateServiceCode("general", "nursing"), 20_000],
  [ipdRateServiceCode("general", "visit"), 30_000],
];
const medical = { kind: "medical" as const };

describe("quoteDeposit (decision 0072 answer 3)", () => {
  it("medical: three class days; overflow bills at general", () => {
    expect(quoteDeposit(book(general), { payerKind: "cash", requestedClass: "general", plan: medical, emergencyUnstabilised: false }))
      .toMatchObject({ depositPaise: 450_000, estimatePaise: 450_000, basis: "medical_class_days", missing: [] });
    expect(quoteDeposit(book(general), { payerKind: "cash", requestedClass: "overflow", plan: medical, emergencyUnstabilised: false }))
      .toMatchObject({ depositPaise: 450_000 });
  });

  it("surgery: half the procedure estimate, rounded up to the rupee", () => {
    expect(quoteDeposit(book(general), {
      payerKind: "cash", requestedClass: "general", plan: { kind: "surgical", procedureEstimatePaise: 1_000_001 }, emergencyUnstabilised: false,
    })).toMatchObject({ depositPaise: 500_100, basis: "surgery_estimate_share" });
  });

  it("scheme pays nothing; an unstabilised emergency pays nothing", () => {
    expect(quoteDeposit(book(general), { payerKind: "pmjay", requestedClass: "general", plan: medical, emergencyUnstabilised: false }))
      .toMatchObject({ depositPaise: 0, basis: "scheme_zero" });
    expect(quoteDeposit(book(general), { payerKind: "cash", requestedClass: "general", plan: medical, emergencyUnstabilised: true }))
      .toMatchObject({ depositPaise: 0, basis: "emergency_exempt" });
  });

  it("cashless: the configured non-payables deposit, or missing — never a guess", () => {
    expect(quoteDeposit(book([...general, [ipdNonPayableDepositCode("general"), 70_000]]), {
      payerKind: "insurance_cashless", requestedClass: "general", plan: medical, emergencyUnstabilised: false,
    })).toMatchObject({ depositPaise: 70_000, basis: "cashless_non_payables" });
    expect(quoteDeposit(book(general), { payerKind: "insurance_cashless", requestedClass: "general", plan: medical, emergencyUnstabilised: false }))
      .toMatchObject({ depositPaise: null, missing: ["non_payables"] });
  });

  it("a missing component nulls the estimate and names itself", () => {
    const q = quoteDeposit(book(general.slice(0, 2)), { payerKind: "cash", requestedClass: "general", plan: medical, emergencyUnstabilised: false });
    expect(q).toMatchObject({ estimatePaise: null, depositPaise: null, missing: ["visit"] });
  });
});
