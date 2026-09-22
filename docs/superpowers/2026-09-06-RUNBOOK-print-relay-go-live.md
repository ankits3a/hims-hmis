# Runbook — getting paper out of the printers

**Written 2026-09-06, for the owner, at their request.** One human, one afternoon, one PC in
Hajipur.

## Why this exists

The print rail has been code-complete since FD-24 and **nothing has ever physically printed.**
Measured on 2026-09-06, on the build host:

```
$ systemctl status hmis-print-relay      -> Unit could not be found
$ ls /opt/hmis-print-relay               -> No such file or directory
$ ls /etc/hmis-print-relay.json          -> No such file or directory
$ which lp lpstat                        -> (nothing; CUPS is not installed)

hmis_fd_dev=# select document, status, count(*) from print_jobs group by 1,2;
     document        | status |  count
---------------------+--------+--------
 opd_payment_receipt | queued |      1
 opd_prescription    | queued |     10
 opd_token_slip      | queued |     11
```

(The eleventh token slip is a REPRINT I queued while testing — a reprint mints a new row rather than
reviving the old one, which is what keeps "who printed this again, and when" answerable.)

Every job the system has ever produced is still sitting at `queued`. That is the queue behaving
**correctly** — the server records an intention to print and a relay inside the hospital comes and
gets it — but it means no patient has ever been handed a slip by this system.

**Caveat, stated because it changes what you should conclude:** the box measured above is the BUILD
host, not the Hajipur PC. Nothing in the repository records an install anywhere, and no config file
naming a real CUPS queue exists in any branch. If a relay was installed by hand on some machine, it
is invisible from here — check before assuming this runbook is needed.

## What already works, so you know what you are switching on

| Piece | State |
|---|---|
| The queue (`print_jobs`, dedupe, lease, reprint) | shipped, tested |
| Token slip, 72 mm renderer | shipped |
| Prescription sheet, A4 renderer | shipped |
| Payment receipt, 72 mm renderer | shipped; **its producer landed 2026-09-06** — before that it was declared and never queued once |
| Vitals slip | destination only; renderer returns `null` pending an artboard. **Map its queue anyway** — see the README |
| The relay itself (`tools/print-relay/relay.mjs`) | written, self-testable, **never installed** |

`tools/print-relay/README.md` is the reference and it is good — packages, config shape, the
one-relay-per-spool lock, the systemd unit. **This page does not repeat it.** It fills the three
things the README cannot know: which machine, how to mint the key, and how to prove it.

---

## 1 · Pick the machine

Any always-on Linux PC on the hospital LAN that can reach both printers and the internet.
Raspberry Pi OS or Debian; Node 22+. **One relay for the whole site** — not one per counter. It
needs no inbound firewall hole and no static address; the connection is outbound only.

The front desk's own PC is the obvious candidate and is fine, with one caveat: if it is switched
off at night, nothing prints at night. A Pi in the server cupboard is better and costs less than
the printers do.

## 2 · Wire the printers to CUPS first, and prove them BEFORE the relay

This is the step that actually takes the afternoon, and doing it first means a relay failure later
is unambiguously the relay's.

```bash
sudo apt install -y chromium cups fonts-noto fonts-noto-devanagari
lpstat -p                                        # the queue names this machine knows
lp -d <QUEUE-NAME> /usr/share/cups/data/testprint # prove EACH queue by holding the paper
```

`fonts-noto-devanagari` is not optional — the token slip's patient-facing half is Hindi, and
without the face it prints boxes.

Three logical destinations to map, and today two of them are the same physical printer at the front
desk:

| Destination | What goes to it | Paper |
|---|---|---|
| `front_desk_thermal` | token slip **and** payment receipt | 80 mm roll, 72 mm printable, continuous |
| `front_desk_a4` | prescription sheet | A4 laser |
| `vitals_thermal` | nothing yet | 80 mm roll |

**Owner ruling 2026-09-06, recorded here because it reverses a question asked the same day:** the
OPD receipt stays on the 80 mm roll beside the token. 4 × 6 was ruled off the list on 2026-08-29
(`docs/design/2026-08-29-opd-counter-flow-v2/PrinterChoice.dc.html`) and stays off — a die-cut label
has a fixed height and an invoice does not. **No new printer is needed for this.**

## 3 · Mint the relay's key

On the server, once. The key is shown once and only its SHA-256 is stored.

```bash
cd /opt/hmis-prod/apps/core
DATABASE_URL=<prod url> AGENT_NAME=print-relay-hajipur pnpm tsx scripts/create-agent.ts
```

Put it in `/etc/hmis-print-relay.json` on the relay PC, `chmod 600`. If it leaks, revoke it with the
agent kill switch — immediate, no deploy.

## 4 · Install, per the README

`tools/print-relay/README.md` → **Install**, **Configure**, **Run**. Copy `relay.mjs` to
`/opt/hmis-print-relay/`, write the config with the queue names from step 2, install the systemd
unit, start it.

```bash
node relay.mjs --self-test    # checks the MAPPING. It never calls `lp`.
```

**The self-test cannot tell you a printer is plugged in** — that is what step 2's `lp -d` was for.
And do not start a second relay by hand against the same spool to watch it work; it refuses, by
design, and the reason is that it would otherwise hand a patient two token slips.

## 5 · Prove it end to end, with a patient nobody is waiting on

```bash
# on the relay PC
journalctl -u hmis-print-relay -f
```

Then, on `/counter`, register a test walk-in and assign a doctor. Within a few seconds:

- a **token slip** should come off the thermal printer, and
- a **prescription sheet** off the A4 laser.

Take the money and a **payment receipt** should follow it onto the thermal roll. Then open **Their
papers** (the button on the done stage, or any row of the patient's history, or the papers button on
`/billing`) and press **print again** — a second copy should come out, and the queue should show a
NEW job rather than the old one changing state. That last check is the one worth doing deliberately:
it proves the reprint path the whole of FD-27 was about.

If nothing comes out, the ladder is: `lpstat -p` (queue alive?) → `lp -d` (printer alive?) →
`journalctl` (did the relay claim the job?) → `select status, last_error from print_jobs order by
created_at desc limit 5` on the server (did it report back?).

## 6 · What to expect afterwards

**Ten-odd historical jobs will print the moment the relay starts.** Every slip queued since FD-24 is
still `queued` and claimable. On the dev database that is 21 documents for patients who left months
ago. Before starting a relay against **production**, decide whether to let that happen or to cancel
the backlog first — a stack of paper for people who are not in the building is confusing rather than
harmful, but it is better to expect it than to discover it.

## Still open after this

- **`vitals_slip` has no artboard.** Owner ruling R3 created the document; its renderer returns
  `null` on purpose rather than inventing a layout. The vitals-desk printer sits idle until that
  lands, and that is correct behaviour, not a misconfiguration.
- **`seed:roles` grants but never revokes.** Unrelated to printing and more serious: a permission
  removed in code stays held in any database seeded before the removal. `cashier/opd.visits.open`
  was removed by FD-25's close pass — to stop one actor lowering a consult fee and then collecting
  it — and was still present in the preview database on 2026-09-06. **Check production.**
