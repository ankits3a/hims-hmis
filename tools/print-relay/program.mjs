/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * HMIS Print — the counter's own print program (decision 0047)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `relay.mjs` is the engine: claim, spool, render, print, report. This file is what makes it a
 * program a person installs on ONE counter PC:
 *
 *   enrol     trade a one-time code from Admin → Printing for this computer's own key
 *   run       the relay loop, a heartbeat, a status page on 127.0.0.1, and the update check
 *   printers  list this computer's printers
 *   printer   choose which printer the A4 sheet comes out of
 *   status    print what the status page would say
 *
 * It claims exactly one destination — `counter:<this computer>:a4` — and the server will serve it
 * no other (the agent's grant). The engine is unchanged by any of this: the config this file
 * writes is the config `relay.mjs` has always read.
 *
 * Still dependency-free. Node 22 has `fetch`, `http` and `crypto`; everything else is two files.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapter, pickPrinter, isPaperPrinter } from "./platform.mjs";
import { acquireSpoolLock, ensureSpool, printOne, tick } from "./relay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STATUS_PORT = 47600;
export const HEARTBEAT_MS = 60_000;
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
export const FEED_NAME = "hmis-print-windows-latest.json";

export async function programVersion(dir = HERE) {
  try { return (await readFile(join(dir, "VERSION"), "utf8")).trim(); } catch { return "0.0.0-dev"; }
}

/* ── small pure things ───────────────────────────────────────────────────────────────────────── */

/** `1.2.10` > `1.2.9`. Anything unparseable is never "newer" — an odd feed must not trigger a swap. */
export function versionNewer(candidate, current) {
  const parse = (v) => /^\d+(\.\d+){0,3}$/.test(String(v)) ? String(v).split(".").map(Number) : null;
  const a = parse(candidate); const b = parse(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** The server's address as typed by a person: no trailing slash, https unless it is this machine. */
export function normaliseServer(raw) {
  let s = String(raw ?? "").trim().replace(/\/+$/, "");
  if (s === "") throw new Error("the server address is empty");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !local) throw new Error("the server address must be https://");
  return `${u.protocol}//${u.host}`;
}

/** The config `relay.mjs` reads, for one enrolled computer. The key is NOT in it on Windows. */
export function buildConfig({ serverUrl, enrolled, printer, paths, platform, sumatra }) {
  return {
    serverUrl,
    computerId: enrolled.computerId,
    name: enrolled.name,
    destination: enrolled.destination,
    queues: { [enrolled.destination]: printer ?? "" },
    spoolDir: paths.spool,
    pollSeconds: 3,
    statusPort: STATUS_PORT,
    platform,
    ...(sumatra === undefined ? {} : { sumatra }),
  };
}

export function configuredPrinter(config) {
  const q = config?.queues?.[config?.destination];
  return typeof q === "string" && q.trim() !== "" ? q : null;
}

/* ── the system, through `platform.mjs` ──────────────────────────────────────────────────────── */

/** Runs one command with no shell. `input` goes to stdin — the only road a secret ever takes. */
export function run({ cmd, args }, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", reject);
    child.on("close", (code) => { if (code === 0) resolve(out); else reject(new Error(`${cmd} exited ${String(code)}: ${err.slice(0, 300)}`)); });
    child.stdin.end(input ?? "");
  });
}

export async function listPrinters(os, runner = run) {
  const printers = os.parsePrinters(await runner(os.listPrintersCommand()));
  if (os.platform !== "win32") {
    const def = os.parseDefaultPrinter(await runner(os.defaultPrinterCommand()).catch(() => ""));
    return printers.map((p) => ({ ...p, isDefault: p.name === def }));
  }
  return printers;
}

