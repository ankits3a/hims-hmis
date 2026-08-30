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
