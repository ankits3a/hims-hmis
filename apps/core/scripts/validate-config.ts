// scripts/validate-config.ts — D-17's ONE GATE (Plan 11c D5). Run before go-live; the hospital
// cannot leave `commissioning` unless THIS script has printed ok=true within the last 24 hours.
//
// It is the runbook-facing twin of `POST /ops/config-validation` and calls exactly the same
// function, so a runbook step and a button can never disagree about what "validated" means.
//
// EXIT CODE IS THE VERDICT (§2.6's negative control is executed against this script both ways):
//   0  every scope green, a report row persisted, `ops.config_validated` appended
//   1  any scope red — or the run itself could not be evaluated
//
// It SUPERSEDES neither `validate:tariff` nor `validate:billing`: both keep working and are the
// right tool when you are fixing one module's configuration. This is the one whose verdict the
// go-live gate reads.
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { runConfigValidation } from "../src/kernel/ops/validate";

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const report = await runConfigValidation(db);

    // Every error first, scope-tagged, so a `grep ERROR` over the transcript is the whole worklist.
    for (const scope of report.scopes) {
      for (const err of scope.errors) console.log(`ERROR [${scope.scope}] ${err.code}: ${err.detail}`);
    }
    for (const scope of report.scopes) {
      const caSigned = scope.caSigned === null ? "" : ` caSigned=${String(scope.caSigned)}`;
      console.log(`scope ${scope.scope}: ok=${String(scope.ok)} errors=${scope.errors.length}${caSigned}`);
    }
    console.log(
      `config-validation: ok=${String(report.ok)} report=${report.reportId} at=${report.at.toISOString()} event=${report.eventId}`,
    );

    // The row is persisted and the event appended WHETHER OR NOT the verdict is green — a red
    // report is the record that the gate was run and refused, and D3's guard reads the LATEST row,
    // so a red run must be able to supersede an earlier green one. Only then does the exit code
    // report the verdict.
    if (!report.ok) process.exit(1);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
}); // seed-script convention: fail loud, exit non-zero
