import { z } from "zod";
import {
  IPD_CLOCK_SKEW_MS,
  IPD_INTENTS,
  IpdProvenanceRecordSchema,
  ipdIsInFuture,
  IPD_INTENT_NAMES,
  IPD_REFUSALS,
  ipdIdempotencyScope,
  ipdSchemaKeys,
  type IpdIntentName,
} from "./index";

/*
  E0.2 (#714) — the IPD intent layer's skeleton. Every value below is synthetic: ids are `01FAKE…`, keys are
  the all-zero uuid family, people are `user-fake-*`. Nothing here is a real patient, bed or person.
*/
const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
const key = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = "2030-01-01T10:00:00.000+05:30";
const USER = "user-fake-01";
const USER2 = "user-fake-02";

const SBAR = { situation: "s", background: "b", assessment: "a", recommendation: "r" };

/** One valid input per intent. A new intent without a sample fails the "every intent has a sample" leg. */
const IPD_SAMPLE_INPUTS: Record<IpdIntentName, Record<string, unknown>> = {
  request_admission: {
    idempotencyKey: key(1), patientId: id(1), source: "opd_advice", sourceRef: id(2), consultantId: USER,
    requestedClass: "general", isolation: "none", plannedFor: AT, provisionalDiagnosis: "synthetic", mlc: false,
  },
  cancel_admission: { idempotencyKey: key(2), admissionId: id(3), reason: "patient_declined", note: "synthetic" },
  reserve_bed: { idempotencyKey: key(3), admissionId: id(3), bedId: id(4), patientId: id(1), need: { requestedClass: "general", isolation: "none", icu: false } },
  release_reservation: { idempotencyKey: key(4), reservationId: id(5), reason: "plan_changed" },
  admit: {
    idempotencyKey: key(5), admissionId: id(3), bedId: id(4),
    consent: { signedBy: "patient", documentId: id(6) }, deposit: { receiptId: id(7) },
  },
  assign_bed: {
    idempotencyKey: key(6), admissionId: id(3), bedId: id(4), patientId: id(1),
    need: { requestedClass: "general", isolation: "airborne", icu: false, placeAs: "female" }, classChange: "upgrade",
    protectBookedClass: "private",
  },
  print_band: { idempotencyKey: key(7), admissionId: id(3), printerId: id(8), size: "adult", site: "wrist" },
  reprint_band: {
    idempotencyKey: key(8), admissionId: id(3), printerId: id(8), size: "adult", site: "ankle", reason: "damaged",
  },
  plan_admission: {
    idempotencyKey: key(41), admissionId: id(3), payerKind: "cash", requestedClass: "private", plan: { kind: "medical" },
  },
  emergency_admit: {
    idempotencyKey: key(42), patientId: id(1), bedId: id(4), consultantId: USER, isolation: "none", mlc: true,
  },
  backfill_downtime: {
    idempotencyKey: key(43), paperSerial: "DT-0001", patientId: id(1), bedId: id(4), consultantId: USER,
    requestedClass: "general", isolation: "none", provisionalDiagnosis: "synthetic", mlc: false, payerKind: "cash",
    requestedAt: AT, admittedAt: AT, consent: { signedBy: "patient", method: "paper", witnessName: "Synthetic Witness" },
  },
  record_consent: {
    idempotencyKey: key(44), admissionId: id(3),
    consent: { signedBy: "guardian", method: "tablet_signature", documentId: id(6), signerName: "Synthetic Guardian", relation: "mother" },
  },
  record_stabilised: { idempotencyKey: key(45), admissionId: id(3), stabilisedAt: AT },
  record_payer_auth: {
    idempotencyKey: key(9), admissionId: id(3), payerKind: "insurance_cashless", payerRef: id(9),
    entry: "initial", preAuthNumber: "FAKE-PA-0001", status: "approved", approvedAmountPaise: 5_000_000,
    provisionalCashlessSigned: true,
  },
  take_deposit: {
    idempotencyKey: key(10), admissionId: id(3), amountPaise: 1_500_000, tender: "upi",
    payer: { name: "Synthetic Payer", relation: "relative", phone: "9000000001" },
  },
  start_transfer: {
    idempotencyKey: key(11), admissionId: id(3), toBedId: id(10), reason: "clinical_step_up", handover: SBAR,
  },
  accept_handover: { idempotencyKey: key(12), transferId: id(11) },
  cancel_transfer: { idempotencyKey: key(46), transferId: id(11), reason: "patient_deteriorated", note: "synthetic" },
  swap_beds: { idempotencyKey: key(13), admissionIdA: id(3), admissionIdB: id(12), reason: "gender_fix" },
  change_class: {
    idempotencyKey: key(14), admissionId: id(3), toClass: "private",
    consent: { signedBy: "patient", documentId: id(13) }, roomRentCapAcknowledged: true,
  },
  block_bed: { idempotencyKey: key(15), bedId: id(4), reason: "maintenance", note: "synthetic", expectedReturnAt: AT },
  unblock_bed: { idempotencyKey: key(16), bedId: id(4) },
  mark_bed_clean: { idempotencyKey: key(17), bedId: id(4), cleanedAt: AT, checklistDone: true },
  release_incumbent_bed: { idempotencyKey: key(40), bedId: id(4), note: "synthetic" },
  record_nursing_assessment: {
    idempotencyKey: key(18), admissionId: id(3), happenedAt: AT, source: "person",
    morse: 25, braden: 18, nutrition: "no_risk", allergyChecked: true, allergies: [], painScore: 2,
    homeMedicines: [{ name: "synthetic drug", dose: "1 tab", frequency: "OD" }],
    pressureInjuriesOnAdmission: [{ site: "sacrum", stage: 1, photoDocumentId: id(14) }],
  },
  record_vitals: {
    idempotencyKey: key(19), admissionId: id(3), observedAt: AT, source: "device", deviceId: id(15),
    values: { temperatureC: 37.1, pulse: 82, respRate: 16, systolic: 122, diastolic: 78, spo2: 97, onOxygen: false, consciousness: "alert" },
  },
  raise_task: {
    idempotencyKey: key(20), admissionId: id(3), kind: "reassessment", assignee: { kind: "role", ref: "ward_nurse" },
    dueAt: AT, note: "synthetic",
  },
  complete_task: { idempotencyKey: key(21), taskId: id(16), outcome: "done", completedAt: AT },
  sign_round: {
    idempotencyKey: key(22), admissionId: id(3), seenAt: AT, mode: "bedside", soap: { subjective: "synthetic", plan: "continue" },
    fit: { when: "tomorrow", disposition: "home" },
  },
  cosign_round: { idempotencyKey: key(40), roundId: id(25) },
  request_consult: { idempotencyKey: key(41), admissionId: id(3), consultantId: USER2, question: "synthetic", urgency: "routine" },
  close_consult: { idempotencyKey: key(42), consultId: id(26), note: "signed off" },
  stop_ip_order: { idempotencyKey: key(43), orderId: id(18), reason: "course complete" },
  cancel_ip_order: { idempotencyKey: key(44), orderId: id(18), reason: "wrong patient" },
  place_ip_order: {
    idempotencyKey: key(23), admissionId: id(3), kind: "drug",
    drug: {
      itemId: id(17), dose: { value: 1, unit: "g" }, route: "iv", frequency: "BD", startAt: AT, stopAt: AT, durationDays: 5,
      antibiotic: true,
    },
  },
  verify_order: {
    idempotencyKey: key(24), orderId: id(18), decision: "verified",
    checks: { allergy: true, interaction: true, dose: true, duplicate: true },
  },
  issue_med: { idempotencyKey: key(25), orderId: id(18), units: 2, batchId: id(19), labelPrinterId: id(20), ownMedicine: false },
  administer_dose: {
    idempotencyKey: key(26), orderId: id(18), doseDueAt: AT, givenAt: AT,
    patientCheck: { kind: "scan", wristbandCode: "FAKE-BAND-1" }, labelCode: "FAKE-LABEL-1",
    secondNurse: { userId: USER2, pinProof: "fake-proof" },
  },
  hold_dose: { idempotencyKey: key(27), orderId: id(18), doseDueAt: AT, reason: "npo" },
  refuse_dose: { idempotencyKey: key(28), orderId: id(18), doseDueAt: AT, reason: "patient_refused" },
  record_infusion_event: { idempotencyKey: key(29), orderId: id(18), event: "start", rateMlPerHour: 50, at: AT },
  miss_dose: { idempotencyKey: key(61), orderId: id(18), doseDueAt: AT, reason: "no_stock" },
  reoffer_held_doses: { idempotencyKey: key(62), admissionId: id(3), reason: "npo_lifted" },
  mark_dose_in_error: {
    idempotencyKey: key(63), actId: id(27), kind: "medication_incident", reason: "synthetic", incident: { type: "wrong_dose", category: "C" },
  },
  second_check: { idempotencyKey: key(64), purpose: "high_alert_dose", username: "fake.nurse", pin: "0000" },
  sign_verbal_order: { idempotencyKey: key(65), orderId: id(18) },
  record_narcotic_wastage: {
    idempotencyKey: key(66), orderId: id(18), qty: 0.5, unit: "ml", reason: "synthetic", witness: { userId: USER2, pinProof: "fake-proof" },
  },
  return_med: { idempotencyKey: key(67), issueId: id(28), units: 4, reason: "order stopped" },
  resolve_allergy_flag: { idempotencyKey: key(68), flagId: id(29), note: "doctor stopped" },
  declare_fit: { idempotencyKey: key(30), admissionId: id(3), when: "today", disposition: "home" },
  cancel_fit: { idempotencyKey: key(31), admissionId: id(3), reason: "synthetic worsening" },
  confirm_charges: { idempotencyKey: key(32), admissionId: id(3), department: "pharmacy" },
  sign_summary: { idempotencyKey: key(33), admissionId: id(3), draftId: id(21), draftVersion: 1 },
  settle_final_bill: {
    idempotencyKey: key(34), admissionId: id(3), billVersion: 3, patientPayablePaise: 250_000, settlement: "paid",
    payments: [{ tender: "card", amountPaise: 250_000 }],
  },
  issue_gate_pass: { idempotencyKey: key(35), admissionId: id(3), followUpAppointmentId: id(22) },
  scan_gate_pass: { idempotencyKey: key(36), gatePassCode: "FAKE-GP-0001", gateId: id(23), scannedAt: AT },
  record_lama: {
    idempotencyKey: key(37), admissionId: id(3), kind: "dama", signedBy: "representative",
    representativeReason: "synthetic", risksExplainedBy: USER, formDocumentId: id(24), at: AT,
  },
  record_abscond: { idempotencyKey: key(38), admissionId: id(3), lastSeenAt: AT, searchDone: true, policeIntimationRef: "FAKE-PI-1" },
  record_death: { idempotencyKey: key(39), admissionId: id(3), diedAt: AT, certifiedBy: USER },
};

