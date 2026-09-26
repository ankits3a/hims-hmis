import { inspect } from "node:util";
import { loadConfig } from "./config";

const base = {
  DATABASE_URL: "postgres://u:p@host:5433/db",
  SECRET_KEY: "ab".repeat(32),
};

describe("loadConfig", () => {
  it("parses a minimal env and applies defaults", () => {
    const cfg = loadConfig(base);
    expect(cfg.databaseUrl).toBe(base.DATABASE_URL);
    expect(cfg.port).toBe(3000);
    expect(cfg.sessionTtlMinutes).toBe(720);
    expect(cfg.secondFactorWindowMinutes).toBe(5);
    expect(cfg.breakGlassTtlMinutes).toBe(60);
    expect(cfg.tempRoleMaxTtlMinutes).toBe(720);
    expect(cfg.secretKey).toBeInstanceOf(Buffer);
    expect(cfg.secretKey.length).toBe(32);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({ SECRET_KEY: base.SECRET_KEY })).toThrow();
  });

  it("throws when SECRET_KEY is not 64 hex chars", () => {
    expect(() => loadConfig({ ...base, SECRET_KEY: "deadbeef" })).toThrow(/SECRET_KEY/);
  });

  it("honours numeric overrides", () => {
    const cfg = loadConfig({ ...base, PORT: "4000", SESSION_TTL_MINUTES: "60" });
    expect(cfg.port).toBe(4000);
    expect(cfg.sessionTtlMinutes).toBe(60);
  });

  // Plan 10 / the B1 scar: none of these three keys may require a value. This asserts the
  // defaults resolve from the same minimal env every other test in this file uses — no
  // WORKER_NOTIFY_INTERVAL_MS / NOTIFY_PROVIDER / NOTIFY_STUCK_AFTER_MS entry anywhere.
  it("defaults the three notify keys from an empty (minimal) environment", () => {
    const cfg = loadConfig(base);
    expect(cfg.workerNotifyIntervalMs).toBe(5000);
    expect(cfg.notifyProvider).toBe("console");
    expect(cfg.notifyStuckAfterMs).toBe(300000);
  });

  it("honours an override of NOTIFY_PROVIDER within the enum", () => {
    const cfg = loadConfig({ ...base, NOTIFY_PROVIDER: "console" });
    expect(cfg.notifyProvider).toBe("console");
  });

  it("rejects a NOTIFY_PROVIDER outside the enum", () => {
    expect(() => loadConfig({ ...base, NOTIFY_PROVIDER: "twilio" })).toThrow();
  });

  /**
   * Plan 11a D6/D7 — the three retention keys.
   *
   * WHAT THIS BLOCK DOES *NOT* DISCHARGE, said here so nobody mistakes it for protection: Global
   * Constraint 14 (and §2.60(a), the `NOTIFY_STUCK_AFTER_MS` scar) asks that a NON-DEFAULT value
   * change BEHAVIOUR through the production wiring shape. Parsing was never the thing in doubt —
   * `config.test.ts:38-43` asserted the notify keys parsed for a whole plan while one of them
   * reached nothing at all. The take-effect leg for all three of these lives in
   * `kernel/retention/sweep.test.ts` ("through the PRODUCTION REGISTRATION", Book V9), where each
   * key is registered through the real `registerAllJobs` with a distinct value and the sweep's
   * behaviour is asserted to differ from the default's. These tests below pin the DEFAULTS, which
   * is a different claim and a load-bearing one: `RETENTION_ENABLED` defaulting to false is
   * Global Constraint 5.
   */
  it("defaults the three retention keys from an empty (minimal) environment — INERT by default", () => {
    const cfg = loadConfig(base);
    expect(cfg.retentionEnabled).toBe(false); // GC5: the mechanism ships off
    expect(cfg.retentionEventsMonths).toBe(120);
    expect(cfg.notifyRetainDays).toBe(180);
  });

  it("honours RETENTION_ENABLED only for the exact strings 'true' and 'false'", () => {
    expect(loadConfig({ ...base, RETENTION_ENABLED: "true" }).retentionEnabled).toBe(true);
    expect(loadConfig({ ...base, RETENTION_ENABLED: "false" }).retentionEnabled).toBe(false);
    // The `z.coerce.boolean()` trap, pinned: under coercion "false" is a non-empty string and
    // therefore TRUE, which would switch retention ON for an operator writing the value that
    // means off. Anything ambiguous fails loudly instead.
    expect(() => loadConfig({ ...base, RETENTION_ENABLED: "1" })).toThrow();
    expect(() => loadConfig({ ...base, RETENTION_ENABLED: "TRUE" })).toThrow();
  });

  it("honours numeric overrides of the two retention windows", () => {
    const cfg = loadConfig({ ...base, RETENTION_EVENTS_MONTHS: "24", NOTIFY_RETAIN_DAYS: "30" });
    expect(cfg.retentionEventsMonths).toBe(24);
    expect(cfg.notifyRetainDays).toBe(30);
  });

  /**
   * PLAN 09 / DD14 — THE FIVE STRUCTURAL-OFF FLAGS.
   *
   * WHAT THIS BLOCK DOES *NOT* DISCHARGE, said here for the same reason the retention block above
   * says it: a NON-DEFAULT value must change BEHAVIOUR through the production wiring, and parsing
   * was never the thing in doubt (§2.60(a), the `NOTIFY_STUCK_AFTER_MS` scar). The take-effect legs
   * belong to the tasks that wire each flag — `priceDraft` for benefits (T4), the accrual handler
   * for the two commission flags (T6/T7) — and each of those is an Assertion Book row of its own
   * (D1, F4, G5).
   *
   * WHAT IT DOES DISCHARGE is the half that is this task's, and it is load-bearing: the defaults
   * resolve from an environment containing NONE of the five keys (the B1 scar — nothing new may be
   * required in any `.env`, on the server or in CI), every one of them is FALSE, and the
   * `z.coerce.boolean()` trap is refused in both directions.
   */
  const FLAGS = [
    ["MEMBERSHIP_SALES_ENABLED", "membershipSalesEnabled"],
    ["MEMBER_BENEFITS_ENABLED", "memberBenefitsEnabled"],
    ["COMMISSION_ACCRUAL_ENABLED", "commissionAccrualEnabled"],
    ["RECEIVABLE_COMMISSION_ENABLED", "receivableCommissionEnabled"],
    ["COUPON_ISSUANCE_ENABLED", "couponIssuanceEnabled"],
  ] as const;

  it("defaults all five Plan 09 flags to FALSE from an env carrying none of them", () => {
    // `base` is DATABASE_URL + SECRET_KEY and nothing else — which is the whole point.
    for (const key of FLAGS.map(([envKey]) => envKey)) {
      expect(Object.keys(base)).not.toContain(key);
    }
    const cfg = loadConfig(base);
    expect(cfg.membershipSalesEnabled).toBe(false); // sales open next phase
    expect(cfg.memberBenefitsEnabled).toBe(false); // DD8's ordered flip has not run
    expect(cfg.commissionAccrualEnabled).toBe(false); // CA/counsel register 2+3 — O-8, owner
    expect(cfg.receivableCommissionEnabled).toBe(false); // CA/counsel register 2 — O-8, owner
    expect(cfg.couponIssuanceEnabled).toBe(false); // CA/counsel register 5 — O-8, owner
  });

  it("honours each Plan 09 flag ONLY for the exact strings 'true' and 'false'", () => {
    for (const [envKey, configKey] of FLAGS) {
      expect(loadConfig({ ...base, [envKey]: "true" })[configKey]).toBe(true);
      expect(loadConfig({ ...base, [envKey]: "false" })[configKey]).toBe(false);
      // The `z.coerce.boolean()` trap, pinned per flag: under coercion "false" is a non-empty
      // string and therefore TRUE, which would arm a lane for an operator writing the value that
      // means off — on a trust hospital, for a lane the CA has not signed off. Anything ambiguous
      // fails loudly instead.
      expect(() => loadConfig({ ...base, [envKey]: "1" })).toThrow();
      expect(() => loadConfig({ ...base, [envKey]: "TRUE" })).toThrow();
      expect(() => loadConfig({ ...base, [envKey]: "" })).toThrow();
    }
  });

  it("one flag ON leaves the other four OFF — they are five gates, not one switch", () => {
    // DD14 maps each flag to a different gate (two of them to different CA/counsel register
    // items), so a shared `enabled` would be a silent widening of whichever ruling came first.
    const cfg = loadConfig({ ...base, MEMBER_BENEFITS_ENABLED: "true" });
    expect(cfg.memberBenefitsEnabled).toBe(true);
    expect(cfg.membershipSalesEnabled).toBe(false);
    expect(cfg.commissionAccrualEnabled).toBe(false);
    expect(cfg.receivableCommissionEnabled).toBe(false);
    expect(cfg.couponIssuanceEnabled).toBe(false);
  });
});

