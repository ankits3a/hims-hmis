---
type: decision
id: "0047"
title: "Each counter PC runs its own print program (Windows), enrolled with a one-time code"
description: "Each counter PC runs its own print program (Windows), enrolled with a one-time code, sending to its own printer."
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
status: draft
ruling: partly-open
tags: [printing, front-desk, admin]
supersedes: []
superseded_by: []
sources:
  - { id: pr-536, resource: "https://github.com/ankits3a/hims-hmis/pull/536", title: "feat(printing): each counter PC runs its own print program — one-time code, its own destination, a Windows package; dormant until enrolled (owner 2026-10-07)" }
---
# 0047 — Each counter PC runs its own print program (Windows), enrolled with a one-time code

- **Date:** 2026-10-07   **Status:** Partly open — built and tested on Linux; **not yet run on a Windows PC**
- **Area:** printing, front desk, admin

## Decision

- Owner, 2026-10-07: *"If you can make a program that runs on windows operating system then I have no problem. For
  now lets go ahead with your recommendation and then may be a small program. Right now I have printer attached with
  each computer at front desk."* Then: *"start the Windows print program next."*
- So, narrowing 0002 (one relay for the whole site) and following 0045 (the browser is the fallback):
  - **One program per counter PC**, because each counter's A4 printer is USB-attached to its own PC and no single
    machine can reach them all. It is the existing relay (`tools/print-relay/relay.mjs`), unchanged in what it does,
    with the two operating-system steps behind one adapter (`platform.mjs`): Edge renders HTML to PDF, the bundled
    SumatraPDF sends the PDF to the named printer, silently.
  - **One computer = one agent = one destination.** A computer enrols with a one-time code (8 characters, 15 minutes,
    one use; only its hash is stored) that an administrator reads out from Users → Print computers. It receives its
    own key, kept under Windows DPAPI at machine scope, and may claim only `counter:<its id>:a4`. The claim route's
    existing grant check (WASA M-10) is what enforces that — no new guard.
  - **The desk chooses, once per browser, which program is "this computer's"** (Printing panel). A paper owed there
    is then sent to that program; nothing is sent to a program that has not asked for work in the last **90 seconds**,
    so a paper is never parked behind a PC that is off — the browser prints it instead (0045).
  - **Removing a computer** turns its agent's kill switch on (its next poll is refused) and hands its waiting paper
    back to the site.
  - **A counter's program being alive is not evidence that the site relay is**: `relayServes` ignores `counter:%`
    claims, or every other counter would stop browser printing the day the first program was installed.
  - **Updates:** the program reads a feed beside the staff app's files and, when the feed says `autoUpdate: true`,
    downloads the new program files, checks their SHA-256, and stages them; a launcher that updates never replace
    swaps them in on the next start and rolls back if the new version will not load. The owner's server decides when
    (`build-windows.sh … --auto-update`); the first builds ship with it **off**.
  - **Not a Windows service.** A service runs as SYSTEM and does not see a user's USB printer; the program starts at
    log-in from the Startup folder and needs no administrator rights.
  - **Unsigned.** The installer is a zip with `install.cmd`; Windows SmartScreen will warn once. A code-signing
    certificate (a purchase) would remove the warning — not bought.

## Why

- The owner has no thermal printers and one A4 printer per counter PC; a Raspberry Pi relay (0002) cannot print on a
  USB printer plugged into somebody else's computer.
- The browser fallback (0045) needs a print window per paper (or a special Chrome shortcut) and cannot print for the
  phone app or unattended. A program can.

## What is NOT decided / not done

- **Nothing has run on Windows.** The Windows half is checked as command lines and parsed PowerShell output on
  Linux. `docs/guides/windows-print-program.md` lists exactly what a first trial on ONE counter PC must confirm.
- **Phone app → a counter's printer.** A visit opened on a phone still goes to the site destination; choosing a
  counter's program from the phone is later.
- **Roll printers** (token slip, receipt) are not sent to a counter program: no counter has one.
- **A code-signing certificate** (money) — owner's call if the SmartScreen warning is a nuisance.

## Where

- Server: `apps/core/src/kernel/printing/computers.ts`, `computers.controller.ts`, migration `0184_print_computers`,
  `served.ts`; tests `apps/core/test/print-computers.e2e.test.ts`.
- Program: `tools/print-relay/{platform,program,launcher}.mjs`, `windows/`, `build-windows.sh`; tests
  `platform.test.mjs`, `program.test.mjs`.
- Web: `apps/web/src/screens/admin-print-computers.tsx`, `components/printing-panel.tsx`,
  `screens/desk-one/print-here.tsx`, `lib/browser-print.ts`.
- Routes: `docker/prod/Caddyfile` (`@print_file`), `Caddyfile.uat` (`@print_feed`).
