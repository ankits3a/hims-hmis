# The HMIS print relay

One small process, running **inside the hospital**, that turns queued print jobs into paper.

## Why this exists

The HMIS server is a Hetzner box in **Helsinki**. The printers are on a LAN in **Hajipur**. A server
in Finland has no route to a printer in Bihar, so the server does not print — it records an
intention to print, and this relay comes and gets it.

The connection is **outbound only**. The hospital needs no inbound firewall hole, no port forward
and no static address.

**One relay serves the whole site**, not one agent per counter. That is the entire advantage over
the per-PC print agent that was rejected: one install, printer configuration in one file, and a new
desk needs nothing.

## What it guarantees

**It keeps printing when the internet does not.** The project brief's binding constraint is *"patient
care must never depend on internet connectivity"*, and with the server 6,000 km away that is a
design requirement rather than a slogan:

- the rendered document arrives **with** the claim, so a claimed job needs nothing further;
- every claim is written to the spool **before** anything is printed;
- a claim that outlived the process is **read back off the spool and printed on the next tick**,
  with the server still unreachable — `jobs/` is replayed, not just written;
- a report that cannot be delivered is kept and retried — the paper is already out, and losing the
  record would be worse than delivering it late.

> **This third bullet was a promise before it was a mechanism.** Until FD-25 nothing ever opened a
> file in `jobs/` again — one write, one `readdir` for the age sweep, three deletes — so a relay
> that was killed between spooling a claim and printing it recovered only when the server's
> 120-second lease lapsed. In Bihar the mains take out the relay's PC and the site router together,
> so that was precisely the channel missing in the case the spool exists for. `jobs/` was a
> write-only store of rendered patient documents whose only consumer was a seven-day deleter.

**It does not print the same slip twice.** The server leases a claim so that a dead relay strands
nothing; the cost is that a relay which printed and then lost its uplink can be handed the same job
again. The spool keeps a `printed/<id>` marker and a marked job is only re-reported, never
reprinted.

## Install

Requires **Node 22+**, **chromium**, and **CUPS** (`lp`). All three are in Raspberry Pi OS and
Debian. There is no `npm install` — the relay is one dependency-free file.

```bash
sudo apt install -y chromium cups fonts-noto fonts-noto-devanagari
```

**`fonts-noto-devanagari` is not optional.** The token slip prints `भुगतान शेष — बिलिंग काउंटर` and
the bilingual "Go next to" block. Without a Devanagari face the patient-facing half of every slip
comes out as boxes.

Add each printer to CUPS and note its **queue name** — that name goes in the config, and the server
never sees it:

```bash
lpstat -p            # the queue names this machine knows
lp -d CRK-Thermal-1 /usr/share/cups/data/testprint   # prove the queue before wiring the relay
```

## Configure

```json
{
  "serverUrl":   "https://hmis.crkmch.com",
  "agentKey":    "…",
  "spoolDir":    "/var/lib/hmis-print-relay",
  "queues": {
    "front_desk_thermal": "CRK-Thermal-1",
    "front_desk_a4":      "CRK-Laser-1",
    "vitals_thermal":     "CRK-Thermal-2"
  },
  "chromium":    "chromium",
  "pollSeconds": 3
}
```

> **`vitals_thermal` HAS NOTHING TO PRINT YET, AND YOU SHOULD STILL MAP IT.**
>
> The vitals slip is a declared document with a destination and no producer: nothing enqueues one,
> and its renderer deliberately returns null pending the artboard owner ruling R3 asked for. So the
> vitals-desk printer will sit idle until that lands, and a relay that has never printed to it is
> working correctly rather than misconfigured.
>
> Map it anyway. The queue name is the thing that needs a human, a store cupboard and a cable; the
> day the slip exists you want the relay already able to reach the printer rather than discovering
> the mapping is wrong with a nurse waiting. `--self-test` checks the **mapping**; the `lp -d` above
> is what proves the **queue** — the self-test never calls `lp` and never touches CUPS, so it cannot
> tell you a printer is plugged in.


The **agent key** is created by an administrator on the server (`createAgent`). Only its SHA-256 is
stored there, so the key is shown once — keep the config file `chmod 600`. A compromised relay is
revoked with the agent **kill switch**, which takes effect immediately and needs no deploy.

`queues` maps the server's **logical destinations** to this hospital's CUPS queues. A destination
with no queue is simply not served, and the relay never claims work it cannot print. Moving a
printer to another desk is an edit to this file — not a deploy, not a migration.

## Run

```bash
node relay.mjs --config /etc/hmis-print-relay.json
node relay.mjs --self-test     # no server, no printer needed
```

> **ONE RELAY PER SPOOL. THE SECOND ONE PRINTS THE SAME SLIP AGAIN.**
>
> The unit below runs that exact first command against that exact spool, so starting it by hand to
> watch a jam — the obvious thing to do, and what this page used to invite without a word of warning
> — means two processes reading one `jobs/` directory. Process A claims a job, writes it to the
> spool and spends two or three seconds in chromium; B's tick lands inside that window, sees a
> document with no marker beside it, and prints the same token slip. The patient is handed two.
>
> That is not a risk the design used to carry: until the spool was replayed, `jobs/` was write-only
> and a second relay was merely idle. Replay is what made the directory shared state.
>
> So the relay now takes `<spoolDir>/relay.lock` before its first tick and a second one **refuses to
> start**, naming the pid that holds it. To watch what the running relay is doing, read its log
> (`journalctl -u hmis-print-relay -f`) or the spool itself; to run it by hand, stop the unit first:
>
> ```bash
> sudo systemctl stop hmis-print-relay
> ```
>
> A lock left behind by a power cut is **not** a reason to refuse: the relay checks whether the
> process named in it is still alive and clears it if not. A relay that would not start after a
> power cut would be a worse bug than the one the lock fixes.

