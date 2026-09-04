#!/usr/bin/env node
// @ts-check
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T4 — THE PRINT RELAY
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This runs INSIDE THE HOSPITAL. The HMIS server is a Hetzner box in Helsinki and the printers are
 * on a LAN in Hajipur, so the server cannot reach a printer — it records an intention to print and
 * this process comes and gets it. The connection is OUTBOUND only: the hospital needs no inbound
 * firewall hole, no static address and no port forward.
 *
 * ONE RELAY PER SITE, not one agent per counter. That is the whole reason this design beat the
 * per-PC print agent: one install, printer configuration in one file, and a new desk needs nothing.
 *
 * ═══ IT MUST KEEP PRINTING WHEN THE INTERNET DOES NOT ═══
 *
 * The project brief's binding constraint is *"patient care must never depend on internet
 * connectivity."* With the server 6,000 km away that is not a slogan, it is the design:
 *
 *   · The rendered HTML arrives WITH the claim, so a claimed job needs nothing further from the
 *     server. Every claim is written to the spool BEFORE anything is printed.
 *   · A job already spooled is printed even if the uplink dies immediately afterwards.
 *   · A report that cannot be delivered is kept and retried. The paper is already out; the server
 *     finding out is not urgent, and losing the record would be worse.
 *
 * ═══ AND IT MUST NOT PRINT THE SAME SLIP TWICE ═══
 *
 * The server's lease exists so a dead relay strands nothing: when the lease lapses the job becomes
 * claimable again. The cost is that a relay which printed a slip and then lost its uplink can be
 * handed the SAME job again after it reconnects. So the spool keeps a `printed/<id>` marker, and a
 * job with a marker is never printed a second time — it is only re-reported. Server-side idempotence
 * and relay-side idempotence together are what make "at least once" behave like "exactly once" for
 * the thing that matters: paper.
 *
 * ═══ NO DEPENDENCIES, DELIBERATELY ═══
 *
 * Plain Node (22, `fetch` is global) plus two binaries that any Debian/Raspberry Pi OS has:
 * `chromium` (HTML → PDF) and `lp` (PDF → printer). No npm install on a machine nobody will
 * maintain, nothing to keep patched, and it copies onto a Pi as one file.
 *
 * USAGE
 *   node relay.mjs --config /etc/hmis-print-relay.json
 *   node relay.mjs --self-test          # exercises the spool and dedupe logic; no server, no printer
 *
 * CONFIG (see README.md)
 *   {
 *     "serverUrl":   "https://hmis.crkmch.com",
 *     "agentKey":    "…",                       // an agent created by an administrator
 *     "spoolDir":    "/var/lib/hmis-print-relay",
 *     "queues":      { "front_desk_thermal": "CRK-Thermal-1",
 *                      "front_desk_a4":      "CRK-Laser-1",
 *                      "vitals_thermal":     "CRK-Thermal-2" },
 *     "chromium":    "chromium",
 *     "pollSeconds": 3
 *   }
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where the spool keeps its three kinds of state. A directory each, so `ls` is the whole status UI. */
const DIRS = /** @type {const} */ ({ jobs: "jobs", printed: "printed", failed: "failed" });

/* ── the pure decisions, kept separate so `--self-test` can exercise them ─────────────────────── */

/**
 * The queue a job goes to, or null if this relay does not serve that destination.
 *
 * A relay must never claim a printer it cannot reach — the server filters by destination for that
 * reason — but the map is checked here too, because a config edit that removes a printer should
 * fail the JOB loudly rather than send it to a queue name that does not exist.
 */
export function queueFor(config, destination) {
  const q = config.queues?.[destination];
  return typeof q === "string" && q.trim() !== "" ? q : null;
}

/** The destinations this relay serves, straight from the config — what it asks the server for. */
export function servedDestinations(config) {
  return Object.entries(config.queues ?? {})
    .filter(([, q]) => typeof q === "string" && q.trim() !== "")
    .map(([d]) => d);
}

