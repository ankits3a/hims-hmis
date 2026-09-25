import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../../lib/auth";
import { setToken } from "../../lib/api";
import { router } from "../../router";
import { stubFetch } from "../../test-utils";
import "../../lib/i18n";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-12 — THE REGISTRATION COUNTER TAKES A REAL RECORD
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-04, holding a competitor's registration screen beside ours: *"when a new patient
 * needs to be registered, the current registration file lack many fields … Also add ABHA related
 * fields and buttons."*
 *
 * ═══ THE DEFECT THIS WORK EXPOSED, WHICH IS WORSE THAN THE MISSING FIELDS ═══
 *
 * `registerPatient` has refused a known minor with no guardian since it was written (D-31,
 * DPDP §9) — and this form had no guardian fields at all. So **no child could be registered from
 * the front desk, at all.** Proved against the running preview before any of this was written:
 *
 *     POST /patients {"name":"Test Child FD11","sex":"male","ageYears":5}
 *       → 400 "a minor's registration must include a guardian (D-31, DPDP §9)"
 *     POST /patients {"name":"Test Adult FD11","sex":"male","ageYears":35}
 *       → 201, UHID U00210129
 *
 * A paediatric walk-in met a 400 the clerk could do nothing about. The first two tests below are
 * that hole, closed from the screen's side.
 *
 * These drive the REAL component rather than a helper, because the bug was never in a helper — a
 * form that cannot express a guardian is a wiring fact, and only the wiring can prove it fixed.
 */

const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
  administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: false,
  district: "Kanpur Nagar", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["name"],
};