/** Windows: DPAPI through PowerShell, the key on stdin. Linux: a 0600 file. Returns what to keep in the key file. */
export async function storeKey(os, paths, agentKey, runner = run) {
  const protect = os.protectSecretCommand();
  if (protect === null) {
    await writeFile(paths.secret, JSON.stringify({ scheme: "plain", value: agentKey }), { encoding: "utf8", mode: 0o600 });
    await chmod(paths.secret, 0o600).catch(() => undefined);
    return "plain";
  }
  try {
    const protectedB64 = (await runner(protect, agentKey)).trim();
    if (!/^[A-Za-z0-9+/=]{20,}$/.test(protectedB64)) throw new Error("DPAPI returned nothing usable");
    await writeFile(paths.secret, JSON.stringify({ scheme: "dpapi-machine", value: protectedB64 }), "utf8");
    return "dpapi-machine";
  } catch (e) {
    // A PC whose PowerShell is locked down still has to print. The file sits in the program's own
    // folder; the guide says how to restrict it. Recorded as `plain` so the status page says so.
    await writeFile(paths.secret, JSON.stringify({ scheme: "plain", value: agentKey, note: String(e).slice(0, 200) }), "utf8");
    return "plain";
  }
}

export async function readKey(os, paths, runner = run) {
  const kept = JSON.parse(await readFile(paths.secret, "utf8"));
  if (kept.scheme === "plain") return String(kept.value);
  const unprotect = os.unprotectSecretCommand();
  if (unprotect === null) throw new Error(`this key was protected with ${String(kept.scheme)}, which this system cannot open`);
  return (await runner(unprotect, String(kept.value))).trim();
}

/* ── enrolment ───────────────────────────────────────────────────────────────────────────────── */

export async function enrol({ serverUrl, code, platform, version, fetchImpl = fetch }) {
  const res = await fetchImpl(`${serverUrl}/api/print/enrol`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, platform, appVersion: version }),
  });
  if (res.status === 403) throw new Error("That code is wrong, already used, or older than 15 minutes. Ask the administrator for a new one (Admin → Printing → Add a computer).");
  if (res.status === 429) throw new Error("Too many tries. Wait one minute, then try again.");
  if (!res.ok) throw new Error(`The server answered ${String(res.status)}. Check the internet connection and the server address.`);
  const body = await res.json();
  for (const k of ["computerId", "agentKey", "destination", "name"]) {
    if (typeof body[k] !== "string" || body[k] === "") throw new Error(`the server's answer has no ${k}`);
  }
  return body;
}

/* ── updates: staged here, applied by the launcher on the next start ─────────────────────────── */

/**
 * Reads the feed and, when it names a newer version AND the server has switched updates on
 * (`autoUpdate: true`), downloads the app bundle, checks its SHA-256 against the feed, and stages
 * it in `app-next/`. NOTHING RUNNING IS REPLACED: `launcher.mjs` swaps the folder in before it
 * imports the program on the next start, so an interrupted download can never leave half a program.
 */
export async function checkForUpdate({ serverUrl, current, nextDir, fetchImpl = fetch, log = () => undefined }) {
  const res = await fetchImpl(`${serverUrl}/app/${FEED_NAME}`, { headers: { "cache-control": "no-store" } });
  if (!res.ok) return { state: "no_feed" };
  const feed = await res.json();
  if (!versionNewer(feed.version, current)) return { state: "current", version: current };
  if (feed.autoUpdate !== true) return { state: "available", version: feed.version };
  if (typeof feed.app !== "string" || !/^hmis-print-[A-Za-z0-9._-]+\.json$/.test(feed.app) || !/^[a-f0-9]{64}$/.test(String(feed.appSha256))) {
    return { state: "bad_feed", version: feed.version };
  }
  const bundleRes = await fetchImpl(`${serverUrl}/app/${feed.app}`);
  if (!bundleRes.ok) return { state: "no_bundle", version: feed.version };
  const raw = Buffer.from(await bundleRes.arrayBuffer());
  if (sha256(raw) !== feed.appSha256) {
    log(`update ${String(feed.version)} refused: the download's SHA-256 is not the feed's`);
    return { state: "bad_hash", version: feed.version };
  }
  const bundle = JSON.parse(raw.toString("utf8"));
  if (bundle.version !== feed.version || typeof bundle.files !== "object" || bundle.files === null) return { state: "bad_bundle", version: feed.version };
  await rm(nextDir, { recursive: true, force: true });
  await mkdir(nextDir, { recursive: true });
  for (const [name, text] of Object.entries(bundle.files)) {
    // A bundle names plain files beside the program — never a path.
    if (!/^[A-Za-z0-9._-]+$/.test(name) || typeof text !== "string") return { state: "bad_bundle", version: feed.version };
    await writeFile(join(nextDir, name), text, "utf8");
  }
  // READY is written LAST and carries the hash of every file: the launcher trusts nothing without it.
  const manifest = Object.fromEntries(Object.entries(bundle.files).map(([n, t]) => [n, sha256(Buffer.from(t, "utf8"))]));
  await writeFile(join(nextDir, "READY"), JSON.stringify({ version: feed.version, files: manifest }), "utf8");
  log(`update ${String(feed.version)} downloaded; it starts the next time this program starts`);
  return { state: "staged", version: feed.version };
}

