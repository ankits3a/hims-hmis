import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser } from "../../../test/helpers/opd";
import { events } from "../../kernel/db/schema";
import { copilotDraftProseAt, doctorCopilotSettings, setDoctorCopilotSettings } from "./copilot-settings";
import { doctorSuggestionsOn } from "./consult-guards";
import type { Db } from "../../kernel/db/client";

/**
 * #619 — DECISION 0006's TWO PER-DOCTOR COPILOT TOGGLES, ON THE SERVER.
 *
 * Owner 2026-09-17: proactive-vs-ask-only is the doctor's choice; drafting clinical prose is opt-in
 * ("confirmation/submission will always be from the doctor side"). Both default OFF. DECIDED with the
 * owner's delegation: they live server-side per user, and flipping `draftProse` appends an event, so
 * "was the copilot permitted to draft on the day this note was signed?" has an answer. `proactive` is
 * pure UX and appends nothing (brainstorm 2026-09-17-doctor-copilot §4.2).
 */
const T1 = new Date("2026-10-15T04:00:00.000Z");
const T2 = new Date("2026-10-15T05:00:00.000Z");
const T3 = new Date("2026-10-15T06:00:00.000Z");

describe("#619 — the doctor's copilot toggles (decision 0006)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dra: { actor: Actor };
  let drb: { actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    dra = await mkUser(db, "dra", ["doctor"]);
    drb = await mkUser(db, "drb", ["doctor"]);
  });
  const draftEvents = () => db.select().from(events).where(eq(events.name, "opd.copilot_draft_prose_set"));

  it("both are OFF until the doctor turns one on, and they are each doctor's own", async () => {
    expect(await doctorCopilotSettings(db, dra.actor.id)).toEqual({ proactive: false, draftProse: false });
    await setDoctorCopilotSettings(db, dra.actor, { proactive: true }, T1);
    expect(await doctorCopilotSettings(db, dra.actor.id)).toEqual({ proactive: true, draftProse: false });
    expect(await doctorCopilotSettings(db, drb.actor.id)).toEqual({ proactive: false, draftProse: false });
  });

  it("they live beside, and never move, the separate count-chips switch (decision 0050)", async () => {
    await setDoctorCopilotSettings(db, dra.actor, { proactive: true, draftProse: true }, T1);
    expect(await doctorSuggestionsOn(db, dra.actor.id)).toBe(true);
  });

  it("flipping draftProse appends ONE event naming who, the old and the new value; the same value again, or proactive, appends none", async () => {
    await setDoctorCopilotSettings(db, dra.actor, { proactive: true }, T1);
    expect(await draftEvents()).toHaveLength(0);
    await setDoctorCopilotSettings(db, dra.actor, { draftProse: true }, T2);
    await setDoctorCopilotSettings(db, dra.actor, { draftProse: true }, T2);
    const rows = await draftEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "user", actorId: dra.actor.id, module: "opd" });
    expect(rows[0]!.payload).toEqual({ userId: dra.actor.id, draftProse: true, previous: false });
    expect(rows[0]!.occurredAt.toISOString()).toBe(T2.toISOString());
  });

  it("answers the audit question: was drafting permitted for this doctor at that moment?", async () => {
    await setDoctorCopilotSettings(db, dra.actor, { draftProse: true }, T2);
    await setDoctorCopilotSettings(db, dra.actor, { draftProse: false }, T3);
    expect(await copilotDraftProseAt(db, dra.actor.id, T1)).toBe(false); // before any setting: the default, off
    expect(await copilotDraftProseAt(db, dra.actor.id, new Date(T2.getTime() + 60_000))).toBe(true);
    expect(await copilotDraftProseAt(db, dra.actor.id, new Date(T3.getTime() + 60_000))).toBe(false);
    expect(await copilotDraftProseAt(db, drb.actor.id, T3)).toBe(false);
  });

  it("a non-user actor cannot hold or set a doctor's toggle", async () => {
    await expect(setDoctorCopilotSettings(db, { type: "system", id: "job" }, { draftProse: true }, T1)).rejects.toMatchObject({ code: "user_actor_required" });
    expect(await draftEvents()).toHaveLength(0);
  });
});
