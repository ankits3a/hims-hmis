# Radiology DICOM seams go-live runbook — Plan 18b (T1–T4)

**Status: CODE-COMPLETE and NOT DEPLOYED.** Nothing here has been run against production. 18a's
own go-live items still stand and come first: a published `pregnancy_policy`, a real §19 PCPNDT
registration entered by a human, the four radiology role keys assigned. This runbook is what turns
the DICOM seams on once a modality and a PACS exist (§7 rulings R1–R3); until then §2–§4 are the
only steps that apply and the department runs exactly as 18a shipped it.

Read `docs/superpowers/plans/2026-09-02-phase1-18b-dicom-seams-no-hardware.md` §8 first — it says
what is proven by execution and what is not.

---

## 0. THE ONE THING THAT WILL BITE YOU IF YOU SKIP IT

**A machine account that holds a clinical role can satisfy a safety gate.** The bridge that pulls
the modality worklist must log in as a user whose ONLY role is `modality_bridge` (one string:
`radiology.mwl.read`). Logging it in as a radiographer "because that works" hands a cron job
`radiology.gates.satisfy` — a declaration about a patient's pregnancy. The kernel has no
service-account door (18b S1), so the safeguard is the role, and only the role.

---

## 1. Preconditions

| # | precondition | how to check |
|---|---|---|
| 1.1 | Migrations `0053` (the UID index) and `0054` (the view table + the `pacs_settings` kind) are applied | `select count(*) from drizzle.__drizzle_migrations` reads **55** or more (the journal is 0-based: 0054 is the 55th entry) |
| 1.2 | 18a's three human items are done | `pregnancy_policy` active; a `pcpndt_registrations` row; four role keys assigned |
| 1.3 | R2 ruled: which modalities have the DICOM worklist option licensed | the AMC / purchase order |
| 1.4 | R1 ruled: where Orthanc runs and its worklist directory path | the compose file on that host |
| 1.5 | R3 ruled: which viewer URL answers by accession number | open it once by hand with a known accession |

---

## 2. Devices: AE titles (T1, D2) — works with NO hardware decision

For every `device` resource that will read the worklist, set `attributes.aeTitle` to the modality's
configured AE title (the string the vendor engineer typed into the console — case exact, 1–16
printable ASCII characters, no backslash). The export ENFORCES that shape: a device whose title
fails it is absent from the worklist and named in the response's `malformedAeTitle` list, so an
empty console with `withheld: 0` and a non-empty `malformedAeTitle` is a typo, not a booking gap.
The attribute looks like this, `modality` kept beside it:

```json
{ "modality": "ct", "aeTitle": "CT1" }
```

> ## ⚠ THERE IS NO REGISTRY SCREEN, AND NOTHING WRITES `aeTitle` AT ALL
>
> This section said *"Registry screen → the device → attributes"*. Measured 2026-09-07: the kernel
> exposes `/resources/board`, `/resources/tree` and `/resources/:id/history` — all GET — and no
> create or update route. **`aeTitle` is read in exactly one place (`mwl.ts:203`) and written in
> none**: no seed, no route, no screen, anywhere in the workspace.
>
> **So `GET /radiology/mwl` returns an empty row set on every deployment, permanently.** `mwl.ts:204`
> skips any device whose `aeTitle` is missing, and none ever has one — which means **step 11's proof
> below can never pass**, and an operator following it will read the empty console as a booking
> problem. It is not one.
>
> 18b's own plan foresaw this and closed the spike the other way: *"if not, T1 adds
> `POST /radiology/devices/:id/ae-title`"*. That route was not built. **Until it is, the modality
> worklist is inert** — the export, its AE-title validation and its `malformedAeTitle` list are all
> correct and all unreachable. See `radiology-go-live.md` §5 for the same gap on the machine itself.

A device without an AE title is simply absent from the export. **A PCPNDT machine is offered
Form F studies only while it is on an active §19 registration** — enter the machine under the
registration BEFORE its AE title, or the worklist stays empty for it and the response's `withheld`
count says so.

Prove: `GET /radiology/mwl?date=<today>` as a user holding `radiology.mwl.read` returns
`{ rows: [...], withheld: 0, malformedAeTitle: [] }` for a scheduled study on that device.

**The Station AE title is the modality's own filter, not HMIS's.** One directory serves every
modality; each item carries `(0040,0001)` and a console configured to query the worklist by its
own AE title (the vendor default) sees only its items. A console configured to query by date and
modality alone sees every item of its modality, including a Form F study meant for the registered
machine next door — D2's withholding is per DEVICE and cannot reach inside a misconfigured
console. Check the console's worklist query settings at commissioning.

## 3. The bridge account (T1, S1)

1. Create a user `modality-bridge` (`seed:staff` or `/admin/users`), assign role `modality_bridge`
   at hospital scope, password in the ops vault.
