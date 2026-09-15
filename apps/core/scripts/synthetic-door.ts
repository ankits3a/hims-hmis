/**
 * PHASE 11i T5 / D5 — THE SYNTHETIC-DATA DOOR, AND IT IS AN ENVIRONMENT FACT RATHER THAN AN
 * ARGUMENT.
 *
 * ═══ WHY THE EXISTING REFUSALS ARE NOT ENOUGH ANY MORE ═══
 *
 * `seed-lab-catalogue` refuses a URL containing `:5434` (production's database port) or
 * `NODE_ENV=production`. `seed-lab-demo` refuses `NODE_ENV=production` and demands
 * `ALLOW_DEMO_DATA=yes`. Both were right, and 11i T3 broke the load-bearing half of both: **UAT
 * runs the PRODUCTION IMAGE, and the production image sets `NODE_ENV=production`.** If it did not,
 * UAT would be rehearsing a different build, which is the one thing UAT must never do.
 *
 * So the door cannot be `NODE_ENV`. It has to be a fact about the ENVIRONMENT that production's
 * own environment file never carries: `HMIS_SYNTHETIC_DATA_OK=1`, set in `/opt/hmis-uat/.env` and
 * nowhere else. `deploy-parity.test.ts` asserts the production template does not declare the key,
 * and `deploy.sh`'s prod target REFUSES TO START if it finds one set.
 *
 * ═══ A THIRD DOOR, NOT A REPLACEMENT ═══
 *
 * Every existing refusal stays. The `:5434` check still catches a laptop pointed at production's
 * port; `NODE_ENV` still catches a plain production container; `ALLOW_DEMO_DATA` is still the word
 * an operator has to type. This is the door that makes UAT possible without making production
 * reachable, and a door that REPLACED the others would be a widening dressed as a fix.
 */
export const SYNTHETIC_DATA_KEY = "HMIS_SYNTHETIC_DATA_OK";

export function assertSyntheticDataAllowed(
  script: string, env: { HMIS_SYNTHETIC_DATA_OK?: string | undefined } = process.env,
): void {
  if (env[SYNTHETIC_DATA_KEY] === "1") return;
  throw new Error(
    `${script}: REFUSED — this script writes SYNTHETIC data and ${SYNTHETIC_DATA_KEY} is not set to 1.\n` +
      "  That key is an environment fact, not a flag: it belongs in a non-production deploy\n" +
      "  directory's .env (/opt/hmis-uat/.env) and in no other .env on this host. Production's\n" +
      "  environment template does not declare it and deploy.sh refuses to run with it set.",
  );
}
