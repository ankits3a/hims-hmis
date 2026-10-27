---
issue: 1017
status: approved
approved: 2026-10-27
---
# SPEC — Lab bridge, first device: the Zybio Z3 haematology analyser (#1017)

## What

The server side of analyser interfacing exists since 17-E (#154): `POST /lab/instruments/:id/results` (grant
`lab.results.interface`, held by a `lab_bridge` service account), a per-instrument code map, the raw transmission
store (`lab_transmissions`), park-never-guess (`lab_parked_results`), and a repeated `transmissionRef` treated as a
retry. What is missing is the program on the lab's side that hears an analyser on the LAN and posts to that route.
First device: the Zybio Z3 (3-part CBC, no CRP). No third-party middleware.

## Decisions (owner, 2026-10-27)

- The lab's PCs run Windows and HMIS in Chrome. Every analyser is on the LAN switch, not cabled to a PC.
- The technician scans or types the tube's S-number as the Z3 sample ID.
- Send the patient list (worklist) to the Z3 if the Z3 supports a host query.
- Values only; no histograms.
- A UHID entered as the sample ID never attaches by itself: it parks, and the technician picks the tube.

## How

- `tools/lab-bridge`, shaped like `tools/print-relay`: Node, dependency-free, Windows zip, outbound to HMIS, a disk
  spool. Chrome cannot listen on the network, so the bridge runs on one always-on lab PC with a fixed address; one
  bridge serves every lab analyser.
- Step 1, capture: the Z3 operation manual has no LIS chapter, and the protocol document found online belongs to a
  different analyser (a chemistry analyser's HL7 v2.3.1 manual). The bridge first ships in capture mode: it listens
  for HL7 over MLLP (and answers ASTM's handshake), ACKs, saves every byte, and posts nothing. One test-sample run on
  the real Z3 gives its true message layout.
- Step 2: the Z3 parser is written from the captured message; the bridge spools, ACKs, then posts. The Z3 is
  registered as instrument `Z3` and its codes mapped on staging first. A simulator replays captured messages.
- Step 3: a device inbox screen in LIMS lists every message per device, matched or parked; a parked row is attached
  to a tube by a technician, never by the system.
- Step 4: worklist to the Z3, only if Zybio's protocol supports a host query.

## Done means

- D1 A Z3 message whose sample ID is a received tube's S-number attaches all mapped CBC values to that tube, entry mode `interface`, unverified.
- D2 A Z3 message with an unknown sample ID parks every row as `unknown_sample`; nothing attaches.
- D3 A Z3 code with no mapping parks as `unmapped_code`; the other rows of that message attach.
- D4 HMIS unreachable: the bridge ACKs the Z3, keeps the message on disk, and posts it once HMIS answers; HMIS records it once.
- D5 The same message sent twice attaches once (`duplicate: true` on the second).
- D6 A value outside the absurd envelope parks as `guard_refused`, never attaches.
- D7 A message whose sample ID is a UHID parks; the device inbox offers only that patient's open CBC tubes; attaching records the technician.

## Owner check

One real CBC on staging: the values appear on the bench screen within 10 seconds of the Z3 finishing.