2. Confirm it can do nothing else: `GET /radiology/worklist` as that user must answer **403**.
3. The bearer token is a SESSION token and expires (`sessionTtlMinutes`); the bridge logs in again
   when a pull answers 401 (`POST /auth/login` with `{ "username", "password" }` → `{ "token" }`),
   which is what §5's script does. Store the password in `/etc/hmis-bridge/password`, mode 0600.

## 4. The viewer book (T3, D5) — works with NO hardware decision, but points nowhere until R1/R3

Publish a `pacs_settings` definition through the governed routes (draft → approval → publish):

```json
{ "viewer_url_template": "https://pacs.<hospital>/ohif/viewer?AccessionNumber={accessionNo}", "enabled": true }
```

Rules the book enforces: `https://` only; placeholders are exactly `{accessionNo}` and
`{studyInstanceUid}`; anything else in braces is refused. Until the viewer exists publish with
`"enabled": false` — the door then answers `pacs_not_configured` and records nothing, which is the
honest state. Prove: on a `pacs` study, **Open images** on the study console opens the viewer in a
new tab and the console shows "Opened 1×".

## 5. The worklist bridge on the Orthanc host (T1, D1) — needs R1 + R2

Install dcmtk (`apt install dcmtk`) beside Orthanc. Run every 15 s as the bridge account. **The
script replaces the directory ONLY after a successful pull** (close review C7): an HMIS outage,
an expired session or a 5xx leaves yesterday's worklist in place rather than emptying every
console's worklist in silence every 15 s.

```sh
#!/bin/sh
# /opt/hmis-bridge/mwl.sh — pull today's worklist, write one .wl per study INSIDE the directory
# (never rename the directory: Orthanc's bind mount follows the inode — pass 2 C7), one run at a time.
set -eu
umask 077
API=https://hmis.<hospital>/api; DIR=/var/lib/orthanc/worklists
TOKEN_FILE=/etc/hmis-bridge/token; USER=modality-bridge; PASS_FILE=/etc/hmis-bridge/password
exec 9>/run/hmis-bridge.lock; flock -n 9 || exit 0          # a slow pull is not overlapped by the next
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
login() {
  curl -fsS -X POST -H 'Content-Type: application/json' -o "$TMP/login.json" \
    -d "{\"username\":\"$USER\",\"password\":\"$(cat $PASS_FILE)\"}" "$API/auth/login" || return 1
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$TMP/login.json" > "$TOKEN_FILE"; [ -s "$TOKEN_FILE" ]
}
[ -s "$TOKEN_FILE" ] || login
pull() { curl -fsS -H "Authorization: Bearer $(cat $TOKEN_FILE)" "$API/radiology/mwl?format=dump" > "$TMP/all.dump"; }
pull || { login; pull; }   # one login on an expired session; a wrong password fails here ONCE per run and never loops
awk -v d="$TMP" 'BEGIN{n=0} /^# Dicom-File-Format/{n++; f=sprintf("%s/%04d.dump",d,n)} n>0{print > f}' "$TMP/all.dump"
for f in "$TMP"/*.dump; do [ -e "$f" ] || break; dump2dcm "$f" "$f.wl" >/dev/null; done
mkdir -p "$DIR"
for w in "$TMP"/*.wl; do [ -e "$w" ] || break; cp "$w" "$DIR/.$(basename "$w").tmp" && mv "$DIR/.$(basename "$w").tmp" "$DIR/$(basename "$w")"; done
for old in "$DIR"/*.wl; do [ -e "$old" ] || break; [ -e "$TMP/$(basename "$old")" ] || rm -f "$old"; done
```

Each `.wl` lands by an atomic rename inside the mounted directory and stale names are removed
afterwards; the directory itself is never renamed. A wrong password fails the run once (no swap) —
watch the bridge's exit status, because five wrong attempts lock the account (`refuseIfThrottled`).

(An empty worklist from a SUCCESSFUL pull is real — no study is booked — and is written as empty.)

Orthanc: enable the worklist plugin with `"Worklists": { "Enable": true, "Database": "/var/lib/orthanc/worklists" }`.
Prove on the modality: query the worklist, see the scheduled patient by accession; acquire; the
console's UID field shows the same `2.25.…` the worklist carried (T2, D3). A modality WITHOUT the
worklist option still works: the technologist types the machine's own UID into the field.

## 6. What this does NOT turn on (18b-ii, after R1)

No images flow into HMIS. There is no reconciliation of DICOM studies against orders
(`study.unmatched`), no dose SR parsing, no Orthanc authorization bridge, no embedded viewer, no
tiering or offsite copy, no model-backed drafter (R4). The offline drafter fills only `technique`;
a radiologist who sees a machine-written finding has found a defect, not a feature.

## 7. Rollback

Everything here is additive. Remove the bridge cron and set `"enabled": false` on `pacs_settings`
to turn the seams off; the department continues on 18a's paths. Migrations `0053`/`0054` stay.
