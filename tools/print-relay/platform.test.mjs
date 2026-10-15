/**
 * The Windows half of the relay, checked as TEXT on Linux — there is no Windows machine in CI.
 * Each row pins a command line or parses an answer a real PC gives. Run: `node --test tools/print-relay/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  adapter, browserArgs, browserCandidates, findBrowser, homeDir, isPaperPrinter, layout, listPrintersCommand, parseDefaultPrinter,
  parsePrinters, pickPrinter, platformName, printCommand, protectSecretCommand, unprotectSecretCommand,
} from "./platform.mjs";

const WIN_ENV = { ProgramData: "C:\\ProgramData", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\Front Desk\\AppData\\Local" };

test("anything that is not Windows prints the CUPS way", () => {
  assert.equal(platformName("win32"), "win32");
  assert.equal(platformName("linux"), "linux");
  assert.equal(platformName("darwin"), "linux");
});

test("LINUX IS UNCHANGED: the browser arguments and the lp command are what relay.mjs always sent", () => {
  assert.deepEqual(browserArgs("linux", "/tmp/x/browser-profile"),
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", "about:blank"]);
  assert.deepEqual(printCommand("linux", { printer: "CRK-Thermal-1", pdfPath: "/tmp/hmis-print-1/doc.pdf", widthMm: 72, heightMm: 143 }),
    { cmd: "lp", args: ["-d", "CRK-Thermal-1", "-o", "media=Custom.72x143mm", "/tmp/hmis-print-1/doc.pdf"] });
  assert.equal(findBrowser("linux", {}, () => false), "chromium");
});

test("Windows looks for Edge first, then Chrome, and says so when there is neither", () => {
  const all = browserCandidates("win32", WIN_ENV);
  assert.equal(all[0], "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  assert.equal(all[1], "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
  assert.ok(all.includes("C:\\Users\\Front Desk\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"));
  assert.equal(findBrowser("win32", WIN_ENV, (p) => p.includes("Chrome") && p.startsWith("C:\\Program Files\\")), "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  assert.equal(findBrowser("win32", WIN_ENV, () => false), null);
});

test("Windows starts the browser on a PRIVATE profile — or an open Edge swallows the command and nothing renders", () => {
  const args = browserArgs("win32", "C:\\Users\\Front Desk\\AppData\\Local\\Temp\\hmis-print-01J\\browser-profile");
  assert.ok(args.includes("--user-data-dir=C:\\Users\\Front Desk\\AppData\\Local\\Temp\\hmis-print-01J\\browser-profile"));
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.equal(args.at(-1), "about:blank");
});

test("an A4 sheet goes to SumatraPDF silently, at its own size, on the named printer", () => {
  const c = printCommand("win32", { printer: "HP LaserJet M1005", pdfPath: "C:\\Temp\\hmis-print-1\\doc.pdf", widthMm: 210, heightMm: 297, sumatra: "C:\\ProgramData\\HMIS Print\\program\\SumatraPDF.exe" });
  assert.equal(c.cmd, "C:\\ProgramData\\HMIS Print\\program\\SumatraPDF.exe");
  assert.deepEqual(c.args, ["-print-to", "HP LaserJet M1005", "-print-settings", "noscale,paper=A4", "-silent", "C:\\Temp\\hmis-print-1\\doc.pdf"]);
});

test("a page that is not A4 is never forced onto A4 paper", () => {
  const c = printCommand("win32", { printer: "TVS RP 3160", pdfPath: "doc.pdf", widthMm: 72, heightMm: 143 });
  assert.deepEqual(c.args.slice(2, 4), ["-print-settings", "noscale"]);
  assert.equal(c.cmd, "SumatraPDF.exe");
});

test("a printer name with spaces, quotes and Devanagari is ONE argument, untouched", async () => {
  const name = 'HP LaserJet (Front "Desk") — काउंटर 1';
  const { args } = printCommand("win32", { printer: name, pdfPath: "C:\\Program Data\\a b\\doc.pdf", widthMm: 210, heightMm: 297 });
  assert.equal(args[1], name);
  // The same array handed to a real process with no shell arrives as the same array.
  const seen = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args]);
    let out = ""; child.stdout.on("data", (d) => { out += String(d); });
    child.on("error", reject); child.on("close", () => { resolve(JSON.parse(out)); });
  });
  assert.deepEqual(seen, args);
});

test("PowerShell's printer list: several printers, exactly one, none, a BOM, and nonsense", () => {
  const many = '[{"Name":"HP LaserJet M1005","Default":true,"WorkOffline":false},{"Name":"Microsoft Print to PDF","Default":false,"WorkOffline":false},{"Name":"कैनन LBP2900","Default":false,"WorkOffline":true}]';
  assert.deepEqual(parsePrinters("win32", many), [
    { name: "HP LaserJet M1005", isDefault: true, offline: false },
    { name: "Microsoft Print to PDF", isDefault: false, offline: false },
    { name: "कैनन LBP2900", isDefault: false, offline: true },
  ]);
  // ConvertTo-Json answers an OBJECT for a single printer — the commonest counter.
  assert.deepEqual(parsePrinters("win32", '\uFEFF{"Name":"Canon LBP2900B","Default":true,"WorkOffline":false}\r\n'), [{ name: "Canon LBP2900B", isDefault: true, offline: false }]);
  assert.deepEqual(parsePrinters("win32", ""), []);
  assert.deepEqual(parsePrinters("win32", "Get-CimInstance : Access denied"), []);
  assert.deepEqual(parsePrinters("win32", '[{"Name":"","Default":false},null,{"Default":true}]'), []);
});

test("the list command asks for UTF-8 and never goes through a shell string we build", () => {
  const c = listPrintersCommand("win32");
  assert.equal(c.cmd, "powershell.exe");
  assert.ok(c.args.includes("-NoProfile") && c.args.includes("-NonInteractive"));
  assert.match(c.args.at(-1), /OutputEncoding=\[System\.Text\.Encoding\]::UTF8/);
  assert.match(c.args.at(-1), /Win32_Printer.*ConvertTo-Json -Compress/);
  assert.deepEqual(listPrintersCommand("linux"), { cmd: "lpstat", args: ["-e"] });
});

test("CUPS' own answers", () => {
  assert.deepEqual(parsePrinters("linux", "CRK-Laser-1\nCRK-Thermal-1\n").map((p) => p.name), ["CRK-Laser-1", "CRK-Thermal-1"]);
  assert.equal(parseDefaultPrinter("linux", "system default destination: CRK-Laser-1\n"), "CRK-Laser-1");
  assert.equal(parseDefaultPrinter("linux", "no system default destination\n"), null);
  assert.equal(parseDefaultPrinter("win32", "HP LaserJet M1005\r\n"), "HP LaserJet M1005");
  assert.equal(parseDefaultPrinter("win32", ""), null);
});

test("the printer offered first is one that puts PAPER out — never 'Print to PDF', even as the Windows default", () => {
  assert.equal(isPaperPrinter("Microsoft Print to PDF"), false);
  assert.equal(isPaperPrinter("Microsoft XPS Document Writer"), false);
  assert.equal(isPaperPrinter("OneNote (Desktop)"), false);
  assert.equal(isPaperPrinter("HP LaserJet M1005"), true);
  assert.equal(pickPrinter([{ name: "Microsoft Print to PDF", isDefault: true }, { name: "Canon LBP2900B", isDefault: false }]), "Canon LBP2900B");
  assert.equal(pickPrinter([{ name: "Canon LBP2900B", isDefault: false }, { name: "HP LaserJet M1005", isDefault: true }]), "HP LaserJet M1005");
  assert.equal(pickPrinter([{ name: "Fax", isDefault: true }]), null);
  assert.equal(pickPrinter([]), null);
});

test("everything lives under one folder, and the folder has a space in its name", () => {
  const home = homeDir("win32", WIN_ENV);
  assert.equal(home, "C:\\ProgramData\\HMIS Print");
  assert.deepEqual(layout("win32", home), {
    config: "C:\\ProgramData\\HMIS Print\\relay.json", spool: "C:\\ProgramData\\HMIS Print\\spool", logs: "C:\\ProgramData\\HMIS Print\\logs",
    secret: "C:\\ProgramData\\HMIS Print\\agent.key", next: "C:\\ProgramData\\HMIS Print\\app-next",
  });
  assert.equal(homeDir("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }), "C:\\Users\\a\\AppData\\Local\\HMIS Print");
  assert.equal(homeDir("linux", {}), "/var/lib/hmis-print-relay");
  assert.equal(homeDir("linux", { HMIS_PRINT_HOME: "/tmp/x" }), "/tmp/x");
});

test("the key is protected by DPAPI at machine scope and NEVER appears on a command line", () => {
  const p = protectSecretCommand("win32"); const u = unprotectSecretCommand("win32");
  for (const c of [p, u]) {
    assert.equal(c.cmd, "powershell.exe");
    assert.match(c.args.at(-1), /ProtectedData/);
    assert.match(c.args.at(-1), /'LocalMachine'/);
    assert.match(c.args.at(-1), /\[Console\]::In\.ReadToEnd\(\)/); // the secret arrives on stdin
  }
  assert.match(p.args.at(-1), /::Protect\(/);
  assert.match(u.args.at(-1), /::Unprotect\(/);
  assert.equal(protectSecretCommand("linux"), null);
  assert.equal(unprotectSecretCommand("linux"), null);
});

test("the adapter is the same functions bound to one platform", () => {
  const w = adapter("win32", WIN_ENV);
  assert.equal(w.platform, "win32");
  assert.equal(w.home(), "C:\\ProgramData\\HMIS Print");
  assert.equal(w.printCommand({ printer: "P", pdfPath: "d.pdf", widthMm: 210, heightMm: 297 }).args[0], "-print-to");
  assert.equal(adapter("linux", {}).printCommand({ printer: "P", pdfPath: "d.pdf", widthMm: 210, heightMm: 297 }).cmd, "lp");
});
