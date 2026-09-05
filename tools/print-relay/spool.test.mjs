// @ts-check
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PRINT RELAY'S SPOOL — the tests the relay never had
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Run it:  node --test tools/print-relay/spool.test.mjs
 *
 * ═══ WHY THIS IS A `node --test` SCRIPT AND NOT A JEST OR VITEST FILE ═══
 *
 * `relay.mjs` is a deliberately dependency-free file that copies onto a Raspberry Pi, and it lives
 * OUTSIDE both test projects: `apps/core`'s jest has rootDir `apps/core`, `apps/web`'s vitest has
 * root `apps/web`, and `pnpm-workspace.yaml` lists only `apps/*` and `packages/*`, so `pnpm
 * typecheck` never reads it either despite its `// @ts-check`. Dragging it into jest is worse than
 * it looks: `jest.config.cjs` forces `module: "commonjs"`, under which TypeScript lowers a dynamic
 * `import()` toward `require()`, and `require()` of an `.mjs` is `ERR_REQUIRE_ESM`.
 *
 * So the harness is Node's own, which the relay's target platform has by definition.
 *
 * ═══ WHAT IS BEING GUARDED, AND WHY EACH ONE MATTERS ON PAPER ═══
 *
 * 1. A TORN `failed/<id>.json` MUST NOT WEDGE THE RELAY. That file is written by a plain
 *    `writeFile` on a hospital PC that gets switched off at the wall. The parse of it used to sit
 *    OUTSIDE the try, so one truncated file threw out of `flushReports`, out of `tick`, into the
 *    retry loop in `main` — every three seconds, and across every restart, because nothing sweeps
 *    `failed/`. `tick` never reached `/print/claim` again: the whole site stopped printing while
 *    systemd still reported the unit `active (running)`.
 *
 * 2. THE SPOOL MUST BE READ BACK. `tick` wrote every claim to `jobs/` before printing it and
 *    NOTHING EVER OPENED ONE OF THOSE FILES AGAIN — one write, one `readdir` for the age sweep,
 *    three deletes. The relay's own comment said "the next tick prints it — from the spool,
 *    without needing the server", and that was false: recovery ran entirely through the server's
 *    120-second lease, the one channel a mains failure takes out along with the relay.
 *
 * 3. AND IT MUST STILL NOT PRINT THE SAME SLIP TWICE. Replay is only safe because `printOne`
 *    writes `printed/<id>.json` the moment `lp` exits 0 and BEFORE any network call. The
 *    end-to-end pair below prints the same spooled job twice over and counts the `lp` invocations.
 *
 * ═══ WHAT NEEDS A BROWSER AND WHAT DOES NOT ═══
 *
 * Every check but the last two runs with no chromium, no CUPS and no network: a job whose
 * destination maps to no queue is refused by `printOne` before anything is spawned, so a `failed/`
 * marker is proof the spooled file was opened, parsed and attempted. The last two DO render a real
 * PDF and hand it to a fake `lp` on `PATH`, because "the file was attempted" and "paper came out"
 * are different claims and the offline guarantee is about the second. They skip loudly without a
 * usable chromium, exactly as the relay's own geometry check does.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/*
  A NAMESPACE IMPORT, ON PURPOSE. Naming the new exports in a destructuring `import { … }` makes a
  missing one a LINK-time SyntaxError that fails the whole file with "does not provide an export
  named X" — which tells you nothing about which behaviour is absent. Reaching through the
  namespace lets each check red on its own, with its own message, which is what a red-first run has
  to produce to be worth anything.
*/
import * as relay from "./relay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, "relay.mjs");

