# 0045 — A counter with no print relay prints on its own printer, from the browser

- **Date:** 2026-10-07   **Status:** Partly open
- **Area:** printing, front desk, opd

## Decision

- Owner, at the front desk on production: *"When I click on handover, can't the browser automatically send the print
  action for prescription slip to default printer? Right now it doesn't automatically prints. I have to click on
  'print the paper again' and then from the popup, I have to click on 'save as pdf' and then print from the next
  dialog screen. 'Print again' button also doesn't send print action to default printer."*
- Owner, on the two options offered (browser printing now; a print program later): *"Right now no thermal printer and
  so I am not printing token. Right now I am working using only the prescription slip. If you can make a program that
  runs on windows operating system then I have no problem. For now lets go ahead with your recommendation and then
  may be a small program. Right now I have printer attached with each computer at front desk."*
- So, amending the scope of 0002 (which rejected browser printing outright):
  - **The relay stays the design.** Nothing in 0002 about the relay, its queue or its audit changes.
  - **Browser printing is the sanctioned fallback while no relay serves a counter.** The counter prints the SAME
    server-rendered document the relay would have printed, from a hidden frame of the page: no pop-up window and no
    save-as-PDF step. The job is then marked printed on the server with who printed it (`browser:<user>`), so a relay
    installed later does not print it again.
  - **The choice belongs to the computer, not the person** (a printer is attached to a machine): "Printing on this
    computer" keeps it in that browser. A browser nobody has told decides from what the server knows — it prints
    here while no relay has claimed a job for that printer, and stops by itself the day one does.
  - **At hand over the prescription sheet prints; the token slip and the payment receipt do not**, until a counter
    switches them on. The owner has no thermal printer and is "working using only the prescription slip".
  - **A Windows print program comes later** (`docs/superpowers/plans/2026-10-07-windows-print-program.md`).

## Why

- No relay was ever installed, so every print job on production sat `queued` and the clerk printed a saved PDF by
  hand for every patient.
- 0002's objections to browser printing were about two printers on one machine (thermal + A4) and one print window
  per patient. With one A4 printer per counter and only the sheet printing, the first does not arise; the second is
  one keypress, or none when the browser is started with `--kiosk-printing`.

## Consequences / how to apply

- No browser reports whether the person pressed Print or Cancel. The screen therefore says "sent to this printer",
  never "printed", and keeps "Print again" beside it.
- Fully automatic printing is a per-computer Windows setting, not something the server can switch on: the A4 printer
  as the default printer and a browser shortcut carrying `--kiosk-printing` (steps in the panel and in
  `docs/guides/print-from-this-computer.md`).
- A sheet (A4) and a slip (72 mm roll) are different page sizes, so a counter that turns both on gets two print
  windows, one after the other.
- The phone app cannot print this way; it still needs a relay or the Windows program.

## Open

- Which Windows print program to build, and when (the plan recommends one).
- Whether other desks (billing counter, vitals, lab, radiology) get the same hand-over printing. Today only Desk One's
  hand over prints automatically; "Their papers" prints directly wherever it is opened.
