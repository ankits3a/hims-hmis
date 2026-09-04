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
 * FD-15 — UNDOING A MISTAKE WITHOUT THROWING THE PATIENT AWAY
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-04, on two things the desk could not do:
 *
 *   *"in the registration page the user mistyped age of the patient which the patient points out at
 *   the appointment screen or billing screen. Currently the user has to clear desk and register
 *   again. this is not good for the operating system."*
 *
 *   *"imagine the patient at the billing screen to change the doctor then the user has no option
 *   rather he has to clear desk restart the process again."*
 *
 * Both remedies were destructive. Clearing the desk to fix an age MINTED A SECOND UHID for one
 * person — the desk's answer to a typo was to create the exact duplicate the whole warning
 * apparatus exists to prevent — and clearing it to change a doctor left the first encounter and its
 * token alive on the board.
 *
 * …and the photo, which the owner reported as "not getting saved". It WAS saving: the PUT answers
 * 200 and the row is written. Nothing ever read it back, so the next time the patient was held the
 * panel was empty. Saved and invisible is indistinguishable from not saved.
 */

const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
  administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: true,
  district: "Kanpur Nagar", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["name"],
};
const OTHER = { ...PATIENT, id: "p-2", uhid: "U00110029", name: "Sunita Devi", administrativeGender: "female", hasPhoto: false };

type Calls = {
  patches: Record<string, unknown>[];
  abandons: { id: string; reason: string }[];
  photoGets: string[];
  reclassifies: { visitType: string; reason: string }[];
};