/** Temp directories every check makes; removed once, at the end, so a failure leaves them to read. */
const scratch = [];
after(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

/** A fresh, empty spool with its three subdirectories. */
async function newSpool() {
  const dir = await mkdtemp(join(tmpdir(), "relay-spool-"));
  scratch.push(dir);
  await relay.ensureSpool(dir);
  return dir;
}

/**
 * A loopback HTTP server standing in for the HMIS box, recording every call the relay makes.
 *
 * `api()` builds `${serverUrl}/api${path}`, so what lands here is `/api/print/failed` and
 * `/api/print/claim`. It binds an ephemeral port on 127.0.0.1: no DNS, no outbound access, nothing
 * a CI runner can refuse.
 */
async function stubServer(respond = () => ({})) {
  /** @type {{path: string, body: any}[]} */
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* the relay always sends JSON; a test may not */ }
      seen.push({ path: String(req.url), body: parsed });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(respond(String(req.url), parsed)));
    });
  });
  await new Promise((r) => { server.listen(0, "127.0.0.1", () => { r(undefined); }); });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    seen,
    url: `http://127.0.0.1:${String(port)}`,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/** A port with certainly nothing behind it: bind one, learn its number, give it back. */
async function deadPort() {
  const server = createServer();
  await new Promise((r) => { server.listen(0, "127.0.0.1", () => { r(undefined); }); });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  await new Promise((r) => { server.close(() => { r(undefined); }); });
  return port;
}

const exists = async (p) => await stat(p).then(() => true, () => false);

/* ── 1 · A TORN FAILURE MARKER MUST NOT WEDGE THE RELAY ───────────────────────────────────────── */

test("a truncated failed/ marker is still reported, and both it and the document are removed", async () => {
  const spool = await newSpool();
  // The exact shape a power cut leaves: `writeFile` got half of `{"error":"printer jam"}` down.
  await writeFile(join(spool, relay.DIRS.failed, "job-torn.json"), '{"error":"printer jam', "utf8");
  await writeFile(join(spool, relay.DIRS.jobs, "job-torn.json"), '{"id":"job-torn","html":"<p>PHI</p>"}', "utf8");

  const stub = await stubServer();
  try {
    await relay.flushReports({ serverUrl: stub.url, agentKey: "k" }, spool, () => {});
  } finally {
    stub.close();
  }

  const reported = stub.seen.filter((s) => s.path === "/api/print/failed");
  assert.equal(reported.length, 1, "the job must still be reported failed — the REASON is a detail, the fact is not");
  assert.equal(reported[0].body.jobId, "job-torn");
  assert.equal(
    await exists(join(spool, relay.DIRS.failed, "job-torn.json")), false,
    "a reported marker must be removed, or it poisons every later tick for ever",
  );
  assert.equal(
    await exists(join(spool, relay.DIRS.jobs, "job-torn.json")), false,
    "the rendered document must go with its marker — it is a patient's name, UHID and doctor",
  );
});

test("a failure marker holding the literal `null` reports \"unknown\", not a TypeError", async () => {
  // This one gets PAST `JSON.parse` and dies on the next token, which is why the read needs `?.`
  // and not just a try: `JSON.parse("null").error` throws "Cannot read properties of null".
  const spool = await newSpool();
  await writeFile(join(spool, relay.DIRS.failed, "job-null.json"), "null", "utf8");

  const stub = await stubServer();
  try {
    await relay.flushReports({ serverUrl: stub.url, agentKey: "k" }, spool, () => {});
  } finally {
    stub.close();
  }

  const reported = stub.seen.filter((s) => s.path === "/api/print/failed");
  assert.equal(reported.length, 1);
  assert.equal(reported[0].body.error, "unknown");
});

test("an empty failure marker is still reported", async () => {
  const spool = await newSpool();
  await writeFile(join(spool, relay.DIRS.failed, "job-empty.json"), "", "utf8");

  const stub = await stubServer();
  try {
    await relay.flushReports({ serverUrl: stub.url, agentKey: "k" }, spool, () => {});
  } finally {
    stub.close();
  }

  assert.equal(stub.seen.filter((s) => s.path === "/api/print/failed").length, 1);
});

