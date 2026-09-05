import { loadEnv } from "../../src/kernel/config";

loadEnv();
// Test-only secret defaults. Never used outside jest; real values come from the environment.
process.env.SECRET_KEY ??= "0".repeat(64);
/**
 * The HARNESS opts in to cheap password hashing; production code never guesses where it is running.
 * `argon2Options` also requires `NODE_ENV === "test"` (jest sets it), so this line alone does
 * nothing outside a test process — `src/kernel/auth/argon2-cost.test.ts` asserts that both ways.
 * Worth ~290 ms per `beforeEach`: the fixtures mint eight users and one OWASP hash costs ~36 ms.
 */
process.env.ARGON2_TEST_COST ??= "1";
