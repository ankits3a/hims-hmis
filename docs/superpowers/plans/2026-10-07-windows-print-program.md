# A Windows print program for the counters — design note (not built)

Owner, 2026-10-07: *"If you can make a program that runs on windows operating system then I have no problem… For now
lets go ahead with your recommendation and then may be a small program. Right now I have printer attached with each
computer at front desk."* Browser printing shipped first (decision 0044). This note is the program that follows.

## What it has to do

- Print the papers the server queues (`print_jobs`) on a printer attached to a Windows PC, silently, with no browser
  open: the prescription sheet today; token slips, receipts, the duty board and pharmacy/lab bills when those
  printers arrive.
- Serve the phone app too: a visit opened on a phone prints at the counter.
- Keep printing through an internet outage for jobs it has already fetched (0002).

## What exists

`tools/print-relay/relay.mjs` is one dependency-free Node file: it claims jobs for the destinations it is granted
(`POST /print/claim`), spools them, renders HTML to PDF with headless Chromium, prints with CUPS `lp`, and reports
(`/print/printed`, `/print/failed`). Enrolment, grants per destination and the audit are all on the server already.
Only two steps are Linux-specific: finding Chromium and calling `lp`.

## Options

**A. Port the relay to Windows (recommended).** Same file, two platform branches:
- render: Edge is on every Windows 10/11 PC — `msedge.exe --headless --print-to-pdf` (Chrome if present);
- print: bundle SumatraPDF (portable, GPLv3) and call `SumatraPDF.exe -print-to "<printer name>" -silent file.pdf`;
  it honours the PDF's page size, which `Start-Process -Verb PrintTo` does not do reliably;
- config: `relay.json` maps a destination to a Windows printer name (`Get-Printer`).
- Packaging: a single `.exe` (Node SEA) plus SumatraPDF in one Inno Setup installer; runs at log-in from the
  Startup folder with a tray icon ("HMIS printing · 3 printed today · last 10:42"), not as a service — a service
  runs as SYSTEM and does not see a user's USB printers by default.

**B. One relay PC with Windows printer sharing.** One install; the other counters' printers are shared over the LAN
and added to that PC. Fewer installs, but every counter's printing then depends on one PC being on, and USB
printers shared from PCs that sleep are the usual failure.

**C. Keep the browser.** No install, but nothing prints for the phone app and nothing prints unattended (the duty
board at 20:00 and 08:00).

## Recommendation

**A, one per counter PC**, because the printers are USB-attached per counter. Each PC enrols as its own relay and is
granted its own destination.

## What the server needs

- **Per-counter destinations.** Today a document maps to one site-wide destination (`front_desk_a4`). With one
  relay per counter the server must know which counter a job belongs to. Smallest change: the session's counter
  (already known for the cash drawer and the queue) picks `front_desk_a4:<counter>`; a relay granted the bare
  destination still claims everything, so a single-relay site keeps working.
- **Enrolment a non-technical person can do.** `/admin/users` already creates relay agents; add "Add a print
  computer" that shows a one-time code the installer asks for.
- **Auto-update.** The program reads a version feed beside the app's (`/app/…`) and replaces itself; signed with the
  hospital's own code-signing certificate or, without one, verified by SHA-256 from the feed.

## Install, as the owner would do it

1. On the counter PC, open `https://hmis.crkmch.com/app/` → download "HMIS printing for Windows".
2. Run it. Windows SmartScreen will warn (unsigned) → "More info → Run anyway".
3. Type the one-time code from `/admin/users → Add a print computer`.
4. Pick the printer for "Prescription sheet (A4)" from the list. Print the test page.

## Risks

- Unsigned installer warnings; antivirus quarantining a self-updating `.exe`. A code-signing certificate removes both.
- A PC that sleeps or is logged out prints nothing: the tray icon and a "print computer offline" line on Desk One.
- Printer renamed in Windows → jobs fail with the printer's name in the error; the screen already shows failures.
- Two paths printing one job (browser and program): `printed-here` and the relay's claim are mutually exclusive on
  the server (a claimed job cannot be marked from a browser, a printed job is never claimed), and a computer in
  "Decide for me" stops printing from the browser the day a relay claims a job.

## Size

About a week: the two platform branches and packaging (2 days), per-counter destinations with tests (2 days),
enrolment screen and feed (1 day), a real-printer check at the hospital (the part nobody here can do).