/**
 * 2026-09-19 — the copilot's first model (TypeSafe). The B1 scar again: nothing may be REQUIRED in
 * any `.env`, and an environment without the key must leave the router exactly as it was — which
 * `typesafeClient` makes true by returning null on a null key.
 */
describe("loadConfig — copilotChoice", () => {
  it("resolves from an environment that names none of its keys, with the classifier switched off", () => {
    expect(Object.keys(base).some((k) => k.startsWith("COPILOT_TYPESAFE_"))).toBe(false);
    expect(loadConfig(base).copilotChoice).toEqual({
      baseUrl: "https://api.typesafe.ai/v1",
      apiKey: null,
      model: "jev-1.13.0", // a VERSION: the confidence line was measured against it
      timeoutMs: 1000,
      minConfidence: 0.6,
    });
  });

  it("honours every override, and refuses a confidence that is not a probability", () => {
    const cfg = loadConfig({
      ...base,
      COPILOT_TYPESAFE_API_KEY: "k",
      COPILOT_TYPESAFE_MODEL: "jev-1.14.0",
      COPILOT_TYPESAFE_TIMEOUT_MS: "800",
      COPILOT_TYPESAFE_MIN_CONFIDENCE: "0.75",
    });
    expect(cfg.copilotChoice).toMatchObject({ apiKey: "k", model: "jev-1.14.0", timeoutMs: 800, minConfidence: 0.75 });
    expect(() => loadConfig({ ...base, COPILOT_TYPESAFE_MIN_CONFIDENCE: "1.5" })).toThrow();
  });
});

