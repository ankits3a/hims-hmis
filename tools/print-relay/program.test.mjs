/**
 * The counter program around the engine: enrolment, the key at rest, the update, the status page.
 * A local HTTP server stands in for the hospital's; nothing here needs a printer or Windows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapter } from "./platform.mjs";
import {
  FEED_NAME, buildConfig, checkForUpdate, configuredPrinter, createStatusServer, enrol, listPrinters, main, normaliseServer, readKey,
  sha256, statusHtml, statusSummary, storeKey, testPageJob, versionNewer,
} from "./program.mjs";
import { applyStagedUpdate, rollBack, start } from "./launcher.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "hmis-print-prog-"));

/** A stand-in hospital server. `routes[path]` is `(req, body) => [status, json | Buffer]`. */
async function fakeServer(routes) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += String(d); });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const h = routes[req.url];
      if (h === undefined) { res.writeHead(404); res.end(); return; }
      const [status, payload] = h(req, body);
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
      res.writeHead(status, { "content-type": "application/json" }); res.end(buf);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${String(server.address().port)}`, seen, close: () => new Promise((r) => server.close(r)) };
}

test("a version is newer only when it parses and is greater", () => {
  assert.equal(versionNewer("1.0.1", "1.0.0"), true);
  assert.equal(versionNewer("1.2.10", "1.2.9"), true);
  assert.equal(versionNewer("1.0.0", "1.0.0"), false);
  assert.equal(versionNewer("0.9.9", "1.0.0"), false);
  assert.equal(versionNewer("2", "1.9.9"), true);
  assert.equal(versionNewer("latest", "1.0.0"), false);
  assert.equal(versionNewer("1.0.1; rm -rf", "1.0.0"), false);
  assert.equal(versionNewer("1.0.1", "0.0.0-dev"), false);
});

test("the server address as a person types it — and never plain http to the hospital", () => {
  assert.equal(normaliseServer("hmis.crkmch.com/"), "https://hmis.crkmch.com");
  assert.equal(normaliseServer(" https://hmis.crkmch.com/counter "), "https://hmis.crkmch.com");
  assert.equal(normaliseServer("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => normaliseServer("http://hmis.crkmch.com"), /https/);
  assert.throws(() => normaliseServer(""), /empty/);
});

test("enrolment trades the code for the key, and says plainly why it was refused", async () => {
  const srv = await fakeServer({
    "/api/print/enrol": (_req, body) => {
      const b = JSON.parse(body);
      if (b.code === "GOOD-CODE") return [201, { computerId: "PC1", name: "Front desk 1", agentKey: "k-secret", destination: "counter:PC1:a4", aliveSeconds: 90 }];
      if (b.code === "SLOW-DOWN") return [429, {}];
      if (b.code === "HALF-ANSW") return [201, { computerId: "PC1" }];
      return [403, { code: "enrolment_code_refused" }];
    },
  });
  try {
    const ok = await enrol({ serverUrl: srv.url, code: "GOOD-CODE", platform: "win32", version: "1.0.0" });
    assert.equal(ok.agentKey, "k-secret");
    assert.deepEqual(JSON.parse(srv.seen[0].body), { code: "GOOD-CODE", platform: "win32", appVersion: "1.0.0" });
    await assert.rejects(enrol({ serverUrl: srv.url, code: "NOPE-NOPE", platform: "win32", version: "1" }), /wrong, already used, or older than 15 minutes/);
    await assert.rejects(enrol({ serverUrl: srv.url, code: "SLOW-DOWN", platform: "win32", version: "1" }), /Wait one minute/);
    await assert.rejects(enrol({ serverUrl: srv.url, code: "HALF-ANSW", platform: "win32", version: "1" }), /no agentKey/);
  } finally { await srv.close(); }
});

test("the config the engine reads names one destination and one printer — and holds no key", () => {
  const paths = adapter("win32", { ProgramData: "C:\\ProgramData" }).layout("C:\\ProgramData\\HMIS Print");
  const config = buildConfig({
    serverUrl: "https://hmis.crkmch.com", platform: "win32", paths, printer: "HP LaserJet M1005", sumatra: "C:\\x\\SumatraPDF.exe",
    enrolled: { computerId: "PC1", name: "Front desk 1", destination: "counter:PC1:a4", agentKey: "k-secret" },
  });
  assert.deepEqual(config.queues, { "counter:PC1:a4": "HP LaserJet M1005" });
  assert.equal(config.spoolDir, "C:\\ProgramData\\HMIS Print\\spool");
  assert.equal(configuredPrinter(config), "HP LaserJet M1005");
  assert.equal(JSON.stringify(config).includes("k-secret"), false);
  assert.equal(configuredPrinter(buildConfig({ serverUrl: "x", platform: "linux", paths, printer: null, enrolled: { computerId: "P", name: "n", destination: "counter:P:a4" } })), null);
});

test("Windows keeps the key under DPAPI: it goes in on stdin and only the protected form is on disk", async () => {
  const home = await tmp();
  try {
    const os = adapter("win32", { ProgramData: home });
    const paths = { secret: join(home, "agent.key") };
    const calls = [];
    const runner = async (c, input) => {
      calls.push({ c, input });
      if (c.args.at(-1).includes("::Protect(")) return `${Buffer.from(`dpapi(${input})`).toString("base64")}\r\n`;
      return `${Buffer.from(input, "base64").toString("utf8").replace(/^dpapi\((.*)\)$/, "$1")}\r\n`;
    };
    assert.equal(await storeKey(os, paths, "k-secret-123", runner), "dpapi-machine");
    const onDisk = await readFile(paths.secret, "utf8");
    assert.equal(onDisk.includes("k-secret-123"), false);
    assert.equal(calls[0].input, "k-secret-123");
    assert.equal(calls[0].c.args.join(" ").includes("k-secret-123"), false);
    assert.equal(await readKey(os, paths, runner), "k-secret-123");

    // A PC whose PowerShell refuses still has to print: the fallback is a plain file, and it says so.
    assert.equal(await storeKey(os, paths, "k2", async () => { throw new Error("powershell.exe blocked by policy"); }), "plain");
    assert.equal(await readKey(os, paths, runner), "k2");
    assert.match(await readFile(paths.secret, "utf8"), /blocked by policy/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Linux keeps the key in a 0600 file", async () => {
  const home = await tmp();
  try {
    const os = adapter("linux", {});
    const paths = { secret: join(home, "agent.key") };
    assert.equal(await storeKey(os, paths, "k-linux"), "plain");
    assert.equal(await readKey(os, paths), "k-linux");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the printer list marks the default on both systems", async () => {
  const win = await listPrinters(adapter("win32", {}), async () => '[{"Name":"A","Default":false},{"Name":"B","Default":true}]');
  assert.deepEqual(win.map((p) => [p.name, p.isDefault]), [["A", false], ["B", true]]);
  const linux = await listPrinters(adapter("linux", {}), async (c) => c.args[0] === "-e" ? "A\nB\n" : "system default destination: A\n");
  assert.deepEqual(linux.map((p) => [p.name, p.isDefault]), [["A", true], ["B", false]]);
});

function bundleFor(version, files) {
  const raw = Buffer.from(JSON.stringify({ version, files }));
  return { raw, hash: sha256(raw) };
}

test("an update is staged only when it is newer, switched on by the server, and matches its hash", async () => {
  const home = await tmp();
  const files = { "program.mjs": "export async function main(){ globalThis.__ran = 'v2'; }\n", "relay.mjs": "export {};\n", "platform.mjs": "export function adapter(){ return { home: () => '' }; }\n", VERSION: "1.1.0\n" };
  const good = bundleFor("1.1.0", files);
  let feed = { version: "1.1.0", autoUpdate: false, app: "hmis-print-app-1.1.0.json", appSha256: good.hash };
  const srv = await fakeServer({ [`/app/${FEED_NAME}`]: () => [200, feed], "/app/hmis-print-app-1.1.0.json": () => [200, good.raw] });
  const nextDir = join(home, "app-next");
  try {
    assert.deepEqual(await checkForUpdate({ serverUrl: srv.url, current: "1.1.0", nextDir }), { state: "current", version: "1.1.0" });
    // Newer, but the server has not switched updates on: told, not taken.
    assert.deepEqual(await checkForUpdate({ serverUrl: srv.url, current: "1.0.0", nextDir }), { state: "available", version: "1.1.0" });
    assert.equal(existsSync(nextDir), false);

    feed = { ...feed, autoUpdate: true, appSha256: "0".repeat(64) };
    assert.equal((await checkForUpdate({ serverUrl: srv.url, current: "1.0.0", nextDir })).state, "bad_hash");
    assert.equal(existsSync(join(nextDir, "READY")), false);

    feed = { ...feed, app: "../../relay.json" };
    assert.equal((await checkForUpdate({ serverUrl: srv.url, current: "1.0.0", nextDir })).state, "bad_feed");

    feed = { version: "1.1.0", autoUpdate: true, app: "hmis-print-app-1.1.0.json", appSha256: good.hash };
    assert.deepEqual(await checkForUpdate({ serverUrl: srv.url, current: "1.0.0", nextDir }), { state: "staged", version: "1.1.0" });
    const ready = JSON.parse(await readFile(join(nextDir, "READY"), "utf8"));
    assert.equal(ready.version, "1.1.0");
    assert.deepEqual(Object.keys(ready.files).sort(), ["VERSION", "platform.mjs", "program.mjs", "relay.mjs"]);
  } finally { await srv.close(); await rm(home, { recursive: true, force: true }); }
});

test("a bundle that names a path instead of a file is refused whole", async () => {
  const home = await tmp();
  const evil = bundleFor("1.1.0", { "..\\..\\Startup\\x.cmd": "calc", VERSION: "1.1.0" });
  const srv = await fakeServer({
    [`/app/${FEED_NAME}`]: () => [200, { version: "1.1.0", autoUpdate: true, app: "hmis-print-app-1.1.0.json", appSha256: evil.hash }],
    "/app/hmis-print-app-1.1.0.json": () => [200, evil.raw],
  });
  try {
    assert.equal((await checkForUpdate({ serverUrl: srv.url, current: "1.0.0", nextDir: join(home, "app-next") })).state, "bad_bundle");
    assert.equal(existsSync(join(home, "app-next", "READY")), false);
  } finally { await srv.close(); await rm(home, { recursive: true, force: true }); }
});

async function installed(home, files) {
  const appDir = join(home, "program", "app");
  await mkdir(appDir, { recursive: true });
  for (const [n, t] of Object.entries(files)) await writeFile(join(appDir, n), t);
  return appDir;
}
async function stage(home, version, files, tamper) {
  const nextDir = join(home, "app-next");
  await mkdir(nextDir, { recursive: true });
  for (const [n, t] of Object.entries(files)) await writeFile(join(nextDir, n), n === tamper ? `${t}// changed after hashing` : t);
  await writeFile(join(nextDir, "READY"), JSON.stringify({ version, files: Object.fromEntries(Object.entries(files).map(([n, t]) => [n, sha256(Buffer.from(t))])) }));
  return nextDir;
}
const V1 = { "program.mjs": "export async function main(argv){ globalThis.__ran = 'v1:' + argv.join(' '); }\n", "relay.mjs": "export {};\n", "platform.mjs": "export function adapter(){ return { home: () => '/nowhere' }; }\n", VERSION: "1.0.0\n" };
const V2 = { ...V1, "program.mjs": "export async function main(argv){ globalThis.__ran = 'v2:' + argv.join(' '); }\n", VERSION: "1.1.0\n" };

