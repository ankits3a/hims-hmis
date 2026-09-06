import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { backupDrillRehearsed } from "../src/kernel/retention/events";

/**
 * Plan 11d / D8 — `deploy.sh`'s two hand-maintained lists become ONE tested invariant.
 *
 * §2.77 has three specimens, all the same shape: a config file was installed for a service and the
 * service was never restarted, so the file was correct on disk, correct INSIDE the container (the
 * mounts are directories), and NOT BEING SERVED. Grafana and Prometheus ran on empty config for 35
 * minutes in Plan 11a; postgres-exporter served no `hmis_backup_last_drill_pass_age_seconds` after
 * Plan 11c, which left the backup-drill watcher D11 exists to provide INERT — a watcher that
 * cannot fire is indistinguishable from a system that is fine.
 *
 * The rule that was earned was written into a source comment above the loop at `deploy.sh:437`:
 *
 *     "every service whose config directory step 2 installs must appear in this loop"
 *
 * §3.46 is the ledger entry that says a hand-off written in a source comment reaches nobody. This
 * file is that comment promoted to an executable invariant, plus its rule-file twin (MINOR 6):
 * `prometheus.yml`'s `rule_files`, the rule files on disk, and `deploy.sh`'s installs are ONE set,
 * and a rule file that is loaded but never installed evaluates nothing while `deploy.sh` exits 0.
 *
 * §2.49 — THIS TEST CAN PASS VACUOUSLY AND MUST NOT: two parsers that both return [] agree with
 * each other forever. Three things prevent it, exactly as `caddyfile-parity.test.ts` does it.
 * EVERY parser below THROWS rather than returns empty on a shape it does not recognise; the census
 * block pins all six counts BEFORE anything is compared; and every leg parses SHIPPED BYTES —
 * `docker/prod/deploy.sh`, `docker/prod/docker-compose.prod.yml` and
 * `docker/prod/prometheus/prometheus.yml` read from disk — never a TypeScript restatement of them,
 * which would be a fourth copy of the fact rather than a check on the first three.
 *
 * The counts are deliberate friction. Adding a service with a config directory, or a rule file,
 * edits three places in one commit — and the number here is the third one.
 *
 * WHY THE SERVICE LIST COMES FROM THE COMPOSE FILE AND NOT FROM `deploy.sh`: the script reads
 * `compose config --services` at `:453`, which a jest test cannot run. The compose file is the
 * same fact one step earlier.
 *
 * WHY "POPULATES" AND NOT "INSTALLS" — measured at compile, and it is load-bearing. `install -D`
 * also targets `$DEPLOY_DIR/pgbackrest/` and `$DEPLOY_DIR/drill/`, NEITHER of which is a compose
 * service; and `alertmanager`'s config is RENDERED from `.env.smtp` rather than installed (it
 * carries an SMTP password and is never committed), so a parser keyed on `install -D` would miss
 * it and read the loop's own `alertmanager` entry as an extra. The property that closes exactly is
 * "step 2 writes a file under `$DEPLOY_DIR/<dir>/`", whichever command writes it.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEPLOY_SH = resolve(REPO_ROOT, "docker", "prod", "deploy.sh");
const DRILL_SH = resolve(REPO_ROOT, "docker", "prod", "drill", "restore-drill.sh");
const UAT_COMPOSE = resolve(REPO_ROOT, "docker", "prod", "docker-compose.uat.yml");
const UAT_RESET_SH = resolve(REPO_ROOT, "docker", "prod", "uat-reset.sh");
const ENV_EXAMPLE = resolve(REPO_ROOT, "docker", "prod", ".env.prod.example");
const COMPOSE_YML = resolve(REPO_ROOT, "docker", "prod", "docker-compose.prod.yml");
const PROMETHEUS_DIR = resolve(REPO_ROOT, "docker", "prod", "prometheus");
const PROMETHEUS_YML = resolve(PROMETHEUS_DIR, "prometheus.yml");

/**
 * The one declared exception to leg 1, and its reason. `caddy` gets an explicit
 * `caddy reload --config …` at `deploy.sh:391`, which is strictly stronger than a container
 * restart: it re-reads the config with no dropped connection at all. An exemption is only honest
 * if the thing it exempts is real, so the leg below asserts BOTH that caddy is genuinely a
 * populated service AND that the reload it is exempted for is actually in the script.
 */
const RESTART_EXEMPT = new Map<string, string>([
  ["caddy", "gets an explicit `caddy reload` at deploy.sh:391, which is stronger than a restart"],
]);

/** `prometheus.yml` is Prometheus's CONFIG file, not one of its rule files. */
const PROMETHEUS_CONFIG_BASENAME = "prometheus.yml";

/** Every service `docker-compose.prod.yml` declares, sorted. Throws if the block is unreadable. */
function composeServices(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^services:[ \t]*$/.test(line));
  if (start < 0) {
    throw new Error("docker-compose.prod.yml: no top-level `services:` key — this parser is stale");
  }
  const services: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^[A-Za-z_]/.test(line)) break; // the next top-level key ends the services block
    const match = /^ {2}([a-z][a-z0-9_-]*):[ \t]*$/.exec(line);
    const name = match?.[1];
    if (name !== undefined) services.push(name);
  }
  if (services.length === 0) {
    throw new Error("docker-compose.prod.yml: the `services:` block declares nothing — stale parser");
  }
  return services.sort();
}

/** `deploy.sh`'s step 2 block, verbatim. Throws if the step markers have moved or been renamed. */
function stepTwoBlock(source: string): string {
  const start = source.indexOf('step "2/8');
  const end = source.indexOf('step "3/8');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('deploy.sh: could not bracket step "2/8" … step "3/8" — this parser is stale');
  }
  return source.slice(start, end);
}

