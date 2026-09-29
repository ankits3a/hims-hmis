# Radiology PACS go-live runbook — Orthanc + OHIF (Plan 18b seams, 18-S RS12)

**Status: CODE-COMPLETE and NOT DEPLOYED. Nothing here has been run against production.** Ruling 6
(plan 18-S, 28 Sep 2026) decides the PACS: an **on-premise Orthanc archive with the OHIF viewer**,
two 3 MP diagnostic monitors per reading station (two 5 MP for mammography), MWL/MPPS licences bought
per modality, **5 years online then archive, MLC cases and minors retained longer**. Installing it is
an **owner-authorised infrastructure step**: procurement, the server, the network and the install are
the owner's infra person's acts, and this runbook is written for that person.

Until it is done the department runs exactly as today: films and CDs, typed doses, `no_pacs_images`
at Send, and the standup census row **`radiology_pacs_configured` reads RED ("PACS not configured")**.
That red is true, not a defect.

Read first: plan 18-S "RS12 (code) as built" (what is proven by tests and what is not) and 18b's
`docs/superpowers/plans/2026-09-02-phase1-18b-dicom-seams-no-hardware.md` §8.

---

## 0. THE ONE THING THAT WILL BITE YOU IF YOU SKIP IT

**A machine account that holds a clinical role can satisfy a safety gate.** The bridge on the
archive host logs in as a user whose ONLY role is `modality_bridge`, which holds exactly two machine
strings: `radiology.mwl.read` (pull the worklist) and `radiology.pacs.interface` (post arrivals and
dose reports). Logging the bridge in as a radiographer "because that works" hands a cron job
`radiology.gates.satisfy` — a declaration about a patient's pregnancy. The kernel has no
service-account door (18b S1); the role is the safeguard.

**And the second one:** nothing in HMIS ever attaches images to a patient by NAME. An archive study is
matched by its accession number (or the worklist's Study Instance UID) **and** the DICOM PatientID
being that study's patient's UHID. Everything else lands in **Rooms → Unmatched images** for a human.
Do not "help" by editing PatientIDs in Orthanc to make things match; attach them in the inbox, where
the reason and the person are recorded.

---

## 1. Preconditions

| # | precondition | how to check |
|---|---|---|
| 1.1 | Migrations through `0148_radiology_pacs_inbox` (RS12) are applied — 18b's `0053`/`0054` and RS12's `0148` | `select count(*) from drizzle.__drizzle_migrations` ≥ the journal's entry count |
| 1.2 | 18a's human items: a published `pregnancy_policy`, a real §19 PCPNDT registration, the radiology role keys assigned | `radiology-go-live.md` |
| 1.3 | Every machine that will send images is registered at **Radiology → Setup → Machines** with its AE title (RS4) | Setup → Machines: no machine that sends DICOM reads "No AE title" |
| 1.4 | The owner has authorised the archive server, its disks and the install (ruling 6) | a written go-ahead |
| 1.5 | Which modalities have the DICOM worklist (MWL) and Radiation Dose SR (RDSR) options licensed | the AMC / purchase order per machine |

---

## 2. Devices: AE titles (18b T1, 18-S RS4) — works with NO hardware

Set each machine's AE title at **Radiology → Setup → Machines** (`PATCH /radiology/setup/devices/:id`,
grant `radiology.devices.manage`) to the AE title the vendor engineer typed into that console: `A–Z`,
`0–9`, `_`, at most 16, unique. The same title goes into Orthanc's `DicomModalities` (§5.3), so one
string names the machine in three places — the console, the archive and HMIS. The worklist export
enforces the shape and names any malformed title in `malformedAeTitle`; it still tolerates the wider
PS3.5 repertoire for a value set before Setup existed (`radiology-go-live.md` §5).

**A PCPNDT machine is offered Form F studies only while it is on an active §19 registration** — enter
the machine under the registration BEFORE its AE title, or its worklist stays empty and `withheld`
says so. **The Station AE title is the console's own filter**: configure every console to query the
worklist by its own AE title (the vendor default); a console querying by date and modality alone sees
every item of its modality, including a Form F study meant for the registered machine next door.

Prove: `GET /api/radiology/mwl?date=<today>` as a holder of `radiology.mwl.read` returns
`{ rows: [...], withheld: 0, malformedAeTitle: [] }` for a scheduled study on that machine.

