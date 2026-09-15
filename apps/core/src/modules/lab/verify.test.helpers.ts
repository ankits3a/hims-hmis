import { eq } from "drizzle-orm";
import { labAnalytes, labReflexRules } from "../../kernel/db/schema";
import { serviceIdForLabCode } from "../../../scripts/seed-lab-catalogue";
import type { Db } from "../../kernel/db/client";

/**
 * SHARED TEST SUPPORT for the lab suites that need a LIVE reflex rule.
 *
 * It is a plain module rather than an export from `verify.test.ts`, because importing one test file
 * from another registers the imported file's `describe` blocks into the importing suite — which
 * silently doubles every assertion in it and attributes the failures to the wrong file.
 *
 * DD8 — the golden catalogue ships all three reflex rules INACTIVE. A reflex is an order the system
 * places and the patient pays for, so it is switched on per hospital by a human decision, and a
 * fixture that needed one switches it on in as many words.
 */
export async function activateTshReflex(db: Db, addsOrderableCode?: string): Promise<void> {
  const [tsh] = await db.select({ id: labAnalytes.id }).from(labAnalytes)
    .where(eq(labAnalytes.code, "TSH"));
  await db.update(labReflexRules)
    .set({
      active: true,
      ...(addsOrderableCode === undefined ? {} : { addsServiceId: serviceIdForLabCode(addsOrderableCode) }),
    })
    .where(eq(labReflexRules.analyteId, tsh!.id));
}

/**
 * ═══ WHY A CALLER WOULD REPOINT THE TARGET — AND A CATALOGUE FINDING, RECORDED ═══
 *
 * The golden catalogue's rule is **`TSH > 6.0 adds TFT`**, which is right for a STANDALONE TSH: a
 * raised thyroid stimulating hormone earns the full profile. It is wrong when the TSH arrives
 * INSIDE a TFT — the profile has already been run, and reflexing adds a second one.
 *
 * That was invisible until the owner's ruling of 2026-09-13 (one service, one charge, one visit) and
 * FD-27's guard: a fixture ordering TFT now has its own TSH reflex refused as a duplicate bill, and
 * `lab.reflex_refused` records it with the billing reason. **The module's behaviour is correct in
 * both directions** — it places when the target is new and records a refusal when it is not.
 *
 * **The catalogue rule is the thing worth a second look, and changing it is not a test's business:**
 * a reflex is a clinical document the pathologist signs off, so whether `TSH -> TFT` should be
 * scoped to standalone TSH orders is the lab head's decision, not a fixture's. Raised, not taken.
 *
 * A test that needs a reflex which actually PLACES passes a target the visit has not billed — and it
 * then behaves identically with or without FD-27's guard, which is the property that lets it sit on
 * `main` before that guard lands.
 */

/**
 * The DIABETIC reflex: a fasting glucose over 126 mg/dL adds an HbA1c — standard screening in any
 * Indian corporate lab. **Its target is deliberately UNPRICED by `seedLabDeskBase`** (`HBA1C` is not
 * in `PRICED_LAB_CODES`), which makes it the fixture for the refusal path: the counter never sells
 * an HbA1c on its own, so nobody notices it is unpriced until a glucose reflexes onto it. That is
 * the ordinary go-live gap close review M1 describes, reproduced rather than invented.
 */
export async function activateGlucoseReflex(db: Db): Promise<void> {
  const [gluf] = await db.select({ id: labAnalytes.id }).from(labAnalytes)
    .where(eq(labAnalytes.code, "GLUF"));
  await db.update(labReflexRules).set({ active: true })
    .where(eq(labReflexRules.analyteId, gluf!.id));
}
