---
issue: 705
status: built
approved: 2026-10-12
---
# SPEC — Share a lab report as PDF from the phone (owner 2026-10-12: "yes, build the PDF share on phone")

Status: APPROVED 2026-10-12 (owner: "yes, build the PDF share").

## What
1. Phone **Quick Reports** gets a **Share PDF** button on each completed report, for holders of `lab.reports.print`
   (the same grant that prints at the desk).
2. Pressing it makes a PDF on the phone that matches the desk print exactly: hospital header, patient band, results with
   flags, the antibiotic table, and the footer. The phone's share sheet then opens (WhatsApp, email, Drive, …).
   The phone's PDF is made from the same HTML as the desk print, moved into a shared file, so the two cannot drift.
3. The file is named `<UHID>-<report no>.pdf`. The patient's name is not in the file name.
4. Every share is recorded on the server: who shared it, which report, and when (one new audit event, `labReportShared`).
   The report itself is not changed and is not marked as handed over.
5. The PDF file is deleted from the phone's cache after the share sheet closes.

Out of scope: sending through the hospital's WhatsApp number (needs an approved template), a patient download link,
and sharing from the web.

## Done means
- On the phone, Share PDF on a completed CBC report opens the share sheet with a one-page PDF. The PDF shows the same
  values, flags and footer as the desk print.
- A urine culture's PDF shows its antibiotic table, with the R rows in bold.
- A user without `lab.reports.print` sees no button. The server refuses their share record with 403.
- The share appears in the audit log with the user and the report.
- The PDF is built from the same template as the desk print, and a test proves both outputs match.
- A new app version goes to staging first, then to production after the owner's OK.