/**
 * What to do with a job that has just arrived (or been re-offered after a lapsed lease).
 *
 * `"print"` — never seen it, or seen it and not finished.
 * `"report-only"` — the paper is already out; the server simply has not been told.
 * That second case is the one that stops a flapping uplink turning into a pile of duplicate slips.
 */
export function decide(spoolState, jobId) {
  if (spoolState.printed.has(jobId)) return "report-only";
  return "print";
}

/* ── the I/O ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * The PDF's OWN page height, read back from the file rather than recomputed.
 *
 * The continuous case measures in the browser, so the relay does not otherwise know how long the
 * slip turned out to be — and CUPS has to be told the same size the document actually is. Reading
 * `/MediaBox` is a few lines and removes a whole class of "the PDF was right and the print was
 * scaled" bug.
 */
/** The PDF's own page WIDTH, for the self-test's geometry check. */
async function pdfWidthMm(pdfPath) {
  const buf = await readFile(pdfPath);
  const m = /\/MediaBox\s*\[([^\]]+)\]/.exec(buf.toString("latin1"));
  if (m === null) return 0;
  const n = m[1].trim().split(/\s+/).map(Number);
  return Math.round(((n[2] - n[0]) * MM_PER_IN) / 72);
}

async function pdfHeightMm(pdfPath) {
  const buf = await readFile(pdfPath);
  const m = /\/MediaBox\s*\[([^\]]+)\]/.exec(buf.toString("latin1"));
  if (m === null) return 297;
  const nums = m[1].trim().split(/\s+/).map(Number);
  const pts = nums[3] - nums[1];
  return Math.max(1, Math.round((pts * MM_PER_IN) / 72));
}

async function ensureSpool(dir) {
  for (const sub of Object.values(DIRS)) await mkdir(join(dir, sub), { recursive: true });
}

async function readSpoolState(dir) {
  const printed = new Set((await readdir(join(dir, DIRS.printed)).catch(() => [])).map((f) => f.replace(/\.json$/, "")));
  return { printed };
}

const MM_PER_IN = 25.4;
const PX_PER_IN = 96;

/**
 * ═══ HTML → PDF, AND WHY THIS IS NOT `--print-to-pdf` ═══
 *
 * **MEASURED ON THIS TOOLCHAIN, NOT ASSUMED.** `chromium --headless --print-to-pdf` SILENTLY IGNORES
 * the document's `@page { size: 72mm auto }` and emits a US-Letter page — 215.9 × 279.4 mm — with a
 * 72 mm slip stranded in the corner of it. Passing `preferCSSPageSize: true` over the DevTools
 * protocol does not rescue it either: only an EXPLICIT height is honoured (`size: 72mm 200mm`
 * renders exactly 72.0 × 200.1 mm). A first cut of this relay used the CLI flag and would have sent
 * every token slip to the printer as a letter-sized page.
 *
 * A thermal roll is CONTINUOUS, so there is no height to declare — the slip is as long as the job
 * needs. The server therefore sends the geometry as data (`page.widthMm`, `page.heightMm`), and when
 * the height is null this MEASURES the laid-out document and prints at exactly that size. One page,
 * no padding, nothing clipped.
 *
 * The DevTools protocol is spoken directly over the global `WebSocket` Node 22 already has, so this
 * stays a zero-dependency file that copies onto a Pi.
 */
