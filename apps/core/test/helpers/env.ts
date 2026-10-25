import { loadEnv } from "../../src/kernel/config";
import { DARK_MODULE_KEYS } from "../../src/kernel/modules/switch";

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
/**
 * Decision 0085 — the suites exercise the modules shipped dark, so the harness switches all ten on; production leaves
 * `HMIS_MODULES_ON` empty. That darkness is proven with explicit switches (`kernel/modules/switch.test.ts`), never by
 * the ambient environment, so this default cannot hide a leak.
 */
process.env.HMIS_MODULES_ON ??= DARK_MODULE_KEYS.join(",");
