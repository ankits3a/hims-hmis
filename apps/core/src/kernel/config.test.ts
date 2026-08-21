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
});