## 3. The bridge account

1. Create a user `modality-bridge` (`/admin/users`), assign role `modality_bridge` at hospital scope,
   password in the ops vault.
2. Confirm it can do nothing else: `GET /api/radiology/worklist` as that user must answer **403**.
3. The bearer token is a session token and expires; every bridge script logs in again on a 401
   (`POST /api/auth/login` → `{ "token" }`). Password in `/etc/hmis-bridge/password`, mode 0600,
   owned by the bridge's own unix user (never root).

## 4. The PACS book (`pacs_settings`) — publish only after §5 works

Radiology → Setup → Books → `pacs_settings`, drafted by the radiologist (HOD), approved by the
medical superintendent, then published (the governed route; drafter ≠ approver):

```json
{
  "viewer": "ohif",
  "viewer_url_template": "https://pacs.<hospital-lan-name>/ohif/viewer?StudyInstanceUIDs={studyInstanceUid}",
  "enabled": true,
  "archive": { "kind": "orthanc", "ae_title": "HMIS_PACS", "base_url": "https://pacs.<hospital-lan-name>/orthanc" }
}
```

The book refuses `http://`, any placeholder other than `{accessionNo}` / `{studyInstanceUid}`, an OHIF
viewer whose template lacks `StudyInstanceUIDs={studyInstanceUid}` (an OHIF link by accession opens an
empty list, which a reader takes for "no images"), and an AE title outside `A–Z 0–9 _`. `archive` is
what the census reads: once published, `radiology_pacs_configured` turns green. HMIS never calls
`base_url`; it is the address the runbook and the reconciler use. A book published before RS12
(no `viewer`, no `archive`) still parses and still opens images; only the census stays red.