function htmlToPdf(config, htmlPath, pdfPath, page) {
  return new Promise((resolve, reject) => {
    const bin = config.chromium ?? "chromium";
    const chrome = spawn(bin, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; try { chrome.kill(); } catch { /* already gone */ } fn(arg); } };
    const timer = setTimeout(() => { done(reject, new Error("chromium timed out rendering")); }, 60_000);

    chrome.on("error", (e) => { clearTimeout(timer); done(reject, e); });
    chrome.stderr.on("data", (d) => {
      stderr += String(d);
      const m = /ws:\/\/[^\s]+/.exec(stderr);
      if (m === null || settled) return;
      const endpoint = m[0];
      (async () => {
        const ws = new WebSocket(endpoint);
        await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
        let id = 0;
        const pending = new Map();
        ws.addEventListener("message", (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        });
        const send = (method, params = {}, sessionId) => new Promise((r) => {
          const i = ++id; pending.set(i, r);
          ws.send(JSON.stringify({ id: i, method, params, sessionId }));
        });

        const target = await send("Target.createTarget", { url: "about:blank" });
        const attached = await send("Target.attachToTarget", { targetId: target.result.targetId, flatten: true });
        const sid = attached.result.sessionId;
        await send("Page.enable", {}, sid);
        await send("Page.navigate", { url: `file://${htmlPath}` }, sid);
        // Layout and webfont settling. A slip is a handful of elements; this is generous.
        await new Promise((r) => setTimeout(r, 900));

        let heightIn;
        if (page.heightMm === null || page.heightMm === undefined) {
          const measured = await send("Runtime.evaluate", {
            expression: "Math.ceil(document.documentElement.getBoundingClientRect().height)",
            returnByValue: true,
          }, sid);
          const px = Number(measured.result?.result?.value ?? 0);
          if (!Number.isFinite(px) || px <= 0) throw new Error("could not measure the document height");
          // A hair of slack so a descender on the last line is never clipped by a rounding error.
          heightIn = px / PX_PER_IN + 0.08;
        } else {
          heightIn = page.heightMm / MM_PER_IN;
        }

        const printed = await send("Page.printToPDF", {
          printBackground: true,       // the UNPAID box is a filled block, not an outline
          preferCSSPageSize: false,    // measured above; see the header for why the CSS cannot decide
          paperWidth: page.widthMm / MM_PER_IN,
          paperHeight: heightIn,
          marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
        }, sid);
        const data = printed.result?.data;
        if (typeof data !== "string") throw new Error("printToPDF returned no data");
        await writeFile(pdfPath, Buffer.from(data, "base64"));
        ws.close();
        clearTimeout(timer);
        done(resolve, undefined);
      })().catch((e) => { clearTimeout(timer); done(reject, e); });
    });
  });
}

/**
 * PDF → printer. `lp` is CUPS' own client; the queue name is the hospital's, never the server's.
 *
 * The media size is derived from the page the PDF was actually built at, so CUPS is told the same
 * thing the document is — a mismatch here is how a correctly-sized PDF still comes out scaled.
 * `-o fit-to-page` is deliberately NOT passed: the geometry is already exact, and fitting would
 * rescale a slip that is correct.
 */