/** Every registration POST this desk makes, with its body, so a test can assert what LEFT the browser. */
function mountDesk(
  posted: { body: unknown }[],
  opts: {
    abdmConfigured?: boolean;
    /** ABDM S1 — create is its own switch (owner ruling pending), off unless a test says so. */
    canCreate?: boolean;
    /** ABDM S1 — extra routes (the ABHA flow, scan-and-share), merged over the defaults. */
    routes?: Record<string, unknown | ((init?: RequestInit, url?: string) => unknown)>;
  } = {},
): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: {
        hospital: ["opd.visits.open", "patients.register", "billing.invoice.issue"],
        scoped: { department: {}, floor: {} },
      },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [PATIENT] },
    "GET /api/patients/abha/capability": {
      configured: opts.abdmConfigured ?? false,
      canRecord: true,
      canCreate: (opts.abdmConfigured ?? false) && (opts.canCreate ?? false),
      canVerify: opts.abdmConfigured ?? false,
      canScanShare: opts.abdmConfigured ?? false,
      reason: "test",
    },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [{ id: "d-1", name: "Cardiology", code: "CARD" }] },
    "GET /api/opd/queues/summary": { items: [] },
    "GET /api/billing/session/current": { session: null },
    "GET /api/me/desk": { stats: [] },
    "GET /api/membership/recognition": { card: null, coupons: [] },
    "POST /api/patients": (init?: RequestInit) => {
      posted.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return {
        patient: {
          id: "p-new", uhid: "U00210130", name: "Chhotu Kumar", phone: null,
          dob: "2021-01-01", addressLine: null,
        },
      };
    },
    ...(opts.routes ?? {}),
  });
  setToken("t-1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: ["/counter"] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/**
 * `router` is a module singleton and `RouterProvider`'s `history` only takes on the FIRST mount in
 * a test file, so the route is DRIVEN rather than requested — the trap `shell-nav.test.tsx` and
 * `triage-debounce.test.tsx` both hit before this file existed.
 */
async function openEnrolment(): Promise<void> {
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
  const user = userEvent.setup({ delay: null });
  // "new walk-in" (F4) is what opens the enrolment form — typing in the find box only searches.
  await user.click(await screen.findByRole("button", { name: /new walk-in/i }));
  await waitFor(() => expect(screen.getByTestId("reg-name")).toBeInTheDocument());
}

afterEach(() => { setToken(null); });

/** ABDM S1 — the view fields every flow answer carries, at their "nothing to say" values. */
const FLOW_DEFAULTS = {
  resend: null, resendNeedsAadhaar: false, accounts: null, demographicsToApply: null, linkedElsewhere: null,
  mobileVerification: null, addressSuggestions: null,
};

describe("FD-12: the registration counter's full record", () => {
  it("a child cannot be registered until a guardian is named — the block opens itself on the age", async () => {
    const posted: { body: unknown }[] = [];
    mountDesk(posted);
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Chhotu Kumar");
    await user.click(screen.getByTestId("reg-sex-male"));
    // an adult: registerable on the four fields, exactly as before
    await user.type(screen.getByTestId("reg-age"), "35");
    expect(screen.getByTestId("reg-submit")).toBeEnabled();

    // now make them five years old — the age is what decides, not the clerk remembering
    await user.clear(screen.getByTestId("reg-age"));
    await user.type(screen.getByTestId("reg-age"), "5");

    // the guardian block opened ITSELF, and register is refused before the server can refuse it
    await waitFor(() => expect(screen.getByTestId("guardian-why")).toBeInTheDocument());
    expect(screen.getByTestId("reg-submit")).toBeDisabled();

    await user.type(screen.getByTestId("guardian-name"), "Ram Prasad");
    await user.selectOptions(screen.getByTestId("guardian-relationship"), "father");

    expect(screen.getByTestId("reg-submit")).toBeEnabled();
    await user.click(screen.getByTestId("reg-submit"));

    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as {
      ageYears: number;
      guardian: {
        name: string; relationship: string;
        authorityMessages: boolean; authorityBills: boolean;
        authorityConsents: boolean; authorityDsr: boolean;
      };
    };
    expect(body.ageYears).toBe(5);
    expect(body.guardian).toMatchObject({ name: "Ram Prasad", relationship: "father" });
    /*
      FD-25 — AND THE FOUR AUTHORITIES, WHICH THIS ASSERTION USED TO PROVE WERE MISSING.

      It was `toEqual({ name, relationship })` — an exact match, so it passed only while the guardian
      travelled with NOTHING ELSE. That is precisely the state the defect describes: the server has
      accepted and stored `authorityMessages`/`Bills`/`Consents`/`Dsr` since the guardians table
      existed, no client had ever sent one, and every guardian row on the deployed system therefore
      holds column defaults for a DPDP §9 question nobody was asked.

      So the exactness is kept rather than loosened — `toMatchObject` for identity, plus this, which
      pins the values. The defaults asserted here are the SIGNED-OFF ARTBOARD's (messages and bills
      on, consents and records off) and they deliberately disagree with the column defaults, which
      have `consents` TRUE. If someone later drops the four from the body to make something else
      pass, this fails and says why.
    */
    expect(body.guardian.authorityMessages).toBe(true);
    expect(body.guardian.authorityBills).toBe(true);
    expect(body.guardian.authorityConsents).toBe(false);
    expect(body.guardian.authorityDsr).toBe(false);
  });

  it("an unknown age is not a minor — the guardian is never demanded from an adult who cannot recall a year", async () => {
    const posted: { body: unknown }[] = [];
    mountDesk(posted);
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.click(screen.getByTestId("reg-sex-female"));
    // no age at all
    expect(screen.getByTestId("reg-submit")).toBeEnabled();
    await user.click(screen.getByTestId("reg-submit"));

    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as Record<string, unknown>;
    expect(body["guardian"]).toBeUndefined();
    expect(body["ageYears"]).toBeUndefined();
  });

  /*
    The server refuses `dob` AND `ageYears` together outright. The toggle is what decides, so that
    a stale value in the box the clerk switched away from cannot travel beside the one they meant.
  */
  it("age or date of birth — never both, whichever the toggle says", async () => {
    const posted: { body: unknown }[] = [];
    mountDesk(posted);
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Sita Devi");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.type(screen.getByTestId("reg-age"), "40");
    // switch to the date box and give it a date; the age typed a moment ago must NOT travel too
    await user.click(screen.getByTestId("reg-agemode-dob"));
    await user.type(screen.getByTestId("reg-dob"), "1986-03-14");
    await user.click(screen.getByTestId("reg-submit"));

    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as Record<string, unknown>;
    expect(body["dob"]).toBe("1986-03-14");
    expect(body["ageYears"]).toBeUndefined();
  });

  it("carries the whole record — demographics, address, ID, referral and consent — and omits every blank", async () => {
    const posted: { body: unknown }[] = [];
    mountDesk(posted);
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.click(screen.getByTestId("reg-sex-female"));

    await user.click(screen.getByTestId("fold-more"));
    await user.type(screen.getByTestId("reg-father"), "Ram Prasad");
    await user.selectOptions(screen.getByTestId("reg-blood"), "B+");
    await user.type(screen.getByTestId("reg-occupation"), "Anganwadi worker");

    await user.click(screen.getByTestId("fold-where"));
    await user.type(screen.getByTestId("reg-district"), "Kanpur Nagar");
    await user.type(screen.getByTestId("reg-pincode"), "208001");

    await user.click(screen.getByTestId("fold-id"));
    await user.selectOptions(screen.getByTestId("reg-idtype"), "aadhaar");
    await user.type(screen.getByTestId("reg-idnumber"), "234512347890");

    await user.click(screen.getByTestId("fold-ref"));
    await user.selectOptions(screen.getByTestId("reg-refsource"), "camp");

    await user.click(screen.getByTestId("fold-flags"));
    await user.click(screen.getByTestId("reg-promotional"));

    await user.click(screen.getByTestId("reg-submit"));
    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as Record<string, unknown>;

    expect(body["fatherHusbandName"]).toBe("Ram Prasad");
    expect(body["bloodGroup"]).toBe("B+");
    expect(body["occupation"]).toBe("Anganwadi worker");
    expect(body["district"]).toBe("Kanpur Nagar");
    expect(body["pincode"]).toBe("208001");
    expect(body["nationalIdType"]).toBe("aadhaar");
    expect(body["referredBySource"]).toBe("camp");
    expect(body["promotionalOptIn"]).toBe(true);

    /*
      A BLANK IS AN OMITTED KEY, NEVER "". Posting an empty string would make "the clerk left this
      blank" and "the clerk answered nothing" the same value in the master forever after.
    */
    expect("religion" in body).toBe(false);
    expect("title" in body).toBe(false);
    expect("referredByName" in body).toBe(false);
    expect("isConfidential" in body).toBe(false);
  });

  it("records several coverages at once, and an untouched blank row is not an entitlement", async () => {
    const posted: { body: unknown }[] = [];
    mountDesk(posted);
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.click(screen.getByTestId("fold-cover"));

    await user.click(screen.getByTestId("cover-add"));
    await user.selectOptions(screen.getByTestId("cover-kind-0"), "pmjay");
    await user.type(screen.getByTestId("cover-beneficiary-0"), "PMJAY-77120");
    await user.click(screen.getByTestId("cover-seen-0"));

    await user.click(screen.getByTestId("cover-add"));
    await user.selectOptions(screen.getByTestId("cover-kind-1"), "insurance");
    await user.type(screen.getByTestId("cover-payer-1"), "Star Health");
    await user.type(screen.getByTestId("cover-policy-1"), "P/551/9921");

    // a third row the clerk opened and never filled — it must not travel
    await user.click(screen.getByTestId("cover-add"));

    await user.click(screen.getByTestId("reg-submit"));
    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as { coverages: Record<string, unknown>[] };

    expect(body.coverages).toHaveLength(2);
    expect(body.coverages[0]).toMatchObject({
      kind: "pmjay", beneficiaryId: "PMJAY-77120", verificationStatus: "card_seen",
    });
    expect(body.coverages[1]).toMatchObject({
      kind: "insurance", payerName: "Star Health", policyNumber: "P/551/9921",
      verificationStatus: "self_declared",
    });
  });

  /**
   * ═══ THE ABHA BUTTONS SAY WHAT THIS HOSPITAL CAN ACTUALLY DO ═══
   *
   * Recording a number the patient reads off their phone needs no gateway. CREATING an ABHA and
   * VERIFYING one are ABDM's to answer. With no credentials those two are disabled with the reason
   * shown — a button that looks live and fails in a clerk's face, with a patient waiting, is worse
   * than one that says why it cannot be used.
   */
  it("without ABDM: an ABHA can be recorded, and create/verify are not offered at all", async () => {
    const posted: { body: unknown }[] = [];
    mountDesk(posted, { abdmConfigured: false });
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.click(screen.getByTestId("fold-abha"));

    await waitFor(() => expect(screen.getByTestId("abha-not-configured")).toBeInTheDocument());
    /* ABDM S1 — a button is drawn only when it works (the FD-12 greyed-out pair is gone). */
    expect(screen.queryByTestId("abha-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("abha-verify")).not.toBeInTheDocument();

    await user.type(screen.getByTestId("abha-number"), "12345678901234");
    await user.click(screen.getByTestId("reg-submit"));

    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as Record<string, unknown>;
    expect(body["abhaNumber"]).toBe("12345678901234");
    /*
      NEVER `verified` FROM THIS SCREEN. That is a claim about a national registry, and only the
      registry answering may make it — `abha_number` is a Class I field a re-rendered document
      reprints, so an unverifiable assertion here would travel into the identity spine.
    */
    expect(body["abhaVerificationStatus"]).toBe("self_declared");
  });

  it("with ABDM connected, verify is offered — and CREATE stays hidden while the hospital has not switched it on", async () => {
    mountDesk([], { abdmConfigured: true });
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.click(screen.getByTestId("fold-abha"));

    await waitFor(() => expect(screen.getByTestId("abha-verify")).toBeEnabled());
    expect(screen.queryByTestId("abha-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("abha-not-configured")).not.toBeInTheDocument();
  });

  it("with Aadhaar creation switched on, create is offered too", async () => {
    mountDesk([], { abdmConfigured: true, canCreate: true });
    await openEnrolment();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("fold-abha"));
    await waitFor(() => expect(screen.getByTestId("abha-create")).toBeEnabled());
    expect(screen.getByTestId("abha-find-aadhaar")).toBeEnabled();
    await user.click(screen.getByTestId("abha-create"));
    // the Aadhaar box is masked, and nothing can be sent until the patient's consent is ticked
    expect(screen.getByTestId("abdm-aadhaar")).toHaveAttribute("type", "password");
    await user.type(screen.getByTestId("abdm-aadhaar"), "987654321098");
    expect(screen.getByTestId("abdm-send-otp")).toBeDisabled();
    await user.click(screen.getByTestId("abdm-consent"));
    expect(screen.getByTestId("abdm-send-otp")).toBeEnabled();
  });

  /**
   * ABDM S1 — VERIFY AT THE COUNTER, BEFORE THE UHID EXISTS. ABDM confirms the ABHA; the form takes
   * the number (and fills only BLANK demographics); the registration still posts `self_declared`;
   * and the moment the UHID exists the desk LINKS it — which is where the server stamps `verified`.
   */
  it("verify → OTP → use → register → the ABHA is linked to the new UHID", async () => {
    const posted: { body: unknown }[] = [];
    const calls: { path: string; body: unknown }[] = [];
    const flow = (stage: "otp_sent" | "authenticated") => ({
      ...FLOW_DEFAULTS,
      transactionId: "tx-opaque-1", purpose: "verify", stage, kind: "abha_number", otpMethod: "mobile_otp",
      expiresAt: "2026-09-25T10:15:00.000Z", message: stage === "otp_sent" ? "OTP sent to ******3210" : null,
      profile: stage === "otp_sent" ? null : {
        abhaNumber: "91-2345-6789-0123", abhaAddress: "asha.devi@sbx", name: "Asha Devi", gender: "female",
        yearOfBirth: 1986, monthOfBirth: 3, dayOfBirth: 14, dob: "1986-03-14", mobile: "******3210",
        addressLine: null, district: null, stateName: null, pincode: null,
      },
      comparison: null, isNew: null,
    });
    mountDesk(posted, {
      abdmConfigured: true,
      routes: {
        "POST /api/abdm/abha/verify": (init?: RequestInit) => { calls.push({ path: "verify", body: JSON.parse(String(init?.body)) }); return flow("otp_sent"); },
        "POST /api/abdm/abha/transactions/tx-opaque-1/otp": (init?: RequestInit) => { calls.push({ path: "otp", body: JSON.parse(String(init?.body)) }); return flow("authenticated"); },
        "POST /api/abdm/abha/transactions/tx-opaque-1/link": (init?: RequestInit) => { calls.push({ path: "link", body: JSON.parse(String(init?.body)) }); return { patientId: "p-new", changed: ["abhaVerificationStatus"], comparison: [] }; },
      },
    });
    await openEnrolment();
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.type(screen.getByTestId("reg-phone"), "9876543210");
    await user.click(screen.getByTestId("fold-abha"));
    await user.click(await screen.findByTestId("abha-verify"));

    await user.type(screen.getByTestId("abdm-identifier"), "91-2345-6789-0123");
    await user.click(screen.getByTestId("abdm-method-mobile"));
    await user.click(screen.getByTestId("abdm-send-otp"));
    await waitFor(() => expect(screen.getByTestId("abdm-otp-message")).toHaveTextContent("******3210"));
    expect(calls[0]).toEqual({ path: "verify", body: { identifier: "91-2345-6789-0123", method: "mobile_otp", patientId: null } });

    await user.type(screen.getByTestId("abdm-otp"), "314159");
    await user.click(screen.getByTestId("abdm-verify-otp"));
    await waitFor(() => expect(screen.getByTestId("abdm-profile")).toBeInTheDocument());
    // ABDM beside the form: the typed name and mobile agree, and nothing is flagged
    expect(screen.getByTestId("abdm-compare-name")).toHaveAttribute("data-result", "same");
    expect(screen.getByTestId("abdm-compare-mobile")).toHaveAttribute("data-result", "same");
    await user.click(screen.getByTestId("abdm-use"));

    expect(screen.getByTestId("abha-number")).toHaveValue("91-2345-6789-0123");
    expect(screen.getByTestId("abdm-pending-link")).toBeInTheDocument();
    // the age box was blank, so ABDM's date of birth filled it; the typed name and mobile were kept
    expect(screen.getByTestId("reg-dob")).toHaveValue("1986-03-14");
    await user.click(screen.getByTestId("reg-submit"));

    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "Asha Devi", phone: "9876543210", dob: "1986-03-14",
      abhaNumber: "91-2345-6789-0123", abhaAddress: "asha.devi@sbx", abhaVerificationStatus: "self_declared",
    });
    expect(JSON.stringify(body)).not.toContain("tx-opaque-1");
    await waitFor(() => expect(calls.find((c) => c.path === "link")).toEqual({ path: "link", body: { patientId: "p-new", acceptAbdmDemographics: true } }));
  });

  it("DECIDED: a difference between ABDM and the form must be ACCEPTED, and then the form takes ABDM's details", async () => {
    mountDesk([], {
      abdmConfigured: true,
      routes: {
        "POST /api/abdm/abha/verify": { ...FLOW_DEFAULTS, transactionId: "tx-2", purpose: "verify", stage: "otp_sent", kind: "abha_number", otpMethod: "aadhaar_otp", expiresAt: "2026-09-25T10:15:00.000Z", message: null, profile: null, comparison: null, isNew: null },
        "POST /api/abdm/abha/transactions/tx-2/otp": {
          ...FLOW_DEFAULTS,
          transactionId: "tx-2", purpose: "verify", stage: "authenticated", kind: "abha_number", otpMethod: "aadhaar_otp", expiresAt: "2026-09-25T10:15:00.000Z", message: null,
          profile: { abhaNumber: "91-2345-6789-0123", abhaAddress: "asha@sbx", name: "Asha Kumari", gender: "female", yearOfBirth: 1986, monthOfBirth: null, dayOfBirth: null, dob: null, mobile: null, addressLine: null, district: null, stateName: null, pincode: null },
          comparison: null, isNew: null,
        },
      },
    });
    await openEnrolment();
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.click(screen.getByTestId("fold-abha"));
    await user.click(await screen.findByTestId("abha-verify"));
    await user.type(screen.getByTestId("abdm-identifier"), "91-2345-6789-0123");
    await user.click(screen.getByTestId("abdm-send-otp"));
    await user.type(await screen.findByTestId("abdm-otp"), "314159");
    await user.click(screen.getByTestId("abdm-verify-otp"));
    await waitFor(() => expect(screen.getByTestId("abdm-compare-name")).toHaveAttribute("data-result", "differs"));
    expect(screen.getByTestId("abdm-use")).toBeDisabled();
    await user.click(screen.getByTestId("abdm-accept"));
    await user.click(screen.getByTestId("abdm-use"));
    // ABDM-verified details are authoritative: the form takes ABDM's spelling, and the year of birth
    expect(screen.getByTestId("reg-name")).toHaveValue("Asha Kumari");
    expect(screen.getByTestId("reg-age")).toHaveValue(String(new Date().getFullYear() - 1986));
    expect(screen.getByTestId("abha-number")).toHaveValue("91-2345-6789-0123");
  });

  it("find by Aadhaar is offered only when the hospital has switched Aadhaar on", async () => {
    mountDesk([], { abdmConfigured: true });
    await openEnrolment();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("fold-abha"));
    await waitFor(() => expect(screen.getByTestId("abha-verify")).toBeInTheDocument());
    expect(screen.queryByTestId("abha-find-aadhaar")).not.toBeInTheDocument();
  });

  /**
   * ABDM S1 — SCAN AND SHARE: the pending list with its token, and "Register" opens the ORDINARY
   * form pre-filled from what the patient shared; the share is linked once the UHID exists.
   */
  it("scan and share: the list shows the token, Register pre-fills the form, and the share is linked after the UHID", async () => {
    const posted: { body: unknown }[] = [];
    const linked: unknown[] = [];
    const share = {
      id: "sh-1", tokenNumber: 7, tokenDate: "2026-09-25", counterId: "1", status: "pending",
      createdAt: "2026-09-25T04:00:00.000Z", expiresAt: "2026-09-25T04:30:00.000Z", ackStatus: "sent", patientId: null,
      profile: {
        abhaNumber: "91-2345-6789-0123", abhaAddress: "sunita.sharma@sbx", name: "Sunita Sharma", gender: "female",
        yearOfBirth: 1986, monthOfBirth: 3, dayOfBirth: 14, dob: "1986-03-14", mobile: "9876543210",
        addressLine: "12 Gandhi Nagar", district: "Jaipur", stateName: "RAJASTHAN", pincode: "302015",
      },
    };
    mountDesk(posted, {
      abdmConfigured: true,
      routes: {
        "GET /api/abdm/scan-share/qr": { url: "https://phrsbx.abdm.gov.in/share-profile?hf=IN0000000001&counter=1", hipId: "IN0000000001", counterId: "1" },
        "GET /api/abdm/scan-share/shares": { shares: [share] },
        "POST /api/abdm/scan-share/shares/sh-1/link": (init?: RequestInit) => { linked.push(JSON.parse(String(init?.body))); return { share: { ...share, status: "linked" }, changed: ["abhaVerificationStatus"], comparison: [] }; },
      },
    });
    await act(async () => { await router.navigate({ to: "/counter" }); });
    await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByTestId("abdm-scan-share-open"));
    await waitFor(() => expect(screen.getByTestId("abdm-counter-qr")).toHaveAttribute("data-url", "https://phrsbx.abdm.gov.in/share-profile?hf=IN0000000001&counter=1"));
    expect(await screen.findByTestId("abdm-share-sh-1")).toHaveTextContent("Sunita Sharma");
    expect(screen.getByTestId("abdm-share-token")).toHaveTextContent("7");

    await user.click(screen.getByTestId("abdm-share-register-sh-1"));
    await waitFor(() => expect(screen.getByTestId("reg-name")).toHaveValue("Sunita Sharma"));
    expect(screen.getByTestId("reg-phone")).toHaveValue("9876543210");
    await user.click(screen.getByTestId("reg-submit"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({
      name: "Sunita Sharma", sex: "female", phone: "9876543210", dob: "1986-03-14",
      abhaNumber: "91-2345-6789-0123", abhaAddress: "sunita.sharma@sbx", abhaVerificationStatus: "self_declared",
      addressLine: "12 Gandhi Nagar", pincode: "302015",
    });
    await waitFor(() => expect(linked).toEqual([{ patientId: "p-new", acceptAbdmDemographics: true }]));
  });

  /* The fast walk-in path is what Desk One is FOR, and none of the above may cost it. */
  it("the four-field walk-in still registers with every fold left closed", async () => {
    const posted: { body: unknown }[] = [];
    mountDesk(posted);
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Walk In");
    await user.type(screen.getByTestId("reg-phone"), "9100000001");
    await user.type(screen.getByTestId("reg-age"), "44");
    await user.click(screen.getByTestId("reg-sex-male"));
    await user.click(screen.getByTestId("reg-submit"));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toEqual({
      name: "Walk In", sex: "male", phone: "9100000001", ageYears: 44,
    });
  });

  /**
   * ═══ FD-25 — THE CONFIDENTIAL TICK THAT WAS A 400 FOR EVERY CLERK WHO EVER USED IT ═══
   *
   * `registration.ts` throws `alias_required` when `isConfidential` arrives without an alias. This
   * screen sent the flag and had no alias field, and `WireRegisterBody` did not declare one — so
   * the refusal was unreachable from the UI in both directions: the clerk could not satisfy it, and
   * no compiler could point at why.
   *
   * It survived a close review because every test here asserts what the SCREEN does, and the screen
   * did the wrong thing consistently. These two are written from the SERVER's rule instead — the
   * body must satisfy `alias_required`, and the screen must not let a clerk submit one that cannot.
   */
  it("a sealed record carries its alias — the flag alone is a refusal the server always makes", async () => {
    const posted: { body: unknown }[] = [];
    mountDesk(posted);
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Staff Member");
    await user.type(screen.getByTestId("reg-age"), "39");
    await user.click(screen.getByTestId("reg-sex-female"));

    await user.click(screen.getByTestId("fold-flags"));
    await user.click(screen.getByTestId("reg-confidential"));

    /* Ticked and no alias yet: the screen refuses BEFORE the server has to, exactly as it does for
       a minor with no guardian. A submit that is enabled here is a guaranteed 400 at the counter. */
    expect(screen.getByTestId("reg-submit")).toBeDisabled();

    await user.type(screen.getByTestId("reg-alias"), "Patient 44");
    expect(screen.getByTestId("reg-submit")).toBeEnabled();
    await user.click(screen.getByTestId("reg-submit"));

    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as { isConfidential?: boolean; alias?: string };
    expect(body.isConfidential).toBe(true);
    expect(body.alias).toBe("Patient 44");
  });

  it("an ordinary record sends no alias, even if one was typed and the box then unticked", async () => {
    const posted: { body: unknown }[] = [];
    mountDesk(posted);
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Ordinary Patient");
    await user.type(screen.getByTestId("reg-age"), "39");
    await user.click(screen.getByTestId("reg-sex-female"));

    await user.click(screen.getByTestId("fold-flags"));
    await user.click(screen.getByTestId("reg-confidential"));
    await user.type(screen.getByTestId("reg-alias"), "Patient 44");
    /* Untick: the alias field goes away with the decision it belonged to, and must not travel. An
       alias on an unsealed record is a public name for somebody who never asked to be hidden. */
    await user.click(screen.getByTestId("reg-confidential"));
    expect(screen.queryByTestId("reg-alias")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("reg-submit"));
    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as { isConfidential?: boolean; alias?: string };
    expect(body.isConfidential).toBeUndefined();
    expect(body.alias).toBeUndefined();
  });
});
