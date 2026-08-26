import { sql } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { allocateUhid, isValidUhid } from "../src/modules/patients/uhid";

/**
 * Renumbers every patient still carrying a PRE-2026-08-25 UHID onto the current format.
 * Usage: pnpm --filter @hmis/core remint:uhids            (add DRY_RUN=1 to print and change nothing)
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF MIGRATION 0024: a new UHID needs its Verhoeff check digit,
 * and the algorithm lives in TypeScript where it is property-tested against every single-digit
 * substitution and every adjacent transposition. Transcribing it into plpgsql to save one command
 * would put a second, untested copy of a correctness-critical algorithm into the migration history.
 *
 * WHY RENUMBERING IS SAFE HERE AND WOULD NOT BE LATER: every patient row that exists when this
 * ships is SYNTHETIC (owner-confirmed 2026-08-25 — 21 rows in production, 2 in dev). A UHID is
 * meant to be permanent precisely because renumbering breaks printed cards and paper records, so
 * this script is a one-time commissioning tool, not a maintenance one. It refuses nothing and
 * asks nothing: read the census it prints before letting it write.
 *
 * IT IS IDEMPOTENT ON FORMAT, NOT ON PREFIX. Selection is "does not already parse as a
 * current-format UHID", so a second run is a no-op rather than a second renumbering — which also
 * means RE-SEEDING THE PREFIX MUST COME FIRST. New ids are minted through `allocateUhid`, which
 * reads `registration_config`; run this before `UHID_PREFIX=U … seed:registration` and every
 * patient is stamped with the old prefix in a shape this script will then decline to revisit.
 */
async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "1";
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const rows = await db.execute<{ id: string; uhid: string; legacy_uhid: string | null }>(
      sql`select id, uhid, legacy_uhid from patients order by uhid asc`,
    );
    const stale = rows.rows.filter((r) => !isValidUhid(r.uhid));
    console.log(`patients: ${rows.rows.length} total, ${stale.length} on the old format`);
    if (stale.length === 0) {
      console.log("nothing to re-mint — every patient already carries a current-format UHID");
      return;
    }
    if (dryRun) {
      for (const r of stale) console.log(`  would re-mint ${r.uhid} (patient ${r.id})`);
      console.log("DRY_RUN=1 — no rows written");
      return;
    }
    await withTx(db, async (tx) => {
      for (const r of stale) {
        const next = await allocateUhid(tx);
        /**
         * The old id goes to `legacy_uhid`, the D-43 paper-era cross-reference column that has
         * been sitting empty since Plan 05 for exactly this shape of problem — a number a human
         * or a document might still quote after the system stopped issuing it. `coalesce` keeps a
         * genuine paper-era value if one is already parked there; this migration's old id is not
         * more important than the hospital's.
         *
         * `qr_version` MUST move. A card's QR payload embeds the UHID under an HMAC (qr.ts), so
         * every card printed before this run now attests to an id its patient no longer has.
         * Bumping the version makes those cards fail verification loudly (D-23) instead of
         * resolving to a patient whose number has silently changed underneath them.
         */
        await tx.execute(sql`
          update patients
             set uhid = ${next},
                 legacy_uhid = coalesce(legacy_uhid, ${r.uhid}),
                 qr_version = qr_version + 1,
                 updated_by = 'remint:uhids',
                 updated_at = now()
           where id = ${r.id}
        `);
        console.log(`  ${r.uhid} → ${next}  (patient ${r.id})`);
      }
    });
    console.log(`re-minted ${stale.length} patient(s); every old id is parked in legacy_uhid and every old QR card is now stale`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
}); // the shipped seed-admin.ts convention: a failed run exits non-zero, loudly
