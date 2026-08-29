import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Plan 11a residual 4 (gate report §7.3) — the drift pin between the scheduler's job registry and
 * the production alert rules.
 *
 * `docker/prod/prometheus/alerts.yml` says of itself: "The nine job names and their cadences are
 * transcribed verbatim from `registerAllJobs`  — this file invents no cadence of its own." It was
 * true when it was written and nothing made it stay true: the names appear THREE times in that
 * file (an interval `job=~` leg, a daily `job=~` leg, and one `absent()` term per job) and there
 * were zero references to `alerts.yml` anywhere under `apps/` or `packages/`.
 *
 * The drift is silent and it fails in the worst direction. Add a tenth job and
 * `HmisSchedulerJobMissing` — the rule whose entire purpose is to notice a job that never starts
 * (spike finding 6: `scheduler_heartbeats` holds a row only once a job has run at least once) —
 * is blind to precisely the new job most likely to be misconfigured. Rename one and the alert
 * fires forever for a job that no longer exists, which is the same as an alert nobody believes.
 *
 * THE SAME PLAN ALREADY SHIPPED THIS PATTERN one directory over, for the Caddyfile
 * (`caddyfile-parity.test.ts`, D14). This is that test's sibling and deliberately its twin in
 * shape, down to the vacuity defences.
 *
 * §2.49 — THIS TEST CAN PASS VACUOUSLY AND MUST NOT: three parsers that all return [] agree with
 * each other forever. Four things prevent it. Every parser THROWS rather than returns empty on a
 * shape it does not recognise; the first test pins the registry side to a known census (nine
 * jobs, `retentionSweep` and `runDispatchCycle` among them) BEFORE anything is compared; the two
 * `job=~` legs are required to be DISJOINT, so a leg that swallowed every name could not pass;
 * and the `absent()` set is compared independently of both legs.
 *
 * The count in the first test is deliberate friction. A task that registers a job edits four
 * places in one commit: `jobs.ts`, both censuses, `alerts.yml`, and that number.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const JOBS_TS = resolve(REPO_ROOT, "apps", "core", "src", "kernel", "worker", "jobs.ts");
const ALERTS_YML = resolve(REPO_ROOT, "docker", "prod", "prometheus", "alerts.yml");

/**
 * The `name:` of every `scheduler.register({ ... })` in `registerAllJobs`, in registration order.
 * Scoped to that function so a `name:` elsewhere in the file cannot leak in.
 */