/** 2026-09-19 — triage's first model (TypeSafe), the same B1 rule: nothing required, off without a key. */
describe("loadConfig — triageChoice", () => {
  it("resolves from an environment that names none of its keys, with the classifier switched off", () => {
    expect(Object.keys(base).some((k) => k.startsWith("TRIAGE_TYPESAFE_"))).toBe(false);
    expect(loadConfig(base).triageChoice).toEqual({
      baseUrl: "https://api.typesafe.ai/v1", apiKey: null, model: "jev-1.13.0", timeoutMs: 1000, minConfidence: 0.6,
    });
  });

  it("honours an override, and refuses a confidence that is not a probability", () => {
    const cfg = loadConfig({ ...base, TRIAGE_TYPESAFE_API_KEY: "k", TRIAGE_TYPESAFE_MIN_CONFIDENCE: "0.7" });
    expect(cfg.triageChoice).toMatchObject({ apiKey: "k", minConfidence: 0.7 });
    expect(() => loadConfig({ ...base, TRIAGE_TYPESAFE_MIN_CONFIDENCE: "-1" })).toThrow();
  });
});

/**
 * ABDM S0 — the connector's settings. `configured` is ONE rule, computed here and read by both of
 * its readers (`modules/patients/abdm.ts`'s capability and `modules/abdm`'s runtime), so the counter
 * can never say "connected" while the callback routes answer 503, or the reverse.
 */
describe("loadConfig — abdm", () => {
  const full = {
    ...base,
    ABDM_BASE_URL: "https://dev.abdm.gov.in/api/hiecm",
    ABDM_CLIENT_ID: "SBX_0001",
    ABDM_CLIENT_SECRET: "s3cr3t-value-never-logged",
    ABDM_HIP_ID: "IN0000000001",
    ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks",
  };

  it("is INERT from an environment that names none of its keys", () => {
    expect(Object.keys(base).some((k) => k.startsWith("ABDM_"))).toBe(false);
    const { abdm } = loadConfig(base);
    expect(abdm).toMatchObject({
      baseUrl: null, abhaBaseUrl: null, clientId: null, hipId: null, hiuId: null, callbackBaseUrl: null,
      cmId: "sbx", jwtAudience: "account", configured: false,
    });
    expect(abdm.clientSecret).toBeNull();
  });

  it("is configured only when gateway, client id, secret, HIP id and callback base are ALL present", () => {
    expect(loadConfig(full).abdm.configured).toBe(true);
    for (const key of ["ABDM_BASE_URL", "ABDM_CLIENT_ID", "ABDM_CLIENT_SECRET", "ABDM_HIP_ID", "ABDM_CALLBACK_BASE_URL"] as const) {
      expect({ key, configured: loadConfig({ ...full, [key]: "" }).abdm.configured }).toEqual({ key, configured: false });
    }
    // The FD-12 triple alone — the old rule — is no longer enough.
    expect(loadConfig({ ...base, ABDM_BASE_URL: full.ABDM_BASE_URL, ABDM_CLIENT_ID: "x", ABDM_CLIENT_SECRET: "y" }).abdm.configured).toBe(false);
    // The optional ones do not gate it.
    expect(loadConfig({ ...full, ABDM_HIU_ID: "", ABDM_ABHA_BASE_URL: "" }).abdm.configured).toBe(true);
  });

  it("reads X-CM-ID as sbx | abdm, an EMPTY value as the sbx default, and refuses anything else at boot", () => {
    expect(loadConfig({ ...full, ABDM_CM_ID: "abdm" }).abdm.cmId).toBe("abdm");
    expect(loadConfig({ ...full, ABDM_CM_ID: "" }).abdm.cmId).toBe("sbx");
    expect(() => loadConfig({ ...full, ABDM_CM_ID: "prod" })).toThrow();
  });

  it("honours the optional keys", () => {
    const { abdm } = loadConfig({ ...full, ABDM_HIU_ID: "HIU-1", ABDM_ABHA_BASE_URL: "https://abhasbx.abdm.gov.in/abha/api", ABDM_JWT_AUDIENCE: "other" });
    expect(abdm).toMatchObject({ hiuId: "HIU-1", abhaBaseUrl: "https://abhasbx.abdm.gov.in/abha/api", jwtAudience: "other" });
  });

  it("keeps the client secret readable but out of every serialisation of the config", () => {
    const cfg = loadConfig(full);
    expect(cfg.abdm.clientSecret).toBe(full.ABDM_CLIENT_SECRET);
    expect(JSON.stringify(cfg)).not.toContain(full.ABDM_CLIENT_SECRET);
    expect(inspect(cfg, { depth: 5 })).not.toContain(full.ABDM_CLIENT_SECRET);
    expect(`${JSON.stringify({ ...cfg.abdm })}`).not.toContain(full.ABDM_CLIENT_SECRET);
  });
});