function mount(calls: Calls, opts: { storedPhoto?: boolean; searchItems?: unknown[]; freeQuote?: boolean } = {}): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: {
        hospital: [
          "opd.visits.open", "patients.register", "patients.update", "billing.invoice.issue",
          "membership.instrument.recognise",
        ],
        scoped: { department: {}, floor: {} },
      },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: opts.searchItems ?? [PATIENT] },
    "GET /api/patients/p-1": { patient: { dob: "1984-01-01", phone: "9100000000", addressLine: "12 Mall Road" } },
    "GET /api/patients/p-2": { patient: { dob: "1990-01-01", phone: "9100000002", addressLine: "" } },
    "GET /api/patients/p-1/photo": (): unknown => {
      calls.photoGets.push("p-1");
      if (opts.storedPhoto !== true) throw new Error("no photo");
      return { mimeType: "image/jpeg", imageBase64: "QUJD" };
    },
    "GET /api/patients/p-2/photo": (): unknown => { calls.photoGets.push("p-2"); throw new Error("no photo"); },
    "PATCH /api/patients/p-1": (init?: RequestInit) => {
      calls.patches.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return { patient: { id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000", dob: "1984-01-01", addressLine: "12 Mall Road" } };
    },
    "GET /api/patients/abha/capability": { configured: false, canRecord: true, canCreate: false, canVerify: false, reason: "t" },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [{ id: "d-1", name: "Cardiology", code: "CARD" }] },
    "GET /api/opd/queues/summary": {
      items: [{
        doctor: {
          id: "doc-1", userId: "u-doc", displayName: "Dr. Verma", registrationNo: null,
          departmentId: "d-1", specialty: null, active: true,
          createdBy: "x", createdAt: "2020-01-01T00:00:00.000Z", updatedBy: "x", updatedAt: "2020-01-01T00:00:00.000Z",
        },
        sessionId: "s-1", status: "open", waitingCount: 1, waitingVitalsCount: 0, nowServing: null,
        scheduledToday: true, roomCode: "R1", avgConsultMinutes: 10, onLeaveToday: false,
      }],
    },
    "GET /api/opd/continuity": { anchor: null },
    "POST /api/opd/walk-in": {
      encounter: { id: "e-1", patientId: "p-1", visitNo: "V1", departmentId: "d-1", doctorId: "doc-1", status: "open" },
      queueEntry: { id: "q-1", tokenNo: 7 }, tokenNo: 7, sessionId: "s-1", roomId: null,
      visitType: "walk_in", doctorScheduledToday: true, patientId: "p-1", registered: false,
    },
    "POST /api/opd/visits/e-1/reclassify": (init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}")) as { visitType: string; reason: string };
      calls.reclassifies.push(b);
      return { encounter: { id: "e-1", visitType: b.visitType } };
    },
    "POST /api/opd/visits/e-1/abandon": (init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}")) as { reason: string };
      calls.abandons.push({ id: "e-1", reason: b.reason });
      return { encounter: { id: "e-1", status: "abandoned" } };
    },
    /*
      A REAL `WireFeeQuote`, because `billOf` walks `quote.draft.lines`. An earlier fixture here
      omitted `draft` entirely: `quote.draft === null` was false (it was UNDEFINED), so the fold ran
      straight into `undefined.lines` and the desk threw "Something went wrong!" the moment the
      quote landed. A fixture narrower than the type it stands in for is a test that proves nothing
      and then fails somewhere unrelated.
    */
    "GET /api/billing/visits/e-1/fee-quote": opts.freeQuote === true ? {
      encounterId: "e-1", visitType: "revisit", free: true, feeServiceId: null, draft: null,
      freeReason: { kind: "review_window", doctorName: "Dr. Verma", seenOn: "2026-08-30", windowEndsOn: "2026-09-29" },
      attributionCode: null,
    } : {
      encounterId: "e-1", visitType: "walk_in", free: false, feeServiceId: "svc-1",
      freeReason: null, attributionCode: null,
      draft: {
        tariffVersionId: "tv-1", intendedPayer: "self",
        lines: [{
          lineId: "l-1", serviceId: "svc-1", serviceName: "OPD consultation", category: "consult",
          qty: 1, unitPaise: 30_000, grossPaise: 30_000, regulatedClamp: null,
          candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 0,
          gst: { sacCode: "999312", rateBps: 0, exempt: true, exemptReason: "healthcare", cgstPaise: 0, sgstPaise: 0 },
          netPaise: 30_000,
        }],
        totals: {
          grossPaise: 30_000, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0,
          taxableTurnoverPaise: 0, exemptTurnoverPaise: 30_000, taxSummary: [],
          rawTotalPaise: 30_000, netPayablePaise: 30_000, roundingPaise: 0,
        },
      },
    },
    "GET /api/billing/session/current": { session: null },
    "GET /api/billing/patients/p-1/dues": { items: [] },
    "GET /api/billing/patients/p-2/dues": { items: [] },
    "GET /api/me/desk": { stats: [] },
    "GET /api/membership/recognition": { patientId: "p-1", memberships: [], coupons: [], disclosure: "" },
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

function emptyCalls(): Calls { return { patches: [], abandons: [], photoGets: [], reclassifies: [] }; }

async function holdFirstHit(): Promise<void> {
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Ramesh");
  await waitFor(() => expect(screen.getAllByRole("button", { name: /this is them/i })[0]).toBeInTheDocument());
  await user.click(screen.getAllByRole("button", { name: /this is them/i })[0]!);
  await waitFor(() => expect(screen.getByPlaceholderText(/seene mein dard/)).toBeInTheDocument());
}

afterEach(() => { setToken(null); });

