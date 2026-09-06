import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SYNTHETIC_DATA_KEY, assertSyntheticDataAllowed } from "../scripts/synthetic-door";
import { assertDemoDataAllowed } from "../scripts/seed-lab-demo";

/**
 * PHASE 11i T5 / D5 — THE SYNTHETIC-DATA DOOR.
 *
 * 11i T3 broke the load-bearing half of both synthetic seeds' refusals, and the break is worth
 * stating exactly: **UAT runs the PRODUCTION IMAGE, and the production image sets
 * `NODE_ENV=production`.** If it did not, UAT would be rehearsing a different build, which is the
 * one thing UAT must never do. So `NODE_ENV` cannot be what separates the hospital from the bench.
 *
 * The door is a fact about the ENVIRONMENT that production's own environment file never carries.
 * Every existing refusal stays — a door was ADDED, not swapped, and the tests below are written to
 * fail if any of them is ever quietly removed.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const CATALOGUE = readFileSync(resolve(__dirname, "..", "scripts", "seed-lab-catalogue.ts"), "utf8");
const DEPLOY_SH = readFileSync(resolve(REPO_ROOT, "docker", "prod", "deploy.sh"), "utf8");

describe("the synthetic-data door (11i T5)", () => {
  it("refuses with the key unset, and names the key and the file it belongs in", () => {
    expect(() => assertSyntheticDataAllowed("seed:test", {})).toThrow(new RegExp(SYNTHETIC_DATA_KEY));
    expect(() => assertSyntheticDataAllowed("seed:test", {})).toThrow(/hmis-uat/);
    expect(() => assertSyntheticDataAllowed("seed:test", { HMIS_SYNTHETIC_DATA_OK: "yes" })).toThrow();
    expect(() => assertSyntheticDataAllowed("seed:test", { HMIS_SYNTHETIC_DATA_OK: "1" })).not.toThrow();
  });

  it("seed:lab-demo needs BOTH doors — the operator's word AND the environment's fact", () => {
    const db = "hmis_uat";
    // The door alone is not enough: ALLOW_DEMO_DATA is a word somebody types, and it stays.
    expect(() => assertDemoDataAllowed({ HMIS_SYNTHETIC_DATA_OK: "1" }, db)).toThrow(/ALLOW_DEMO_DATA/);
    // The word alone is not enough either: that is the whole of what T5 adds.
    expect(() => assertDemoDataAllowed({ ALLOW_DEMO_DATA: "yes" }, db)).toThrow(new RegExp(SYNTHETIC_DATA_KEY));
    expect(() => assertDemoDataAllowed({ ALLOW_DEMO_DATA: "yes", HMIS_SYNTHETIC_DATA_OK: "1" }, db)).not.toThrow();
  });

  it("seed:lab-demo still refuses NODE_ENV=production when the door is CLOSED", () => {
    expect(() =>
      assertDemoDataAllowed({ NODE_ENV: "production", ALLOW_DEMO_DATA: "yes" }, "hmis"),
    ).toThrow(new RegExp(SYNTHETIC_DATA_KEY));
    // and passes on UAT, which carries NODE_ENV=production because it runs the production image
    expect(() =>
      assertDemoDataAllowed(
        { NODE_ENV: "production", ALLOW_DEMO_DATA: "yes", HMIS_SYNTHETIC_DATA_OK: "1" }, "hmis_uat",
      ),
    ).not.toThrow();
  });

  it("seed:lab-catalogue keeps its `:5434` refusal, which no door opens", () => {
    // The port of production's database. It is checked BEFORE the door and independently of it, so
    // a UAT deployment pointed by mistake at production's port is still refused.
    const source = CATALOGUE;
    const portRefusal = source.indexOf('url.includes(":5434")');
    // THE CALL, not the import. The first `assertSyntheticDataAllowed` in this file is on line 6
    // and the ordering claim is about line 195 — an index that answered the adjacent question and
    // would have read "the door comes first" for ever.
    const doorCall = source.indexOf('assertSyntheticDataAllowed("seed:lab-catalogue")');
    expect(portRefusal).toBeGreaterThan(0);
    expect({ portRefusal, doorCall, portFirst: portRefusal < doorCall })
      .toEqual({ portRefusal, doorCall, portFirst: true });
    // and the `:5434` branch is not conditioned on the key
    expect(source).toMatch(/if \(url\.includes\(":5434"\)\) \{/);
  });

  it("seed:lab-demo's entry point runs when COMPILED — the deploy runs dist, not ts", () => {
    // It was `process.argv[1]?.endsWith("seed-lab-demo.ts")`, so `node dist/scripts/seed-lab-demo.js`
    // loaded, defined its exports and exited 0 having written nothing. A seed that reports success
    // and seeds nothing is worse than one that fails.
    const raw = readFileSync(resolve(__dirname, "..", "scripts", "seed-lab-demo.ts"), "utf8");
    // COMMENTS STRIPPED. The paragraph above the guard QUOTES the old expression to explain what
    // it broke, and an assertion over the raw text would fail on the sentence that documents the
    // fix. Third instance of this shape in one phase (`vitals-bay.test.tsx`,
    // `deploy-parity`'s UAT legs, here): a text assertion cannot tell the thing it names from the
    // thing it means, so it must be pointed at code and never at prose.
    const source = raw.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(source).toMatch(/if \(require\.main === module\) \{/);
    expect(source).not.toMatch(/argv\[1\]\?\.endsWith\("seed-lab-demo\.ts"\)/);
    expect(raw).toContain("seed-lab-demo.ts"); // the stripped read is not vacuous
  });

  it("deploy.sh's PROD target refuses to run with the door open — both ways it could arrive", () => {
    // In the environment file, which every container would inherit; and in the shell, which is how
    // a hand carries it in. Neither may deploy production.
    expect(DEPLOY_SH).toMatch(/if grep -q '\^HMIS_SYNTHETIC_DATA_OK=' "\$ENV_FILE"[\s\S]{0,120}die/);
    expect(DEPLOY_SH).toMatch(/\[ -z "\$\{HMIS_SYNTHETIC_DATA_OK:-\}" \] \|\| die/);
    // and the refusal is on the PROD target only — UAT's whole purpose needs the key set
    const guard = /if \[ "\$TARGET" = "prod" \]; then([\s\S]*?)\nfi/.exec(DEPLOY_SH);
    expect(guard).not.toBeNull();
    expect(guard![1]).toContain("HMIS_SYNTHETIC_DATA_OK");
  });
});
