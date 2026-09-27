import { abhaCapability } from "./abdm";

/**
 * ABDM S0 — the counter's capability answer reads the SAME `configured` rule as the connector.
 *
 * Before S0 the capability said "connected" on three keys (gateway, id, secret) while the connector
 * cannot receive a single callback without a HIP id and a callback base. A counter told "an ABHA can
 * be verified here" by a deployment whose callback routes answer 503 is the button-that-fails this
 * file's header forbids.
 */
describe("abhaCapability — the one configured rule", () => {
  const base = { DATABASE_URL: "postgres://unused", SECRET_KEY: "ab".repeat(32) };
  const full = {
    ...base,
    ABDM_BASE_URL: "https://dev.abdm.gov.in/api/hiecm",
    ABDM_CLIENT_ID: "SBX_0001",
    ABDM_CLIENT_SECRET: "secret",
    ABDM_HIP_ID: "IN0000000001",
    ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks",
  };

  it("is NOT configured on the old three keys alone", () => {
    const cap = abhaCapability({ ...base, ABDM_BASE_URL: full.ABDM_BASE_URL, ABDM_CLIENT_ID: "x", ABDM_CLIENT_SECRET: "y" });
    expect(cap).toMatchObject({ configured: false, canRecord: true, canCreate: false, canVerify: false });
    expect(cap.reason).toMatch(/not connected to ABDM yet/);
  });

  it("is configured when every required key is present — but verifying also needs the ABHA service", () => {
    const cap = abhaCapability(full);
    expect(cap).toMatchObject({ configured: true, canRecord: true, canCreate: false, canVerify: false, canScanShare: true });
    expect(cap.reason).toMatch(/ABHA service is not set up/);
  });

  /**
   * ABDM S1 — VERIFY is on whenever ABDM (and its ABHA service) is; CREATE by Aadhaar OTP is ON by
   * default since the owner ruled yes (2026-09-26), and only `ABDM_ABHA_CREATE_AADHAAR=false` — in
   * those letters — switches it off.
   */
  it("S1: with the ABHA service, verify is ON and create is ON by default; \"false\" switches create off", () => {
    const withAbha = { ...full, ABDM_ABHA_BASE_URL: "https://abhasbx.abdm.gov.in/abha/api" };
    expect(abhaCapability(withAbha)).toMatchObject({ configured: true, canVerify: true, canCreate: true, canScanShare: true });
    const off = abhaCapability({ ...withAbha, ABDM_ABHA_CREATE_AADHAAR: "false" });
    expect(off).toMatchObject({ configured: true, canVerify: true, canCreate: false, canScanShare: true });
    expect(off.reason).toMatch(/Creating a new ABHA with Aadhaar is not switched on/);
  });

  it("S1: create follows ABDM_ABHA_CREATE_AADHAAR, and needs ABDM itself", () => {
    const withAbha = { ...full, ABDM_ABHA_BASE_URL: "https://abhasbx.abdm.gov.in/abha/api" };
    expect(abhaCapability({ ...withAbha, ABDM_ABHA_CREATE_AADHAAR: "true" })).toMatchObject({ canVerify: true, canCreate: true });
    expect(abhaCapability({ ...withAbha, ABDM_ABHA_CREATE_AADHAAR: "false" }).canCreate).toBe(false);
    expect(() => abhaCapability({ ...withAbha, ABDM_ABHA_CREATE_AADHAAR: "yes" })).toThrow();
    // the flag alone, without ABDM, switches on nothing
    expect(abhaCapability({ ...base, ABDM_ABHA_CREATE_AADHAAR: "true" })).toMatchObject({ canCreate: false, canVerify: false, canScanShare: false });
  });

  it("recording a number the patient gives never depends on ABDM", () => {
    expect(abhaCapability(base).canRecord).toBe(true);
  });
});