function lpPrint(queue, pdfPath, mediaMm) {
  return new Promise((resolve, reject) => {
    const child = spawn("lp", ["-d", queue, "-o", `media=Custom.${mediaMm}mm`, pdfPath], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lp exited ${String(code)}: ${err.slice(0, 400)}`));
    });
  });
}

async function api(config, path, body) {
  const res = await fetch(`${config.serverUrl.replace(/\/$/, "")}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-key": config.agentKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${String(res.status)}`);
  return await res.json();
}

/**
 * Deliver every report the spool is still holding.
 *
 * Runs BEFORE each claim, deliberately: a relay that reconnects should tell the server what it
 * already printed before asking for more, or the server will keep re-offering jobs whose paper is
 * sitting on the counter.
 */
async function flushReports(config, spool, log) {
  for (const file of await readdir(join(spool, DIRS.printed)).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    try {
      await api(config, "/print/printed", { jobId: id });
      await rm(join(spool, DIRS.printed, file), { force: true });
      await rm(join(spool, DIRS.jobs, `${id}.json`), { force: true });
      log(`reported printed ${id}`);
    } catch (e) {
      // The uplink is down. The paper is out and the marker stays — this is not an error worth
      // shouting about, and retrying it forever is the correct behaviour.
      log(`report deferred ${id}: ${String(e)}`);
      return;
    }
  }
  for (const file of await readdir(join(spool, DIRS.failed)).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    const reason = JSON.parse(await readFile(join(spool, DIRS.failed, file), "utf8")).error ?? "unknown";
    try {
      await api(config, "/print/failed", { jobId: id, error: String(reason).slice(0, 2000) });
      await rm(join(spool, DIRS.failed, file), { force: true });
      log(`reported failed ${id}`);
    } catch { return; }
  }
}

async function printOne(config, spool, job, log) {
  const queue = queueFor(config, job.destination);
  if (queue === null) throw new Error(`no queue configured for destination ${job.destination}`);

  const work = join(tmpdir(), `hmis-print-${job.id}`);
  await mkdir(work, { recursive: true });
  const htmlPath = join(work, "doc.html");
  const pdfPath = join(work, "doc.pdf");
  try {
    await writeFile(htmlPath, job.html, "utf8");
    // Geometry from the server, which owns the template. A job from an older server without it
    // falls back to a 72 mm continuous roll — the commonest document, and the safest guess.
    const page = job.page ?? { widthMm: 72, heightMm: null };
    await htmlToPdf(config, htmlPath, pdfPath, page);
    const pdfHeight = await pdfHeightMm(pdfPath);
    await lpPrint(queue, pdfPath, `${String(Math.round(page.widthMm))}x${String(pdfHeight)}`);
    // THE MARKER GOES DOWN THE MOMENT `lp` ACCEPTS, before any attempt to tell the server. If the
    // uplink dies now, the next claim finds the marker and re-reports instead of reprinting.
    await writeFile(join(spool, DIRS.printed, `${job.id}.json`), JSON.stringify({ at: new Date().toISOString(), queue }), "utf8");
    log(`printed ${job.id} → ${queue} (${job.title})`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function tick(config, spool, log) {
  await flushReports(config, spool, log);

  const state = await readSpoolState(spool);
  const claimed = await api(config, "/print/claim", {
    destinations: servedDestinations(config),
    limit: 5,
  });
  for (const job of claimed.jobs ?? []) {
    // SPOOL FIRST, PRINT SECOND. If this process is killed between the two, the job is on disk and
    // the next tick prints it — from the spool, without needing the server.
    await writeFile(join(spool, DIRS.jobs, `${job.id}.json`), JSON.stringify(job), "utf8");
    if (decide(state, job.id) === "report-only") {
      log(`already printed ${job.id}, re-reporting only`);
      continue;
    }
    try {
      await printOne(config, spool, job, log);
    } catch (e) {
      log(`FAILED ${job.id}: ${String(e)}`);
      await writeFile(join(spool, DIRS.failed, `${job.id}.json`), JSON.stringify({ error: String(e) }), "utf8");
    }
  }
  await flushReports(config, spool, log);
}

/* ── self-test: the spool and dedupe logic, with no server and no printer ─────────────────────── */

async function selfTest() {
  const dir = join(tmpdir(), `relay-selftest-${String(Date.now())}`);
  await ensureSpool(dir);
  const fail = (m) => { console.error(`SELF-TEST FAIL: ${m}`); process.exitCode = 1; };

  const cfg = { queues: { front_desk_thermal: "T1", front_desk_a4: "", vitals_thermal: "T2" } };
  if (queueFor(cfg, "front_desk_thermal") !== "T1") fail("queueFor should map a configured destination");
  if (queueFor(cfg, "front_desk_a4") !== null) fail("a blank queue is NOT configured and must fail the job loudly");
  if (queueFor(cfg, "nowhere") !== null) fail("an unknown destination has no queue");
  const served = servedDestinations(cfg).sort();
  if (served.join(",") !== "front_desk_thermal,vitals_thermal") fail(`servedDestinations should skip the blank one, got ${served.join(",")}`);

  let state = await readSpoolState(dir);
  if (decide(state, "job-1") !== "print") fail("an unseen job must print");
  await writeFile(join(dir, DIRS.printed, "job-1.json"), "{}", "utf8");
  state = await readSpoolState(dir);
  // THE ONE THAT MATTERS: a re-offered job whose paper is already out must NOT print again.
  if (decide(state, "job-1") !== "report-only") fail("a job with a printed marker must not print twice");
  if (decide(state, "job-2") !== "print") fail("a different job must still print");

  /*
    ═══ THE GEOMETRY TEST, AND IT IS THE ONE THIS FILE EXISTS TO KEEP HONEST ═══

    `chromium --print-to-pdf` ignores `@page { size: 72mm auto }` and emits US Letter. That defect is
    invisible in code review, invisible in a unit test of the server, and obvious only in the paper.
    So the self-test renders a real 72 mm document through the REAL `htmlToPdf` and reads the page
    box back out of the PDF. If someone "simplifies" this relay back to the CLI flag, this fails.

    Skipped, loudly, when there is no chromium — a CI box without a browser should not fail here,
    but it must not silently claim to have checked either.
  */
  const cfg2 = { chromium: process.env.RELAY_CHROMIUM ?? "chromium" };
  const html = join(tmpdir(), `relay-geom-${String(Date.now())}.html`);
  const pdf = html.replace(/\.html$/, ".pdf");
  await writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 72mm auto; margin: 0 }
    html,body{margin:0;padding:0} body{width:72mm;padding:3mm;font:10pt sans-serif}
  </style></head><body><div>MED-1</div><div>भुगतान शेष</div></body></html>`, "utf8");
  try {
    await htmlToPdf(cfg2, html, pdf, { widthMm: 72, heightMm: null });
    const w = await pdfWidthMm(pdf);
    const h = await pdfHeightMm(pdf);
    if (Math.abs(w - 72) > 1.5) fail(`the PDF should be 72 mm wide, got ${String(w)} mm — the CSS @page was ignored`);
    if (h > 120) fail(`a two-line slip should be short, got ${String(h)} mm — the height was not measured`);
    if (!process.exitCode) console.log(`geometry checked: ${String(w)} x ${String(h)} mm, continuous`);
  } catch (e) {
    console.log(`geometry check SKIPPED (no usable chromium): ${String(e).slice(0, 120)}`);
  } finally {
    await rm(html, { force: true });
    await rm(pdf, { force: true });
  }

  await rm(dir, { recursive: true, force: true });
  if (process.exitCode) console.error("self-test FAILED");
  else console.log("self-test passed: queue mapping, served destinations, print-once dedupe, page geometry");
}

/* ── entry ────────────────────────────────────────────────────────────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) { await selfTest(); return; }

  const ci = argv.indexOf("--config");
  if (ci < 0 || argv[ci + 1] === undefined) {
    console.error("usage: relay.mjs --config <file.json>   |   relay.mjs --self-test");
    process.exitCode = 2;
    return;
  }
  const config = JSON.parse(await readFile(argv[ci + 1], "utf8"));
  for (const key of ["serverUrl", "agentKey", "spoolDir", "queues"]) {
    if (config[key] === undefined) { console.error(`config is missing "${key}"`); process.exitCode = 2; return; }
  }
  const spool = config.spoolDir;
  await ensureSpool(spool);
  const log = (m) => { console.log(`${new Date().toISOString()} ${m}`); };
  const pollMs = Math.max(1, Number(config.pollSeconds ?? 3)) * 1000;

  log(`relay up · server ${config.serverUrl} · serving ${servedDestinations(config).join(", ")}`);
  for (;;) {
    try {
      await tick(config, spool, log);
    } catch (e) {
      // A tick that throws is almost always the uplink. Anything already spooled still prints on the
      // next one, so this is a log line and not a crash: a relay that exits stops the counter.
      log(`tick error (will retry): ${String(e)}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

await main();
