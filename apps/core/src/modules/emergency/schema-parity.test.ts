import { ER_AGE_BANDS, ER_ARRIVAL_MODES, ER_EPISODE_STATES, ER_OPEN_STATES } from "@hmis/contracts";
import { ER_AGE_BAND_VALUES, ER_ARRIVAL_MODE_VALUES, ER_EPISODE_STATE_VALUES, ER_OPEN_STATE_VALUES } from "../../kernel/db/schema";
import { ER_EPISODE_TRANSITIONS, erEpisodeWorkflowDefinition } from "./workflow";

/** ER lane 1 (#808) — the schema's retyped value lists equal the contract's; the workflow names every episode state. */
describe("emergency schema ↔ contract parity", () => {
  it("states, open states, arrival modes and age bands are the same lists", () => {
    expect([...ER_EPISODE_STATE_VALUES]).toEqual([...ER_EPISODE_STATES]);
    expect([...ER_OPEN_STATE_VALUES]).toEqual([...ER_OPEN_STATES]);
    expect([...ER_ARRIVAL_MODE_VALUES]).toEqual([...ER_ARRIVAL_MODES]);
    expect([...ER_AGE_BAND_VALUES]).toEqual([...ER_AGE_BANDS]);
  });

  it("the episode workflow declares exactly the contract's states and every edge has roles", () => {
    expect(erEpisodeWorkflowDefinition.states.map((s) => s.name).sort()).toEqual([...ER_EPISODE_STATES].sort());
    for (const t of erEpisodeWorkflowDefinition.transitions) expect(t.roles.length).toBeGreaterThan(0);
    // Every arrival-lane edge is driven by a lane-1 act; brought dead is reachable only from arrived.
    expect(ER_EPISODE_TRANSITIONS.filter((t) => t.to === "brought_dead")).toEqual([{ from: "arrived", to: "brought_dead", intent: "record_brought_dead" }]);
  });
});
