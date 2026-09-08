import { eq } from "drizzle-orm";
import { labAnalytes, labReflexRules } from "../../kernel/db/schema";
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
export async function activateTshReflex(db: Db): Promise<void> {
  const [tsh] = await db.select({ id: labAnalytes.id }).from(labAnalytes)
    .where(eq(labAnalytes.code, "TSH"));
  await db.update(labReflexRules).set({ active: true })
    .where(eq(labReflexRules.analyteId, tsh!.id));
}

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
