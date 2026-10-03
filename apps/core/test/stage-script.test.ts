import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * OWNER 2026-09-30 — "see changes fast": `tools/stage.sh <lane>` puts a lane on the staging site
 * (the UAT stack) before it merges. It runs deploy.sh from a LANE commit, and on 2026-09-06 a
 * lane's older deploy.sh deployed production (see the top of docker/prod/deploy.sh). These pins
 * are the reasons that cannot happen again; each one is a line a later edit could drop while
 * staging kept working. Static reads only: nothing here executes a deploy.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const stage = readFileSync(resolve(REPO_ROOT, "tools", "stage.sh"), "utf8");
const auto = readFileSync(resolve(REPO_ROOT, "tools", "auto-deploy.sh"), "utf8");

describe("tools/stage.sh can only ever deploy UAT", () => {
  it("parses as bash", () => {
    execFileSync("bash", ["-n", resolve(REPO_ROOT, "tools", "stage.sh")]);
    execFileSync("bash", ["-n", resolve(REPO_ROOT, "tools", "auto-deploy.sh")]);
  });

  it("pins the uat target and directory on every deploy it runs", () => {
    expect(stage).toMatch(/HMIS_TARGET=uat HMIS_DEPLOY_DIR="\$UAT_DIR" HMIS_DEPLOY_ALLOW_DIRTY="\$DIRTY_OK" bash "\$DEPLOY"/);
    expect(stage).toMatch(/^UAT_DIR=\/opt\/hmis-uat$/m);
    expect(stage).not.toMatch(/hmis-prod/);
  });

  it("runs MAIN's deploy tooling over the lane's commit, never the lane's own", () => {
    expect(stage).toMatch(/git -C "\$STAGE_TREE" checkout -q "\$\(git -C "\$MAIN" rev-parse HEAD\)" -- docker\/prod/);
    expect(stage).toMatch(/die "lane '\$REF' changes docker\/prod\/; deploy tooling cannot be staged, only merged"/);
    expect(stage).toMatch(/grep -q 'DEPLOY_DIR="\$\{HMIS_DEPLOY_DIR:-\/opt\/hmis-uat\}"' "\$DEPLOY"/);
  });

  it("shares auto-deploy's lock, and auto-deploy hands staging to it", () => {
    expect(stage).toMatch(/^LOCK=\/run\/lock\/hmis-auto-deploy\.lock$/m);
    expect(auto).toMatch(/^LOCK=\/run\/lock\/hmis-auto-deploy\.lock$/m);
    expect(auto).toMatch(/HMIS_STAGE_LOCK_HELD=1 bash "\$REPO\/tools\/stage\.sh" --follow-main/);
    // auto-deploy no longer runs a uat deploy of its own that would overwrite a staged lane
    expect(auto).not.toMatch(/HMIS_TARGET=uat/);
  });

  /* 2026-10-03 — an automatic reset wiped the owner's working copy of staging (every user). Never again by itself. */
  it("never resets UAT's database unless the caller asks with STAGE_ALLOW_RESET=1", () => {
    const calls = stage.split("\n").filter((l) => /\breset_uat\b/.test(l) && !/^\s*reset_uat\(\)/.test(l) && !/^\s*#/.test(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const [i, l] of calls.entries()) {
      const at = stage.split("\n").indexOf(l);
      const before = stage.split("\n").slice(Math.max(0, at - 2), at + 1).join("\n");
      expect({ i, guarded: /STAGE_ALLOW_RESET:-0\}" = "1"/.test(before) }).toEqual({ i, guarded: true });
    }
  });
});
