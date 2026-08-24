/**
 * PLAN 11g / DD5 — THE DESK STOPS OFFERING A CONTROL THAT ORPHANS A PATIENT RECORD.
 *
 * WHAT WAS MEASURED (2026-08-24 synthetic smoke test, D6). `SYN-Confidential Case`, registered
 * through the desk with the confidential box ticked, came back a clean 201 with a fresh UHID —
 * and thereafter, for EVERY user in production:
 *
 *     GET /patients/search?q=SYN-Confidential  ->  200 {"items":[]}
 *     GET /patients/<id>                       ->  404
 *
 * `search.ts:45-48` filters confidential records unless the caller holds
 * `patients.confidential.read`, and `getPatient` applies the same rule. **No role in production
 * holds that permission** — `seed-roles.ts:270` records it as awaiting an owner ruling on WHO may
 * read such a record. So the record cannot be found, opened, billed or treated, by anybody, and
 * there is no repair through any screen. One click at the desk, and a patient is gone.
 *
 * ═══ WHY A CONSTANT AND NOT A DELETION, AND WHY NOT A SERVER GUARD ═══
 *
 * The FEATURE is not wrong; the grant is missing. When the owner rules who may read a
 * confidential record, this flips to `true` and both controls come back — one line, no
 * archaeology. Deleting the fields would make that a rebuild.
 *
 * And the API is deliberately NOT guarded. A refusal at `registerPatient` would be a new guard on
 * a clinical write path the owner has not ruled on, and it would break any future import or merge
 * that legitimately carries the flag. What is being fixed here is a DESK AFFORDANCE that orphans a
 * record with one click — not the data model, which is correct and waiting.
 *
 * WHAT THE TWO SCREENS DO WHILE THIS IS `false`:
 *   - Registration omits `isConfidential` from the POST body entirely (the form default is
 *     `false`, and the body only carries the field when it is true).
 *   - Patient-detail keeps the record's CURRENT value in its form state and never marks it dirty,
 *     so the PATCH omits it — an edit must never silently UN-confidential a record that already is
 *     one. That is the half a plain deletion would have got wrong.
 */
export const CONFIDENTIAL_CAPTURE_ENABLED = false;
