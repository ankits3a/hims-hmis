import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedBillingBase } from "../../../test/helpers/billing";
import { loadBillingConfig } from "./config";
import { loadUpiPayee, setUpiPayee, upiPayUri } from "./upi";
import type { Db } from "../../kernel/db/client";

/** Owner 2026-10-09 — the hospital's own UPI id, for the QR the desk shows. No payment company. */
describe("billing — the hospital's UPI id", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); await seedBillingBase(db); });

  it("is unset until somebody sets it; a set id is read back; a blank clears it — and the config's own shape is untouched", async () => {
    const before = await loadBillingConfig(db);
    expect(await loadUpiPayee(db)).toBeNull();
    expect(await setUpiPayee(db, { vpa: " crkmch@sbi ", payeeName: " CRK Medical College & Hospital " })).toEqual({ vpa: "crkmch@sbi", payeeName: "CRK Medical College & Hospital" });
    expect(await loadUpiPayee(db)).toEqual({ vpa: "crkmch@sbi", payeeName: "CRK Medical College & Hospital" });
    expect(await loadBillingConfig(db)).toEqual(before);
    expect(await setUpiPayee(db, { vpa: "", payeeName: "kept?" })).toBeNull();
    expect(await loadUpiPayee(db)).toBeNull();
  });

  it("refuses an id that is not name@bank, and a payee name too long for a QR — nothing is stored", async () => {
    for (const vpa of ["crkmch", "crkmch@", "@sbi", "crk mch@sbi", "crkmch@sbi@x", "a@b"]) {
      await expect(setUpiPayee(db, { vpa })).rejects.toMatchObject({ code: "invalid_upi_id" });
    }
    await expect(setUpiPayee(db, { vpa: "crkmch@sbi", payeeName: "x".repeat(41) })).rejects.toMatchObject({ code: "invalid_upi_id" });
    expect(await loadUpiPayee(db)).toBeNull();
  });

  it("the payment request names the payee, the amount in rupees and paise, INR, and the note", () => {
    expect(upiPayUri({ vpa: "crkmch@sbi", payeeName: "CRK Hospital" }, 10_000, "A2610100009")).toBe("upi://pay?pa=crkmch%40sbi&pn=CRK%20Hospital&am=100.00&cu=INR&tn=A2610100009");
    expect(upiPayUri({ vpa: "crkmch@sbi", payeeName: "" }, 12_550, "A1")).toBe("upi://pay?pa=crkmch%40sbi&am=125.50&cu=INR&tn=A1");
  });
});
