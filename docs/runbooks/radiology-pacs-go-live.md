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
| 1.1 | Production is at migration `0054` or later (`0053` the UID index, `0054` the view table + the `pacs_settings` kind) | `select count(*) from drizzle.__drizzle_migrations` |
| 1.2 | 18a's three human items are done | `pregnancy_policy` active; a `pcpndt_registrations` row; four role keys assigned |
| 1.3 | R2 ruled: which modalities have the DICOM worklist option licensed | the AMC / purchase order |
| 1.4 | R1 ruled: where Orthanc runs and its worklist directory path | the compose file on that host |
| 1.5 | R3 ruled: which viewer URL answers by accession number | open it once by hand with a known accession |

---

## 2. Devices: AE titles (T1, D2) — works with NO hardware decision

For every `device` resource that will read the worklist, set `attributes.aeTitle` to the modality's
configured AE title (the string the vendor engineer typed into the console — case and length exact,
≤ 16 characters). Registry screen → the device → attributes, keeping `modality` beside it:

```json
{ "modality": "ct", "aeTitle": "CT1" }
```

A device without an AE title is simply absent from the export. **A PCPNDT machine is offered
Form F studies only while it is on an active §19 registration** — enter the machine under the
registration BEFORE its AE title, or the worklist stays empty for it and the response's `withheld`
count says so.

Prove: `GET /radiology/mwl?date=<today>` as a user holding `radiology.mwl.read` returns
`{ rows: [...], withheld: 0 }` for a scheduled study on that device.

## 3. The bridge account (T1, S1)

1. Create a user `modality-bridge` (`seed:staff` or `/admin/users`), assign role `modality_bridge`
   at hospital scope, password in the ops vault.
2. Confirm it can do nothing else: `GET /radiology/worklist` as that user must answer **403**.

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

Install dcmtk (`apt install dcmtk`) beside Orthanc. Run every 15 s from the bridge account's token:

```sh
#!/bin/sh
# /opt/hmis-bridge/mwl.sh — pull today's worklist, write one .wl per study, remove the stale ones
set -eu
API=https://hmis.<hospital>/api; DIR=/var/lib/orthanc/worklists; TOKEN=$(cat /etc/hmis-bridge/token)
TMP=$(mktemp -d)
curl -fsS -H "Authorization: Bearer $TOKEN" "$API/radiology/mwl?format=dump" \
  | awk -v d="$TMP" 'BEGIN{n=0} /^# HMIS modality worklist item/{n++; f=sprintf("%s/%04d.dump",d,n)} n>0{print > f}'
for f in "$TMP"/*.dump; do [ -e "$f" ] || break; dump2dcm "$f" "$f.wl" >/dev/null; done
mkdir -p "$DIR"; rm -f "$DIR"/*.wl; mv "$TMP"/*.wl "$DIR"/ 2>/dev/null || true; rm -rf "$TMP"
```

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
