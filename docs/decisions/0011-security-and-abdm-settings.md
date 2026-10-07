---
type: decision
id: "0011"
title: "Security (WASA) and ABDM settings: password length, Aadhaar, hosting, SMS, 2FA, ICD-11"
description: "Password length stays 10, ABHA creation by Aadhaar OTP is allowed, hosting may be anywhere, and MSG91 is the SMS sender."
generated: { by: agent:claude, at: 2026-09-26 }
verified: []
status: draft
ruling: partly-open
tags: [security, auth, abdm, hosting, coding]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0011 — Security (WASA) and ABDM settings: password length, Aadhaar, hosting, SMS, 2FA, ICD-11

- **Date:** 2026-09-26   **Status:** Partly open
- **Area:** security, auth, abdm, hosting, coding (ICD-11)

Owner, verbatim: "password length = 10, ABHA creation with Aadhaar, hosting anywhere, MSG91 SMS Sender (token will
be provided later), the WASA auditor will be provided later but for now let it be a synthetic auditor, yes for
emergency self-elevation, yes for PIN login from the internet, two-factor login later not now, yes the preview on
port 8443, load ICD-11 data from internet."

## Decision

- **Password length stays 10** (M-09 stays backed out; the 2026-08-23 ruling — 10 characters plus a top-20 list —
  stands).
- **ABHA creation by Aadhaar OTP is ALLOWED.** `ABDM_ABHA_CREATE_AADHAAR` defaults to true, inert until ABDM is
  configured.
- **Hosting: anywhere.** Production stays where it is. ABDM's FAQ asks for an India-hosted callback; if their
  review flags it, report it and do not re-ask.
- **SMS: MSG91 is the sender**; the token comes later. An MSG91 OTP sender stays off until `MSG91_AUTH_KEY` is set;
  DLT template ids come with the token.
- **WASA auditor: synthetic for now.** Run an auditor-style WASA test against a synthetic-data stand-up, NEVER
  production. The real CERT-In auditor comes later.
- **H-01 emergency self-elevation is KEPT** as designed.
- **H-02 PIN login from the internet is KEPT.**
- **H-03 two-factor login: later, not now.**
- **H-04 port 8443 preview:** the first answer was ambiguous. On 2026-09-27 the owner ruled: "yes close 8443 if
  it's not of any use." Port 8443 was closed.
- **Webcam** (2026-09-27): "Yes the site should allow the webcam on it's pages." `Permissions-Policy camera=(self)`
  (PR #338).
- **ICD-11: "load ICD-11 data from internet".** The licence question is settled by the owner. The loader downloads
  WHO's mapping release (2026-01, pinned sha256) and loads it.

## Open

- CERT-In's 180-day log retention is separate from hosting location and was not ruled.
- Port 8444 (an AERB demo preview) is still open; the owner did not rule on it.