test("NEGATIVE CONTROL: a well-formed marker reports its own reason, unchanged", async () => {
  /*
    The control the census cannot draw for itself. Everything above asserts on the torn road; this
    one asserts that the ordinary road is untouched, so a fix that reported "unreadable" for every
    failure would be caught here rather than looking like a pass.
  */
  const spool = await newSpool();
  await writeFile(
    join(spool, relay.DIRS.failed, "job-ok.json"),
    JSON.stringify({ error: "lp exited 1: CRK-Thermal-1 is offline" }), "utf8",
  );

  const stub = await stubServer();
  try {
    await relay.flushReports({ serverUrl: stub.url, agentKey: "k" }, spool, () => {});
  } finally {
    stub.close();
  }

  const reported = stub.seen.filter((s) => s.path === "/api/print/failed");
  assert.equal(reported.length, 1);
  assert.equal(reported[0].body.error, "lp exited 1: CRK-Thermal-1 is offline");
});

test("a torn failure marker must not stop the tick from reaching /print/claim", async () => {
  /*
    THE HARM, ASSERTED WHERE IT IS FELT. The check above pins the decision; this one pins the
    consequence that made it a CRITICAL — `flushReports` runs BEFORE the claim in `tick`, so a
    throw there means the relay never asks for work again and the whole site stops printing.
  */
  const spool = await newSpool();
  await writeFile(join(spool, relay.DIRS.failed, "job-torn.json"), '{"error":"printer jam', "utf8");

  const stub = await stubServer((path) => (path === "/api/print/claim" ? { jobs: [] } : {}));
  try {
    await relay.tick(
      { serverUrl: stub.url, agentKey: "k", queues: { front_desk_thermal: "T1" } },
      spool, () => {},
    );
  } finally {
    stub.close();
  }

  assert.equal(
    stub.seen.filter((s) => s.path === "/api/print/claim").length, 1,
    "one unreadable byte on the local disk must not stop this relay claiming work",
  );
});

/* ── 2 · A LOCAL DISK FAULT IN THE SWEEP IS THE SAME WEDGE, ONE LINE EARLIER ──────────────────── */

test("a spool entry that cannot be removed does not wedge the sweep", async () => {
  /*
    `sweepSpool` runs one line BEFORE `flushReports` in `tick`, and its `rm` had no catch. `force:
    true` suppresses ENOENT and nothing else, so EACCES / EPERM / EROFS — an immutable attribute, a
    read-only remount, a spool restored from a backup with the wrong owner — throws out of `tick`
    in the identical silent, restart-surviving way, and the entry is by definition already older
    than the cutoff so it is re-hit for ever.

    The CAUSE here is synthetic (this process is root, so a permission bit would not stop it — a
    non-empty directory where a file is expected is the cheapest thing that makes `rm` throw). The
    CLASS is not.
  */
  const spool = await newSpool();
  const stuck = join(spool, relay.DIRS.jobs, "job-stuck.json");
  await mkdir(join(stuck, "not-empty"), { recursive: true });
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await utimes(stuck, old, old);

  await relay.sweepSpool(spool, () => {});
  assert.equal(await exists(stuck), true, "and it is still there, because nothing could remove it");
});

/* ── 3 · THE SPOOL IS READ BACK ───────────────────────────────────────────────────────────────── */

test("jobsToReplay picks exactly the spooled job that still owes paper", async () => {
  const spool = await newSpool();
  await writeFile(join(spool, relay.DIRS.printed, "job-1.json"), "{}", "utf8");  // paper is out
  await writeFile(join(spool, relay.DIRS.failed, "job-3.json"), "{}", "utf8");   // given up on
  const state = await relay.readSpoolState(spool);

  assert.equal(
    relay.jobsToReplay(state, ["job-3", "job-1", "job-2"]).join(","), "job-2",
    "only the un-marked job may be replayed, and the result is sorted into the server's own order",
  );
});

