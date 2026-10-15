/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * The relay's two operating systems, in one place (decision 0047)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `relay.mjs` is the same program on a Raspberry Pi and on a counter's Windows PC. Everything that
 * differs between them is here and NOWHERE else:
 *
 *   · which browser renders HTML to PDF (chromium · Edge, which every Windows 10/11 PC has);
 *   · how a PDF reaches a named printer (CUPS `lp` · the bundled SumatraPDF);
 *   · how the machine's printers are listed (`lpstat` · PowerShell `Win32_Printer`);
 *   · where the spool, the config and the logs live;
 *   · how the agent key is kept at rest (a 0600 file · DPAPI, machine scope).
 *
 * EVERY FUNCTION HERE THAT TOUCHES THE SYSTEM RETURNS A COMMAND (`{ cmd, args }`) OR PARSES ITS
 * OUTPUT. Nothing here spawns anything. That is deliberate: there is no Windows machine in CI, so
 * the Windows half can only be checked as text — the exact command line and the parse of a real
 * PowerShell answer — and `platform.test.mjs` does exactly that on Linux. What CANNOT be checked
 * that way is listed, honestly, in `docs/guides/windows-print-program.md`.
 *
 * Arguments are always an ARRAY handed to `spawn` with no shell, so a printer called
 * `HP LaserJet (Front "Desk") — काउंटर 1` or a path with spaces needs no quoting of ours: Node
 * builds the Windows command line and nothing is ever interpolated into a string a shell reads.
 */

import { win32 as winPath, posix as posixPath } from "node:path";

export const PLATFORMS = /** @type {const} */ (["linux", "win32"]);

/** `process.platform`, narrowed: anything that is not Windows prints the CUPS way. */
export function platformName(p = process.platform) {
  return p === "win32" ? "win32" : "linux";
}

/* ── where things live ───────────────────────────────────────────────────────────────────────── */

/**
 * The program's own folder: config, spool, logs, and (on Windows) the program files themselves.
 *
 * Windows: `%ProgramData%\HMIS Print` — one counter PC is one print computer whoever is logged in,
 * which is also why the key is protected at MACHINE scope below. `%LOCALAPPDATA%` is the fallback
 * for a PC whose ProgramData is locked down; the installer decides and passes `--home`.
 */
export function homeDir(platform, env) {
  if (platform === "win32") {
    const base = env.ProgramData ?? env.PROGRAMDATA ?? env.LOCALAPPDATA ?? "C:\\ProgramData";
    return winPath.join(base, "HMIS Print");
  }
  return env.HMIS_PRINT_HOME ?? "/var/lib/hmis-print-relay";
}

export function layout(platform, home) {
  const j = platform === "win32" ? winPath.join : posixPath.join;
  return { config: j(home, "relay.json"), spool: j(home, "spool"), logs: j(home, "logs"), secret: j(home, "agent.key"), next: j(home, "app-next") };
}

/* ── the browser ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Where a headless browser may be, most likely first. Edge before Chrome on Windows: Edge is part
 * of the operating system and is updated by it; Chrome is there only if somebody installed it.
 */
export function browserCandidates(platform, env) {
  if (platform !== "win32") return ["chromium", "chromium-browser", "google-chrome"];
  const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const pf = env.ProgramFiles ?? "C:\\Program Files";
  const local = env.LOCALAPPDATA;
  const out = [
    winPath.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    winPath.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    winPath.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    winPath.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
  ];
  if (local !== undefined) out.push(winPath.join(local, "Google", "Chrome", "Application", "chrome.exe"));
  return out;
}

/** The first candidate that exists. On Linux the names are looked up on PATH by `spawn`, so the first is returned as is. */
export function findBrowser(platform, env, exists) {
  const all = browserCandidates(platform, env);
  if (platform !== "win32") return all[0];
  return all.find((p) => exists(p)) ?? null;
}

/**
 * The arguments the headless browser is started with.
 *
 * Linux: EXACTLY what `relay.mjs` has always passed — this refactor must not move a Pi's output.
 *
 * Windows adds a private `--user-data-dir`. Without it a second `msedge.exe` started while the
 * clerk has Edge open HANDS THE COMMAND LINE TO THE RUNNING BROWSER AND EXITS: no DevTools port is
 * ever printed and the render times out. A private profile makes it its own process.
 */
