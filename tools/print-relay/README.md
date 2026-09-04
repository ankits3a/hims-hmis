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
- a report that cannot be delivered is kept and retried — the paper is already out, and losing the
  record would be worse than delivering it late.

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

It skips loudly — never silently — on a machine with no usable chromium.

## Operating it

The spool is the whole status UI:

```
/var/lib/hmis-print-relay/
  jobs/     claimed, document on disk
  printed/  paper is out, the server has not been told yet
  failed/   gave up, waiting to report why
```

A file sitting in `printed/` means the uplink is down, not that anything is wrong. A file in
`failed/` is worth reading: `cat failed/<id>.json` gives the reason the job did not print.

**A print failure never blocks the counter** (owner ruling R7). The screen tells the clerk and
offers a reprint; a patient can be sent to the doctor on a spoken token. A hospital that stops
taking money because a printer jammed is worse than one that prints late.