describe("IPD intents — one contract per §0B intent", () => {
  it("every intent has a sample, and every sample input round-trips through its schema unchanged", () => {
    expect(Object.keys(IPD_SAMPLE_INPUTS).sort()).toEqual([...IPD_INTENT_NAMES].sort());
    for (const name of IPD_INTENT_NAMES) {
      const parsed = IPD_INTENTS[name].input.safeParse(IPD_SAMPLE_INPUTS[name]);
      if (!parsed.success) throw new Error(`${name}: ${parsed.error.message}`);
      expect(parsed.data).toEqual(IPD_SAMPLE_INPUTS[name]);
    }
  });

  it("an input is strict: an unknown field is refused, never silently dropped", () => {
    for (const name of IPD_INTENT_NAMES) {
      expect(IPD_INTENTS[name].input.safeParse({ ...IPD_SAMPLE_INPUTS[name], surprise: 1 }).success).toBe(false);
    }
  });

  it("each intent's refusal enum parses exactly its own codes", () => {
    for (const name of IPD_INTENT_NAMES) {
      const def = IPD_INTENTS[name];
      for (const code of def.refusals) expect(def.refusal.parse(code)).toBe(code);
      expect(def.refusal.safeParse("not_a_refusal").success).toBe(false);
    }
  });
});