test("the launcher swaps a staged update in, keeps the old one, and starts the new program", async () => {
  const home = await tmp();
  try {
    const appDir = await installed(home, V1);
    const nextDir = await stage(home, "1.1.0", V2);
    assert.equal(await applyStagedUpdate({ appDir, nextDir }), "applied");
    assert.equal((await readFile(join(appDir, "VERSION"), "utf8")).trim(), "1.1.0");
    assert.equal((await readFile(join(home, "program", "app-prev", "VERSION"), "utf8")).trim(), "1.0.0");
    assert.equal(existsSync(nextDir), false);
    assert.equal(await applyStagedUpdate({ appDir, nextDir }), "none");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a staged file changed after it was hashed is refused and the running version is untouched", async () => {
  const home = await tmp();
  try {
    const appDir = await installed(home, V1);
    const nextDir = await stage(home, "1.1.0", V2, "program.mjs");
    assert.match(await applyStagedUpdate({ appDir, nextDir }), /^refused: program\.mjs does not match/);
    assert.equal((await readFile(join(appDir, "VERSION"), "utf8")).trim(), "1.0.0");
    assert.equal(existsSync(nextDir), false);
    const { "relay.mjs": _gone, ...partial } = V2;
    assert.match(await applyStagedUpdate({ appDir, nextDir: await stage(home, "1.1.0", partial) }), /^refused: the update has no relay\.mjs/);
    assert.match(await applyStagedUpdate({ appDir, nextDir: await stage(home, "1.2.0", V2) }), /^refused: VERSION is not/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an update that will not even load costs one restart: the launcher puts the old program back and runs it", async () => {
  const home = await tmp();
  try {
    const appDir = await installed(home, V1);
    await stage(home, "1.1.0", { ...V2, "program.mjs": "export async function main( {{{ this is not JavaScript\n" });
    const lines = [];
    globalThis.__ran = undefined;
    await start(["status", "--home", home], { root: join(home, "program"), env: {}, log: (m) => { lines.push(m); } });
    assert.equal(globalThis.__ran, `v1:status --home ${home}`);
    assert.equal((await readFile(join(appDir, "VERSION"), "utf8")).trim(), "1.0.0");
    assert.ok(lines.some((l) => l.includes("going back to the previous one")));

    // And a good one runs as the new version.
    await stage(home, "1.1.0", V2);
    await start(["run", "--home", home], { root: join(home, "program"), env: {}, log: () => undefined });
    assert.equal(globalThis.__ran, `v2:run --home ${home}`);
    await rollBack(appDir);
    assert.equal((await readFile(join(appDir, "VERSION"), "utf8")).trim(), "1.0.0");
  } finally { await rm(home, { recursive: true, force: true }); }
});

const baseState = () => ({
  enrolled: true, revoked: false, name: "Front desk 1", serverUrl: "https://hmis.crkmch.com", printer: "HP LaserJet M1005",
  printers: [{ name: "HP LaserJet M1005", isDefault: true, offline: false }, { name: "Microsoft Print to PDF", isDefault: false, offline: false }],
  version: "1.0.0", keyScheme: "dpapi-machine", lastOkAt: Date.now(), lastPrintAt: null, lastPrintTitle: null, printedToday: 0, lastError: null, update: null, testResult: null,
});

test("the status page says the one thing that is wrong, in words", () => {
  const now = Date.now();
  assert.equal(statusSummary(baseState(), now).headline, "Connected");
  assert.equal(statusSummary({ ...baseState(), lastOkAt: now - 60_000 }, now).headline, "Not connected to the hospital server");
  assert.equal(statusSummary({ ...baseState(), printer: null }, now).headline, "No printer chosen");
  assert.equal(statusSummary({ ...baseState(), printer: "Old Canon" }, now).headline, 'Printer "Old Canon" is not on this computer any more');
  assert.equal(statusSummary({ ...baseState(), revoked: true }, now).headline, "Switched off by the administrator");
  assert.equal(statusSummary({ ...baseState(), enrolled: false }, now).headline, "Not set up yet");
  const html = statusHtml({ ...baseState(), name: 'Desk <script>alert(1)</script>', lastError: "<b>x</b>" }, now);
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.ok(html.includes("Desk &lt;script"));
  // "Print to PDF" is never offered as the counter's printer.
  assert.equal(html.includes("Microsoft Print to PDF"), false);
  assert.ok(html.includes("protected by Windows (DPAPI)"));
});

test("the status page is local, shows no patient, and takes only its own two forms", async () => {
  const state = baseState();
  const done = [];
  const server = createStatusServer(state, {
    setPrinter: async (name) => { done.push(["printer", name]); state.printer = name; },
    testPage: async () => { done.push(["test"]); },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${String(server.address().port)}`;
  try {
    assert.equal(server.address().address, "127.0.0.1");
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="headline">Connected</);
    const json = await (await fetch(`${base}/status.json`)).json();
    assert.deepEqual([json.connected, json.printerOk, json.name, json.printer], [true, true, "Front desk 1", "HP LaserJet M1005"]);

    const set = await fetch(`${base}/printer`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: "printer=HP+LaserJet+M1005" });
    assert.equal(set.status, 303);
    const t = await fetch(`${base}/test`, { method: "POST", redirect: "manual", headers: { origin: base } });
    assert.equal(t.status, 303);
    assert.deepEqual(done, [["printer", "HP LaserJet M1005"], ["test"]]);
    assert.match(state.testResult, /Test page sent to HP LaserJet M1005/);

    // A page on another site cannot drive it.
    const cross = await fetch(`${base}/test`, { method: "POST", headers: { origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
    assert.equal(done.length, 2);
    assert.equal((await fetch(`${base}/relay.json`)).status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});

test("a failed test page says why on the page", async () => {
  const state = baseState();
  const server = createStatusServer(state, { setPrinter: async () => undefined, testPage: async () => { throw new Error("SumatraPDF.exe exited 1: printer offline"); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fetch(`http://127.0.0.1:${String(server.address().port)}/test`, { method: "POST", redirect: "manual" });
    assert.match(state.testResult, /did not print: SumatraPDF\.exe exited 1: printer offline/);
  } finally { await new Promise((r) => server.close(r)); }
});

test("the local test page is an A4 job with both scripts on it", () => {
  const job = testPageJob("Front desk 1", "HP LaserJet M1005");
  assert.deepEqual(job.page, { widthMm: 210, heightMm: 297 });
  assert.ok(job.html.includes("जाँच पृष्ठ") && job.html.includes("Front desk 1"));
});

test("`enrol` on a fresh machine writes the config, the key and the folders — and `status` reads them back", async () => {
  const home = await tmp();
  const srv = await fakeServer({ "/api/print/enrol": () => [201, { computerId: "PC9", name: "Front desk 9", agentKey: "k-nine", destination: "counter:PC9:a4" }] });
  const lines = [];
  try {
    await main(["enrol", "--code", "ABCD-EFGH", "--server", srv.url, "--printer", "CRK-Laser-1", "--home", home], { HMIS_PRINT_HOME: home }, (m) => { lines.push(m); });
    const config = JSON.parse(await readFile(join(home, "relay.json"), "utf8"));
    assert.equal(config.destination, "counter:PC9:a4");
    assert.deepEqual(config.queues, { "counter:PC9:a4": "CRK-Laser-1" });
    assert.equal(JSON.stringify(config).includes("k-nine"), false);
    assert.equal(JSON.parse(await readFile(join(home, "agent.key"), "utf8")).value, "k-nine");
    assert.deepEqual((await readdir(home)).sort(), ["agent.key", "logs", "relay.json", "spool"]);
    assert.ok(lines.some((l) => l.includes('This computer is now "Front desk 9"')));
    await main(["status", "--home", home], {}, (m) => { lines.push(m); });
    assert.match(lines.at(-1), /Front desk 9 · printer CRK-Laser-1/);
    await assert.rejects(main(["dance", "--home", home], {}, () => undefined), /unknown command/);
  } finally { await srv.close(); await rm(home, { recursive: true, force: true }); }
});
