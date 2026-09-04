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
  opts: { abdmConfigured?: boolean } = {},
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
      canCreate: opts.abdmConfigured ?? false,
      canVerify: opts.abdmConfigured ?? false,
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
    const body = posted[0]!.body as { ageYears: number; guardian: { name: string; relationship: string } };
    expect(body.ageYears).toBe(5);
    expect(body.guardian).toEqual({ name: "Ram Prasad", relationship: "father" });
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
  it("without ABDM: an ABHA can be recorded, and create/verify are visibly unavailable", async () => {
    const posted: { body: unknown }[] = [];
    mountDesk(posted, { abdmConfigured: false });
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.click(screen.getByTestId("fold-abha"));

    await waitFor(() => expect(screen.getByTestId("abha-not-configured")).toBeInTheDocument());
    expect(screen.getByTestId("abha-create")).toBeDisabled();
    expect(screen.getByTestId("abha-verify")).toBeDisabled();

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

  it("with ABDM connected, create and verify become available", async () => {
    mountDesk([], { abdmConfigured: true });
    await openEnrolment();
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.click(screen.getByTestId("fold-abha"));

    await waitFor(() => expect(screen.getByTestId("abha-create")).toBeEnabled());
    expect(screen.getByTestId("abha-verify")).toBeEnabled();
    expect(screen.queryByTestId("abha-not-configured")).not.toBeInTheDocument();
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
});
