import { holderBookImports } from "../../kernel/db/schema";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ BENEFITS ARMED WITH NO HOLDER BOOK — A WARNING AT BOOT, AND WHY IT IS HERE ═══
 *
 * `MEMBER_BENEFITS_ENABLED` arms the counter's member discounts. `membership.controller.ts` records
 * the intended order: *"recognition is deployed and the holder book imported BEFORE
 * `MEMBER_BENEFITS_ENABLED`"*. Done in the other order — flag first, book never — **every member
 * presents a card and is billed at full price**, and nothing anywhere says so.
 *
 * ═══ FOUR PLACES THIS COULD HAVE LIVED, AND WHY EACH OF THE OTHER THREE IS WRONG ═══
 *
 * · **A readiness-census row.** `holder_book_imports` is a real durable trace, so it was checkable —
 *   but membership is OPTIONAL and off by default, and every `hospital` row is a UNIVERSAL fact
 *   (billing config, GST, registration config, a second administrator). `deploy.sh` prints the
 *   census's reds as "the to-do list", so an unconditional row is a permanent red on every
 *   partnerless hospital for ever — the anti-pattern `standup-check.ts`'s own header names.
 * · **A flag-conditional census row.** Green during exactly the window when the work is due, because
 *   the documented sequence imports the book BEFORE the flip. **A check that reports success while
 *   the thing is undone is not a weak check; it is the same defect as a row that reads green over an
 *   empty table.**
 * · **A warning inside the importer.** It fires when somebody RUNS the import — the correct path.
 *   The failure is that nobody ran it, so it would never print. **A control that only fires when you
 *   do the thing right is not a control for doing it wrong.**
 *
 * So it fires HERE, at boot, on the failure state itself: armed, and no book. Silent in every
 * partnerless hospital because the flag is off, and silent once a book exists.
 *
 * ═══ IT WARNS AND DOES NOT REFUSE, WHICH IS A DELIBERATE SPLIT FROM `buildSubscriptionBus` ═══
 *
 * That one turns a declared subscription with no handler into a BOOT ERROR, and rightly: it is a
 * CODE defect that can never be correct and is caught in CI before an operator ever sees it. This is
 * a DATA state an operator can legitimately be halfway through, with **no safety edge** — a member
 * billed at full price is recoverable at the counter and visible the first time a card is presented.
 * Refusing to boot would take the whole API down for an optional module's misconfiguration.
 *
 * It is also this module's own posture. `errors.ts` records why `MEMBER_BENEFITS_ENABLED` exists at
 * all: a clerk *"saw an unexplained server error instead of 'split the bill'"*. The module's history
 * is turning hard failures into legible ones, not the reverse.
 */
export const MEMBER_BENEFITS_ARMED_WITHOUT_BOOK =
  "MEMBER_BENEFITS_ENABLED is on and no holder book has ever been imported: every member will be "
  + "billed at full price and no card will be recognised. Import the partner's book "
  + "(`pnpm --filter @hmis/core tsx scripts/import-holder-book.ts <counterparty> <file>`), or set "
  + "MEMBER_BENEFITS_ENABLED=false until it is loaded.";

/** Where the warning goes. `console` in the API; a recorder in the assertions (`worker.ts`'s shape). */
export type BootLog = { warn(message: string): void };

/**
 * `enabled` is passed IN rather than read here, and that is not ceremony. `invoices.ts` reads the
 * flag from `process.env` because `loadConfig()` parses the WHOLE environment and throws where
 * `DATABASE_URL` is absent; the API's boot has already resolved `AppConfig`, so the caller hands us
 * the value the running process will actually use. **A third parse of this flag would be a third
 * copy of one fact** — `entitlements.test.ts` already pins the two that exist against each other by
 * execution, and §2.54 is what a third would violate.
 */
export async function warnIfBenefitsArmedWithoutBook(
  db: Db,
  enabled: boolean,
  log: BootLog,
): Promise<boolean> {
  if (!enabled) return false;
  const rows = await db.select({ id: holderBookImports.id }).from(holderBookImports).limit(1);
  if (rows.length > 0) return false;
  log.warn(MEMBER_BENEFITS_ARMED_WITHOUT_BOOK);
  return true;
}
