# HANDOFF — doctor desk, ABDM, WASA, formulary (2026-09-24 → 2026-09-29)

This handoff is written for the next session, local or cloud, so it can continue without the chat
history. Everything a GitHub-only session needs is in this repository. Material that lives only on
the build host (`/opt/hmis-context/…`, screenshots, WHO data) is named, but a cloud session cannot
read it. The owner's rulings are quoted, not paraphrased.

## 0. State at hand-off (2026-09-29)

- **Production** runs `6b169640`, with 145 migrations applied.
- **main** is at `3276ff7a`. It adds #383 and #384 and migration `0145_consult_rx_draft`.
- **Main is NOT DEPLOYED.** The next action is the owner's deploy (§4). After it, production should
  show 146 migrations.
- **Open PRs from this work:** none.

## 1. What shipped (all merged; everything except #383/#384 is deployed)

| PR | What | Migration |
|---|---|---|
| #308 | Referral fee: a referred visit within 7 days is free (owner ruling 2026-09-24) | 0122 |
| #312–#318 | Consult engine, first specialty ophthalmology: eye sections, laterality, eye-drop line, glasses A4 print (Doctor ID only), layout builder | 0126–0128 |
| #321, #335 | ICD-11 beside ICD-10. `icd11:load --from-who` downloads WHO 2026-01 with a pinned sha256; no WHO data in the repo. **LOADED in production 2026-09-28: 12,597 rows** | 0130 |
| #323, #333 | ABDM connector S0–S3 (M1 ABHA, M2 HIP, M3 HIU). **Off until credentials exist** (every route answers 503). Fidelius via `@noble/curves` | 0132, 0136 |
| #340 | MSG91 SMS adapter (off until `MSG91_AUTH_KEY` is set); the ABDM linking OTP sent by SMS; `ABDM_ABHA_CREATE_AADHAAR` defaults to true | — |
| #324, #326, #338, #339 | WASA fixes, waves 1–3b: edge-log redaction, auth audit, TOTP replay, dependency upgrades, report-only CSP, CSV injection, strict registration, append-only audit tables, print-relay and heartbeat binding, nested patient routes, `camera=(self)` | 0133, 0134, 0139 |
| #337 | 15 s test budget for `opd-consult.test.tsx` | — |
| #342, #343 | `/my-day` fits a 390 px phone (the copilot ask box shrinks) | — |
| #376 | **Paediatrics** profile: Child tab, WHO under-5 z-scores, IAP 2023 immunisation, birth, milestones, feeding, informant. No dosing | — |
| #383 | Front desk: an unpaid visit can be billed after the desk is cleared; REFERRAL badge at desk and billing; age or DOB required at registration; `/photo` returns 204 | — |
| #384 | Consult: Rx lines survive a reload (`rx_draft`); the issued Rx shows on reopen; every diagnosis coded on the print; **e-Rx prints Doctor ID only**; "My layout" in the header; allergy list and dialog fixes | 0145 |

**Production formulary data (the owner applied these 2026-09-28, each a dry run first, `--as admin`).**
Before that date, production's prescribing checks ran on 26 mapped substances.
- Substances: `owner-resolution-2026-09-16-substances`. 3,125 mapped, 158 unmappable, 0 pending.
- Allergy classes: 100 moieties. Therapeutic classes: 55 new plus 6 already present.
- Drug–disease: 148 rows. Interactions: 400 rows.

## 2. Owner rulings in force (verbatim where quoted)

- **Hospital paper prints the Doctor ID only.** "Prescription print: Doctor ID only." (2026-09-28,
  re-confirming 2026-09-06.) The one exception is the lab report's signing pathologist (full name
  and council number). No signature line on the e-Rx: K50, the signed QR is the authentication.
- **ICD-11 for ICD-10-CM subcodes:** "leave as it is". Exact match only, no parent fallback.
- **2026-09-26:** "password length = 10, ABHA creation with Aadhaar, hosting anywhere, MSG91 SMS
  Sender (token will be provided later), the WASA auditor will be provided later but for now let it
  be a synthetic auditor, yes for emergency self-elevation, yes for PIN login from the internet,
  two-factor login later not now, yes the preview on port 8443, load ICD-11 data from internet."
- **2026-09-27:** ports 8443 and 8444 are CLOSED (preview and AERB demo containers stopped, ufw
  rules deleted). `camera=(self)` is allowed.
- **Working rule, 2026-09-27:** "Stop running the full suite locally. CI already runs it … Run only
  the suites you touched locally." CI is the gate. Deploy a CI-green main SHA.
- **Specialty order:** ophthalmology, then paediatrics, then gynaecology. Specialty screens are chosen
  by the visit's department.

## 3. What is left, in priority order

1. **Deploy main `3276ff7a`** (§4), then verify on production:
   - migrations = 146;
   - the api/caddy image digest equals `hmis-prod/{server,web}:<sha>`;
   - `/api/health` is ok;
   - a Chromium walk as a General Medicine doctor: the e-Rx shows "Doctor ID …" with no name or
     reg. no., both diagnosis codes print, and "My layout" is in the header.
