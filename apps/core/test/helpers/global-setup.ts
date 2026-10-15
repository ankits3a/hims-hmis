import { loadEnv } from "../../src/kernel/config";
import { prepareWorkerDb } from "./db";

/**
 * Runs once per jest run, in the parent, before any worker starts. It creates and migrates
 * `<TEST_DATABASE_URL db>_1 .. _N`, where N is the run's resolved worker count (`maxWorkers` in
 * jest.config.cjs, or `-w` on the command line; jest sets `JEST_WORKER_ID=1` under `--runInBand`).
 * The cold migrate then happens here, where no hook timeout applies, and not inside the first suite's
 * `beforeAll(setupTestDb)` with its 15 s budget. Main 4b300060 went red that way: CI run
 * 36750365736, core shard 1 (see `migrateTestDb` in ./db.ts). The DBs are distinct, so they migrate
 * in parallel.
 */
export default async function globalSetup(globalConfig: { maxWorkers?: number }): Promise<void> {
  loadEnv();
  const workers = Math.max(1, globalConfig.maxWorkers ?? 2);
  await Promise.all(Array.from({ length: workers }, (_, i) => prepareWorkerDb(String(i + 1))));
}
