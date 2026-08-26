import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * PLAN 13 T2 — the resource registry's event catalog (DD8).
 *
 * The house pattern is `kernel/retention/events.ts` and `kernel/ops/events.ts`: one file per kernel
 * concern, and **NO PER-RUN NOISE — every name here is appended only when the fact it records
 * actually happened.**
 *
 * ═══ FIVE EVENTS, AND TWO OF THEM ARE WIDER THAN THE ROADMAP'S LIST ═══
 *
 * The roadmap names three: `resource.status_changed`, `resource.assigned`, `resource.released`.
 * This phase also ships `resource.registered` and `resource.updated`, and the widening is argued
 * rather than slipped in. Spec §6 says audit is STRUCTURAL — *"event log + append-only financials +
 * row-level `updated_by`/`updated_at`"* — and §11.18's sweep #3 puts master changes under change
 * control. **`createRoom` emits NOTHING today**, which is an audit hole in OPD; carrying that hole
 * into a kernel table that IPD, the mini-OT, pharmacy and lab will all build on makes it a hole in
 * the FOUNDATION instead of in one module. The cost is two `defineEvent` entries and two
 * `appendEvent` calls inside transactions that already exist.
 *
 * **`masterdata.changed` — §11.18 sweep #3's own name — is NOT this phase's event.** It is
 * cross-cutting, it belongs with the governance machinery, and § 4A item 3 routes the whole
 * question: the owner RULED on 2026-08-26 that master-data change control is a dedicated phase
 * after the IPD cluster, covering rooms, doctors, departments, formulary and tariff in ONE shape,
 * and that it cannot be scheduled before runbook O1 closes because a Class-B/C flow with one
 * approver is theatre.
 *
 * ═══ THE HONEST HALF, SO NOBODY READS A GREEN SUITE AS A LIVE ONE ═══
 *
 * **None of these five will fire in production during this phase.** `resource.registered` and
 * `resource.updated` do fire from T6 onward, because OPD's `createRoom`/`updateRoom` delegate into
 * the registry — but `status_changed`, `assigned` and `released` have no caller until Plan 15
 * assigns something. DD14 says this in as many words about the read routes; it is equally true
 * here, and it is 16a's precedent for saying so out loud.
 *
 * NO PATIENT IDENTITY IN ANY PAYLOAD (GC6). `occupantRef` can name an admission or an encounter,
 * which is a reference to a journey and not to a person; the envelope's `patientId` is where a
 * patient id belongs, and a caller that has one passes it there.
 */
const RESOURCES = "resources";

/** Every event in this catalog identifies its subject the same way. §10.5: a payload never duplicates an envelope field. */
const subject = {
  resourceId: z.string().min(1),
  kind: z.string().min(1),
  code: z.string().min(1),
  siteId: z.string().min(1),
};

/**
 * A PLACE JOINED THE HOSPITAL. The first row of `resource_status_history` records the same fact as
 * state; this is the notification.
 *
 * **Migrated rows do NOT get one** — `0032` writes history rows and appends no event, because
 * migrations do not append events. The audit trail for the two OPD rooms therefore starts at their
 * history row rather than at a registration, and `0032`'s own header says so in the file, so the
 * gap reads as chosen rather than missed.
 */
export const resourceRegistered = defineEvent(
  "resource.registered",
  RESOURCES,
  z.object({ ...subject, name: z.string().min(1), parentId: z.string().nullable(), status: z.string().min(1) }),
);

/**
 * A PLACE'S DESCRIPTION CHANGED — its name, its attributes, or its parent.
 *
 * `parentId` carries BOTH ends because a move is the change most worth reconstructing later: "which
 * ward was this bed in during March" is an incident-review question, and a payload holding only the
 * new value cannot answer it. `changed` names the fields that actually moved, so a consumer need
 * not diff.
 */
export const resourceUpdated = defineEvent(
  "resource.updated",
  RESOURCES,
  z.object({
    ...subject,
    changed: z.array(z.string().min(1)).min(1),
    fromParentId: z.string().nullable(),
    toParentId: z.string().nullable(),
  }),
);

/**
 * THE STATUS MOVED, and `from` is the value that was there BEFORE.
 *
 * `from` is NULLABLE rather than optional, and for the same reason `resource_status_history`'s
 * column is: the creation transition has no previous status, and `undefined` would make "there was
 * none" indistinguishable from "the writer forgot the field" (the `ops.mode_changed` lesson, one
 * plan later and learned rather than repeated).
 */
export const resourceStatusChanged = defineEvent(
  "resource.status_changed",
  RESOURCES,
  z.object({
    ...subject,
    from: z.string().nullable(),
    to: z.string().min(1),
    reason: z.string().nullable(),
  }),
);

/** SOMETHING IS IN IT. `occupantType` is what makes `occupantRef` resolvable (DD6). */
export const resourceAssigned = defineEvent(
  "resource.assigned",
  RESOURCES,
  z.object({
    ...subject,
    occupantType: z.string().min(1),
    occupantRef: z.string().min(1),
    status: z.string().min(1),
  }),
);

/**
 * IT IS FREE AGAIN — and `status` is the KIND'S `onRelease`, which for a bed is `cleaning` and not
 * `available` (§11.2's discharge cascade). A consumer that assumed "released ⇒ available" would
 * offer an uncleaned bed to the next admission, so the actual status is on the payload rather than
 * inferred from the verb.
 */
export const resourceReleased = defineEvent(
  "resource.released",
  RESOURCES,
  z.object({
    ...subject,
    occupantType: z.string().min(1),
    occupantRef: z.string().min(1),
    status: z.string().min(1),
  }),
);