2. **Gynaecology/obstetrics profile.** The third specialty, designed in
   `docs/superpowers/brainstorms/2026-09-18-doctor-desk/01-CONSULT-ENGINE.md` §6.3. Build it the way
   #376 built paediatrics: sections in `opd_section_records`, `PROFILES`, a tab, and a stub-API
   Chromium walk. There is no board, so follow `docs/design/2026-09-23-consult-engine/Ophthal.dc.html`.
3. **Curator and drug-dose sign-off** (board `docs/design/2026-09-23-consult-engine/Curator.dc.html`).
   - A doctor's own entries stay private until a curator promotes them; the curators are the head
     of department, the medical records officer and the admin.
   - Paediatric dose rules enter only through P&T committee sign-off.
4. **Print and share** (board `PrintShare.dc.html`): an English/Hindi toggle, complaints,
   examination and follow-up on the Rx, and WhatsApp/SMS share once MSG91 is live. **The board
   draws name and Reg. No.; the owner's ruling overrides it: Doctor ID only.**
5. **Teleconsult:** Telemedicine Practice Guidelines 2020, Lists O/A/B; Schedule X and NDPS prohibited.
6. **Consult-walk leftovers, not fixed:**
   - The board vs the screen: complaints are offered rather than pre-filled; the left rail doesn't
     collapse; there is no "Complete & print"; ophthal slit-lamp preset chips and a per-eye Rx line
     are missing; the layout builder has no Collapsed / On-print / Copilot columns.
   - The duplicate-suspect check matched two different people by a shared surname token.
   - `/opd/admin` overflows at 390 px, and so does Desk One (its left column never collapses).
7. **Paediatrics follow-ups:**
   - IAP 2015 LMS values (request them from the IAP Growth Chart Committee) for 5–18 z-scores.
   - Decide IAP 2025 vs 2023.
   - Check the UIP notes.
   - Vaccination-card print.
   - Weight-based dosing waits on **the owner's licence ruling (IAP Drug Formulary / BNFc are paid)**.
8. **ABDM go-live blockers (owner):**
   - HFR facility id, HPR ids, sandbox client id and secret, the callback URL.
   - `*.abdm.gov.in` answers 403 from this Helsinki host, which looks like geo-blocking. It needs
     Indian egress or hosting.
   - Book the NHA functional test.
   - Still owed in code: 5 more FHIR record types, the erasure worker job, a push body limit over
     1 MB, and the HPR id as requester.
   - Plan: `docs/superpowers/plans/2026-09-25-abdm-connector.md`.
9. **MSG91 go-live (owner):**
   - The auth key, the DLT sender id, and DLT template ids for the pharmacy messages and
     `ABDM_LINK_OTP_DLT_TEMPLATE_ID`.
   - MSG91 templates using `##VAR1##…`, listed in `MSG91_TEMPLATE_IDS`.
   - `NOTIFY_PROVIDER=live` and `NOTIFY_SMS_PROVIDER=msg91` for both the api and the worker.
   - Follow-up in code: move `MSG91_TEMPLATE_IDS` to a column.
10. **WASA:**
    - Operator steps from `docs/runbooks/wasa-database-roles.md`: create `hmis_app`, set
      `API_DATABASE_URL`, check the print grants.
    - Rotate the agent keys, and purge `caddy_data:/data/logs/access.log*`.
    - Open findings: M-03, M-06, M-11, M-12, L-04, L-10, L-11. The owner has deferred 2FA login.
    - Enforce the CSP after a report-only period.
    - The certificate comes only from a CERT-In-empanelled auditor, which is the owner's
      procurement. **Never claim "certified".**
11. **Standup gate:** add production-DATA checks ("substances pending = 0", "allergy classes > 0").
    The formulary sat unadopted for 12 days because the gate only checks that tables exist.

## 4. How to deploy (the owner runs it; the agent classifier blocks an agent's deploy and `gh pr merge`)

```
cd /opt/hmis && git stash push -- .claude/settings.json && git pull --ff-only \
  && /opt/hmis-lanes/.orchestrator/bin/test-lock.sh run prod-deploy bash docker/prod/deploy.sh; git stash pop
```

Before a deploy:
1. CI is green on that main SHA (`gh run list --branch main`).
2. The new migrations are additive, and their journal `when` values increase and are later than
   production's watermark.
3. `caddy validate` passes if the Caddyfile changed.

Do NOT rerun the full suites locally.

## 5. Traps learned this week (do not repeat)

- **Never `pkill -f` or pattern kills on the prod host.** A container's processes are in the host's
  process list. `pkill -f "node dist/src/main.js"` killed the production API on 2026-09-26. Kill
  exact PIDs only.
- **A renumbered migration on a pushed branch** is fixed with a commit-tree merge (the tested tree,
  parents = the remote tip and origin/main) and a fast-forward push. Never force-push. Then drop the
  lane's test DBs.
- **A second PR that touches the same screen goes DIRTY** after the first merges. Resolve it by
  keeping both sides, then typecheck.
- **Check production DATA, not just tables**, after a feature that depends on reference data.
- **The owner's `!` commands** must carry no `<placeholder>` values.

---
Written 2026-09-29 by the doctor-desk / ABDM / WASA session.