There is a second, fuller set of checks that does not belong on the hospital PC:

```bash
node --test tools/print-relay/spool.test.mjs
```

It drives the spool logic against a loopback stub server and, where a usable chromium exists, prints
a spooled job end to end through a fake `lp` on `PATH` — including replaying the same job twice to
prove the second slip never comes out. `--self-test` is the on-box smoke check; this is the one that
holds the offline and print-once guarantees in place.

As a service:

```ini
[Unit]
Description=HMIS print relay
After=network-online.target cups.service

[Service]
ExecStart=/usr/bin/node /opt/hmis-print-relay/relay.mjs --config /etc/hmis-print-relay.json
Restart=always
RestartSec=5
User=hmis-print

[Install]
WantedBy=multi-user.target
```

## The self-test, and the bug it exists to catch

`--self-test` checks the queue mapping, the served-destination filter, the print-once dedupe, **and
the page geometry against a real browser.** That last one is the important one.

**Chromium's `--print-to-pdf` silently ignores `@page { size: 72mm auto }` and emits a US-Letter
page** — 215.9 × 279.4 mm, with a 72 mm slip stranded in one corner. `preferCSSPageSize: true` over
the DevTools protocol does not rescue it either; only an *explicit* height is honoured, and a
continuous roll has no height to declare.

So this relay drives Chromium over the DevTools protocol, **measures** the laid-out document when
the server says the height is continuous, and prints at exactly that size. The self-test renders a
real 72 mm document and reads the page box back out of the PDF. If someone simplifies this back to
the CLI flag, it fails with `got 216 mm — the CSS @page was ignored`.

It skips loudly — never silently — on a machine with no usable chromium, and the summary line says
so: a browserless run ends `self-test passed: queue mapping, served destinations, print-once dedupe
— page geometry SKIPPED (no usable chromium)`. It used to print `…, page geometry` on that run too,
which meant every browserless run claimed a check it had not made.

## Operating it

The spool is the whole status UI:

```
/var/lib/hmis-print-relay/
  jobs/       claimed, document on disk
  printed/    paper is out, the server has not been told yet
  failed/     gave up, waiting to report why
  relay.lock  the pid of the relay that owns this spool
```

A file sitting in `printed/` means the uplink is down, not that anything is wrong. A file in
`failed/` is worth reading: `cat failed/<id>.json` gives the reason the job did not print. A file in
`jobs/` with no marker beside it is **work that still owes paper**, and it prints on the next tick
whether or not the uplink is back.

**Nothing on this disk can stop the relay.** A marker or a spooled document that a power cut left
half-written is reported to the server as a failure — `failure marker unreadable (…)`, or `spooled
document unreadable: …` — and then deleted, so the job is requeued and the relay heals itself. That
matters more than it sounds: an unreadable file used to throw out of every tick before the claim,
which stopped the whole site printing, permanently and across restarts, while `systemctl status`
still reported the unit `active (running)`.

**And a disk that is FULL cannot make it print twice.** `printed/<id>.json` is the only thing that
stops a second slip, and it is written the moment `lp` accepts the job. If that write fails — a full
spool is the ordinary end of a relay left offline for a week, since `jobs/` holds whole rendered
documents and is swept only at seven days — the relay keeps the marker **in memory**, stops the pass
rather than printing more work it cannot record, and writes it out on the first tick the disk
accepts. Watch for `could not write printed/<id>.json` in the log; it means **free space on the spool
disk now**. Left unguarded this was the worst failure this relay had: the same patient's slip off the
front-desk thermal every three seconds until the roll ran out, while nothing else in the hospital
printed at all.

The one thing that memory cannot survive is a reboot, so a relay restarted onto a still-full spool
may reprint **one** slip, once. That is the same trade the marker itself makes by going down *after*
`lp` rather than before: a clerk handed two token slips throws one away, and a patient handed none
stands at a counter that believes it printed.

> **`jobs/` HOLDS PATIENT DATA. TREAT THE SPOOL DIRECTORY AS A CLINICAL RECORD.**
>
> Each file there is the whole rendered document — the patient's name, UHID, age and sex, the visit
> number and the doctor. It has to be: the relay carries the document with the claim so it can keep
> printing with the uplink down, and that is the offline guarantee the brief demands.
>
> So: `chmod 700` the spool directory, put it on the same disk you would put any patient record on,
> and do not copy it into a bug report. The relay deletes each file as soon as the server
> acknowledges the outcome, and sweeps anything older than seven days on every tick — that sweep
> exists for the one case the acknowledgement cannot cover, which is the relay being killed or the
> machine powered off between spooling a claim and reporting it.
>
> That killed-in-the-middle case is also the one the replay serves, so most of these files now leave
> by being **printed and reported** rather than by ageing out.

**A print failure never blocks the counter** (owner ruling R7). The screen tells the clerk and
offers a reprint; a patient can be sent to the doctor on a spoken token. A hospital that stops
taking money because a printer jammed is worse than one that prints late.
