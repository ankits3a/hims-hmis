import argon2 from "argon2";
import { argon2Options } from "./identity";

/**
 * ═══ THE TEST COST MUST NEVER BE REACHABLE BY A REAL DEPLOYMENT ═══
 *
 * Fixtures mint eight users per `beforeEach` and one OWASP-baseline hash costs ~36 ms, so lowering
 * the cost in tests is worth ~290 ms of every test in the repository. The whole safety of that
 * trade is the guard, and a guard nobody asserts is a guard nobody has.
 *
 * TWO independent conditions, and this file's job is to prove **each one alone is inert**. A single
 * condition would be a foot-gun either way round: `NODE_ENV=test` is a plausible deployment slip,
 * and a lone opt-in variable is a switch named "weaken the password hashing" that anything could
 * set. Both must be wrong at once, which is not a slip but a decision.
 *
 * `argon2Options` takes its environment as a PARAMETER rather than reading the ambient one, which
 * is what lets this file assert the production branch from inside a process where `NODE_ENV` is
 * already `test`. A guard that could only be tested in the environment it is meant to exclude
 * could not be tested at all.
 */
const OWASP = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

describe("argon2 cost guard", () => {
  it("defaults to the OWASP baseline when the environment says nothing", () => {
    expect(argon2Options({})).toEqual(OWASP);
  });

  it("NODE_ENV=test ALONE is inert — a test-shaped environment does not weaken hashing", () => {
    expect(argon2Options({ NODE_ENV: "test" })).toEqual(OWASP);
  });

  it("the opt-in variable ALONE is inert — including in production, which is the dangerous case", () => {
    expect(argon2Options({ ARGON2_TEST_COST: "1" })).toEqual(OWASP);
    expect(argon2Options({ NODE_ENV: "production", ARGON2_TEST_COST: "1" })).toEqual(OWASP);
  });

  it("only BOTH together lower the cost, and then only to the documented test params", () => {
    const opts = argon2Options({ NODE_ENV: "test", ARGON2_TEST_COST: "1" });
    expect(opts).toEqual({ type: argon2.argon2id, memoryCost: 1024, timeCost: 2, parallelism: 1 });
  });

  /**
   * ═══ AND THE TEST PARAMS MUST BE ONES ARGON2 WILL ACTUALLY ACCEPT ═══
   *
   * This case exists because the suite above SHIPPED GREEN WITH INVALID PARAMETERS. Asserting the
   * shape of the returned object proves the guard chose the right branch and says nothing about
   * whether the library consents to it: `memoryCost: 512, timeCost: 1` satisfied every assertion
   * above and then threw `Invalid memoryCost` inside every fixture in the repository.
   *
   * A test that checks what a function RETURNS, where the real contract is what a dependency
   * ACCEPTS, is a test that cannot fail for the reason it was written.
   */
  it("the test params are ones argon2 will actually hash with — the assertion the shape check cannot make", async () => {
    const opts = argon2Options({ NODE_ENV: "test", ARGON2_TEST_COST: "1" });
    const hash = await argon2.hash("p1234567", opts);
    expect(hash).toContain("m=1024");
    await expect(argon2.verify(hash, "p1234567")).resolves.toBe(true);
    await expect(argon2.verify(hash, "wrong-password")).resolves.toBe(false);
  }, 30000);

  /**
   * THE PRODUCTION PARAMS ARE PINNED, not merely defaulted. If a later change lowers the real
   * baseline — the failure this whole file exists to prevent — the first three cases above would
   * still pass, because they only assert that production and test differ.
   */
  it("pins the production baseline itself: 19456 KiB / t=2 / p=1, argon2id", () => {
    expect(argon2Options({ NODE_ENV: "production" })).toEqual(OWASP);
  });

  /**
   * A hash carries its own parameters, so nothing hashed at production cost needs rehashing and
   * verification is unaffected by this switch. Asserted rather than assumed, because the entire
   * "no retrospective effect" claim rests on it.
   */
  it("a hash minted at PRODUCTION cost still verifies inside a test process", async () => {
    const hash = await argon2.hash("p1234567", argon2Options({ NODE_ENV: "production" }));
    expect(hash).toContain("m=19456");
    await expect(argon2.verify(hash, "p1234567")).resolves.toBe(true);
    await expect(argon2.verify(hash, "wrong-password")).resolves.toBe(false);
  }, 30000);
});