/** Logical shell lines: backslash-continuations joined, whole-line comments dropped. */
function commandLines(block: string): string[] {
  return block
    .replace(/\\\n[ \t]*/g, " ")
    .split("\n")
    .filter((line) => !/^[ \t]*#/.test(line));
}

/**
 * Every `<dir>` under `$DEPLOY_DIR` that step 2 writes a FILE into — by `install -D`, by a
 * rendering block, or by anything else. `$DEPLOY_DIR/docker-compose.prod.yml` (a file at the top
 * level) and `$DEPLOY_DIR/log` (a directory nothing is written into) are correctly excluded: both
 * lack the second path segment that makes a directory a CONFIG directory.
 *
 * PHASE 11i T8 — ONE NAMED EXCEPTION, and it is named rather than absorbed into the integer.
 * `$DEPLOY_DIR/previous` is where step 2 SNAPSHOTS the outgoing compose file, `caddy/` and
 * `prometheus/` before overwriting them, so the rollback path can put the configs back beside the
 * images. It matches the shape of a config directory and is definitionally not one: no service
 * mounts it, and nothing in it is ever read by a running container. Bumping the census to eight
 * would have made "populated config directory" mean two different things in the same test; this
 * keeps the census's meaning and states the exception. The snapshot itself is pinned by the T8
 * block further down.
 */
const NOT_A_CONFIG_DIR = ["previous"];

function populatedConfigDirs(block: string): string[] {
  const dirs = new Set<string>();
  for (const line of commandLines(block)) {
    for (const match of line.matchAll(/\$DEPLOY_DIR\/([A-Za-z0-9._-]+)\/[A-Za-z0-9._-]/g)) {
      const dir = match[1];
      if (dir !== undefined && !NOT_A_CONFIG_DIR.includes(dir)) dirs.add(dir);
    }
  }
  if (dirs.size === 0) {
    throw new Error("deploy.sh step 2: no `$DEPLOY_DIR/<dir>/<file>` path found — stale parser");
  }
  return [...dirs].sort();
}

/**
 * The services named in the ONE literal `for svc in …; do` restart loop. The script has three
 * other `for svc in …` loops and every one of them iterates a `$VARIABLE`, so the `[^;$\n]+`
 * class is what distinguishes the hand-maintained list from the enumerated ones. Anything but
 * exactly one literal loop throws.
 */
function restartLoopServices(source: string): string[] {
  const matches = [...source.matchAll(/^[ \t]*for svc in ([^;$\n]+); do[ \t]*$/gm)];
  if (matches.length !== 1) {
    throw new Error(
      `deploy.sh: expected exactly one literal \`for svc in …; do\` loop, found ${matches.length} — this parser is stale`,
    );
  }
  const services = (matches[0]?.[1] ?? "").trim().split(/[ \t]+/).filter((token) => token !== "");
  if (services.length === 0) {
    throw new Error("deploy.sh: the restart loop lists no services — this parser is stale");
  }
  for (const service of services) {
    if (!/^[a-z][a-z0-9_-]*$/.test(service)) {
      throw new Error(`deploy.sh: restart-loop token ${service} is not a service name`);
    }
  }
  return services.sort();
}

/** The BASENAMES `prometheus.yml`'s `rule_files` loads. Throws on any path shape it cannot read. */
function declaredRuleFiles(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^rule_files:[ \t]*$/.test(line));
  if (start < 0) {
    throw new Error("prometheus.yml: no top-level `rule_files:` key — this parser is stale");
  }
  const files: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^[A-Za-z_]/.test(line)) break; // the next top-level key ends the block
    if (line.trim() === "" || /^[ \t]*#/.test(line)) continue;
    const item = /^[ \t]*-[ \t]*(\S+)[ \t]*$/.exec(line);
    const path = item?.[1];
    if (path === undefined) {
      throw new Error(
        `prometheus.yml: unrecognised line inside rule_files: ${JSON.stringify(line)} — stale parser`,
      );
    }
    const named = /^\/etc\/prometheus\/([A-Za-z0-9._-]+\.yml)$/.exec(path);
    const basename = named?.[1];
    if (basename === undefined) {
      throw new Error(`prometheus.yml: rule_files entry ${path} is not an /etc/prometheus/*.yml path`);
    }
    files.push(basename);
  }
  if (files.length === 0) {
    throw new Error("prometheus.yml: rule_files loads nothing — this parser is stale");
  }
  return files.sort();
}

/** Every `*.yml` in `docker/prod/prometheus/` that is a RULE file (i.e. not Prometheus's config). */
function ruleFilesOnDisk(dir: string): string[] {
  const entries = readdirSync(dir).filter(
    (name) => name.endsWith(".yml") && name !== PROMETHEUS_CONFIG_BASENAME,
  );
  if (entries.length === 0) {
    throw new Error(`${dir}: no rule files on disk beside ${PROMETHEUS_CONFIG_BASENAME} — stale parser`);
  }
  return entries.sort();
}

/** The `prometheus/` basenames step 2's `install` lines copy into `$DEPLOY_DIR`. */
function installedPrometheusFiles(block: string): string[] {
  const files = new Set<string>();
  for (const line of commandLines(block)) {
    if (!/^[ \t]*install\b/.test(line)) continue;
    for (const match of line.matchAll(/\$DEPLOY_DIR\/prometheus\/([A-Za-z0-9._-]+\.yml)/g)) {
      const file = match[1];
      if (file !== undefined) files.add(file);
    }
  }
  if (files.size === 0) {
    throw new Error("deploy.sh step 2: no `$DEPLOY_DIR/prometheus/*.yml` install found — stale parser");
  }
  return [...files].sort();
}