function registeredJobNames(source: string): string[] {
  const start = source.indexOf("export function registerAllJobs");
  if (start < 0) {
    throw new Error("jobs.ts: no `export function registerAllJobs` — this parser is stale");
  }
  const body = source.slice(start);
  const names = [...body.matchAll(/scheduler\.register\(\{\s*[\s\S]*?name:\s*"([A-Za-z0-9_]+)"/g)].map(
    (m) => m[1] as string,
  );
  if (names.length === 0) {
    throw new Error("jobs.ts: found `registerAllJobs` but no `scheduler.register({ name: \"…\" })`");
  }
  return names;
}

/** The alternation inside a `job=~"a|b|c"` matcher. Throws if the file has no such matcher. */
function regexLegs(source: string): string[][] {
  const legs = [...source.matchAll(/job=~"([^"]+)"/g)].map((m) =>
    (m[1] as string).split("|").map((s) => s.trim()).filter(Boolean),
  );
  if (legs.length === 0) {
    throw new Error("alerts.yml: no `job=~\"…\"` matcher found — this parser is stale");
  }
  return legs;
}

/** Every job named inside an `absent(...)` term. Throws if there are none. */
function absentJobNames(source: string): string[] {
  const terms = [...source.matchAll(/absent\(\s*hmis_scheduler_heartbeat_staleness_seconds\{job="([^"]+)"\}\s*\)/g)].map(
    (m) => m[1] as string,
  );
  if (terms.length === 0) {
    throw new Error("alerts.yml: no `absent(hmis_scheduler_heartbeat_staleness_seconds{job=\"…\"})` term found");
  }
  return terms;
}

const jobsSource = readFileSync(JOBS_TS, "utf8");
const alertsSource = readFileSync(ALERTS_YML, "utf8");

describe("alerts.yml mirrors the scheduler's job registry (Plan 11a residual 4)", () => {
  const registered = registeredJobNames(jobsSource);

  it("pins the registry census, so nothing below can agree vacuously", () => {
    // Not `toHaveLength` alone: name the jobs, so a rename is a readable diff rather than a count.
    expect([...registered].sort()).toEqual(
      [
        "createEventPartitions",
        // PLAN 15 T4 / F1 — the TWELFTH job, an INTERVAL one, so like the tenth it joins leg 1a's
        // `job=~` alternation and leg 2's `absent()` chain and leaves the daily leg alone. This
        // array is SORTED (a rename is a readable diff), so it lands second rather than last.
        "flagLateSurgeons",
        "retentionSweep",
        // PLAN 07c T8 — the THIRTEENTH job, a DAILY one (`dailyIst("02:00")`): the per-user daily
        // rollup the five-period briefs read. Like the eleventh it joins leg 1b's `job=~`
        // alternation and leg 2's `absent()` chain, and the INTERVAL leg does not move. The
        // docstring's prediction held for a third time — jobs.ts, both censuses, alerts.yml, and
        // the number below — and this time all four were in the task's Files list.
        "rollupUserDayFacts",
        "runDailyClose",
        "runDispatchCycle",
        "runDueTimers",
        "runNotifyPump",
        "sweepAppointmentNoShows",
        "sweepGuardianMajority",
        "sweepExpiredTempRoles",
        // Plan 11c D6 — the TENTH job. It is an INTERVAL job, so it joins leg 1a's `job=~`
        // alternation and leg 2's `absent()` chain in `alerts.yml`; the DAILY leg does not move.
        "sweepInterfaceHeartbeats",
        // PLAN 14 T8 / DD14 — the ELEVENTH job. It is a DAILY job (`dailyIst("06:30")`), so it
        // joins leg 1b's `job=~` alternation and leg 2's `absent()` chain; the INTERVAL leg does
        // not move. **The docstring above predicted this edit exactly** — "a task that registers a
        // job edits four places in one commit: `jobs.ts`, both censuses, `alerts.yml`, and that
        // number" — and Plan 14 T8's Files list named only two of the four. Finding F14.
        "sweepBatchExpiry",
        // PLAN 17a T5 / DD20 — the FOURTEENTH and FIFTEENTH. `sweepLabNonReturn` is DAILY
        // (`dailyIst("07:00")`) so it joins leg 1b's alternation; `sweepLabSla` is an INTERVAL job
        // (`every(60_000)`) so it joins leg 1a's. **The docstring above predicted this edit for a
        // third time** — "a task that registers a job edits four places in one commit" — and 17a
        // T5's Files list, like Plan 14 T8's, named only some of them. Finding F19.
        "sweepLabNonReturn",
        "sweepLabSla",
      ].sort(),
    );
    expect(registered).toHaveLength(15);
    expect(new Set(registered).size).toBe(15); // no job registered twice
  });

  it("the two staleness legs together cover every registered job, exactly once each", () => {
    const legs = regexLegs(alertsSource);
    expect(legs).toHaveLength(2); // one interval leg, one daily leg

    const [intervalLeg, dailyLeg] = legs as [string[], string[]];
    // DISJOINT, asserted: a leg that had swallowed every name would otherwise satisfy the union.
    const overlap = intervalLeg.filter((j) => dailyLeg.includes(j));
    expect(overlap).toEqual([]);

    const covered = [...intervalLeg, ...dailyLeg].sort();
    expect(covered).toEqual([...registered].sort());
  });

  it("the missing-series rule names every registered job in its own absent() term", () => {
    // This is flag ⑨'s rule. A job absent from here is a job whose total silence is invisible —
    // the staleness legs cannot see it, because a job that never ran has no series to be stale.
    const absent = absentJobNames(alertsSource);
    expect(new Set(absent).size).toBe(absent.length); // no duplicated term
    expect([...absent].sort()).toEqual([...registered].sort());
  });

  it("every parser throws on a shape it does not recognise, rather than returning empty", () => {
    // The vacuity guard itself, tested. Two parsers that both return [] agree forever.
    expect(() => registeredJobNames("export function somethingElse() {}")).toThrow(/stale/);
    expect(() => regexLegs("groups: []\n")).toThrow(/stale/);
    expect(() => absentJobNames("groups: []\n")).toThrow(/absent/);
  });
});