describe("FD-15: the photo is read back, and belongs to the patient in hand", () => {
  it("a stored photo is fetched when the patient is held — saved but invisible is not saved", async () => {
    const calls = emptyCalls();
    mount(calls, { storedPhoto: true });
    await holdFirstHit();

    await waitFor(() => expect(calls.photoGets).toContain("p-1"));
    const img = await screen.findByTestId("photo-preview");
    expect(img).toHaveAttribute("src", "data:image/jpeg;base64,QUJD");
  });

  it("a patient with no photo on file shows the capture buttons, not an error", async () => {
    const calls = emptyCalls();
    mount(calls, { storedPhoto: false });
    await holdFirstHit();

    await waitFor(() => expect(calls.photoGets).toContain("p-1"));
    expect(screen.getByTestId("photo-upload")).toBeInTheDocument();
    expect(screen.queryByTestId("photo-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("photo-error")).not.toBeInTheDocument();
  });

  /**
   * ═══ WHAT THIS DOES AND DOES NOT PROVE, stated because a mutant forced the distinction ═══
   *
   * It proves the reachable property: take a different patient and the panel shows THAT patient's
   * photo state — here, no photo, because p-2 has none on file.
   *
   * It does NOT prove the `photo: null` guard inside `hold`, and it is labelled so rather than
   * dressed up. Deleting that guard leaves this test green, because the route this test takes goes
   * through `clearDesk`, which empties the whole session first. No route today reaches `hold`
   * carrying somebody else's face — the duplicate list's "this is them" passes a photo the clerk
   * just took of the person standing there. The guard is deliberate defence for the next caller
   * through that door, and claiming coverage it does not have would be worse than saying so.
   */
  it("taking a different patient shows that patient's photo state, not the last one's", async () => {
    const calls = emptyCalls();
    mount(calls, { storedPhoto: true, searchItems: [PATIENT, OTHER] });
    await holdFirstHit();
    await waitFor(() => expect(screen.getByTestId("photo-preview")).toBeInTheDocument());

    // clear the desk and take the OTHER patient, who has no photo on file
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: /clear desk/i }));
    await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Sunita");
    await waitFor(() => expect(screen.getAllByRole("button", { name: /this is them/i }).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole("button", { name: /this is them/i })[1]!);

    await waitFor(() => expect(calls.photoGets).toContain("p-2"));
    expect(screen.queryByTestId("photo-preview")).not.toBeInTheDocument();
  });
});

describe("FD-15: correcting what was typed, from any stage", () => {
  it("the register dot opens the correction sheet for somebody who already has a UHID", async () => {
    const calls = emptyCalls();
    mount(calls);
    await holdFirstHit();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("flow-dot-register"));
    // the correction sheet, NOT the enrolment form that would mint a second UHID
    expect(await screen.findByTestId("amend-age")).toBeInTheDocument();
    expect(screen.queryByTestId("reg-submit")).not.toBeInTheDocument();
  });

  it("a mistyped age is corrected as an estimated dob, with a reason, and no second UHID", async () => {
    const calls = emptyCalls();
    mount(calls);
    await holdFirstHit();
    const user = userEvent.setup({ delay: null });

    // noticed at the APPOINTMENT stage, which is where the owner said it surfaces
    await user.click(screen.getByTestId("flow-dot-register"));
    const age = await screen.findByTestId("amend-age");
    await user.clear(age);
    await user.type(age, "36");

    // the reason picker appears only because a Class I field moved
    expect(screen.getByTestId("amend-reason-row")).toBeInTheDocument();
    await user.click(screen.getByTestId("amend-save"));

    await waitFor(() => expect(calls.patches).toHaveLength(1));
    const body = calls.patches[0]!;
    expect(body["dobEstimated"]).toBe(true);
    expect(body["reasonClass"]).toBe("clerical_error");
    const year = new Date().getUTCFullYear() - 36;
    expect(String(body["dob"])).toContain(String(year));
    // nothing registered a second person
    expect(calls.patches).toHaveLength(1);
  });

  /* A phone fix is Class II and owes no reason — making a clerk justify it trains them to click through. */
  it("a phone-only correction asks for no reason and sends none", async () => {
    const calls = emptyCalls();
    mount(calls);
    await holdFirstHit();
    const user = userEvent.setup({ delay: null });

    await user.click(screen.getByTestId("flow-dot-register"));
    const phone = await screen.findByTestId("amend-phone");
    await user.clear(phone);
    await user.type(phone, "9100000009");

    expect(screen.queryByTestId("amend-reason-row")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("amend-save"));

    await waitFor(() => expect(calls.patches).toHaveLength(1));
    expect(calls.patches[0]!["phone"]).toBe("9100000009");
    expect("reasonClass" in calls.patches[0]!).toBe(false);
  });
});