describe("deploy.sh / compose / prometheus.yml parity (Plan 11d D8)", () => {
  const deploySource = readFileSync(DEPLOY_SH, "utf8");
  const composeSource = readFileSync(COMPOSE_YML, "utf8");
  const prometheusSource = readFileSync(PROMETHEUS_YML, "utf8");
  const stepTwo = stepTwoBlock(deploySource);

  const services = composeServices(composeSource);
  const populatedDirs = populatedConfigDirs(stepTwo);
  const populatedServices = populatedDirs.filter((dir) => services.includes(dir));
  const loopServices = restartLoopServices(deploySource);
  const declaredRules = declaredRuleFiles(prometheusSource);
  const diskRules = ruleFilesOnDisk(PROMETHEUS_DIR);
  const installedRules = installedPrometheusFiles(stepTwo).filter(
    (file) => file !== PROMETHEUS_CONFIG_BASENAME,
  );

  // ---------------------------------------------------------------------------------------------
  // LEG 3 — the census, stated BEFORE anything is compared (§2.49 / GC15). Two parsers that both
  // return [] agree forever; these numbers are what stops that being a green run.
  // ---------------------------------------------------------------------------------------------
  describe("leg 3 — the census, pinned before anything is compared", () => {
    it("reads nine services out of docker-compose.prod.yml", () => {
      expect(services).toHaveLength(9);
      expect(services).toContain("alertmanager");
      expect(services).toContain("postgres-exporter");
      expect(services).toContain("caddy");
    });

    it("reads seven populated config directories out of deploy.sh step 2", () => {
      expect(populatedDirs).toHaveLength(7);
      // The two that are populated and are NOT services — the reason this leg says "populates"
      // rather than "installs", and the reason it intersects with the compose file at all.
      expect(populatedDirs).toContain("pgbackrest");
      expect(populatedDirs).toContain("drill");
      // The one that is RENDERED rather than installed.
      expect(populatedDirs).toContain("alertmanager");
    });

    it("intersects those to exactly five services that own a config directory", () => {
      expect(populatedServices).toEqual([
        "alertmanager",
        "caddy",
        "grafana",
        "postgres-exporter",
        "prometheus",
      ]);
    });

    it("reads four services out of deploy.sh's restart loop", () => {
      expect(loopServices).toEqual(["alertmanager", "grafana", "postgres-exporter", "prometheus"]);
    });

    it("reads three rule files from rule_files, from disk, and from deploy.sh's installs", () => {
      expect(declaredRules).toHaveLength(3);
      expect(diskRules).toHaveLength(3);
      expect(installedRules).toHaveLength(3);
      expect(declaredRules).toContain("alerts-meta.yml");
    });
  });

  // ---------------------------------------------------------------------------------------------
  // LEG 1 — restart-loop closure. §2.77's rule, promoted out of a source comment.
  // ---------------------------------------------------------------------------------------------
  describe("leg 1 — every service whose config step 2 populates is restarted", () => {
    it("leaves no populated service out of the restart loop, except the declared exception", () => {
      const missing = populatedServices.filter(
        (service) => !loopServices.includes(service) && !RESTART_EXEMPT.has(service),
      );
      expect(missing).toEqual([]);
    });

    it("restarts nothing whose config step 2 does not populate", () => {
      const extra = loopServices.filter((service) => !populatedServices.includes(service));
      expect(extra).toEqual([]);
    });

    it("restarts nothing the compose file does not declare", () => {
      const undeclared = loopServices.filter((service) => !services.includes(service));
      expect(undeclared).toEqual([]);
    });

    it("exempts caddy for a real reason — it is populated, absent from the loop, and reloaded", () => {
      expect([...RESTART_EXEMPT.keys()]).toEqual(["caddy"]);
      // A vacuous exemption would be the worst outcome here: it would hide a real omission.
      expect(populatedServices).toContain("caddy");
      expect(loopServices).not.toContain("caddy");
      expect(deploySource).toMatch(
        /compose exec -T caddy caddy reload --config \/etc\/caddy\/Caddyfile/,
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  // LEG 2 — rule-file closure, both directions (MINOR 6). A rule file that prometheus.yml loads
  // and deploy.sh never installs makes Prometheus refuse to start; one that exists and is loaded
  // by nobody evaluates nothing while every green light stays green.
  // ---------------------------------------------------------------------------------------------
  describe("leg 2 — rule_files, the files on disk and deploy.sh's installs are one set", () => {
    it("names no rule file that does not exist on disk", () => {
      expect(declaredRules.filter((file) => !diskRules.includes(file))).toEqual([]);
    });

    it("leaves no rule file on disk out of rule_files", () => {
      expect(diskRules.filter((file) => !declaredRules.includes(file))).toEqual([]);
    });

    it("installs every rule file it loads", () => {
      expect(declaredRules.filter((file) => !installedRules.includes(file))).toEqual([]);
    });

    it("installs nothing it does not load", () => {
      expect(installedRules.filter((file) => !declaredRules.includes(file))).toEqual([]);
    });

    it("installs prometheus.yml itself, which is the config and not a rule file", () => {
      expect(installedPrometheusFiles(stepTwo)).toContain(PROMETHEUS_CONFIG_BASENAME);
      expect(installedRules).not.toContain(PROMETHEUS_CONFIG_BASENAME);
    });
  });
});

/**
 * ═══ PLAN 11g CLOSE REVIEW, MAJOR 1 — THE CONFIGURATION-SEED STEP, PINNED BY ORDER ═══
 *
 * Plan 11g put five seeds and a gate into `deploy.sh` (DD2), and the FIRST version ordered them
 * wrongly in a way no test could see: `seed-roles` checks a reachability invariant that includes
 * the three `ops.*` grants `seed-ops` writes, so running it first made its verdict NOT READY on a
 * fresh box — and under `set -euo pipefail` its non-zero exit killed the deploy after migrations
 * had applied and before the containers were recreated. `test/seed-roles.test.ts:545,578` already
 * asserted `ready === false` in exactly that state; nothing connected that fact to the script.
 *
 * These legs are that connection. They are static — they read the SHIPPED BYTES of `deploy.sh` —
 * because the failure is an ORDERING between programs a jest run cannot execute.
 *
 * §2.49: every parser below THROWS rather than returning empty, and the census is pinned BEFORE
 * anything is compared.
 */
const SEED_STEP_SCRIPTS = [
  // `seed-patients.js` joined on 2026-08-26 with the patients approval types. It is in the DEPLOY
  // path rather than the runbook for a measured reason: `patient_merge` was named by `merge.ts`
  // from Plan 05 and registered by nothing, so every merge request threw `unknown_type` on the
  // live box until somebody went looking.
  "seed-ops.js", "seed-opd.js", "seed-patients.js", "seed-billing.js", "seed-tariff.js",
  // ═══ PLAN 15 T2 / DD15 — THIS CENSUS NAMED SEVEN OF NINE, AND THAT IS THE DEFECT IT EXISTS TO
  //     CATCH, TWICE OVER (finding T2-e) ═══
  //
  // `deploy.sh` runs NINE configuration seeds. This array listed SEVEN: `seed-membership.js` and
  // `seed-materials.js` were both absent, so neither was checked to exist in `scripts/`, and
  // neither was checked to run BEFORE the `check-config-present.js` gate. A seed named in
  // `deploy.sh` and deleted from the tree kills a production deploy at a `node` that cannot find
  // its file — after migrations, before the containers come up — and this test is the only thing
  // standing between that and a hospital. The `seed-materials.js` gap was recorded at Plan 14's
  // close and carried here; the `seed-membership.js` gap had never been noticed at all.
  //
  // Both join in the same edit as Plan 15's own seed, because a census that names seven of nine is
  // not a census. The comment below is kept verbatim — its ORDER claim about seed-membership is
  // exactly the fact the array did not carry.
  "seed-membership.js",
  // Plan 16a T9 — the severe-pair floor, after seed-membership and before the seed-roles gate.
  "seed-formulary-interactions.js",
  "seed-materials.js",
  // PLAN 15 T2 — the day-care unit's registry rows (one theatre, two bays, the consignment bin) and
  // its two approval types. It runs AFTER `seed-materials.js` and that order is load-bearing rather
  // than cosmetic: `ensureOtUnit` creates `OT-CONSIGN` through `materials.createStore`, so the
  // materials module's own seed must have run first.
  "seed-ot.js",
  "seed-pharmacy.js", // PLAN 16c T5
  // PHASE 11i T1 — the laboratory's two Class-C definitions and its `lab_release_unpaid`
  // approval type. It joins for the reason `seed-patients` and `seed-materials` did, in its
  // sharpest form yet: the lab has been DEPLOYED since migration 0046 and could not take an
  // order the whole time, because `activateLabDefinitions` had one caller in the tree and it
  // was `test/helpers/lab.ts`. A module that ships, migrates, serves routes and throws
  // `no_active_definition` on first use is what this census exists to make impossible.
  "seed-lab.js",
  "seed-roles.js",
] as const;

/** The `dist/scripts/*.js` names `deploy.sh` runs, in the order it runs them. Throws if none. */
function deploySeedOrder(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/compose run --rm api node dist\/scripts\/([A-Za-z0-9-]+\.js)/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  if (names.length === 0) {
    throw new Error("deploy.sh: no `compose run --rm api node dist/scripts/*.js` line — this parser is stale");
  }
  return names;
}

describe("deploy.sh configuration seeding (Plan 11g / DD2, close review MAJOR 1)", () => {
  const deploySource = readFileSync(DEPLOY_SH, "utf8");
  const scriptsDir = resolve(REPO_ROOT, "apps", "core", "scripts");

  it("reads a non-vacuous census of the scripts deploy.sh runs from inside the image", () => {
    const order = deploySeedOrder(deploySource);
    /**
     * migrate + seed-cursors + the SIX config seeds + the gate.
     *
     * PLAN 09 T3 — SIX SINCE 2026-08-25, and this line is a DISCLOSED PLAN DEFECT rather than a
     * routine bump. Plan 09's §6.0 S14 rules that `seed:membership` joins `deploy.sh` (an approval
     * type reaches a deployment only through a seed script, and a grace-honor lane nobody can
     * approve is the §6.0 S3 gap), and the same sweep recorded this file as "checked and clear"
     * on the grounds that the phase changes no compose service, no config directory and no restart
     * loop — which is true, and which misses the SEED CENSUS three paragraphs below it. The sweep's
     * own remedy for exactly this shape elsewhere (S11, the SPA route census) is that the file
     * pinning the number joins the Files list of the task that moves it; this one was not, so the
     * integer is corrected here and the omission is reported as a plan defect.
     */
    // 9 until 2026-08-26, when `seed-patients.js` joined between seed-opd and seed-billing with the
    // patients approval types — the registration whose ABSENCE left every merge request throwing
    // `unknown_type` from Plan 05 onward.
    // 11 since Plan 16a T9 added `seed-formulary-interactions.js` after seed-membership: the severe
    // -pair starter FLOOR. It joins the deploy path for the same reason `seed-patients` did — a
    // check suite with an empty pair table is a check suite that finds nothing, silently — and it
    // is the first seed here that writes CLINICAL content, so its idempotence is stricter than the
    // others': an existing pair is left alone, severity and all, because §1.4 lets the DTC
    // downgrade one and a deploy must not restore it. (This file joins the Files list of the task
    // that moves the integer — the S11 rule the paragraph above invokes, applied to itself.)
    // 12 since Plan 14 T2 added `seed-materials.js` after seed-formulary-interactions: the two
    // materials approval types. It joins for the reason `seed-patients` and `seed-membership` did
    // — an approval type reaches a deployment ONLY through a seed script, and `requestApproval`
    // throws `unknown_type` without one — and unlike `seed-formulary-interactions` it writes no
    // content at all, so its idempotence question is only "does a second run draft a redundant
    // workflow definition version". `approval-types.test.ts` answers that by counting rows.
    // 13 since Plan 15 T2 added `seed-ot.js` after `seed-materials.js`: the two OT approval types
    // AND the day-care unit's four registry rows (one theatre, two kernel `bed` bays, the
    // `OT-CONSIGN` store). The ORDER matters and is asserted separately below — `ensureOtUnit`
    // creates that store through `materials.createStore`, so the materials seed must run first.
    // 14 since Plan 16c T5 added `seed-pharmacy.js` after `seed-ot.js` (the `PHARM-OPD` store is a
    // materials store too, so the materials seed still runs first).
    // 15 since Phase 11i T1 added `seed-lab.js` after `seed-pharmacy.js` and before `seed-roles.js`
    // — the pharmacy shape, one module over. (This file joins the Files list of the task that moves
    // the integer, which is the S11 rule the paragraph above invokes.)
    // 16 since Phase 11i T2 added `standup-check.js` — which is NOT a seed and is deliberately not
    // in SEED_STEP_SCRIPTS: it runs AFTER the gate and writes nothing. It appears here only because
    // this parser counts every `compose run --rm api node dist/scripts/*.js` line.
    expect(order).toHaveLength(16);
    expect(order[0]).toBe("migrate.js");
    expect(order[1]).toBe("seed-cursors.js");
  });

  it("runs seed-ops BEFORE seed-roles — the ordering the close review caught", () => {
    const order = deploySeedOrder(deploySource);
    const ops = order.indexOf("seed-ops.js");
    const roles = order.indexOf("seed-roles.js");
    expect(ops).toBeGreaterThanOrEqual(0);
    expect(roles).toBeGreaterThanOrEqual(0);
    // NAME the property rather than comparing two numbers silently: seed-roles' census counts the
    // three ops.* grants seed-ops writes, so the reverse order reports NOT READY on a fresh box.
    expect({ seedOpsAt: ops, seedRolesAt: roles, opsFirst: ops < roles })
      .toEqual({ seedOpsAt: ops, seedRolesAt: roles, opsFirst: true });
  });

  it("runs seed-roles LAST of the configuration seeds — PHASE 11i T1", () => {
    /**
     * The leg above pins ONE pair (`seed-ops` before `seed-roles`) because that pair is the one
     * that broke. This pins the PROPERTY the pair is an instance of, and it was added because 11i
     * T1's own mutant survived: `seed-lab.js` moved to after `seed-roles.js` and every existing
     * assertion here stayed green — the census counted 15, found each file, and saw all 15 run
     * before the gate.
     *
     * `seed-roles`' verdict is a census over the grants and role holders THE OTHER SEEDS WRITE.
     * A seed that runs after it is a seed whose grants its verdict cannot see, so the deploy
     * prints NOT READY about a box that is in fact ready — and a verdict that cries wolf is a
     * verdict nobody reads, which is the whole value of running it at all (`deploy.sh`:497).
     */
    const order = deploySeedOrder(deploySource);
    const rolesAt = order.indexOf("seed-roles.js");
    expect(rolesAt).toBeGreaterThanOrEqual(0);
    const after = SEED_STEP_SCRIPTS.filter((n) => n !== "seed-roles.js" && order.indexOf(n) > rolesAt);
    expect({ seedRolesAt: rolesAt, seedsRunningAfterIt: after }).toEqual({ seedRolesAt: rolesAt, seedsRunningAfterIt: [] });
  });

  it("runs every one of the configuration seeds, and each one exists in scripts/", () => {
    const order = deploySeedOrder(deploySource);
    expect(SEED_STEP_SCRIPTS.filter((name) => !order.includes(name))).toEqual([]);
    // A seed named here but deleted from the tree would make the deploy die at a `node` that
    // cannot find its file — after migrations, before the containers come up.
    const missing = SEED_STEP_SCRIPTS.filter(
      (name) => !existsSync(resolve(scriptsDir, name.replace(/\.js$/, ".ts"))),
    );
    expect(missing).toEqual([]);
  });

  it("runs the configuration GATE, and runs it after every seed", () => {
    const order = deploySeedOrder(deploySource);
    const gate = order.indexOf("check-config-present.js");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(existsSync(resolve(scriptsDir, "check-config-present.ts"))).toBe(true);
    for (const seed of SEED_STEP_SCRIPTS) expect(order.indexOf(seed)).toBeLessThan(gate);
  });

  it("runs the readiness census AFTER the gate, and does NOT obey its exit code — PHASE 11i T2", () => {
    /**
     * D3, and the `seed-roles` rule one level up. The census is RED on every box until the
     * hospital has hired its people and typed in its catalogue — a permanent, correct RED. Under
     * `set -euo pipefail` an UNWRAPPED non-zero here would kill every deploy from now until the
     * laboratory opens, after migrations and before the containers are recreated.
     *
     * The order matters too: the gate REFUSES and must run first, so a box that cannot issue an
     * invoice stops there rather than reading a census about benches.
     */
    const order = deploySeedOrder(deploySource);
    const census = order.indexOf("standup-check.js");
    const gate = order.indexOf("check-config-present.js");
    expect(existsSync(resolve(scriptsDir, "standup-check.ts"))).toBe(true);
    expect({ censusAt: census, gateAt: gate, gateFirst: gate >= 0 && census > gate })
      .toEqual({ censusAt: census, gateAt: gate, gateFirst: true });
    // Wrapped in an `if`, exactly as seed-roles is — and NOT a bare line, which is what the gate is.
    expect(deploySource).toMatch(/if compose run --rm api node dist\/scripts\/standup-check\.js all; then/);
    expect(deploySource).not.toMatch(/^compose run --rm api node dist\/scripts\/standup-check\.js/m);
    // It is not a seed: it writes nothing and must not be counted among the rows the gate guards.
    expect(SEED_STEP_SCRIPTS).not.toContain("standup-check.js");
  });

  /**
   * ═══ PHASE 11i T8 — THE BACKOUT, AND THE DRILL AS THE MIGRATION REHEARSAL (D12, D13) ═══
   *
   * Everything below reads the SHIPPED BYTES of two shell scripts, for the reason the seed census
   * above does: the failure is a sequence between programs, and `deploy.sh` is the one artefact in
   * this repository where a mistake reaches production directly rather than through a merge and a
   * train. Running it to find out is not an option; reading what it says is.
   */
  describe("the backout path and the drill's rehearsal mode (11i T8)", () => {
    const drillSource = readFileSync(DRILL_SH, "utf8");

    /** Everything between `if [ -n "$ROLLBACK_TO" ]; then` and its matching `else`/`fi`. */
    function rollbackBranches(source: string): string {
      const out: string[] = [];
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/^if \[ -n "\$ROLLBACK_TO" \]; then$/.test(lines[i]!)) continue;
        let depth = 1;
        const body: string[] = [];
        for (let j = i + 1; j < lines.length && depth > 0; j++) {
          const line = lines[j]!;
          if (/^\s*if /.test(line)) depth++;
          if (/^\s*fi\s*$/.test(line)) { depth--; if (depth === 0) break; }
          if (depth === 1 && /^else$/.test(line)) break; // the else half is the BUILD path
          body.push(line);
        }
        out.push(body.join("\n"));
      }
      if (out.length === 0) throw new Error("deploy.sh: no `if [ -n \"$ROLLBACK_TO\" ]` branch — this parser is stale");
      return out.join("\n");
    }

    it("the rollback path BUILDS NOTHING and MIGRATES NOTHING — D13", () => {
      const rollback = rollbackBranches(deploySource);
      expect(rollback.length).toBeGreaterThan(200); // non-vacuous: the branches were actually read
      // A comment may SAY "migrate"; a command line may not BE one.
      const commands = rollback.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
      expect(commands.filter((l) => l.includes("docker build"))).toEqual([]);
      expect(commands.filter((l) => /migrate\.js|db:migrate/.test(l))).toEqual([]);
      expect(commands.filter((l) => /check-config-present\.js|seed-[a-z-]+\.js/.test(l))).toEqual([]);
      // and it DOES retag, which is the whole of what it may do to the images
      expect(rollback).toMatch(/docker tag "\$repo:\$ROLLBACK_TO" "\$repo:latest"/);
    });

    it("refuses BY NAME when the image it would retag is not on the host", () => {
      // A `:latest` retagged from nothing leaves the stack pointing at nothing, and the first
      // symptom is a container that will not start — while somebody is rolling back an outage.
      expect(deploySource).toMatch(/docker image inspect "\$repo:\$ROLLBACK_TO" >\/dev\/null 2>&1[\s\S]{0,80}\|\| die/);
    });

    it("tags every image with the SHA it was built from, beside :latest", () => {
      expect(deploySource).toMatch(/IMAGE_REPOS="\$IMAGE_NS\/server \$IMAGE_NS\/web \$IMAGE_NS\/db"/);
      // `$IMAGE_NS`, not the literal `hmis-prod`: 11i T3 gave the script a second target, and a
      // SHA tag hard-coded to production's namespace would have put UAT's images there — measured,
      // by this leg failing when the target landed.
      for (const name of ["server", "web", "db"]) {
        expect(deploySource).toContain(`docker tag "$${name.toUpperCase()}_IMAGE" "$IMAGE_NS/${name}:$GIT_SHA"`);
      }
      expect(deploySource).toMatch(/GIT_SHA="\$\(git -C "\$REPO_DIR" rev-parse --short HEAD/);
      expect(deploySource).toMatch(/prune_sha_tags/);
    });

    it("snapshots the outgoing configs BEFORE the installs overwrite them", () => {
      // A retag without the configs is half a rollback: yesterday's images beside today's
      // Caddyfile, compose file and alert rules is a state that never ran anywhere.
      const snapshotAt = deploySource.indexOf('cp -a "$DEPLOY_DIR/docker-compose.prod.yml" "$DEPLOY_DIR/previous/docker-compose.prod.yml"');
      const firstInstallAt = deploySource.indexOf('install -m 0644 "$SRC_DIR/docker-compose.prod.yml"');
      expect(snapshotAt).toBeGreaterThan(0);
      expect(firstInstallAt).toBeGreaterThan(0);
      expect({ snapshotAt, firstInstallAt, snapshotFirst: snapshotAt < firstInstallAt })
        .toEqual({ snapshotAt, firstInstallAt, snapshotFirst: true });
      expect(rollbackBranches(deploySource)).toMatch(/cp -a "\$DEPLOY_DIR\/previous\/docker-compose\.prod\.yml"/);
    });

    it("the drill's REHEARSAL seed list is the DEPLOY'S list, in the deploy's order", () => {
      // A second hand-maintained copy of a seed census is the exact shape that goes stale in
      // silence — this census exists because that happened twice already.
      const match = /REHEARSAL_SEEDS="([^"]+)"/.exec(drillSource);
      if (match === null) throw new Error("restore-drill.sh: no REHEARSAL_SEEDS — this parser is stale");
      const rehearsed = match[1]!.trim().split(/\s+/);
      expect(rehearsed[0]).toBe("seed-cursors.js"); // the deploy runs it first, before any config seed
      // seed-roles is run separately because its verdict is printed and not obeyed, exactly as in
      // deploy.sh — so the two lists agree once it is put back on the end.
      expect([...rehearsed.slice(1), "seed-roles.js"]).toEqual([...SEED_STEP_SCRIPTS]);
      expect(drillSource).toMatch(/node dist\/scripts\/seed-roles\.js \|\| note/);
      expect(drillSource).toMatch(/node dist\/scripts\/check-config-present\.js/);
      expect(drillSource).toMatch(/node dist\/scripts\/standup-check\.js all/);
    });

    it("the rehearsal asserts migration count by EQUALITY, read out of the candidate image", () => {
      // `>=` is right for a weekly drill (did the restore regress?) and wrong for a rehearsal: a
      // half-applied journal — one migration refused, the rest skipped by the watermark — passes
      // `>=` against the live census and would report PASS.
      expect(drillSource).toMatch(/CANDIDATE_MIGRATIONS="\$\(docker run --rm "\$SERVER_IMAGE"/);
      expect(drillSource).toMatch(/_journal\.json"\)\.entries\.length/);
      expect(drillSource).toMatch(/\[ "\$RESTORED_MIGRATIONS" = "\$CANDIDATE_MIGRATIONS" \][\s\S]{0,40}\|\| die/);
      // and the weekly drill's own `>=` assertions are untouched
      expect(drillSource).toMatch(/\[ "\$RESTORED_EVENTS" -ge "\$CENSUS_EVENTS" \]/);
      expect(drillSource).toMatch(/\[ "\$RESTORED_MIGRATIONS" -ge "\$CENSUS_MIGRATIONS" \]/);
    });

    it("a rehearsal appends backup.drill_rehearsed and NEVER drill_passed", () => {
      // The prometheus rule that watches for a MISSED weekly drill counts `drill_passed`; a
      // rehearsal appending it would let a genuinely missed backup drill hide behind somebody's
      // deploy preparation, and a failed rehearsal would page as a failed backup.
      expect(backupDrillRehearsed.name).toBe("backup.drill_rehearsed");
      expect(drillSource).toMatch(/catalog\.backupDrillRehearsed/);
      expect(drillSource).toMatch(/const rehearsal = process\.env\.HMIS_DRILL_REHEARSAL_MODE === "1";/);
      // the ternary must be REACHED before the pass/fail one, not beside it
      const rehearsedAt = drillSource.indexOf("catalog.backupDrillRehearsed");
      const passedAt = drillSource.indexOf("catalog.backupDrillPassed");
      expect({ rehearsedAt, passedAt, rehearsalFirst: rehearsedAt < passedAt })
        .toEqual({ rehearsedAt, passedAt, rehearsalFirst: true });
    });

    it("both scripts still parse", () => {
      // The cheapest possible guard on the file whose failure mode is the owner's live box.
      for (const script of [DEPLOY_SH, DRILL_SH]) {
        const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
        expect({ script, status: r.status, stderr: r.stderr }).toEqual({ script, status: 0, stderr: "" });
      }
    });
  });

  /**
   * ═══ PHASE 11i T3 — UAT IS A TARGET OF THIS SCRIPT, NOT A SECOND SCRIPT ═══
   *
   * The danger is not that UAT breaks; it is that UAT reaches production. One host, two stacks,
   * one script — so every leg below asks the same question from a different side: **with
   * `HMIS_TARGET=uat`, does anything still say `hmis-prod`?**
   */
  describe("the UAT target (11i T3)", () => {
    /**
     * The overlay's YAML with its COMMENTS STRIPPED. This file explains at length why it takes
     * 8443 instead of 80/443 and why the db moves off 5434 — and an assertion that "5434 does not
     * appear" would fail on the sentence saying so. `i18n-keys.test.ts` and `vitals-bay.test.tsx`
     * both hit the same false positive; the fix is the same one: read the directives, not the prose.
     */
    const uatCompose = readFileSync(UAT_COMPOSE, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const uatComposeWithProse = readFileSync(UAT_COMPOSE, "utf8");

    /**
     * The script's OWN target block, extracted from the shipped bytes and evaluated — the
     * caddyfile-parity shape. Reading the text would tell us the words are there; running it
     * tells us what they resolve to, which is the only thing a mistake here would be about.
     */
    function resolveTarget(target: string): Record<string, string> {
      const block = /TARGET="\$\{HMIS_TARGET:-prod\}"\ncase "\$TARGET" in\n[\s\S]*?\nesac\n/.exec(deploySource);
      if (block === null) throw new Error("deploy.sh: no `case \"$TARGET\"` block — this parser is stale");
      const cronLine = /CRON_FILE="\$\{HMIS_CRON_FILE:-[^"]*\}"/.exec(deploySource);
      if (cronLine === null) throw new Error("deploy.sh: no CRON_FILE line — this parser is stale");
      const script = [
        "set -euo pipefail",
        block[0],
        cronLine[0],
        'SERVER_IMAGE="$IMAGE_NS/server:latest"',
        'IMAGE_REPOS="$IMAGE_NS/server $IMAGE_NS/web $IMAGE_NS/db"',
        'printf "%s\\n%s\\n%s\\n%s\\n%s\\n" "$PROJECT" "$IMAGE_NS" "$DEPLOY_DIR" "$CRON_FILE" "$SERVER_IMAGE"',
      ].join("\n");
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, HMIS_TARGET: target, HMIS_DEPLOY_DIR: "", HMIS_CRON_FILE: "" } });
      expect({ target, status: r.status, stderr: r.stderr }).toEqual({ target, status: 0, stderr: "" });
      const [project, ns, dir, cron, image] = r.stdout.trim().split("\n");
      return { project: project!, ns: ns!, dir: dir!, cron: cron!, image: image! };
    }

    it("resolves production's names when the target is unset — the default is not a new thing", () => {
      const prod = resolveTarget("");
      expect(prod).toEqual({
        project: "hmis-prod", ns: "hmis-prod", dir: "/opt/hmis-prod",
        cron: "/etc/cron.d/hmis-prod-backup", image: "hmis-prod/server:latest",
      });
    });

    it("says `hmis-prod` NOWHERE when the target is uat — project, image, directory or cron", () => {
      const uat = resolveTarget("uat");
      expect(uat).toEqual({
        project: "hmis-uat", ns: "hmis-uat", dir: "/opt/hmis-uat",
        cron: "/etc/cron.d/hmis-uat-backup", image: "hmis-uat/server:latest",
      });
      // The property, stated once over all four, so a fifth value added later is covered too.
      expect(Object.values(uat).filter((v) => v.includes("hmis-prod"))).toEqual([]);
    });

    it("refuses a target it does not know, rather than deploying production by default", () => {
      const block = /TARGET="\$\{HMIS_TARGET:-prod\}"\ncase "\$TARGET" in\n[\s\S]*?\nesac\n/.exec(deploySource)!;
      const r = spawnSync("bash", ["-c", `set -euo pipefail\n${block[0]}`], {
        encoding: "utf8", env: { ...process.env, HMIS_TARGET: "staging" },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/HMIS_TARGET must be 'prod' or 'uat'/);
    });

    it("skips the stanza, the cron and the real-hostname edge check on uat, and nothing else", () => {
      // Each of the three is production-only BY NATURE (no repository, no backup to schedule, no
      // public hostname). Everything else — build, config, migrate, seeds, gate, census, service
      // census, restarts — must be the same code, or the rehearsal proves nothing about the deploy.
      expect(deploySource).toMatch(/if \[ "\$TARGET" = "uat" \]; then\n {2}# 11i T3 \/ D1 — UAT has no backup repository/);
      expect(deploySource).toMatch(/note "target uat — no backup or restore-drill cron installed"/);
      expect(deploySource).toMatch(/SITE_BASE="https:\/\/\$UAT_SITE:8443"/);
      // and the migrate/seed/gate block is NOT behind a target branch
      expect(deploySource).not.toMatch(/if \[ "\$TARGET" = "uat" \]; then[\s\S]{0,200}migrate\.js/);
    });

    it("the UAT overlay runs FOUR services and profiles the five it does not", () => {
      for (const svc of ["node-exporter", "postgres-exporter", "prometheus", "grafana", "alertmanager"]) {
        expect(uatCompose).toMatch(new RegExp(`${svc}:\\n +profiles: \\["monitoring"\\]`));
      }
      // An override cannot DELETE a service, and `scale: 0` would still leave it in
      // `compose config --services` — which is what step 6b enumerates.
      expect(uatCompose).not.toMatch(/scale:\s*0/);
      expect(uatComposeWithProse).toContain("PHASE 11i T3"); // the stripped read is not vacuous
    });

    it("UAT shares no volume, no network and no port with production", () => {
      // Compose namespaces volumes and networks by project, so the ONLY ways to reach across are
      // an `external: true` volume or a `name:` that pins one. Neither may appear.
      expect(uatCompose).not.toMatch(/external:\s*true/);
      expect(uatCompose).not.toMatch(/^\s+name:\s/m);
      // The two ports production holds, replaced rather than merged — compose APPENDS port lists.
      expect(uatCompose).toMatch(/ports: !override \["8443:443"\]/);
      expect(uatCompose).toMatch(/ports: !override \["127\.0\.0\.1:5435:5432"\]/);
      expect(uatCompose).not.toMatch(/"80:80"|"443:443"|5434/);
    });

    it("UAT's database archives nothing and mounts no pgBackRest anything — §2b row 23", () => {
      // UAT NEVER RESTORES A PRODUCTION BACKUP (D1): a training box holding a real patient is a
      // DPDP incident wearing a training label. It follows that it has no repository at all —
      // and an `archive_command` pointing at a stanza that does not exist fills pg_wal until the
      // disk does, silently.
      expect(uatCompose).toMatch(/command: !override \["postgres"\]/);
      expect(uatCompose).toMatch(/env_file: !reset null/);
      expect(uatCompose).toMatch(/volumes: !override\n\s+- hmis_prod_pgdata:/);
      expect(uatCompose).not.toMatch(/pgbackrest/);
    });

    it("the production environment template carries neither the banner key nor the synthetic door", () => {
      // §2b row 22 and D5. Both are things only a NON-production deployment can turn on, which is
      // the only direction that fails safe: production does not switch the banner off, it never
      // had it.
      const example = readFileSync(ENV_EXAMPLE, "utf8");
      expect(example).not.toMatch(/HMIS_ENVIRONMENT_LABEL/);
      expect(example).not.toMatch(/HMIS_SYNTHETIC_DATA_OK/);
    });

    it("uat-reset.sh REFUSES production, and it is asked rather than read", () => {
      const r = spawnSync("bash", [UAT_RESET_SH], {
        encoding: "utf8",
        env: { ...process.env, HMIS_UAT_PROJECT: "hmis-prod", HMIS_TARGET: "uat", HMIS_DEPLOY_DIR: "/opt/hmis-uat" },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/DROPS A DATABASE and will not run/);
      // and the deploy directory is checked too, independently of the project name
      const byDir = spawnSync("bash", [UAT_RESET_SH], {
        encoding: "utf8",
        env: { ...process.env, HMIS_UAT_PROJECT: "hmis-uat", HMIS_TARGET: "uat", HMIS_DEPLOY_DIR: "/opt/hmis-prod" },
      });
      expect(byDir.status).not.toBe(0);
      expect(byDir.stderr).toMatch(/that is production's/);
    });

    it("uat-reset.sh runs the DEPLOY'S seed list, in the deploy's order", () => {
      const source = readFileSync(UAT_RESET_SH, "utf8");
      const match = /for seed in ([\s\S]*?); do/.exec(source);
      if (match === null) throw new Error("uat-reset.sh: no seed loop — this parser is stale");
      const seeds = match[1]!.replace(/\\\n/g, " ").trim().split(/\s+/);
      expect(seeds[0]).toBe("seed-cursors.js");
      expect([...seeds.slice(1), "seed-roles.js"]).toEqual([...SEED_STEP_SCRIPTS]);
    });

    it("both new scripts parse", () => {
      for (const script of [UAT_RESET_SH]) {
        const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
        expect({ script, status: r.status, stderr: r.stderr }).toEqual({ script, status: 0, stderr: "" });
      }
    });
  });

  it("does NOT let seed-roles' readiness verdict abort the deploy, and DOES let the gate", () => {
    // seed-roles' non-zero is a verdict about who HOLDS the roles — staffing, not configuration —
    // and no deploy can repair it. It is wrapped in an `if`; the gate is not, so `set -e` still
    // kills the deploy on a missing configuration row.
    expect(deploySource).toMatch(/if compose run --rm api node dist\/scripts\/seed-roles\.js; then/);
    expect(deploySource).toMatch(/^compose run --rm api node dist\/scripts\/check-config-present\.js$/m);
  });
});