/* ── the status page ─────────────────────────────────────────────────────────────────────────── */

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function statusSummary(state, now = Date.now()) {
  const connected = state.lastOkAt !== null && now - state.lastOkAt < 30_000;
  const printerOk = state.printer !== null && (state.printers.length === 0 || state.printers.some((p) => p.name === state.printer));
  return {
    connected,
    printerOk,
    headline: !state.enrolled ? "Not set up yet"
      : state.revoked ? "Switched off by the administrator"
      : state.printer === null ? "No printer chosen"
      : !printerOk ? `Printer "${state.printer}" is not on this computer any more`
      : connected ? "Connected" : "Not connected to the hospital server",
  };
}

export function statusHtml(state, now = Date.now()) {
  const s = statusSummary(state, now);
  const ok = state.enrolled && !state.revoked && s.connected && s.printerOk;
  const t = (ms) => ms === null ? "—" : new Date(ms).toLocaleTimeString("en-IN", { hour12: false });
  const options = state.printers.filter((p) => isPaperPrinter(p.name) || p.name === state.printer)
    .map((p) => `<option value="${esc(p.name)}"${p.name === state.printer ? " selected" : ""}>${esc(p.name)}${p.isDefault ? " (Windows default)" : ""}${p.offline ? " — offline" : ""}</option>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>HMIS Print</title>
<style>body{font-family:"Segoe UI",system-ui,sans-serif;margin:0;background:#f4f7f4;color:#132420}main{max-width:560px;margin:32px auto;padding:0 16px}.card{background:#fff;border:1px solid #dfe7e1;border-radius:12px;padding:18px 20px;margin-bottom:14px}h1{font-size:20px;margin:0 0 4px}.big{font-size:22px;font-weight:600;color:${ok ? "#0e6b4e" : "#b23a30"}}dl{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;margin:14px 0 0;font-size:14px}dt{color:#5c6f66}dd{margin:0}button,select{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #c9d5cd;background:#fff}button.p{background:#0e6b4e;border-color:#0e6b4e;color:#fff;font-weight:600}form{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.dim{color:#5c6f66;font-size:13px}</style></head><body><main>
<div class="card"><h1>HMIS Print</h1><div class="big" id="headline">${esc(s.headline)}</div>
<dl><dt>This computer</dt><dd>${esc(state.name ?? "—")}</dd><dt>Printer</dt><dd>${esc(state.printer ?? "not chosen")}</dd><dt>Hospital server</dt><dd>${esc(state.serverUrl ?? "—")}</dd><dt>Last answer</dt><dd>${t(state.lastOkAt)}</dd><dt>Last print</dt><dd>${t(state.lastPrintAt)}${state.lastPrintTitle ? ` · ${esc(state.lastPrintTitle)}` : ""}</dd><dt>Printed today</dt><dd>${String(state.printedToday)}</dd><dt>Version</dt><dd>${esc(state.version)}${state.update?.state === "staged" ? ` · ${esc(state.update.version)} starts on the next restart` : state.update?.state === "available" ? ` · ${esc(state.update.version)} is available` : ""}</dd>${state.lastError ? `<dt>Last problem</dt><dd>${esc(state.lastError)}</dd>` : ""}</dl></div>
<div class="card"><b>Printer for the prescription sheet (A4)</b><form method="post" action="/printer"><select name="printer">${options}</select><button>Use this printer</button></form>
<form method="post" action="/test"><button class="p">Print a test page</button></form><p class="dim">${esc(state.testResult ?? "The test page prints from this computer alone — it does not need the internet.")}</p></div>
<p class="dim">This page is only on this computer (127.0.0.1). The key is kept ${state.keyScheme === "dpapi-machine" ? "protected by Windows (DPAPI)" : "in a file in the program's folder"}.</p></main></body></html>`;
}

function readForm(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (d) => { body += String(d); if (body.length > 10_000) req.destroy(); });
    req.on("end", () => { resolve(Object.fromEntries(new URLSearchParams(body))); });
  });
}

