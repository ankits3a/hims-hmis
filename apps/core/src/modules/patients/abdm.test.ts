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

  it("is configured when every required key is present, and says so in the clerk's words", () => {
    const cap = abhaCapability(full);
    expect(cap).toMatchObject({ configured: true, canRecord: true, canCreate: true, canVerify: true });
    expect(cap.reason).toBe("ABDM is connected — an ABHA can be created and verified here.");
  });

  it("recording a number the patient gives never depends on ABDM", () => {
    expect(abhaCapability(base).canRecord).toBe(true);
  });
});