describe("IPD refusals — principle 5, no dead ends", () => {
  it("every code has a one-sentence rule and a short fix label", () => {
    for (const [code, r] of Object.entries(IPD_REFUSALS)) {
      expect(r.rule).toMatch(/^[A-Z].*\.$/);
      expect(r.rule.split(/\.\s/).length).toBe(1);
      expect(r.fix.length).toBeGreaterThan(0);
      expect(r.fix.length).toBeLessThanOrEqual(32);
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("every refusal code is used by some intent, and every intent's code is registered", () => {
    const used = new Set(IPD_INTENT_NAMES.flatMap((n) => [...IPD_INTENTS[n].refusals]));
    expect([...used].filter((c) => !(c in IPD_REFUSALS))).toEqual([]);
    expect(Object.keys(IPD_REFUSALS).filter((c) => !used.has(c as never))).toEqual([]);
  });

  it("every intent can refuse at least once", () => {
    for (const name of IPD_INTENT_NAMES) expect(IPD_INTENTS[name].refusals.length).toBeGreaterThan(0);
  });
});

describe("IPD idempotency (§4.10 edge 9: a retried give records once)", () => {
  it("every intent marked idempotent requires a uuid idempotencyKey", () => {
    for (const name of IPD_INTENT_NAMES) {
      if (!IPD_INTENTS[name].idempotent) continue;
      const { idempotencyKey: _drop, ...rest } = IPD_SAMPLE_INPUTS[name];
      expect([name, IPD_INTENTS[name].input.safeParse(rest).success]).toEqual([name, false]);
      expect(IPD_INTENTS[name].input.safeParse({ ...rest, idempotencyKey: "retry-1" }).success).toBe(false);
    }
  });

  it("every IPD intent creates or moves something, so every one is idempotent", () => {
    expect(IPD_INTENT_NAMES.filter((n) => !IPD_INTENTS[n].idempotent)).toEqual([]);
  });

  it("ipdIdempotencyScope is deterministic, separates intents, and refuses a malformed key", () => {
    expect(ipdIdempotencyScope("administer_dose", key(1))).toBe(ipdIdempotencyScope("administer_dose", key(1)));
    expect(ipdIdempotencyScope("administer_dose", key(1))).not.toBe(ipdIdempotencyScope("hold_dose", key(1)));
    expect(ipdIdempotencyScope("administer_dose", key(1))).not.toBe(ipdIdempotencyScope("administer_dose", key(2)));
    expect(ipdIdempotencyScope("admit", key(1).toUpperCase())).toBe(ipdIdempotencyScope("admit", key(1)));
    expect(() => ipdIdempotencyScope("admit", "retry-1")).toThrow();
    expect(() => ipdIdempotencyScope("no_such_intent" as IpdIntentName, key(1))).toThrow();
  });
});

describe("IPD metadata", () => {
  it("every intent declares at least one actor, at least one event, and events live under ipd.*", () => {
    for (const name of IPD_INTENT_NAMES) {
      const def = IPD_INTENTS[name];
      expect(def.actors.length).toBeGreaterThan(0);
      expect(def.events.length).toBeGreaterThan(0);
      for (const e of def.events) expect(e).toMatch(/^ipd\.[a-z_]+\.[a-z_]+$/);
    }
  });

  it("an agent tier above none needs `agent` among the actors, and an agent actor needs a tier", () => {
    for (const name of IPD_INTENT_NAMES) {
      const def = IPD_INTENTS[name];
      expect([name, def.agentTier !== "none"]).toEqual([name, def.actors.includes("agent")]);
    }
  });

  it("ipdSchemaKeys sees keys inside optional, nullable, array and union members", () => {
    const keys = ipdSchemaKeys(IPD_INTENTS.settle_final_bill.input);
    expect(keys).toContain("payments");
    expect(keys).toContain("amountPaise");
    expect(ipdSchemaKeys(IPD_INTENTS.administer_dose.input)).toEqual(expect.arrayContaining(["wristbandCode", "overrideReason", "pinProof"]));
  });
});

describe("E1.2 ipd-admit contract rules", () => {
  const parse = (name: IpdIntentName, patch: Record<string, unknown>) =>
    IPD_INTENTS[name].input.safeParse({ ...IPD_SAMPLE_INPUTS[name], ...patch }).success;

  it("consent: a document unless on paper; paper names a witness; a guardian or representative is named with relation", () => {
    expect(parse("record_consent", { consent: { signedBy: "patient" } })).toBe(false);
    expect(parse("record_consent", { consent: { signedBy: "patient", documentId: id(6) } })).toBe(true);
    expect(parse("record_consent", { consent: { signedBy: "patient", method: "paper" } })).toBe(false);
    expect(parse("record_consent", { consent: { signedBy: "patient", method: "paper", witnessName: "W" } })).toBe(true);
    expect(parse("record_consent", { consent: { signedBy: "guardian", documentId: id(6) } })).toBe(false);
  });

  it("backfill: the paper request cannot be later than the paper admission", () => {
    expect(parse("backfill_downtime", { requestedAt: "2030-01-01T11:00:00.000+05:30", admittedAt: AT })).toBe(false);
    expect(parse("backfill_downtime", { requestedAt: "2030-01-01T09:00:00.000+05:30", admittedAt: AT })).toBe(true);
  });

  it("plan: a surgical plan carries its procedure estimate", () => {
    expect(parse("plan_admission", { plan: { kind: "surgical" } })).toBe(false);
    expect(parse("plan_admission", { plan: { kind: "surgical", procedureEstimatePaise: 10_000_000 } })).toBe(true);
  });

  it("the old consent shape (signedBy + documentId) still parses for admit", () => {
    expect(parse("admit", {})).toBe(true);
  });
});

describe("review fixes on PR #745 (cross-field rules live in the contract, not a screen)", () => {
  const parse = (name: IpdIntentName, patch: Record<string, unknown>) =>
    IPD_INTENTS[name].input.safeParse({ ...IPD_SAMPLE_INPUTS[name], ...patch }).success;

  it("admit: an approved waiver names its approval; scheme and emergency exemptions need none", () => {
    expect(parse("admit", { deposit: { exempt: "approved_waiver" } })).toBe(false);
    expect(parse("admit", { deposit: { exempt: "approved_waiver", approvalId: id(30) } })).toBe(true);
    expect(parse("admit", { deposit: { exempt: "scheme" } })).toBe(true);
    expect(parse("admit", { deposit: { exempt: "emergency_not_stabilised" } })).toBe(true);
  });

  it("administer_dose can refuse a give stamped in the future (2-minute skew allowance)", () => {
    expect(IPD_INTENTS.administer_dose.refusals).toContain("time_in_future");
    const now = new Date("2030-01-01T10:00:00.000Z");
    expect(ipdIsInFuture("2030-01-01T10:01:59.000Z", now)).toBe(false);
    expect(ipdIsInFuture("2030-01-01T10:02:01.000Z", now)).toBe(true);
    expect(IPD_CLOCK_SKEW_MS).toBe(120_000);
  });

  it("record_vitals: at least one value, or refused with none; a device id only and always with a device source", () => {
    expect(parse("record_vitals", { values: {} })).toBe(false);
    expect(parse("record_vitals", { values: {}, refused: true, source: "person", deviceId: undefined })).toBe(true);
    expect(parse("record_vitals", { refused: true })).toBe(false);
    expect(parse("record_vitals", { deviceId: undefined })).toBe(false);
    expect(parse("record_vitals", { source: "person" })).toBe(false);
    expect(parse("record_vitals", { source: "person", deviceId: undefined })).toBe(true);
  });

  it("settle_final_bill: each settlement kind carries what it rests on", () => {
    expect(parse("settle_final_bill", { payments: [] })).toBe(false);
    // E3.2 review ⚖: dues rest on the signed undertaking, not on an approval (the approval follows the exit).
    expect(parse("settle_final_bill", { settlement: "dues_recorded" })).toBe(false);
    expect(parse("settle_final_bill", { settlement: "dues_recorded", duesApprovalId: id(31) })).toBe(false);
    expect(parse("settle_final_bill", { settlement: "dues_recorded", undertakingDocumentId: id(31) })).toBe(true);
    expect(parse("settle_final_bill", { settlement: "insurer_pending_undertaking" })).toBe(false);
    expect(parse("settle_final_bill", { settlement: "insurer_pending_undertaking", undertakingDocumentId: id(32) })).toBe(true);
  });

  it("provenance allows a system act: { source: system, actor: system }", () => {
    expect(IpdProvenanceRecordSchema.safeParse({ source: "system", actor: "system" }).success).toBe(true);
    expect(IpdProvenanceRecordSchema.safeParse({ source: "robot", actor: "system" }).success).toBe(false);
  });

  it("ipdSchemaKeys walks tuple and lazy schemas", () => {
    const nested = z.lazy(() => z.object({ rows: z.tuple([z.object({ visitFeeRupees: z.number() })]) }));
    expect(ipdSchemaKeys(nested)).toEqual(expect.arrayContaining(["rows", "visitFeeRupees"]));
  });
});

describe("E4.2 ipd-rounds contract rules (#734)", () => {
  const parse = (name: IpdIntentName, patch: Record<string, unknown>) =>
    IPD_INTENTS[name].input.safeParse({ ...IPD_SAMPLE_INPUTS[name], ...patch }).success;

  it("sign_round: a structured S/O/A/P note with at least one part; no free `note`", () => {
    expect(parse("sign_round", { soap: {} })).toBe(false);
    expect(parse("sign_round", { soap: { subjective: "   " } })).toBe(false);
    expect(parse("sign_round", { soap: { assessment: "stable" } })).toBe(true);
    expect(parse("sign_round", { note: "free text" })).toBe(false);
    expect(parse("sign_round", { mode: "remote_review", source: "voice" })).toBe(true);
  });

  it("no round, order or consult answer names money (decision 0058)", () => {
    const money = /paise|rupee|amount|fee|charge|dues|payable|price|deposit|bill/i;
    for (const name of ["sign_round", "cosign_round", "request_consult", "close_consult", "place_ip_order", "stop_ip_order", "cancel_ip_order"] as const) {
      expect([name, ipdSchemaKeys(IPD_INTENTS[name].output).filter((k) => money.test(k))]).toEqual([name, []]);
    }
  });

  it("orders are never on a copilot card and never an agent's (§4.11)", () => {
    for (const name of ["stop_ip_order", "cancel_ip_order"] as const) {
      expect([IPD_INTENTS[name].copilotProposable, IPD_INTENTS[name].agentTier]).toEqual([false, "none"]);
    }
  });
});
