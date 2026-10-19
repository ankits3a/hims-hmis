import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * #913: `deploy.sh`'s `prune_sha_tags` printed "pruned hmis-prod/db:<sha>" for the SHA it had just
 * deployed. It used to keep "the first N lines of `docker images`", taking that list as newest
 * first. `docker images` sorts by the image's CREATED time, though, not by when a tag was put on it,
 * and the db image is a fully cached build (postgres + pgbackrest), so every SHA's db image carries
 * the same CreatedAt. On a tie the order is arbitrary, and the tag this deploy just made could be
 * the one past the cut.
 *
 * NEVER AGAINST REAL DOCKER. A test once ran deploy.sh and deployed production. So:
 *   - only the `prune_sha_tags` FUNCTION is cut out of deploy.sh's bytes and run. The script is
 *     never sourced or executed;
 *   - PATH is a temp directory holding a stub `docker` plus /usr/bin:/bin for grep, awk and the like;
 *   - the harness refuses (exit 99) unless `command -v docker` resolves to that stub, and the stub
 *     refuses unless HMIS_DOCKER_STUB=1. The last case below shows the refusal firing.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEPLOY_SH = resolve(REPO_ROOT, "docker", "prod", "deploy.sh");

function pruneFunction(): string {
  const source = readFileSync(DEPLOY_SH, "utf8");
  const start = source.indexOf("\nprune_sha_tags() {\n");
  if (start < 0) throw new Error("deploy.sh: no `prune_sha_tags() {` at column 0. This extractor is stale");
  const end = source.indexOf("\n}\n", start + 1);
  if (end < 0) throw new Error("deploy.sh: prune_sha_tags has no closing `}` at column 0");
  const body = source.slice(start + 1, end + 3);
  // An extract must not reach anything outside the function.
  expect(body).not.toMatch(/\n(step|compose) /);
  return body;
}

const STUB_DOCKER = `#!/bin/bash
[ "\${HMIS_DOCKER_STUB:-}" = "1" ] || { echo "stub docker: HMIS_DOCKER_STUB is not set, refusing" >&2; exit 98; }
printf '%s\\n' "$*" >>"$STUB_LOG"
case "$1" in
  images) repo="\${!#}"; f="$STUB_IMAGES/\${repo//\\//_}"; [ -f "$f" ] && cat "$f"; exit 0 ;;
  rmi) exit 0 ;;
  *) echo "stub docker: unexpected command $*" >&2; exit 97 ;;
esac
`;

interface Run {
  status: number | null;
  out: string;
  removed: string[];
  calls: string[];
  history: string[];
}