test("a tick reads jobs/ back and attempts what is spooled there, with no server reachable", async () => {
  /*
    THE WIRING, which is the assertion that actually matters: a pure-function check on
    `jobsToReplay` cannot prove that anything CALLS it, and a test aimed one layer off the decision
    is how this lane has been bitten before.

    `not_mapped` has no queue, so `printOne` refuses it before spawning chromium or `lp` — the
    `failed/` marker left behind is proof that the file in `jobs/` was opened, parsed and attempted,
    and its text says exactly how far it got.
  */
  const spool = await newSpool();
  const port = await deadPort();
  await writeFile(join(spool, relay.DIRS.jobs, "job-9.json"), JSON.stringify({
    id: "job-9", document: "opd_token_slip", destination: "not_mapped",
    title: "Token", html: "<p>x</p>", page: { widthMm: 72, heightMm: null },
  }), "utf8");

  await assert.rejects(
    relay.tick(
      { serverUrl: `http://127.0.0.1:${String(port)}`, agentKey: "k", queues: { front_desk_thermal: "T1" } },
      spool, () => {},
    ),
    "the claim cannot reach a server — that is the whole point of the scenario",
  );

  const marker = JSON.parse(await readFile(join(spool, relay.DIRS.failed, "job-9.json"), "utf8"));
  assert.match(
    String(marker.error), /no queue configured for destination not_mapped/,
    "the spooled document must have been read off disk and handed to printOne",
  );
});

test("a spooled job whose paper is already out is never replayed", async () => {
  const spool = await newSpool();
  const port = await deadPort();
  // `not_mapped` again: if replay so much as looks at this job, printOne throws and a `failed/`
  // marker appears. The absence of one is what "it was skipped" looks like from outside.
  await writeFile(join(spool, relay.DIRS.jobs, "job-p.json"), JSON.stringify({
    id: "job-p", destination: "not_mapped", title: "t", html: "<p>x</p>",
  }), "utf8");
  await writeFile(join(spool, relay.DIRS.printed, "job-p.json"), "{}", "utf8");

  await assert.rejects(relay.tick(
    { serverUrl: `http://127.0.0.1:${String(port)}`, agentKey: "k", queues: { front_desk_thermal: "T1" } },
    spool, () => {},
  ));

  assert.equal(await exists(join(spool, relay.DIRS.failed, "job-p.json")), false, "it must not be re-attempted");
  assert.equal(await exists(join(spool, relay.DIRS.printed, "job-p.json")), true, "and the marker must survive to be reported");
});

test("a spooled job this relay already gave up on is left to the server, not retried", async () => {
  /*
    `MAX_ATTEMPTS` lives on the server (`kernel/printing/claim.ts`), not here. A relay that retried
    its own `failed/` jobs would spin a jammed printer once per poll interval — every three seconds
    — with nothing counting the attempts. Asserted by CONTENT rather than by absence: the marker
    still holds the reason the FIRST attempt wrote, so nothing overwrote it.
  */
  const spool = await newSpool();
  const port = await deadPort();
  await writeFile(join(spool, relay.DIRS.jobs, "job-f.json"), JSON.stringify({
    id: "job-f", destination: "not_mapped", title: "t", html: "<p>x</p>",
  }), "utf8");
  await writeFile(join(spool, relay.DIRS.failed, "job-f.json"),
    JSON.stringify({ error: "lp exited 1: out of paper" }), "utf8");

  await relay.replaySpool(
    { serverUrl: `http://127.0.0.1:${String(port)}`, agentKey: "k", queues: { front_desk_thermal: "T1" } },
    spool, () => {},
  );

  const marker = JSON.parse(await readFile(join(spool, relay.DIRS.failed, "job-f.json"), "utf8"));
  assert.equal(marker.error, "lp exited 1: out of paper");
});