**Viewer, DECIDED (RS12):** the study console (and RS8's reading room, through the same door) opens
OHIF **in a new tab** at the URL the server built — `POST /radiology/studies/:id/images/open` records
the view, the event and the PHI line first. No iframe embed until the hospital network and the
reading-room monitors are in place: an embed across an unreviewed network is a PHI surface.

## 5. Install Orthanc + OHIF (the owner's infra person)

**Not on the HMIS application server.** A separate server on the hospital LAN (ruling 6: on-premise).
Nothing below touches any running HMIS stack.

### 5.1 Sizing (ruling 6: 5 years online)

| modality | typical study | per day (mid-size hospital) |
|---|---|---|
| CT | 150–600 MB (thin slices) | 40 studies ≈ 16 GB |
| MRI | 50–300 MB | 15 ≈ 3 GB |
| DR / CR | 10–30 MB | 150 ≈ 3 GB |
| Mammography | 50–120 MB | 10 ≈ 1 GB |
| USG | 5–50 MB | 80 ≈ 2 GB |

≈ 25 GB/day ≈ **45 TB for 5 years** before compression; Orthanc's lossless storage compression roughly
halves it. Recommended: 2 × 3.84 TB NVMe (RAID 1) for the index and the last 90 days, an 8-bay
nearline array (RAID 6) for the 5-year tier, and the offsite copy (§7). Measure the first month's real
growth and correct this table.

### 5.2 Services and ports

| service | port | exposed to |
|---|---|---|
| Orthanc DICOM (C-STORE, C-FIND, C-MOVE, worklist) | **4242/tcp** | the modality VLAN only |
| Orthanc REST + DICOMweb | 8042/tcp | **localhost only** — behind the reverse proxy |
| Reverse proxy (TLS) serving `/orthanc` and `/ohif` | 443/tcp | the hospital LAN (reading rooms, HMIS clients) |
| PostgreSQL (Orthanc's index) | 5432/tcp | localhost only |

Orthanc's own AE title: **`HMIS_PACS`** (the same string goes in the book's `archive.ae_title`).

### 5.3 Orthanc configuration (`orthanc.json`, the parts that matter)

```json
{
  "Name": "HMIS_PACS",
  "DicomAet": "HMIS_PACS",
  "DicomPort": 4242,
  "DicomCheckCalledAet": true,
  "DicomAlwaysAllowStore": false,
  "DicomCheckModalityHost": true,
  "DicomModalities": {
    "CT_1": { "AET": "CT_1", "Host": "10.10.20.11", "Port": 104 },
    "DX_1": { "AET": "DX_1", "Host": "10.10.20.12", "Port": 104 },
    "MG_1": { "AET": "MG_1", "Host": "10.10.20.13", "Port": 104 }
  },
  "RemoteAccessAllowed": true,
  "AuthenticationEnabled": true,
  "RegisteredUsers": { "hmis-bridge": "<vault>", "ohif": "<vault>" },
  "StorageCompression": true,
  "StableAge": 60,
  "MaximumStorageSize": 0,
  "MaximumPatientCount": 0,
  "PostgreSQL": { "EnableIndex": true, "EnableStorage": false, "Host": "127.0.0.1", "Database": "orthanc" },
  "Worklists": { "Enable": true, "Database": "/var/lib/orthanc/worklists" },
  "DicomWeb": { "Enable": true, "Root": "/dicom-web/" }
}
```

- `DicomModalities`: one entry per machine, **`AET` = the AE title in HMIS Setup**, `Host` = the
  console's fixed IP. `DicomAlwaysAllowStore: false` + `DicomCheckModalityHost: true` — only the
  registered machines may send.
- `StableAge: 60` — a study is "stable" (and forwarded to HMIS) 60 s after its last image; a late
  series re-sends the notice and HMIS refreshes the counts.
- `MaximumStorageSize` / `MaximumPatientCount` **0** — Orthanc must never recycle the oldest patient
  on its own (§7).
- Plugins: PostgreSQL index, DICOMweb, worklists (Debian/Ubuntu packages `orthanc`,
  `orthanc-postgresql`, `orthanc-dicomweb`; or the official `orthancteam/orthanc` image — on the
  ARCHIVE host).

### 5.4 OHIF

Serve OHIF v3's static build at `/ohif/` from the reverse proxy, with a DICOMweb data source pointing
at `/orthanc/dicom-web` (`qidoRoot`, `wadoRoot`, `wadoUriRoot`). A study opens at
`/ohif/viewer?StudyInstanceUIDs=<uid>` — exactly what the book's template produces. Put OHIF and
`/orthanc` behind the proxy's authentication, hospital LAN only; never on the public internet.

### 5.5 The modalities (the vendor engineer, per machine)

1. Storage destination: AE `HMIS_PACS`, host = the archive server, port 4242.
2. Worklist (MWL): AE `HMIS_PACS`, port 4242, **query by the console's own AE title**.
3. **Radiation Dose SR (RDSR): enable "send dose report to PACS"** on every CT, DR/fluoroscopy and
   mammography unit that has the option. This is where HMIS reads the dose from (§6.3).
4. MPPS: **not consumed by HMIS** (DECIDED, RS12 — Orthanc has no MPPS receiver, and the dose MPPS
   would carry is read from the RDSR instead). Leave it unset, or pointed at the vendor's own box.

## 6. The bridge on the archive host — three jobs, one unix user

All three run as an unprivileged unix user `hmis-bridge` (systemd timers), log in to HMIS as the
`modality-bridge` user, and never advance their own state past a failed HMIS call.

### 6.1 The worklist (18b T1) — unchanged

```sh
#!/bin/sh
# /opt/hmis-bridge/mwl.sh — every 15 s: today's worklist, one .wl per study, atomic renames INSIDE the directory.
set -eu
umask 077
API=https://hmis.<hospital>/api; DIR=/var/lib/orthanc/worklists
TOKEN_FILE=/etc/hmis-bridge/token; USER=modality-bridge; PASS_FILE=/etc/hmis-bridge/password
exec 9>/run/hmis-bridge/mwl.lock; flock -n 9 || exit 0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
login() {
  curl -fsS -X POST -H 'Content-Type: application/json' -o "$TMP/login.json" \
    -d "{\"username\":\"$USER\",\"password\":\"$(cat $PASS_FILE)\"}" "$API/auth/login" || return 1
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$TMP/login.json" > "$TOKEN_FILE"; [ -s "$TOKEN_FILE" ]
}
[ -s "$TOKEN_FILE" ] || login
pull() { curl -fsS -H "Authorization: Bearer $(cat $TOKEN_FILE)" "$API/radiology/mwl?format=dump" > "$TMP/all.dump"; }
pull || { login; pull; }
awk -v d="$TMP" 'BEGIN{n=0} /^# Dicom-File-Format/{n++; f=sprintf("%s/%04d.dump",d,n)} n>0{print > f}' "$TMP/all.dump"
for f in "$TMP"/*.dump; do [ -e "$f" ] || break; dump2dcm "$f" "$f.wl" >/dev/null; done
mkdir -p "$DIR"
for w in "$TMP"/*.wl; do [ -e "$w" ] || break; cp "$w" "$DIR/.$(basename "$w").tmp" && mv "$DIR/.$(basename "$w").tmp" "$DIR/$(basename "$w")"; done
for old in "$DIR"/*.wl; do [ -e "$old" ] || break; [ -e "$TMP/$(basename "$old")" ] || rm -f "$old"; done
```

Never rename the worklist directory (Orthanc's bind mount follows the inode). A wrong password fails
the run once; five wrong attempts lock the account — watch the exit status. An empty worklist from a
SUCCESSFUL pull is real (nothing booked) and is written as empty.

### 6.2 Images arrived → HMIS (RS12 T1)

Every 10 s: read Orthanc's `/changes` feed from the last acknowledged sequence; for each
`StableStudy`, fetch the study and its statistics and post both, **as Orthanc returned them**, to
`POST /api/radiology/pacs/arrivals` (body `{ "study": <GET /studies/{id}>, "statistics": <GET
/studies/{id}/statistics> }`). Advance the stored sequence **only after HMIS answered 200**; HMIS is
idempotent on the Study Instance UID, so a re-post after a crash is harmless.

```sh
#!/bin/sh
# /opt/hmis-bridge/arrivals.sh — Orthanc /changes → HMIS. Needs curl + jq on the ARCHIVE host.
set -eu
umask 077
API=https://hmis.<hospital>/api; ORTHANC=http://127.0.0.1:8042; OAUTH="hmis-bridge:$(cat /etc/hmis-bridge/orthanc)"
SEQ_FILE=/var/lib/hmis-bridge/changes.seq; TOKEN_FILE=/etc/hmis-bridge/token
exec 9>/run/hmis-bridge/arrivals.lock; flock -n 9 || exit 0
. /opt/hmis-bridge/login.sh          # defines login(), exactly as in mwl.sh
since=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
changes=$(curl -fsS -u "$OAUTH" "$ORTHANC/changes?since=$since&limit=100")
post() { curl -fsS -o /dev/null -X POST -H "Authorization: Bearer $(cat $TOKEN_FILE)" -H 'Content-Type: application/json' --data-binary @- "$API$1"; }
for id in $(echo "$changes" | jq -r '.Changes[] | select(.ChangeType=="StableStudy") | .ID'); do
  body=$(jq -n --argjson s "$(curl -fsS -u "$OAUTH" "$ORTHANC/studies/$id")" \
               --argjson t "$(curl -fsS -u "$OAUTH" "$ORTHANC/studies/$id/statistics")" '{study:$s, statistics:$t}')
  echo "$body" | post /radiology/pacs/arrivals || { login; echo "$body" | post /radiology/pacs/arrivals; }
  # 6.3 — the study's Radiation Dose SRs
  for inst in $(curl -fsS -u "$OAUTH" "$ORTHANC/studies/$id/instances" | jq -r '.[].ID'); do
    tags=$(curl -fsS -u "$OAUTH" "$ORTHANC/instances/$inst/tags?simplify")
    [ "$(echo "$tags" | jq -r .SOPClassUID)" = "1.2.840.10008.5.1.4.1.1.88.67" ] || continue
    sr=$(jq -n --argjson t "$tags" '{tags:$t}')
    echo "$sr" | post /radiology/pacs/dose-reports || { login; echo "$sr" | post /radiology/pacs/dose-reports; }
  done
done
echo "$changes" | jq -r .Last > "$SEQ_FILE.tmp" && mv "$SEQ_FILE.tmp" "$SEQ_FILE"
```

(`set -e` stops the run at the first HMIS failure, so the sequence never moves past a study HMIS did
not acknowledge. Walking every instance is fine at hospital volumes; list the study's series first and
keep only `Modality == SR` if a site's CTs send thousands of images per study.)

What HMIS does with an arrival: accession (then UID) **and** UHID agree → the study gets
`image_source = pacs`, the archive's UID, series/image counts and the arrival time (the study console
shows "In the archive: 3 series, 212 images, since 10:42"). Images that arrive **before** the room
presses Send wait and attach themselves at Send. Everything else → the inbox (§8).

### 6.3 Dose reports → HMIS (RS12 T2)

The script above posts every **X-Ray Radiation Dose SR** (SOP class `1.2.840.10008.5.1.4.1.1.88.67`)
to `POST /api/radiology/pacs/dose-reports` as `{ "tags": <GET /instances/{id}/tags?simplify> }`.
HMIS reads, in DCM codes: CT (TID 10011) — 113813 DLP total, 113830 Mean CTDIvol (the highest
acquisition's); projection X-ray / fluoroscopy / mammography (TID 10001) — 113722 DAP total (Gy·m²
converted to Gy·cm², ×10,000), 113730 total fluoro time, 111637 accumulated AGD (the higher breast).
Units are read from each item; an unknown unit drops that number rather than guessing.

- A dose report that arrives **before Send**: the console shows "From the machine's dose report …"
  and Send records those numbers when nothing is typed (`dose_origin = dose_sr`), through the same
  register write, so the DRL comparison runs.
- A dose report that arrives **after** a typed number: the typed number stays; agreement (within 2 %
  or 0.05) is recorded as `confirmed`, disagreement as a `conflict` listed in the inbox for the RSO.
- Idempotent on the SR's SOP Instance UID.

## 7. Storage, retention and backup (ruling 6)

- **Online 5 years**, then the archive tier. **MLC studies and minors are retained longer**
  (DECIDED, standard practice: an MLC study until the case is closed and the court releases it —
  never on a timer; a minor's studies until age 21 when that is later than 5 years). **Nothing is
  deleted automatically** — HMIS has no deletion job, and Orthanc's `MaximumStorageSize` /
  `MaximumPatientCount` stay 0.
- PCPNDT obstetric ultrasound: 2 years statutory minimum; the 5-year rule covers it.
- **Backup:** nightly `pg_dump` of the Orthanc index + an incremental copy of the storage directory to
  an offsite target **in India** (DPDP). Weekly: restore one random study from the offsite copy onto a
  scratch Orthanc and open it in OHIF — a backup nobody restored is not a backup.
- The archive server's disks are encrypted at rest; the proxy is TLS only.

## 8. The daily act: Rooms → Unmatched images (RS12 T3)

Who: the technologist on shift, or the radiologist — both hold `radiology.pacs.reconcile`. Every open
archive study no accession + UHID could claim is listed with why (patient ID does not match the order,
no order has this accession, a second study for one order, the order was cancelled, no identifiers,
waiting for Send). Open one: the images' name / patient ID / accession sit beside the order's.

- **Attach** — type the accession of the study these images belong to and **why**. The attach records
  the person, the time and the reason, rewrites nothing in Orthanc, and moves the study's UID to the
  archive's. Refused: a study not yet sent (press Send first — the images then attach themselves), an
  outside film, a study that already holds another archive study.
- **Reject** — a QA phantom, a test, a duplicate send; with a reason. Nothing is deleted.
- **DECIDED (RS12): one person with a reason, audited** (event `imaging.images_reconciled` + the PHI
  log), not a second signature — the standard PACS-administrator practice.

## 9. Prove it (acceptance, on the day)

1. `standup:check radiology` — `radiology_pacs_configured` **ok** after §4.
2. Book a CT on CT-1; the console's worklist shows the patient by accession.
3. Scan; the console sends to `HMIS_PACS`; within ~70 s the study console shows "In the archive: …".
4. **Open images** opens OHIF in a new tab on that study; "Opened 1×" appears.
5. With RDSR enabled: after the scan the room console shows the machine's dose; Send with nothing
   typed; the dose log shows the row with the DRL verdict.
6. Send a phantom with PatientID `QA` → it appears in Unmatched images → reject it with a reason.
7. Send a study with a deliberately wrong PatientID → "Patient ID does not match the order" → attach
   it with a reason → the study shows the images.

## 10. Rollback

Everything is additive. Stop the bridge timers and set `"enabled": false` on `pacs_settings`; the
department returns to films and typed doses. The RS12 migration stays (two tables, six columns).

## 11. Not built (see the plan: "RS12 — NEXT")

The IR suite (sign-in / time-out / skin-dose alert / sign-out), night teleradiology (an external
reporter identity, prelim, morning over-read), an embedded viewer, automatic tiering, MPPS, DICOM
print and CD burning, and a model-backed drafter.
