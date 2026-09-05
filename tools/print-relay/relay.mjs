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
import { realpathSync, rmSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Where the spool keeps its three kinds of state. A directory each, so `ls` is the whole status UI.
 *
 * EXPORTED, LIKE THE I/O FUNCTIONS BELOW, FOR ONE REASON: this relay is a dependency-free `.mjs`
 * that lives outside both test projects — `apps/core`'s jest rootDir and `apps/web`'s vitest root
 * both stop at their own package — so the only thing that can drive it is a sibling script run by
 * `node --test`. See `spool.test.mjs`. Nothing else in the repository imports this file.
 */
export const DIRS = /** @type {const} */ ({ jobs: "jobs", printed: "printed", failed: "failed" });

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

/**
 * Which spooled jobs still owe paper, in the order the server handed them over.
 *
 * A `printed/` marker means the slip is on the counter and only the report is outstanding. A
 * `failed/` marker means THIS relay already gave up and the SERVER owns the retry — `MAX_ATTEMPTS`
 * and the backoff live in `kernel/printing/claim.ts`, not here — so replaying one would spin a
 * jammed printer once every poll interval with nothing at all counting the attempts.
 *
 * THE ASYMMETRY WITH `decide` IS DELIBERATE, not an oversight. `decide` answers "the server has
 * just handed me this job again, what now?", and a server that re-offers a job after `reportFailed`
 * requeued it is ordering a genuine retry — so the CLAIM path must not consult `failed`. Only
 * REPLAY does, because replay is this relay arguing with itself.
 *
 * Sorted by id: the id is a ULID and `claimPrintJobs` tie-breaks on `id asc`, so this reproduces
 * the server's own order and the queue tokens come off the roll the way they were issued.
 */
export function jobsToReplay(spoolState, spooledIds) {
  return [...spooledIds]
    .filter((id) => !spoolState.printed.has(id) && !spoolState.failed.has(id))
    .sort();
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

export async function ensureSpool(dir) {
  for (const sub of Object.values(DIRS)) await mkdir(join(dir, sub), { recursive: true });
}

/* ── the spool's own writes, which are NEVER allowed to throw ─────────────────────────────────── */

/**
 * ═══ A MARKER THIS RELAY COULD NOT WRITE TO DISK IS STILL A MARKER ═══
 *
 * `printed/<id>.json` is the only thing that stops a slip being printed a second time, and it is put
 * down by a plain `writeFile` onto a spool disk that CAN FILL — `jobs/` holds whole rendered
 * documents and is swept only at seven days, so a relay left offline for a week fills it as designed.
 * When that write threw, it threw through `replaySpool`'s own catch (whose `failed/` write fails for
 * the identical reason), out of `tick` BEFORE `/print/claim`, and into the retry loop in `main`.
 * Three seconds later the same un-marked job was replayed and THE SAME SLIP CAME OUT AGAIN: one
 * patient's name, UHID and doctor, once per poll interval until the roll ran out, while nothing else
 * in the hospital printed at all and `systemctl status` said `active (running)`.
 *
 * That is the wedge the failure-marker parse used to be — moved from `failed/` to `jobs/`, and now
 * moving paper with it. So there is ONE rule here rather than a guard at each of the five call sites:
 *
 *   A SPOOL WRITE NEVER THROWS, AND A MARKER THE DISK REFUSED IS HELD IN MEMORY INSTEAD.
 *
 * `readSpoolState` folds these in, so every decision that reads a marker — `decide` on the claim
 * path, `jobsToReplay` on the replay path — sees what this relay KNOWS rather than only what the
 * disk managed to keep. Each pass tries the refused writes again, so the moment the disk has room
 * the durable record replaces the one in RAM and this process stops carrying it.
 *
 * A restart loses the RAM copy, and that is the honest limit of this: ONE duplicate slip, once, on
 * the first tick after a reboot onto a spool that still cannot be written — not one every three
 * seconds, for ever. It is the same trade `printOne` already makes by marking AFTER `lp` rather than
 * before: a clerk handed two token slips throws one away, a patient handed none stands at a counter
 * that believes it printed.
 *
 * Per PROCESS, not per spool directory, because a relay serves exactly one spool — and now refuses
 * to start if another process is already serving it (`acquireSpoolLock`).
 */
export const unwrittenMarkers = { printed: new Map(), failed: new Map() };

/**
 * Put a marker down, and if the disk refuses, remember it instead of throwing.
 *
 * Returns whether the DURABLE record is on disk. The caller has to know, because a `printed/` marker
 * that exists only in this process's memory is a promise that a reboot can break.
 */
async function markSpool(spool, sub, id, body, log) {
  const written = await writeFile(join(spool, sub, `${id}.json`), body, "utf8").then(() => true, (e) => {
    log(`could not write ${sub}/${id}.json: ${String(e)}`);
    return false;
  });
  if (written) unwrittenMarkers[sub].delete(id);
  else unwrittenMarkers[sub].set(id, body);
  return written;
}

/** Retry every marker the disk has refused so far. Cheap, and it is how the relay heals itself. */
async function flushUnwrittenMarkers(spool, log) {
  for (const sub of [DIRS.printed, DIRS.failed]) {
    for (const [id, body] of [...unwrittenMarkers[sub]]) await markSpool(spool, sub, id, body, log);
  }
}

/**
 * Take a file out of the spool, logging rather than throwing, and say whether it is gone.
 *
 * `force: true` SUPPRESSES ENOENT AND NOTHING ELSE. An immutable attribute, a read-only remount, a
 * spool restored from a backup under the wrong owner — each throws EACCES/EPERM/EROFS out of an
 * unguarded `rm`, and every caller here sits upstream of `/print/claim` in `tick`, so that is the
 * same silent, restart-surviving wedge in a third shape.
 *
 * The RETURN VALUE is the load-bearing part, not the catch: a caller deleting a marker and the
 * document it guards has to know whether the document actually went.
 */
async function removeSpoolFile(path, log) {
  return await rm(path, { force: true }).then(() => true, (e) => {
    log(`could not remove ${path}: ${String(e)}`);
    return false;
  });
}

/**
 * The two marker sets the spool holds: paper that is out, and work this relay gave up on.
 *
 * `failed` is new, and `decide` deliberately still reads only `printed` — see `jobsToReplay` for
 * why the CLAIM path and the REPLAY path must answer that question differently.
 *
 * Markers the disk refused are folded in from `unwrittenMarkers`. That is deliberate and it is the
 * whole point of holding them: a decision made from the disk alone would reprint a slip this relay
 * knows perfectly well is already on the counter.
 */
export async function readSpoolState(dir) {
  const idsIn = async (sub) => new Set([
    ...(await readdir(join(dir, sub)).catch(() => []))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, "")),
    ...unwrittenMarkers[sub].keys(),
  ]);
  return { printed: await idsIn(DIRS.printed), failed: await idsIn(DIRS.failed) };
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
export function htmlToPdf(config, htmlPath, pdfPath, page) {
  return new Promise((resolve, reject) => {
    const bin = config.chromium ?? "chromium";
    const chrome = spawn(bin, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let settled = false;
    /*
      ═══ ONE CHROMIUM LAUNCH IS ONE CDP SESSION, AND `settled` CANNOT SAY SO ═══

      The DevTools endpoint is scraped out of chromium's stderr, and this handler re-ran the regex
      against the WHOLE accumulated buffer on every chunk — guarded only by `settled`, which is not
      set until `done` runs at the very end of the render, two to three seconds later. Any ordinary
      stderr line inside that window therefore re-matched the `ws://` still sitting in the buffer and
      opened a SECOND, concurrent CDP session: its own target, its own render, and its own
      `writeFile` against the same `doc.pdf` the first one was writing. Headless chromium talks on
      stderr routinely (fontconfig, `bus.cc`, GPU and OOM-score notices) and every slip here loads a
      Devanagari face, which is precisely what makes fontconfig talk.

      Two writes truncating and interleaving leave a PDF with no findable `/MediaBox`, so
      `pdfHeightMm` silently returns its 297 fallback, CUPS is told `Custom.72x297mm`, `lp` exits 0
      and the marker goes down: the clerk is told it printed and is holding a blank strip, with no
      failure anywhere to reprint from. `settled` cannot serve as the guard because `done()` has to
      stay callable later; this is a separate one-shot.

      The listener stays attached rather than being removed, because nothing else drains
      `chrome.stderr` and an unread pipe blocks the child once its buffer fills.
    */
    let started = false;
    const done = (fn, arg) => { if (!settled) { settled = true; try { chrome.kill(); } catch { /* already gone */ } fn(arg); } };
    const timer = setTimeout(() => { done(reject, new Error("chromium timed out rendering")); }, 60_000);

    chrome.on("error", (e) => { clearTimeout(timer); done(reject, e); });
    chrome.stderr.on("data", (d) => {
      stderr += String(d);
      if (started || settled) return;
      const m = /ws:\/\/[^\s]+/.exec(stderr);
      if (m === null) return;
      started = true;
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
 * ═══ THE DOCUMENT GOES FIRST. ITS MARKER IS WHAT KEEPS IT OFF THE PRINTER ═══
 *
 * Both report legs used to delete their own marker and THEN the rendered document. Until the spool
 * was read back that order was inert — nothing ever opened `jobs/` again except the seven-day sweep.
 * `replaySpool` made it live: `jobsToReplay` defines "work that still owes paper" as a file in
 * `jobs/` with no marker beside it, which is EXACTLY what those two unlinks leave behind between
 * them. A power cut or a `systemctl restart` in that window — on the ordinary success path of every
 * job — meant a second copy of a patient's prescription off the laser on the next start. And with no
 * crash at all: if the `jobs/` unlink threw for a local reason (EROFS, EACCES) while the marker's had
 * already succeeded, the relay reprinted that job once per poll interval for ever.
 *
 * Reversed, the same interruption leaves a marker with no document: `flushReports` re-reports it next
 * tick (a no-op on the server, which guards on `status = 'claimed'`) and tidies it away, and
 * `jobsToReplay` cannot see it at all because there is no document to replay. No paper either way.
 *
 * So the rule, in one place rather than at four call sites: THE DURABLE RECORD OF "THIS PRINTED"
 * OUTLIVES ANYTHING THAT COULD MAKE IT PRINT AGAIN. A document that would not go keeps its marker,
 * loudly, and the next job is still reported — a disk fault here is not an uplink outage.
 */
async function removeSpooledDocumentBeforeMarker(spool, sub, markerFile, id, log) {
  if (!await removeSpoolFile(join(spool, DIRS.jobs, `${id}.json`), log)) {
    log(`keeping ${sub}/${markerFile}: its spooled document is still on disk and nothing else stops a reprint`);
    return false;
  }
  await removeSpoolFile(join(spool, sub, markerFile), log);
  return true;
}

/**
 * Deliver every report the spool is still holding.
 *
 * Runs BEFORE each claim, deliberately: a relay that reconnects should tell the server what it
 * already printed before asking for more, or the server will keep re-offering jobs whose paper is
 * sitting on the counter.
 */
export async function flushReports(config, spool, log) {
  for (const file of await readdir(join(spool, DIRS.printed)).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    try {
      await api(config, "/print/printed", { jobId: id });
    } catch (e) {
      // The uplink is down. The paper is out and the marker stays — this is not an error worth
      // shouting about, and retrying it forever is the correct behaviour. The try is NARROW on
      // purpose: the two deletions below are local-disk work and must not be filed as an outage.
      log(`report deferred ${id}: ${String(e)}`);
      return;
    }
    if (!await removeSpooledDocumentBeforeMarker(spool, DIRS.printed, file, id, log)) continue;
    log(`reported printed ${id}`);
  }
  for (const file of await readdir(join(spool, DIRS.failed)).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    /*
      ═══ A TORN MARKER MUST NOT WEDGE THE RELAY, AND THIS READ USED TO BE OUTSIDE THE TRY ═══

      This file is written by a plain `writeFile` (the catch in `tick`) on a hospital PC that gets
      switched off at the wall, onto a spool disk that can fill. A power cut mid-write leaves it
      truncated — on ext4, commonly NUL-filled — and parsing that out here threw past this function,
      past `tick`, into the retry loop in `main`. Nothing sweeps `failed/`, so the SAME file re-threw
      every three seconds and across every restart, and `tick` never got as far as `/print/claim`
      again: token slips, receipts, prescriptions and vitals slips all stopped, for the whole site,
      while `systemctl status` still said `active (running)`. Recovery meant a human deleting a file
      whose path no log line named.

      The REASON TEXT is a detail; the fact that this job failed is what the server needs. So an
      unreadable marker still reports — it just reports that — and is then deleted like any other,
      which is what lets the relay heal itself on the first tick that reaches the server.

      `?.error` rather than `.error` is load-bearing: a marker holding the literal `null` parses
      cleanly and then dies on the property access with a TypeError. The inner catch would hold it,
      but `?.` gives the honest "unknown" instead of dressing an ordinary empty record as a tear.

      The try is deliberately NARROW — read and parse only. The existing `catch { return; }` below
      means "the uplink is down, stop and retry next tick"; folding a permanent local-disk fault
      into it would rebuild the wedge in a new shape.
    */
    let reason = "unknown";
    try {
      reason = JSON.parse(await readFile(join(spool, DIRS.failed, file), "utf8"))?.error ?? "unknown";
    } catch (e) {
      reason = `failure marker unreadable (${String(e).slice(0, 160)})`;
      log(`unreadable failure marker ${file}, reporting anyway: ${String(e)}`);
    }
    try {
      await api(config, "/print/failed", { jobId: id, error: String(reason).slice(0, 2000) });
    } catch { return; }
    /*
      ═══ AND THE RENDERED DOCUMENT, WHICH THIS LEG WAS LEAVING ON DISK FOR EVER ═══

      `jobs/<id>.json` holds the CLAIM — the fully rendered HTML, with the patient's name, UHID,
      age, sex, visit number and doctor in it. The printed leg above has always removed it. This
      one removed only its own marker, so every permanently failed job left a copy of a patient's
      document on in-hospital hardware, invisible from the server, with nothing that would ever
      clean it up. A jammed printer was a privacy leak with a long half-life.
    */
    if (!await removeSpooledDocumentBeforeMarker(spool, DIRS.failed, file, id, log)) continue;
    log(`reported failed ${id}`);
  }
}

/**
 * Render one job and hand it to the printer.
 *
 * THROWS when no paper came out. RESOLVES FALSE when the paper IS out but the `printed/` marker
 * could not reach the disk — the caller must then stop rather than go on printing work it cannot
 * record, which is the difference between one slip and one every poll interval.
 */
export async function printOne(config, spool, job, log) {
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
    // uplink dies now, the next claim finds the marker and re-reports instead of reprinting. And if
    // the DISK refuses it, `markSpool` keeps it in memory and says so — see its header.
    const recorded = await markSpool(spool, DIRS.printed, job.id,
      JSON.stringify({ at: new Date().toISOString(), queue }), log);
    log(`printed ${job.id} → ${queue} (${job.title})`);
    return recorded;
  } finally {
    // Not even the tidying may throw: the paper is out and the marker is down, and failing to clear
    // a scratch directory under /tmp is no reason to tell the server this job did not print.
    await rm(work, { recursive: true, force: true }).catch((e) => { log(`could not clear ${work}: ${String(e)}`); });
  }
}

/**
 * ═══ THE SPOOL IS NOT A LOG, AND IT HOLDS PATIENT DATA ═══
 *
 * Every file in `jobs/` is a rendered document: a name, a UHID, an age and sex, a visit number and
 * a doctor. The two report legs delete their own as soon as the server acknowledges them, which
 * covers the ordinary roads — but not the one that actually happens on a hospital machine: the
 * relay is killed, or the box is powered off, between spooling a claim and reporting its outcome.
 * That file then belongs to nobody and no code path would ever remove it.
 *
 * So the spool is swept by AGE on every tick. The window is generous — a relay offline for a day is
 * a normal Tuesday and its spool must survive that, because the offline guarantee is the whole
 * reason the document travels with the claim. A week is long past the point where a document is
 * still going to be printed, and any job still wanted after that will be re-claimed from the server
 * rather than recovered from here.
 */
const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function sweepSpool(spool, log) {
  const cutoff = Date.now() - SPOOL_MAX_AGE_MS;
  let removed = 0;
  for (const file of await readdir(join(spool, DIRS.jobs)).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const path = join(spool, DIRS.jobs, file);
    const info = await stat(path).catch(() => null);
    if (info === null || info.mtimeMs >= cutoff) continue;
    /*
      `removeSpoolFile` rather than a bare `rm`, and it is the same reason every other deletion here
      uses it: `force: true` suppresses ENOENT AND NOTHING ELSE. An immutable attribute, a read-only
      remount, a spool restored from a backup under the wrong owner — each throws EACCES/EPERM/EROFS
      out of an unguarded `rm`, and `sweepSpool` runs one line before `flushReports` in `tick`, so
      that is the same silent, restart-surviving wedge the failure-marker parse used to be: the entry
      is already past the cutoff, so it is hit again on every single tick and the relay never claims
      work again.

      Logged and stepped over instead. Once every poll interval is noisy, and noisy is the point —
      a line an operator can grep beats a unit that reports itself healthy while nothing prints.
      The count stays honest: a file that could not be removed was not swept.
    */
    if (await removeSpoolFile(path, log)) removed += 1;
  }
  if (removed > 0) log(`swept ${String(removed)} spooled document(s) older than 7 days`);
}

/**
 * ═══ THE SPOOL IS READ BACK, WHICH IS WHAT MAKES THE OFFLINE GUARANTEE TRUE ═══
 *
 * `tick` has always written each claim to `jobs/` BEFORE printing it, under a comment promising
 * that "the next tick prints it — from the spool, without needing the server". NOTHING EVER OPENED
 * ONE OF THOSE FILES AGAIN: one write, one `readdir` for the age sweep, three deletes. Recovery ran
 * entirely through the server's 120-second lease, which is precisely the channel that is gone in
 * the case the spool exists for — in Bihar the mains take out the relay's host and the site router
 * together. So `jobs/` was a write-only store of rendered patient documents whose only consumer was
 * a seven-day deleter, and the brief's binding constraint ("patient care must never depend on
 * internet connectivity") was carried by a sentence rather than by code.
 *
 * Everything needed was already on disk: the claim carries `id`, `destination`, `title`, `html` and
 * `page`, and `printOne` consumes exactly those.
 *
 * ═══ AND IT STILL MUST NOT PRINT THE SAME SLIP TWICE ═══
 *
 * No new mechanism is introduced for that, because the right one already exists: `printOne` writes
 * `printed/<id>.json` the moment `lp` exits 0 and BEFORE any network call, and `jobsToReplay`
 * filters on it. Four roads, all closed:
 *
 *   1. printed, uplink dead, relay restarts → the marker is there, replay skips it.
 *   2. printed, uplink dead, lease lapses, the server re-offers it → `decide` says "report-only".
 *      That keeps working because replay writes its marker through the same `printOne`, and
 *      because this runs BEFORE `readSpoolState` in `tick`, so the state the claim loop reads
 *      already contains anything replay has just printed.
 *   3. spooled, never printed, relay dies → replay prints it; if the server also re-offers it, (2).
 *   4. spooled, print failed → a `failed/` marker; replay skips, the server owns the retry.
 *
 * The window between `lp` exiting 0 and the marker reaching disk — milliseconds — is left open ON
 * PURPOSE. Closing it means writing the marker BEFORE `lp`, which converts the failure mode from a
 * duplicate slip into a MISSING one, and `kernel/printing/claim.ts` rules that way round explicitly:
 * a clerk who gets two token slips throws one away, while a patient who gets none stands at a
 * counter that believes it printed. This does not widen the window; it does reach it sooner, because
 * a restart now replays locally instead of waiting out the lease — and the lease would have produced
 * the same reprint two minutes later anyway.
 *
 * ═══ AND THIS PARAGRAPH USED TO SAY THAT WAS THE ONLY WINDOW ═══
 *
 * It was not, and the two it missed were both opened by replay itself, on roads that had nothing to
 * do with a crash. They are closed elsewhere and named here because this is where anyone reasoning
 * about duplicate paper will look:
 *
 *   5. The marker WRITE fails. A full or read-only spool threw the write out of this function,
 *      out of `tick` before the claim, and into the retry loop in `main` — which replayed the same
 *      un-marked job three seconds later, and again, for ever. `markSpool` and `unwrittenMarkers`
 *      hold the record in memory instead and this loop stops the pass; see their header.
 *   6. `flushReports` deleted a marker BEFORE the document it guards, so anything interrupting those
 *      two unlinks left a document that `jobsToReplay` reads as owing paper. Reversed; see
 *      `removeSpooledDocumentBeforeMarker`.
 *
 * And two relays on one spool print everything twice, because replay is what turned `jobs/` from a
 * write-only store into shared state. See `acquireSpoolLock`.
 *
 * Nothing in here is allowed to throw for a local-disk reason. That was the whole lesson of the
 * failure-marker parse above, and implementing replay carelessly would simply have moved the wedge
 * from `failed/` to `jobs/`.
 */
export async function replaySpool(config, spool, log) {
  // A marker the disk refused earlier gets another chance BEFORE anything is decided from the
  // markers, so a spool that has recovered stops carrying the record in RAM.
  await flushUnwrittenMarkers(spool, log);
  const state = await readSpoolState(spool);
  const spooled = (await readdir(join(spool, DIRS.jobs)).catch(() => []))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  for (const id of jobsToReplay(state, spooled)) {
    let job;
    try {
      job = JSON.parse(await readFile(join(spool, DIRS.jobs, `${id}.json`), "utf8"));
    } catch (e) {
      log(`unreadable spooled job ${id}: ${String(e)}`);
      await markSpool(spool, DIRS.failed, id,
        JSON.stringify({ error: `spooled document unreadable: ${String(e).slice(0, 160)}` }), log);
      continue;
    }
    if (typeof job?.html !== "string" || typeof job?.destination !== "string") {
      log(`spooled file ${id} is not a print job`);
      await markSpool(spool, DIRS.failed, id,
        JSON.stringify({ error: "spooled file is not a print job" }), log);
      continue;
    }
    log(`replaying spooled job ${id}`);
    let recorded;
    try {
      // THE FILENAME IS THE ID, not whatever the payload says. A disagreement between the two must
      // never write a `printed/` or `failed/` marker under a job id this relay never claimed.
      recorded = await printOne(config, spool, { ...job, id }, log);
    } catch (e) {
      log(`FAILED (replay) ${id}: ${String(e)}`);
      await markSpool(spool, DIRS.failed, id, JSON.stringify({ error: String(e) }), log);
      continue;
    }
    if (!recorded) {
      /*
        A SPOOL THAT CANNOT RECORD WHAT IT PRINTED MUST STOP PRINTING, NOT CARRY ON.

        `unwrittenMarkers` already keeps THIS job off the printer next pass. Stopping the pass is the
        other half: the reason the marker did not land is almost always a full or read-only spool,
        and every further job in this pass would come off the printer with the same nothing recorded
        about it. Paper nobody can count is the state to avoid, and it is cheap to avoid — the next
        tick starts again from `flushUnwrittenMarkers`, and picks up where this left off the moment
        the disk takes a write.
      */
      log(`stopping this replay pass: ${id} is on paper but its printed marker is not on disk`);
      return;
    }
  }
}

export async function tick(config, spool, log) {
  await sweepSpool(spool, log);
  await flushReports(config, spool, log);
  // Paper the previous run owed, printed off the disk. Before the claim, because the claim is the
  // first thing in this function that can throw on a dead uplink — and an outage is exactly when
  // the spool has to earn its keep.
  await replaySpool(config, spool, log);

  const state = await readSpoolState(spool);
  const claimed = await api(config, "/print/claim", {
    destinations: servedDestinations(config),
    limit: 5,
  });
  for (const job of claimed.jobs ?? []) {
    // SPOOL FIRST, PRINT SECOND. If this process is killed between the two, the job is on disk and
    // the next tick prints it — from the spool, without needing the server (`replaySpool`, above).
    const spooledOk = await writeFile(join(spool, DIRS.jobs, `${job.id}.json`), JSON.stringify(job), "utf8")
      .then(() => true, (e) => {
        log(`could not spool ${job.id}: ${String(e)}`);
        return false;
      });
    if (!spooledOk) {
      // A job that is not on the spool cannot be replayed, cannot be swept and cannot be re-reported,
      // so printing it now would put paper on a counter that nothing here remembers. Stop instead:
      // the lease lapses, the server offers it again, and nothing was printed twice. This used to
      // throw out of `tick`, which at least also printed nothing — but it lost the report flush
      // below with it, which is the one thing a full spool still needs to get done.
      log(`not printing ${job.id}: it could not be written to the spool`);
      break;
    }
    if (decide(state, job.id) === "report-only") {
      log(`already printed ${job.id}, re-reporting only`);
      continue;
    }
    let recorded;
    try {
      recorded = await printOne(config, spool, job, log);
    } catch (e) {
      log(`FAILED ${job.id}: ${String(e)}`);
      await markSpool(spool, DIRS.failed, job.id, JSON.stringify({ error: String(e) }), log);
      continue;
    }
    // Same rule as the replay loop: paper this spool cannot record is where duplicates come from.
    if (!recorded) {
      log(`stopping this claim: ${job.id} is on paper but its printed marker is not on disk`);
      break;
    }
  }
  await flushReports(config, spool, log);
}

/* ── one relay per spool ──────────────────────────────────────────────────────────────────────── */

const LOCK_FILE = "relay.lock";

/**
 * The pid holding an existing lock, or null if nobody is.
 *
 * "CANNOT TELL" MUST MEAN STALE, and that is not caution, it is the whole safety argument for having
 * a lock at all. A hospital PC switched off at the wall leaves this file behind; a relay that then
 * refuses to start is a site-wide printing outage that survives every restart — the exact failure
 * this file has already produced twice, and strictly worse than the duplicate slip the lock prevents.
 * So an unreadable, unparseable or unbelievable lock is treated as abandoned.
 *
 * EPERM is the one exception: that is the kernel saying the process exists and belongs to someone
 * else, which is a live holder and not a stale file.
 */
async function lockHolder(spool) {
  const raw = await readFile(join(spool, LOCK_FILE), "utf8").catch(() => null);
  if (raw === null) return null;
  let pid = 0;
  try {
    pid = Number(JSON.parse(raw)?.pid);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return e?.code === "EPERM" ? pid : null;
  }
}

/**
 * ═══ TWO RELAYS ON ONE SPOOL NOW MEANS TWO SLIPS ═══
 *
 * Until the spool was read back, a second relay process was harmless: the only consumer of a claim
 * was the process that made it, and the server's `for update skip locked` guaranteed two relays
 * could never hold the same job. `jobs/` was write-only. `replaySpool` makes it SHARED MUTABLE
 * STATE that any process pointed at the spool will act on — and README.md's own Run section shows
 * the by-hand command twenty lines above the systemd unit that runs the same command against the
 * same spool, which is exactly what a technician clearing a jam does.
 *
 * Process A claims job X, writes `jobs/X.json`, and spends two or three seconds in chromium. B's
 * tick lands inside that window, sees a document with no marker, and prints the same token slip:
 * the patient is handed two. Both are also rendering through `join(tmpdir(), "hmis-print-<id>")`,
 * a fixed path per job id, so A's `finally` can delete the PDF out from under B's `lp` — B then
 * reports a failure for a job whose paper is already on the counter and the server requeues it.
 *
 * Returns a release function when this process owns the spool, and NULL when a live relay already
 * does — the caller must then refuse to start. A lock that cannot be created for a reason other
 * than contention (a read-only spool, wrong ownership) is logged loudly and started WITHOUT: a
 * relay that will not start is a worse outcome than one running unlocked, and it is the same
 * ruling as everywhere else in this file — never stop the counter.
 */
export async function acquireSpoolLock(spool, log) {
  const path = join(spool, LOCK_FILE);
  // Two passes at most: one to find a stale lock and clear it, one to take the lock itself. The
  // create is `wx` — O_CREAT|O_EXCL — so two relays racing to replace the same stale file cannot
  // both win, and the loser sees a live holder on its second pass.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle = null;
    try {
      handle = await open(path, "wx");
    } catch (e) {
      if (e?.code !== "EEXIST") {
        log(`could not take the spool lock at ${path} (${String(e)}) — starting WITHOUT it`);
        return () => {};
      }
      const held = await lockHolder(spool);
      if (held !== null) {
        log(`another relay (pid ${String(held)}) already holds ${path}`);
        return null;
      }
      log(`clearing a stale relay lock at ${path} — the process that wrote it is gone`);
      if (!await removeSpoolFile(path, log)) return null;
      continue;
    }
    // The lock is ours the moment `wx` succeeded; the pid inside it is only how the NEXT start tells
    // a live holder from an abandoned file. So a failure to write it is logged and stepped over
    // rather than thrown — an empty lock reads as stale, which is the safe direction, and refusing
    // to start over 60 bytes would be the outage this whole guard exists to avoid.
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, "utf8");
    } catch (e) {
      log(`took the spool lock but could not record this pid in it: ${String(e)}`);
    }
    await handle.close().catch(() => { /* the fd goes with the process, and the file is the lock */ });
    // `rmSync`, because this also runs from a `process.on("exit")` handler, where nothing async can.
    return () => { try { rmSync(path, { force: true }); } catch { /* the next start clears it */ } };
  }
  log(`another relay took the spool lock at ${path} first`);
  return null;
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
  let geometryChecked = false;
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
    geometryChecked = true;
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
  /*
    ═══ THE SUMMARY LINE IS ITSELF AN ASSERTION, AND IT USED TO LIE ═══

    This printed "… print-once dedupe, page geometry" unconditionally — including on the run that
    had just printed `geometry check SKIPPED (no usable chromium)` two lines above it. Every
    browserless run therefore claimed a check it had not made, in a repository whose first binding
    rule is "never report a test green you did not run in that state". The skip was always meant to
    be loud; the line that followed it took the loudness back.
  */
  const checked = "queue mapping, served destinations, print-once dedupe";
  if (process.exitCode) console.error("self-test FAILED");
  else if (geometryChecked) console.log(`self-test passed: ${checked}, page geometry`);
  else console.log(`self-test passed: ${checked} — page geometry SKIPPED (no usable chromium)`);
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

  /*
    THE LOCK COMES BEFORE THE LOOP, because `replaySpool` is the one code path that acts on another
    process's claim — and it runs on the very first tick. Refusing here is the only place refusing is
    still free: nothing has been claimed, nothing has been rendered and no paper is at stake.
  */
  const release = await acquireSpoolLock(spool, log);
  if (release === null) {
    console.error(`another relay is already running against ${spool} — refusing to start a second one`);
    process.exitCode = 3;
    return;
  }
  // systemd stops this unit with SIGTERM, whose default handler exits WITHOUT running `exit`
  // listeners, so the lock has to be given back on the signal too or every restart clears a stale
  // one it did not need to.
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { release(); process.exit(0); });
  }

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

/*
  ═══ RUN THE LOOP ONLY WHEN THIS FILE IS THE PROGRAM ═══

  This was a bare `await main();`, which meant that merely IMPORTING this file ran the relay. Under
  a test runner `process.argv` carries no `--config`, so `main` printed the usage line and set
  `process.exitCode = 2` — a test run where every assertion passed would still have exited 2. That
  is why `spool.test.mjs` can exist at all.

  `realpathSync` rather than a bare string compare: Node resolves the entry point through its real
  path, so `import.meta.url` is already the real file. An install that puts a SYMLINK in
  `/opt/hmis-print-relay/relay.mjs` would otherwise compare a symlink path against a real one, miss,
  and start a relay that silently prints nothing — the worst possible way for this guard to be
  wrong. `spool.test.mjs` runs the real CLI through a symlink for exactly that reason.
*/
const invokedAs = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return null;
  try {
    return pathToFileURL(realpathSync(entry)).href;
  } catch {
    return pathToFileURL(entry).href;
  }
})();
if (invokedAs === import.meta.url) await main();