describe("FD-15: changing the doctor from the bill", () => {
  async function toBill(): Promise<void> {
    await holdFirstHit();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("propose-assign"));
    await waitFor(() => expect(screen.getByTestId("change-doctor")).toBeInTheDocument());
  }

  it("abandons the seating ON THE SERVER and returns to the appointment with the patient still in hand", async () => {
    const calls = emptyCalls();
    mount(calls);
    await toBill();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("change-doctor"));

    // the token is cancelled server-side — not merely forgotten by this screen
    await waitFor(() => expect(calls.abandons).toHaveLength(1));
    expect(calls.abandons[0]!.id).toBe("e-1");
    expect(calls.abandons[0]!.reason).toContain("doctor changed");

    // back at the appointment, with the SAME person — nothing re-typed, no second UHID
    await waitFor(() => expect(screen.getByPlaceholderText(/seene mein dard/)).toBeInTheDocument());
    expect(screen.getByText("Ramesh Kumar")).toBeInTheDocument();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-18 — THE BILLING OVERRIDE, ON THE SCREEN
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling 2026-09-04: *"re-classify the visit, not the price"* and *"cashier alone, fully
 * audited"*. What matters on this side is that the clerk sends a CORRECTION and never a discount,
 * that a reason is mandatory, and that the control disappears once a bill exists — because after
 * that it would change the next quote and leave the issued bill untouched, which would let a clerk
 * believe they had fixed something they had not.
 */
describe("FD-18: correcting a misread visit type from the bill", () => {
  async function toBill(calls: Calls): Promise<void> {
    mount(calls);
    await holdFirstHit();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("propose-assign"));
    await waitFor(() => expect(screen.getByTestId("reclassify-open")).toBeInTheDocument());
  }

  it("sends a visit-type correction with a reason — no discount, no category", async () => {
    const calls = emptyCalls();
    await toBill(calls);
    const user = userEvent.setup({ delay: null });

    await user.click(screen.getByTestId("reclassify-open"));
    await user.click(screen.getByTestId("reclassify-revisit"));
    await user.type(screen.getByTestId("reclassify-reason"), "seen here on 28 Aug, consult never closed");
    await user.click(screen.getByTestId("reclassify-submit"));

    await waitFor(() => expect(calls.reclassifies).toHaveLength(1));
    expect(calls.reclassifies[0]).toEqual({
      visitType: "revisit", reason: "seen here on 28 Aug, consult never closed",
    });
  });

  it("refuses a correction with no reason, and posts nothing", async () => {
    const calls = emptyCalls();
    await toBill(calls);
    const user = userEvent.setup({ delay: null });

    await user.click(screen.getByTestId("reclassify-open"));
    await user.type(screen.getByTestId("reclassify-reason"), "   ");
    await user.click(screen.getByTestId("reclassify-submit"));

    expect(await screen.findByTestId("reclassify-error")).toBeInTheDocument();
    expect(calls.reclassifies).toHaveLength(0);
  });

  /**
   * THE MIRROR IMAGE OF THE OWNER'S CASE, and the one a surviving mutant caught. A visit the
   * classifier wrongly marked `revisit` quotes FREE — and `moneyTaken` is true for any free quote,
   * so gating the override on it would hide the control on exactly the visits the hospital is about
   * to not charge for. Nothing has been invoiced or settled; the correction must still be offered.
   */
  it("is still offered on a FREE quote — a wrongly-free visit must be correctable too", async () => {
    const calls = emptyCalls();
    mount(calls, { freeQuote: true });
    await holdFirstHit();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("propose-assign"));

    /*
      WAIT FOR THE FREE QUOTE TO LAND FIRST. Asserting the control straight after the click passed
      whatever the guard said, because `moneyTaken` reads `quote.data`, which was still undefined —
      the assertion ran before the thing it was meant to be sensitive to existed. Anchoring on the
      free line makes the test actually see a free bill.
    */
    await waitFor(() => { expect(screen.getAllByText(/free till 2026-09-29/).length).toBeGreaterThan(0); });
    expect(screen.getByTestId("reclassify-open")).toBeInTheDocument();
  });
});