interface Scenario {
  gitSha: string;
  /** what `docker images <repo>` prints, per repo, in the order docker prints it */
  images: Record<string, string[]>;
  /** sha-tags.history before the run, oldest first; undefined = no file */
  history?: string[];
  /** deployed.sha before the run; undefined = no file */
  deployed?: string;
  kept?: number;
  /** test-only: run with a PATH whose docker is NOT the stub */
  withoutStub?: boolean;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function run(s: Scenario): Run {
  const dir = mkdtempSync(join(tmpdir(), "hmis-prune-tags-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const images = join(dir, "images");
  const deployDir = join(dir, "deploy");
  mkdirSync(bin);
  mkdirSync(images);
  mkdirSync(join(deployDir, "log"), { recursive: true });
  writeFileSync(join(bin, "docker"), STUB_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  for (const [repo, lines] of Object.entries(s.images)) {
    writeFileSync(join(images, repo.replace(/\//g, "_")), lines.map((l) => `${l}\n`).join(""));
  }
  if (s.history) writeFileSync(join(deployDir, "log", "sha-tags.history"), s.history.map((l) => `${l}\n`).join(""));
  if (s.deployed !== undefined) writeFileSync(join(deployDir, "log", "deployed.sha"), `${s.deployed}\n`);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");

  const script = [
    "set -euo pipefail",
    `[ "$(command -v docker)" = "${join(bin, "docker")}" ] || { echo "harness: docker on PATH is not the stub, refusing" >&2; exit 99; }`,
    '[ "${HMIS_DOCKER_STUB:-}" = "1" ] || exit 99',
    'note() { printf "    %s\\n" "$*"; }',
    pruneFunction(),
    "prune_sha_tags",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    env: {
      PATH: s.withoutStub ? "/usr/bin:/bin" : `${bin}:/usr/bin:/bin`,
      HMIS_DOCKER_STUB: "1",
      STUB_LOG: log,
      STUB_IMAGES: images,
      IMAGE_REPOS: Object.keys(s.images).join(" "),
      GIT_SHA: s.gitSha,
      DEPLOY_DIR: deployDir,
      SHA_TAGS_KEPT: String(s.kept ?? 3),
    },
    encoding: "utf8",
  });
  const calls = readFileSync(log, "utf8").split("\n").filter((l) => l !== "");
  const historyFile = join(deployDir, "log", "sha-tags.history");
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    calls,
    removed: calls.filter((c) => c.startsWith("rmi ")).map((c) => c.split(/\s+/).pop()!).sort(),
    history: existsSync(historyFile) ? readFileSync(historyFile, "utf8").split("\n").filter((l) => l !== "") : [],
  };
}

const REPOS = ["hmis-prod/server", "hmis-prod/web", "hmis-prod/db"];
function everyRepo(tags: string[]): Record<string, string[]> {
  return Object.fromEntries(REPOS.map((repo) => [repo, tags.map((t) => `${repo}:${t}`)]));
}
function inEveryRepo(shas: string[]): string[] {
  return REPOS.flatMap((repo) => shas.map((s) => `${repo}:${s}`)).sort();
}

describe("deploy.sh prune_sha_tags (#913)", () => {
  it("the 2026-10-16 shape: a tied CreatedAt puts the deployed SHA and the previous good one last, and both survive", () => {
    // The order docker printed for hmis-prod/db on this box: same CreatedAt for all, so the order is
    // arbitrary. The SHA being deployed (e5) and the previous good one (d4) are at the tail.
    const r = run({
      gitSha: "e5e5e5e5",
      history: ["a1a1a1a1", "b2b2b2b2", "c3c3c3c3", "d4d4d4d4"],
      deployed: "d4d4d4d4",
      images: {
        "hmis-prod/db": [
          "hmis-prod/db:a1a1a1a1",
          "hmis-prod/db:b2b2b2b2",
          "hmis-prod/db:latest",
          "hmis-prod/db:c3c3c3c3",
          "hmis-prod/db:d4d4d4d4",
          "hmis-prod/db:e5e5e5e5",
        ],
      },
    });
    expect(r.status).toBe(0);
    expect(r.removed).not.toContain("hmis-prod/db:e5e5e5e5");
    expect(r.removed).not.toContain("hmis-prod/db:d4d4d4d4");
    expect(r.removed).toEqual(["hmis-prod/db:a1a1a1a1", "hmis-prod/db:b2b2b2b2"]);
  });

  it("keeps exactly the last N SHAs this deploy history recorded, whatever order docker prints them in", () => {
    const r = run({
      gitSha: "e5e5e5e5",
      history: ["a1a1a1a1", "b2b2b2b2", "c3c3c3c3", "d4d4d4d4"],
      deployed: "d4d4d4d4",
      images: everyRepo(["c3c3c3c3", "e5e5e5e5", "latest", "a1a1a1a1", "d4d4d4d4", "b2b2b2b2"]),
    });
    expect(r.status).toBe(0);
    expect(r.removed).toEqual(inEveryRepo(["a1a1a1a1", "b2b2b2b2"]));
    expect(r.calls.filter((c) => c.includes(":latest"))).toEqual([]); // :latest is never touched
    expect(r.history.slice(-1)).toEqual(["e5e5e5e5"]); // this deploy is recorded
  });

  it("keeps the previous GOOD SHA even when failed deploys since then pushed it out of the last N", () => {
    // b2 was the last green deploy; c3 and d4 failed; e5 is going out now. Rolling back from e5
    // has to land on b2.
    const r = run({
      gitSha: "e5e5e5e5",
      history: ["a1a1a1a1", "b2b2b2b2", "c3c3c3c3", "d4d4d4d4"],
      deployed: "b2b2b2b2",
      images: everyRepo(["a1a1a1a1", "b2b2b2b2", "c3c3c3c3", "d4d4d4d4", "e5e5e5e5", "latest"]),
    });
    expect(r.status).toBe(0);
    expect(r.removed).toEqual(inEveryRepo(["a1a1a1a1"]));
  });

  it("a re-deploy of the same SHA counts once, so the history does not crowd out older rollbacks", () => {
    const r = run({
      gitSha: "d4d4d4d4",
      history: ["a1a1a1a1", "b2b2b2b2", "c3c3c3c3", "d4d4d4d4"],
      deployed: "d4d4d4d4",
      images: everyRepo(["a1a1a1a1", "b2b2b2b2", "c3c3c3c3", "d4d4d4d4"]),
    });
    expect(r.status).toBe(0);
    expect(r.removed).toEqual(inEveryRepo(["a1a1a1a1"]));
  });

  it("with no history yet (the first run after this change) it prunes nothing, because it cannot tell old from new", () => {
    const r = run({
      gitSha: "e5e5e5e5",
      images: everyRepo(["w0w0w0w0", "x0x0x0x0", "y0y0y0y0", "z0z0z0z0", "e5e5e5e5", "latest"]),
    });
    expect(r.status).toBe(0);
    expect(r.removed).toEqual([]);
    expect(r.history).toEqual(["e5e5e5e5"]);
  });

  it("once the history is N deep, tags it never recorded are older than all of it and go", () => {
    const r = run({
      gitSha: "e5e5e5e5",
      history: ["c3c3c3c3", "d4d4d4d4"],
      deployed: "d4d4d4d4",
      images: everyRepo(["z0z0z0z0", "c3c3c3c3", "d4d4d4d4", "e5e5e5e5"]),
    });
    expect(r.status).toBe(0);
    expect(r.removed).toEqual(inEveryRepo(["z0z0z0z0"]));
  });

  it("GUARD: the harness refuses to run when PATH's docker is not the stub", () => {
    const r = run({ gitSha: "e5e5e5e5", images: everyRepo(["a1a1a1a1"]), withoutStub: true });
    expect(r.status).toBe(99);
    expect(r.calls).toEqual([]);
  });
});