test("an unreadable spooled document is failed and reported, not thrown", async () => {
  /*
    The same tear as check 1, on the other directory — and it has to be handled the same way, or
    implementing replay would simply move the wedge from `failed/` to `jobs/`. Failing it hands the
    job to the server, which requeues it and lets a re-claim produce a document that is not torn.
  */
  const spool = await newSpool();
  const port = await deadPort();
  await writeFile(join(spool, relay.DIRS.jobs, "job-t.json"), '{"id":"job-t","html":"<p>x', "utf8");

  await relay.replaySpool(
    { serverUrl: `http://127.0.0.1:${String(port)}`, agentKey: "k", queues: { front_desk_thermal: "T1" } },
    spool, () => {},
  );

  const marker = JSON.parse(await readFile(join(spool, relay.DIRS.failed, "job-t.json"), "utf8"));
  assert.match(String(marker.error), /unreadable/);
});

/* ── 4 · AND PAPER ACTUALLY COMES OUT, WITH NOTHING REACHABLE ─────────────────────────────────── */

/**
 * A `lp` that is not CUPS: it appends its arguments to a log and copies the PDF it was handed.
 *
 * `spawn("lp", …)` resolves through `PATH`, so putting this first in `PATH` is enough — the relay
 * is not modified for the test and `lpPrint` runs exactly as it does in Hajipur.
 */
async function fakeLp() {
  const dir = await mkdtemp(join(tmpdir(), "relay-lp-"));
  scratch.push(dir);
  const log = join(dir, "invocations.log");
  const captured = join(dir, "captured.pdf");
  const bin = join(dir, "lp");
  await writeFile(bin, [
    "#!/bin/sh",
    'last=""',
    'for a in "$@"; do last="$a"; done',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    `cp "$last" ${JSON.stringify(captured)}`,
    "exit 0",
  ].join("\n"), "utf8");
  await chmod(bin, 0o755);
  return {
    dir, captured,
    invocations: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((l) => l !== ""),
  };
}

/** The relay's own convention: skip loudly rather than fail on a box with no usable browser. */
const CHROMIUM = process.env.RELAY_CHROMIUM ?? "chromium";
const browserUsable = await new Promise((r) => {
  const p = spawn(CHROMIUM, ["--version"], { stdio: "ignore" });
  p.on("error", () => { r(false); });
  p.on("close", (code) => { r(code === 0); });
});

test("a spooled job prints from disk with no server reachable, and leaves its printed marker", {
  skip: browserUsable ? false : `no usable chromium at ${CHROMIUM} — the offline print path is NOT covered by this run`,
}, async () => {
  const spool = await newSpool();
  const port = await deadPort();
  const lp = await fakeLp();
  const path0 = process.env.PATH;
  process.env.PATH = `${lp.dir}:${String(path0)}`;
  try {
    await writeFile(join(spool, relay.DIRS.jobs, "job-live.json"), JSON.stringify({
      id: "job-live", document: "opd_token_slip", destination: "front_desk_thermal",
      title: "Token 14", html: "<!doctype html><html><body><div>MED-1</div></body></html>",
      page: { widthMm: 72, heightMm: null },
    }), "utf8");

    await relay.replaySpool({
      serverUrl: `http://127.0.0.1:${String(port)}`, agentKey: "k",
      chromium: CHROMIUM, queues: { front_desk_thermal: "CRK-Thermal-1" },
    }, spool, () => {});

    const calls = await lp.invocations();
    assert.equal(calls.length, 1, "exactly one job on the spool, exactly one trip to the printer");
    assert.match(calls[0], /-d CRK-Thermal-1/, "and to the hospital's own queue name, not the server's destination");
    assert.equal(
      (await readFile(lp.captured)).subarray(0, 4).toString("latin1"), "%PDF",
      "what reached the printer must be a rendered PDF, not the HTML off the spool",
    );
    assert.equal(
      await exists(join(spool, relay.DIRS.printed, "job-live.json")), true,
      "and the marker must be down before any network call, or a restart reprints it",
    );
  } finally {
    process.env.PATH = path0;
  }
});

