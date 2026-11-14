---
issue: 629
status: built
approved: 2026-10-23
---
# SPEC — Privacy policy page for the staff app (#629) — APPROVED by owner 2026-10-23 ("OK to build")

Apple asks every app for a privacy policy URL. The staff app has none. The owner reviews the wording on the PR
and on staging before production.

1. **One static page, no sign-in:** `apps/web/public/privacy.html`. Vite copies it into the web build, so the
   site serves it at `/privacy.html` (production: `https://hmis.crkmch.com/privacy.html`). The Caddy catch-all
   already serves files from `/srv` before the SPA fallback. DECIDED: no Caddy, router or route-count change.
   The page has no script and no outside resource, so the site's CSP serves it as-is. Staging keeps its
   site-wide basic auth (staging is not public).
2. **Plain, short English**, with each sentence true of the code today: the location check, voice notes, the
   camera, notifications, Aadhaar, the copilot, what the phone keeps, where data is kept, who sees it, how long
   it is kept, the DPDP Act 2023 framing and a contact line ("the hospital's IT office"). There are no names,
   emails, phone numbers or IP addresses on the page. DECIDED: English only for now. The page is static and the
   app's i18n does not reach it. A Hindi version is owed as its own issue.
3. **Phone app:** Settings gets a "Privacy policy" row that opens the page on the app's own server in the
   phone's browser. This is JS only and ships as an OTA update.

## Done means
- **D1** `apps/web/public/privacy.html` exists. It has no `<script>` and loads nothing from another origin.
  The production Caddyfile's catch-all `handle` serves it from `/srv` with no sign-in, and no earlier `handle`
  matches `/privacy.html`.
- **D2** The page says each of these: the location is read once, only at Mark attendance, and coordinates are
  not stored; voice notes go to a speech-to-text service and the audio is not kept; what the camera
  photographs; notifications carry no patient details; Aadhaar is kept as a code plus its last four digits.
- **D3** The page says where data is kept (the hospital's HMIS servers), who sees it (by job, with changes
  logged), how long it is kept (copilot questions 180 days, unused lab-slip photos 90 days, patient records as
  hospital medical records), the DPDP Act 2023, and the contact (the hospital's IT office).
- **D4** The page has no email address, phone number, IP address or person's name.
- **D5** Phone Settings shows "Privacy policy" (English and Hindi labels). Tapping it opens
  `<the app's server>/privacy.html`.
