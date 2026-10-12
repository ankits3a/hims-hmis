import { IPD_INTENTS, IPD_REFUSALS, ipdSchemaKeys } from "@hmis/contracts";
import { defineWorkflow } from "../../../kernel/workflow/definition";
import { ADMISSION_TRANSITIONS, admissionWorkflowDefinition } from "../admission-workflow";

/**
 * E0.2 (#714) — "DONE MEANS" FOR THE IPD INTENT LAYER'S SKELETON (spec §6, Architecture; decision 0072).
 *
 * The §0B catalogue is written out here as LITERAL TEXT, copied from the spec, not imported: if the contract
 * package lost or renamed an intent, a list read from the package would shrink with it and stay green.
 */
const SPEC_0B_INTENTS = [
  "request_admission", "reserve_bed", "release_reservation", "admit", "assign_bed", "print_band", "reprint_band",
  "record_payer_auth", "take_deposit", "start_transfer", "accept_handover", "swap_beds", "change_class",
  "block_bed", "unblock_bed", "mark_bed_clean", "record_nursing_assessment", "record_vitals", "raise_task",
  "complete_task", "sign_round", "place_ip_order", "verify_order", "issue_med", "administer_dose", "hold_dose",
  "refuse_dose", "record_infusion_event", "declare_fit", "cancel_fit", "confirm_charges", "sign_summary",
  "settle_final_bill", "issue_gate_pass", "scan_gate_pass", "record_lama", "record_abscond", "record_death",
] as const;

const SPEC_0B_STATES = [
  "requested", "reserved", "admitted", "transferring", "fit_declared", "discharging",
  "discharged", "lama", "absconded", "deceased", "transferred_out", "cancelled",
];
const SPEC_0B_TERMINALS = ["discharged", "lama", "absconded", "deceased", "transferred_out", "cancelled"];

const intents = IPD_INTENTS as Record<string, (typeof IPD_INTENTS)[keyof typeof IPD_INTENTS]>;

describe("IPD intents — done means (E0.2, #714)", () => {
  it("every §0B intent has an input schema, an output schema and a refusal enum", () => {
    expect(SPEC_0B_INTENTS).toHaveLength(38);
    for (const name of SPEC_0B_INTENTS) {
      const def = intents[name];
      expect([name, def !== undefined]).toEqual([name, true]);
      expect(typeof def!.input.safeParse).toBe("function");
      expect(typeof def!.output.safeParse).toBe("function");
      expect(def!.refusals.length).toBeGreaterThan(0);
    }
  });

  it("every refusal any intent can return names its rule and offers a fix (principle 5)", () => {
    const refusals = IPD_REFUSALS as Record<string, { rule: string; fix: string } | undefined>;
    for (const name of SPEC_0B_INTENTS) {
      for (const code of intents[name]!.refusals) {
        expect([name, code, Boolean(refusals[code]?.rule), Boolean(refusals[code]?.fix)]).toEqual([name, code, true, true]);
      }
    }
  });

  it("every intent that creates or moves something requires an idempotency key (§4.10 edge 9)", () => {
    for (const name of SPEC_0B_INTENTS) {
      const def = intents[name]!;
      expect([name, def.idempotent]).toEqual([name, true]);
      expect([name, ipdSchemaKeys(def.input).includes("idempotencyKey")]).toEqual([name, true]);
      expect([name, def.input.safeParse({}).success]).toEqual([name, false]);
    }
  });

  it("no doctor or resident intent answers with money (decision 0058)", () => {
    const doctorIntents = Object.entries(intents).filter(([, d]) => d.actors.includes("doctor") || d.actors.includes("resident"));
    expect(doctorIntents.length).toBeGreaterThan(5);
    for (const [name, def] of doctorIntents) {
      expect([name, ipdSchemaKeys(def.output).filter((k) => /paise$/i.test(k))]).toEqual([name, []]);
    }
  });

  it("doses and orders are never proposed by a copilot or run by an agent (§4.11 'Never')", () => {
    for (const name of ["place_ip_order", "verify_order", "issue_med", "administer_dose", "hold_dose", "refuse_dose", "record_infusion_event"]) {
      expect([name, intents[name]!.agentTier, intents[name]!.copilotProposable]).toEqual([name, "none", false]);
    }
    // Never auto-sign, never auto-accept.
    expect(intents.sign_summary!.agentTier).toBe("none");
    expect(intents.accept_handover!.agentTier).toBe("none");
  });

  it("the admission workflow is valid to the engine and every state of §0B is in it", () => {
    expect(() => defineWorkflow(admissionWorkflowDefinition)).not.toThrow();
    expect(admissionWorkflowDefinition.states.map((s) => s.name).sort()).toEqual([...SPEC_0B_STATES].sort());
    expect(admissionWorkflowDefinition.states.filter((s) => s.terminal).map((s) => s.name).sort()).toEqual([...SPEC_0B_TERMINALS].sort());
  });

  it("every admission transition is driven by an intent that exists", () => {
    for (const t of ADMISSION_TRANSITIONS) expect([t.from, t.to, intents[t.intent] !== undefined]).toEqual([t.from, t.to, true]);
  });
});