/** Bound to 127.0.0.1 ONLY. It shows no patient and takes two actions: choose the printer, print a test page. */
export function createStatusServer(state, actions) {
  return createServer((req, res) => {
    void (async () => {
      // A page on another site must not be able to drive this one: only same-origin forms are taken.
      const origin = req.headers.origin;
      if (req.method === "POST" && origin !== undefined && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
        res.writeHead(403); res.end("forbidden"); return;
      }
      if (req.method === "GET" && req.url === "/status.json") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ...statusSummary(state), name: state.name, printer: state.printer, version: state.version, lastPrintAt: state.lastPrintAt, printedToday: state.printedToday }));
        return;
      }
      if (req.method === "POST" && req.url === "/printer") {
        const form = await readForm(req);
        if (typeof form.printer === "string" && form.printer !== "") await actions.setPrinter(form.printer);
        res.writeHead(303, { location: "/" }); res.end(); return;
      }
      if (req.method === "POST" && req.url === "/test") {
        state.testResult = await actions.testPage().then(() => `Test page sent to ${String(state.printer)} at ${new Date().toLocaleTimeString("en-IN", { hour12: false })}.`, (e) => `The test page did not print: ${String(e instanceof Error ? e.message : e)}`);
        res.writeHead(303, { location: "/" }); res.end(); return;
      }
      if (req.method === "GET" && (req.url === "/" || req.url === "")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(statusHtml(state)); return;
      }
      res.writeHead(404); res.end("not found");
    })().catch(() => { try { res.writeHead(500); res.end("error"); } catch { /* the socket is gone */ } });
  });
}

export function testPageJob(name, printer) {
  const at = new Date().toLocaleString("en-IN", { hour12: false });
  return {
    id: `local-test-${String(Date.now())}`,
    title: "HMIS test page",
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html><head><meta charset="utf-8"><title>HMIS test page</title><style>@page{size:A4;margin:0}body{margin:14mm;font-family:"Noto Sans","Noto Sans Devanagari","Nirmala UI","Segoe UI",sans-serif;font-size:13pt}h1{font-size:18pt;margin:0 0 6mm}.box{border:1px solid #000;padding:6mm;margin-top:8mm}</style></head><body><h1>HMIS Print — test page</h1><p>This computer's print program is working.</p><p>जाँच पृष्ठ — इस कंप्यूटर का प्रिंट प्रोग्राम काम कर रहा है।</p><p>${esc(name)} · ${esc(printer)} · ${esc(at)}</p><div class="box">A4 · 210 × 297 mm — the border should be whole on all four sides.</div></body></html>`,
  };
}

/* ── the commands ────────────────────────────────────────────────────────────────────────────── */

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
}

