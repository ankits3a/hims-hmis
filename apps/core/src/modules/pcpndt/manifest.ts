import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * PLAN 18a T2 / DD1 — **THE STATUTORY REGISTER IS ITS OWN MANIFEST, AND THAT IS THE DECISION.**
 *
 * ═══ WHY, IN ONE PARAGRAPH ═══
 *
 * INDEX §5 row 14 asked Plan 15 to build this and Plan 15 did not, so 18a does — and it builds it
 * where **15b (MTP-era gynae day-care ultrasound) and 62 (maternity) can install it WITHOUT
 * installing radiology.** The PCPNDT Act does not care which department held the probe: a Form F
 * written from the mini-OT's portable and one written in the radiology suite must land in ONE
 * gap-free serial series per machine per year, for one inspector reading one register. A table
 * inside `modules/radiology` would make 15b import radiology to write a statutory row, and the
 * first thing that would break is the serial series — the property the whole Act turns on.
 *
 * That decision is also why `pcpndt_form_f.study_id` is plain text and NOT a foreign key into
 * `imaging_studies` (§6.5): 15b's scan is a day-care case, not an imaging study, and an FK would
 * name one consumer and lock the other out.
 *
 * ═══ FIVE PERMISSIONS, AND THE ONE SEPARATION THEY EXIST TO ENFORCE ═══
 *
 * `pcpndt.form_f.write` and `pcpndt.form_f.verify` are **two permissions on purpose**, and DD14's
 * separation is that no role holds both: the sonologist writes the form, the PCPNDT in-charge
 * verifies it, and `verifyFormF` additionally refuses when the verifier IS `signed_by`
 * (`same_actor`). An officer who can write and self-verify a statutory declaration is a single
 * point of failure with a criminal statute behind it — and a permission census counting to 131
 * cannot see that, which is why T2 A3 pins it by name.
 *
 * ═══ NO MENU ═══
 *
 * The Form F screen is reached from a STUDY (`/pcpndt/form-f/$studyId`, T9), never browsed as a
 * list — because a list of Form F rows is a list of pregnant women by name, and the one thing this
 * register must not become is a searchable surface. `formFForStudy` is the only reader, it requires
 * `pcpndt.form_f.read`, and it logs the `pcpndt.form_f` PHI surface on every call. The inspection
 * persona that legitimately needs the register as a book is 18a-ii's, with its own permission and
 * its own certified print.
 *
 * ═══ NO SUBSCRIPTION, NO JOB, NO RESOURCE KIND, NO ORDER KIND ═══
 *
 * This module owns tables and rules, nothing asynchronous. It is installed in the worker
 * nonetheless, because the radiology `order.placed` consumer that runs there evaluates DD14's
 * applicability rule and refuses an unregistered machine — so the worker's registry must carry
 * these permissions for `hasPermission` to answer about them at all.
 */
export const pcpndtManifest: ModuleManifest = {
  key: "pcpndt",
  title: "PCPNDT Register",
  menu: [],
  permissions: [
    "pcpndt.registrations.manage",
    "pcpndt.registrations.read",
    "pcpndt.form_f.write",
    "pcpndt.form_f.read",
    "pcpndt.form_f.verify",
  ],
  subscriptions: [],
};