test("replaying twice prints once — the marker, not the server, is what stops the second slip", {
  skip: browserUsable ? false : `no usable chromium at ${CHROMIUM} — idempotence across a restart is NOT covered by this run`,
}, async () => {
  /*
    THE IDEMPOTENCE CLAIM, END TO END AND COUNTED. Two `replaySpool` calls with the same spool is
    what a crash-and-restart looks like from the disk's point of view, and the server is
    unreachable throughout, so nothing but the local `printed/` marker can be doing the stopping.
  */
  const spool = await newSpool();
  const port = await deadPort();
  const lp = await fakeLp();
  const path0 = process.env.PATH;
  process.env.PATH = `${lp.dir}:${String(path0)}`;
  try {
    await writeFile(join(spool, relay.DIRS.jobs, "job-twice.json"), JSON.stringify({
      id: "job-twice", destination: "front_desk_thermal", title: "Token 15",
      html: "<!doctype html><html><body><div>MED-2</div></body></html>",
      page: { widthMm: 72, heightMm: null },
    }), "utf8");

    const config = {
      serverUrl: `http://127.0.0.1:${String(port)}`, agentKey: "k",
      chromium: CHROMIUM, queues: { front_desk_thermal: "CRK-Thermal-1" },
    };
    await relay.replaySpool(config, spool, () => {});
    await relay.replaySpool(config, spool, () => {});

    assert.equal((await lp.invocations()).length, 1, "the patient must not be handed two token slips");
  } finally {
    process.env.PATH = path0;
  }
});

/* ── 5 · AND THE SELF-TEST MUST NOT CLAIM A CHECK IT SKIPPED ──────────────────────────────────── */

/** Run the relay's own CLI and collect what it said. */
function runRelay(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RELAY, ...args], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { out += String(d); });
    p.on("close", (code) => { resolve({ code, out }); });
  });
}

test("--self-test names the geometry check only when a browser actually ran it", async () => {
  /*
    `self-test passed: … page geometry` printed unconditionally, including on the run that had just
    said `geometry check SKIPPED`. In a repository whose first binding rule is "never report a test
    green you did not run in that state", the summary line was the assertion.
  */
  const skipped = await runRelay(["--self-test"], { RELAY_CHROMIUM: "/nonexistent-chromium" });
  assert.equal(skipped.code, 0, skipped.out);
  assert.match(skipped.out, /geometry check SKIPPED/);
  assert.match(
    skipped.out,
    /self-test passed: queue mapping, served destinations, print-once dedupe — page geometry SKIPPED \(no usable chromium\)/,
  );
});

test("--self-test still runs as a program, directly and through a symlink", async () => {
  /*
    The entry guard that makes this file importable is also the thing that could silently stop the
    relay starting under systemd — an install that symlinks `/opt/hmis-print-relay/relay.mjs` would
    compare a symlink path against a real one and simply exit 0, printing nothing, for ever.
  */
  const direct = await runRelay(["--self-test"], { RELAY_CHROMIUM: "/nonexistent-chromium" });
  assert.match(direct.out, /self-test passed/, direct.out);

  const dir = await mkdtemp(join(tmpdir(), "relay-link-"));
  scratch.push(dir);
  const link = join(dir, "relay.mjs");
  await new Promise((resolve, reject) => {
    const p = spawn("ln", ["-s", RELAY, link]);
    p.on("close", (c) => {
      if (c === 0) resolve(undefined);
      else reject(new Error(`ln exited ${String(c)}`));
    });
  });
  const viaLink = await new Promise((resolve) => {
    const p = spawn(process.execPath, [link, "--self-test"], {
      env: { ...process.env, RELAY_CHROMIUM: "/nonexistent-chromium" },
    });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.on("close", () => { resolve(out); });
  });
  assert.match(viaLink, /self-test passed/, "a symlinked install must still start the relay");
});
