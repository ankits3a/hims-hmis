#!/usr/bin/env node
/**
 * LOCKED ACCEPTANCE CHECKS (owner 2026-10-07). Tests the owner approved as a feature's "done means"
 * live under any folder named `acceptance/`. An agent may ADD such tests freely, but a pull request that
 * CHANGES, DELETES or RENAMES one fails here unless it carries the label `owner-approved-checks`, which
 * only the owner adds. Without this, the only thing stopping an agent from loosening a test until it is
 * green is an instruction; with it, doing so is a visible, deliberate act in the PR's history.
 *
 * Runs in CI's required `static` job. Outside a pull_request event it does nothing.
 * After the owner adds the label, re-run by pushing a commit (`git commit --allow-empty`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const LABEL = "owner-approved-checks";
const LOCKED = /(^|\/)acceptance\//;

/** `git diff --name-status` lines → the locked paths a PR modifies, deletes or renames away. */
export function violations(nameStatus) {
  const out = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status, a, b] = line.split("\t");
    const kind = status[0];
    if (kind === "A") continue; // adding a new acceptance test is always allowed
    if ((kind === "R" || kind === "C") && LOCKED.test(a)) out.push(`${status} ${a} -> ${b}`);
    else if ((kind === "M" || kind === "D" || kind === "T") && LOCKED.test(a)) out.push(`${kind} ${a}`);
  }
  return out;
}

function main() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    console.log("acceptance-guard: not a pull request; nothing to check.");
    return;
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  const labels = (pr.labels ?? []).map((l) => l.name);
  try {
    execFileSync("git", ["fetch", "-q", "--no-tags", "origin", pr.base.sha, pr.head.sha], { stdio: "ignore" });
  } catch {
    // A shallow checkout lacks the base commit; a full one already has both. Either way diff below decides.
  }
  const diff = execFileSync("git", ["diff", "--name-status", "-M", `${pr.base.sha}...${pr.head.sha}`], { encoding: "utf8" });
  const found = violations(diff);
  if (found.length === 0) {
    console.log("acceptance-guard: no approved acceptance check is changed.");
    return;
  }
  if (labels.includes(LABEL)) {
    console.log(`acceptance-guard: ${found.length} approved check(s) changed WITH the owner's label '${LABEL}':\n  ${found.join("\n  ")}`);
    return;
  }
  console.error(
    `acceptance-guard: this PR changes ${found.length} owner-approved acceptance check(s):\n  ${found.join("\n  ")}\n` +
      `Approved checks may not be edited, deleted or renamed by an agent. If the owner agrees the check itself must change,\n` +
      `the owner adds the label '${LABEL}' to the PR; then push a commit to re-run CI.`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
