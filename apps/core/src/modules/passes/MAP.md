---
type: module-notes
title: "passes — module notes"
description: "Why and traps of the attendant and visitor passes module (E1.3): entitlement by bed class, visiting hours, the scan's one answer, lost-pass reissue, police custody, the doctor's visitor ban, and expiry of every pass when the stay ends."
resource: apps/core/src/modules/passes
tags: [passes, ipd, security, attendants]
generated: { by: agent:claude, at: 2026-10-13 }
verified: []
stale_after: 2027-01-13
---
# passes — module notes

Hand-written notes: the WHY and the traps. Signatures are generated in `docs/architecture/modules/passes.md`.
Paths are relative to `apps/core/src/modules/passes/` unless they start with `kernel/`, `packages/` or `apps/`.
Spec: SPEC-ipd-companions-2026-10-12 §8 (kept outside the repository); issue #720; decision 0072.

## 1. Purpose
Attendant and visitor passes per admission. The desk issues what the bed class allows; security scans the QR at a
ward door and gets ONE answer; a lost pass is reissued (the old one revoked in the same transaction); every pass of
an admission expires the moment the stay ends (discharge, refer-out, LAMA, absconding, death).

## 2. Key files
- `packages/contracts/src/passes.ts` — kinds, states, scan results, the intents' zod inputs (`PASS_INTENTS`), the
  refusals with rule and fix (`PASS_REFUSALS`), read models, `PASS_ROUTES`, visiting hours (16:00–19:00 IST).
- `policy.ts` — pure rules: `entitlementFor`, `inVisitingHours`, `scanResult` (order: revoked, expired, paused,
  wrong ward, outside hours, valid).
- `passes.ts` — the intents (`issuePasses`, `issueVisitorPass`, `reissuePass`, `pausePasses`, `resumePasses`,
  `setPoliceCustody`) and the consumer's acts (`expireAdmissionPasses`, `movePassesToCurrentWard`).
- `read.ts` — `viewAdmissionPasses` (desk), `scanPass`, `listPassWards`.
- `consumer.ts` — `passes.admission`; `manifest.ts` — four permissions and the five subscriptions.
- `kernel/db/schema/passes.ts` — `passes`, `pass_events` and `pass_scans` (append-only by trigger),
  `pass_admission_flags` (custody, visitor ban). Migration `passes` (0207 in the lane; renumbered at merge).
- `modules/ipd/admission-place.ts` — `admissionPlace` (state, open stay, bed, ward) and the event names; passes reads
  IPD only through it.
- Web: `apps/web/src/screens/ipd-passes.tsx` (`/ipd/passes?admission=`), `apps/web/src/screens/passes-scan.tsx` (`/passes/scan`).

## 3. Invariants
- The QR is the opaque `token` (24 random bytes, base64url) and nothing else. Events carry ids, never the token or
  the holder.
- Entitlement (DECIDED): general, semi-private, LDR, overflow, day care, emergency 1; private, deluxe, suite 2; HDU,
  ICU, NICU, PICU 0 at the bedside + 1 lounge; a child (<14 or NICU/PICU bed) gets `parent_stay`; police custody: 2
  `police_guard` only. Visitor and NICU-mother passes do not count against it. A reissue does not either (the old one
  is revoked in the same transaction).
- Every write takes the advisory lock `passes:<admissionId>` first; the expiry takes the same lock.
- A sealed or VIP patient prints as the ALIAS on every card, whoever reads it: the card is rendered for a viewer with
  no confidential permission (`PASS_CARD_VIEWER`). The scan answer never names the patient.
- The scan reads the admission's end LIVE, so a discharge scans "expired" even before the consumer runs.
- Visitor passes are valid to the end of their IST day; outside 16:00–19:00 that day they scan "outside hours".

## 4. Traps
- The stay-ending events (`ipd.admission.discharged|lama|absconded|deceased`) and `ipd.transfer.accepted` are the
  CONTRACT's names; ipd-discharge and ipd-transfer do not emit them yet. The consumer only reads `admissionId` and
  re-reads IPD live, so their payload shapes do not matter. A refer-out arrives as `discharged` with the admission in
  `transferred_out`.
- The consumer is in `workerConsumers` and `seedCursors` seeds it at `max(seq)` on deploy; the dispatcher's 5,000-seq
  look-back still re-reads recent history once — harmless, both acts are idempotent.
- Police custody lives HERE (`pass_admission_flags`), not on the admission (MLC is not custody). Move it when IPD
  gains a custody field.
- No camera reader on the scan screen: handheld scanners type the token and Enter.

## 5. Callers
`passes.controller.ts` (web), the worker's dispatcher (`passes.admission`). Nothing imports this module yet.