export function browserArgs(platform, profileDir) {
  const base = ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0"];
  if (platform === "win32") {
    return [...base, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"];
  }
  return [...base, "about:blank"];
}

/* ── PDF → printer ───────────────────────────────────────────────────────────────────────────── */

/**
 * The command that puts `pdfPath` on `printer`.
 *
 * Linux: `lp -d <queue> -o media=Custom.<w>x<h>mm <pdf>` — unchanged.
 *
 * Windows: SumatraPDF, the unmodified portable exe that ships beside the program.
 * `-print-to` names the printer, `-silent` suppresses every dialog and error box (a box nobody is
 * there to click would hang the queue), and `noscale` prints the PDF at its own size — the server
 * built it at exactly the paper's size, and "fit" would shrink a sheet whose margins are already
 * right. `paper=A4` is passed only for an A4 document: for any other size the printer's own
 * default tray must not be overridden with a size the document is not.
 */
export function printCommand(platform, opts) {
  const { printer, pdfPath, widthMm, heightMm, sumatra } = opts;
  if (platform !== "win32") {
    return { cmd: "lp", args: ["-d", printer, "-o", `media=Custom.${String(Math.round(widthMm))}x${String(Math.round(heightMm))}mm`, pdfPath] };
  }
  const a4 = Math.abs(widthMm - 210) <= 1 && Math.abs(heightMm - 297) <= 1;
  return {
    cmd: sumatra ?? "SumatraPDF.exe",
    args: ["-print-to", printer, "-print-settings", a4 ? "noscale,paper=A4" : "noscale", "-silent", pdfPath],
  };
}

/* ── the machine's printers ──────────────────────────────────────────────────────────────────── */

const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
/** PowerShell writes the console's code page unless told otherwise; a Devanagari printer name would arrive as `?`. */
const PS_UTF8 = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";

export function listPrintersCommand(platform) {
  if (platform !== "win32") return { cmd: "lpstat", args: ["-e"] };
  return {
    cmd: "powershell.exe",
    args: [...PS, `${PS_UTF8} Get-CimInstance Win32_Printer | Select-Object Name,Default,WorkOffline | ConvertTo-Json -Compress`],
  };
}

export function defaultPrinterCommand(platform) {
  if (platform !== "win32") return { cmd: "lpstat", args: ["-d"] };
  return {
    cmd: "powershell.exe",
    args: [...PS, `${PS_UTF8} (Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1).Name`],
  };
}

/**
 * `{ name, isDefault, offline }` for every printer.
 *
 * `ConvertTo-Json` answers an OBJECT, not a one-element array, when there is exactly one printer —
 * the commonest case at a counter — and nothing at all when there are none. Both are handled here
 * because both were the answer on somebody's PC before they were a line in a test.
 */
export function parsePrinters(platform, stdout) {
  const text = String(stdout).replace(/^\uFEFF/, "").trim();
  if (platform !== "win32") {
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").map((name) => ({ name, isDefault: false, offline: false }));
  }
  if (text === "") return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((r) => r !== null && typeof r === "object" && typeof r.Name === "string" && r.Name.trim() !== "")
    .map((r) => ({ name: r.Name, isDefault: r.Default === true, offline: r.WorkOffline === true }));
}

export function parseDefaultPrinter(platform, stdout) {
  const text = String(stdout).replace(/^\uFEFF/, "").trim();
  if (platform === "win32") return text === "" ? null : text.split(/\r?\n/)[0].trim();
  // "system default destination: CRK-Laser-1" · "no system default destination"
  const m = /default destination:\s*(.+)$/m.exec(text);
  return m === null ? null : m[1].trim();
}

/** Virtual "printers" that put no paper out. Never offered as the counter's printer, never the default pick. */
const NOT_PAPER = [/microsoft print to pdf/i, /microsoft xps/i, /onenote/i, /^fax$/i, /send to/i, /anydesk/i, /pdf/i];
export function isPaperPrinter(name) {
  return !NOT_PAPER.some((re) => re.test(name));
}

/** The printer to offer first: the Windows default if it prints paper, else the first that does. */
export function pickPrinter(printers) {
  const paper = printers.filter((p) => isPaperPrinter(p.name));
  return (paper.find((p) => p.isDefault) ?? paper[0] ?? null)?.name ?? null;
}

/* ── the agent key at rest ───────────────────────────────────────────────────────────────────── */

/**
 * Windows keeps the key under DPAPI at MACHINE scope: readable by this PC, useless copied to
 * another. The secret travels on STDIN, never on a command line (a command line is visible in Task
 * Manager and in the event log). Linux writes a 0600 file, as the relay's config always has.
 *
 * `protect`: stdin = the key, stdout = base64 of the protected bytes.
 * `unprotect`: stdin = that base64, stdout = the key.
 */
export function protectSecretCommand(platform) {
  if (platform !== "win32") return null;
  return {
    cmd: "powershell.exe",
    args: [...PS, "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,'LocalMachine'))"],
  };
}
export function unprotectSecretCommand(platform) {
  if (platform !== "win32") return null;
  return {
    cmd: "powershell.exe",
    args: [...PS, "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,'LocalMachine'))"],
  };
}

/** The one object `relay.mjs` asks for. */
export function adapter(platform = platformName(), env = process.env) {
  return {
    platform,
    home: () => homeDir(platform, env),
    layout: (home) => layout(platform, home),
    browserCandidates: () => browserCandidates(platform, env),
    findBrowser: (exists) => findBrowser(platform, env, exists),
    browserArgs: (profileDir) => browserArgs(platform, profileDir),
    printCommand: (opts) => printCommand(platform, opts),
    listPrintersCommand: () => listPrintersCommand(platform),
    defaultPrinterCommand: () => defaultPrinterCommand(platform),
    parsePrinters: (stdout) => parsePrinters(platform, stdout),
    parseDefaultPrinter: (stdout) => parseDefaultPrinter(platform, stdout),
    protectSecretCommand: () => protectSecretCommand(platform),
    unprotectSecretCommand: () => unprotectSecretCommand(platform),
  };
}