export async function loadConfig(paths) {
  try { return JSON.parse(await readFile(paths.config, "utf8")); } catch { return null; }
}

async function cmdEnrol(os, paths, argv, out) {
  const serverUrl = normaliseServer(flag(argv, "server") ?? "https://hmis.crkmch.com");
  const code = flag(argv, "code");
  if (code === undefined) throw new Error("usage: enrol --code ABCD-EFGH [--server https://…] [--printer \"name\"]");
  const version = await programVersion();
  const enrolled = await enrol({ serverUrl, code, platform: os.platform, version });
  await mkdir(paths.spool, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
  const keyScheme = await storeKey(os, paths, enrolled.agentKey);
  const printers = await listPrinters(os).catch(() => []);
  const printer = flag(argv, "printer") ?? pickPrinter(printers);
  const sumatra = os.platform === "win32" ? join(HERE, "..", "SumatraPDF.exe") : undefined;
  const config = buildConfig({ serverUrl, enrolled, printer, paths, platform: os.platform, sumatra });
  await writeFile(paths.config, JSON.stringify({ ...config, keyScheme }, null, 2), "utf8");
  out(`This computer is now "${enrolled.name}".`);
  out(printer === null ? "No printer was found — choose one on the status page." : `Printer: ${printer}`);
  return config;
}

async function cmdPrinters(os, out) {
  const printers = await listPrinters(os);
  if (printers.length === 0) out("No printers found on this computer.");
  for (const p of printers) out(`${p.isDefault ? "*" : " "} ${p.name}${p.offline ? "  (offline)" : ""}`);
}

async function cmdRun(os, paths, out, env) {
  const config = await loadConfig(paths);
  if (config === null) throw new Error("this computer is not set up yet — run the installer and type the code from Admin → Printing");
  const version = await programVersion();
  await mkdir(paths.logs, { recursive: true });
  await ensureSpool(config.spoolDir);
  const state = {
    enrolled: true, revoked: false, name: config.name, serverUrl: config.serverUrl, printer: configuredPrinter(config), printers: [],
    version, keyScheme: config.keyScheme ?? "plain", lastOkAt: null, lastPrintAt: null, lastPrintTitle: null, printedToday: 0, printedDay: new Date().toDateString(),
    lastError: null, update: null, testResult: null,
  };
  const log = (m) => {
    const line = `${new Date().toISOString()} ${m}`;
    out(line);
    void appendFile(join(paths.logs, `hmis-print-${new Date().toISOString().slice(0, 10)}.log`), `${line}\n`).catch(() => undefined);
    const printed = /^printed \S+ → .*\((.*)\)$/.exec(m);
    if (printed !== null) {
      if (state.printedDay !== new Date().toDateString()) { state.printedDay = new Date().toDateString(); state.printedToday = 0; }
      state.lastPrintAt = Date.now(); state.lastPrintTitle = printed[1]; state.printedToday += 1;
    }
    if (m.startsWith("FAILED ")) state.lastError = m.slice(0, 300);
  };

  const release = await acquireSpoolLock(config.spoolDir, log);
  if (release === null) throw new Error("HMIS Print is already running on this computer");
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { release(); process.exit(0); });

  config.agentKey = await readKey(os, paths);
  const refreshPrinters = async () => { state.printers = await listPrinters(os).catch(() => state.printers); };
  const heartbeat = async () => {
    await refreshPrinters();
    await fetch(`${config.serverUrl}/api/print/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-key": config.agentKey },
      body: JSON.stringify({ printer: state.printer, printers: state.printers.map((p) => p.name), platform: os.platform, appVersion: version }),
    }).then((r) => { if (r.status === 401 || r.status === 403) state.revoked = true; }, () => undefined);
  };
  const actions = {
    setPrinter: async (name) => {
      config.queues = { [config.destination]: name };
      state.printer = name;
      // The key lives in memory and in its own protected file — never in this one.
      const onDisk = Object.fromEntries(Object.entries(config).filter(([k]) => k !== "agentKey"));
      await writeFile(paths.config, JSON.stringify(onDisk, null, 2), "utf8");
      log(`printer set to ${name}`);
      await heartbeat();
    },
    testPage: async () => {
      if (state.printer === null) throw new Error("choose a printer first");
      const scratch = await mkdtemp(join(tmpdir(), "hmis-print-test-"));
      try {
        await ensureSpool(scratch);
        await printOne(config, scratch, { ...testPageJob(config.name, state.printer), destination: config.destination }, log);
      } finally { await rm(scratch, { recursive: true, force: true }).catch(() => undefined); }
    },
  };
  const server = createStatusServer(state, actions);
  server.on("error", (e) => { log(`status page not available: ${String(e)}`); });
  server.listen(config.statusPort ?? STATUS_PORT, "127.0.0.1");

  const update = async () => {
    state.update = await checkForUpdate({ serverUrl: config.serverUrl, current: version, nextDir: paths.next, log }).catch(() => state.update);
  };
  await heartbeat();
  void update();
  setInterval(() => { void heartbeat(); }, HEARTBEAT_MS).unref();
  setInterval(() => { void update(); }, UPDATE_CHECK_MS).unref();

  log(`HMIS Print ${version} up · ${config.name} · printer ${String(state.printer)} · status http://127.0.0.1:${String(config.statusPort ?? STATUS_PORT)}/`);
  const pollMs = Math.max(1, Number(config.pollSeconds ?? 3)) * 1000;
  for (;;) {
    try {
      if (state.printer !== null) {
        await tick(config, config.spoolDir, log);
        state.lastOkAt = Date.now();
        state.revoked = false;
      }
      // An update is waiting and something will start this program again (the installer's
      // run-hidden loop, or systemd): stop here, between ticks, with nothing half printed. The
      // launcher swaps the new version in on the way back up. Unsupervised, it waits for a restart.
      if (state.update?.state === "staged" && env.HMIS_PRINT_SUPERVISED === "1") {
        log("restarting to start the new version");
        release();
        process.exit(0);
      }
    } catch (e) {
      const msg = String(e);
      // 401/403 on the claim is the administrator's revoke (the agent's kill switch): say so, keep
      // asking slowly — a revoke is undone by enrolling again, and nothing is printed meanwhile.
      if (/HTTP 40[13]/.test(msg)) state.revoked = true;
      state.lastError = msg.slice(0, 300);
      log(`tick error (will retry): ${msg}`);
    }
    await new Promise((r) => setTimeout(r, state.revoked ? 30_000 : pollMs));
  }
}

export async function main(argv, env = process.env, out = (m) => { console.log(m); }) {
  const os = adapter(undefined, env);
  const home = flag(argv, "home") ?? os.home();
  const paths = os.layout(home);
  await mkdir(home, { recursive: true });
  const cmd = argv[0] ?? "run";
  if (cmd === "enrol") { await cmdEnrol(os, paths, argv, out); return; }
  if (cmd === "printers") { await cmdPrinters(os, out); return; }
  if (cmd === "printer") {
    const config = await loadConfig(paths);
    if (config === null) throw new Error("not set up yet");
    const name = argv[1];
    if (name === undefined) throw new Error('usage: printer "<printer name>"');
    config.queues = { [config.destination]: name };
    await writeFile(paths.config, JSON.stringify(config, null, 2), "utf8");
    out(`Printer: ${name}`);
    return;
  }
  if (cmd === "status") {
    const config = await loadConfig(paths);
    out(config === null ? "Not set up yet." : `${String(config.name)} · printer ${String(configuredPrinter(config))} · ${String(config.serverUrl)} · version ${await programVersion()}`);
    return;
  }
  if (cmd === "run") { await cmdRun(os, paths, out, env); return; }
  throw new Error(`unknown command ${cmd} — enrol | run | printers | printer | status`);
}

