import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../../lib/auth";
import { setToken } from "../../lib/api";
import { router } from "../../router";
import { stubFetch } from "../../test-utils";
import { base64Of } from "./photo";
import "../../lib/i18n";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-14 — THE TWO RAILS: WHAT THE LEFT COLUMN SAYS, AND THE SCHEMES RAIL AT BILLING
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-04: *"instead of showing texts 'Flow · F1 Register Appointment Bill' in the left
 * sidebar, show important info that would enhance the usability for the user. We can add
 * Camera/upload photo while registering new user in the left sidebar."* — and, pointing at the
 * "Three Seats, One Desk" artboard's `/billing`: *"check the left sidebar and right sidebar."*
 *
 * The artboard's billing body is three columns: a 290px rail of who is paying and what they owe,
 * the bill and tender in the middle, and a 296px SCHEMES rail. Desk One already had the left rail —
 * the dossier is that column on every stage — so what these tests pin is what was added to it (the
 * face, the outstanding balance) and the right rail that did not exist.
 */

const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
  administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: false,
  district: "Kanpur Nagar", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["name"],
};

/**
 * jsdom ships NO canvas, so `getContext` returns null and the real downscale path throws before it
 * can reach the server. These stubs are the smallest thing that lets the WIRING be tested — the
 * question here is "does a chosen file reach `PUT /patients/:id/photo`", not "does Chrome encode
 * JPEG". The size ladder in `downscaleToDataUrl` is exercised by the tiny URL this returns.
 */
function stubCanvas(): void {
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
    () => Promise.resolve({ width: 1200, height: 1600 });
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => undefined })) as never;
  HTMLCanvasElement.prototype.toDataURL = (() => "data:image/jpeg;base64,QUJD") as never;
}

function mount(opts: {
  photoPuts?: { id: string; body: string }[];
  dues?: { outstandingPaise: number }[];
  registered?: { body: unknown }[];
  memberships?: unknown[];
  coupons?: unknown[];
} = {}): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: {
        /*
          `membership.instrument.recognise` is REQUIRED for the schemes rail to hold anything: the
          recognition query is gated on it, and a clerk without it correctly sees "nothing
          recognised" rather than an invented card. Omitting it here made the rail look broken when
          it was behaving exactly as designed.
        */
        hospital: [
          "opd.visits.open", "patients.register", "billing.invoice.issue",
          "membership.instrument.recognise",
        ],
        scoped: { department: {}, floor: {} },
      },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [PATIENT] },
    "GET /api/patients/p-1": { patient: { dob: "1984-01-01", phone: "9100000000", addressLine: "12 Mall Road" } },
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
    "POST /api/opd/walk-in": {
      encounter: { id: "e-1", patientId: "p-1", visitNo: "V1", departmentId: "d-1", doctorId: "doc-1", status: "open" },
      queueEntry: { id: "q-1", tokenNo: 7 }, tokenNo: 7, sessionId: "s-1", roomId: null,
      visitType: "walk_in", doctorScheduledToday: true, patientId: "p-1", registered: false,
    },
    /*
      A REAL `WireFeeQuote`, because `billOf` walks `quote.draft.lines`. An earlier fixture here
      omitted `draft` entirely: `quote.draft === null` was false (it was UNDEFINED), so the fold ran
      straight into `undefined.lines` and the desk threw "Something went wrong!" the moment the
      quote landed. A fixture narrower than the type it stands in for is a test that proves nothing
      and then fails somewhere unrelated.
    */
    "GET /api/billing/visits/e-1/fee-quote": {
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
    "GET /api/opd/continuity": { anchor: null },
    "GET /api/billing/session/current": { session: null },
    "GET /api/billing/patients/p-1/dues": {
      items: (opts.dues ?? []).map((d, i) => ({
        invoiceId: `inv-${String(i)}`, invoiceNo: `I-${String(i)}`, patientId: "p-1",
        name: "Ramesh Kumar", restricted: false, alias: null,
        netPayablePaise: d.outstandingPaise, outstandingPaise: d.outstandingPaise,
      })),
    },
    "GET /api/me/desk": { stats: [] },
    "GET /api/membership/recognition": {
      patientId: "p-1",
      memberships: opts.memberships ?? [],
      coupons: opts.coupons ?? [],
      disclosure: "This hospital honours the card shown.",
    },
    "PUT /api/patients/p-1/photo": (init?: RequestInit) => {
      opts.photoPuts?.push({ id: "p-1", body: String(init?.body ?? "") });
      return { ok: true };
    },
    "PUT /api/patients/p-new/photo": (init?: RequestInit) => {
      opts.photoPuts?.push({ id: "p-new", body: String(init?.body ?? "") });
      return { ok: true };
    },
    "POST /api/patients": (init?: RequestInit) => {
      opts.registered?.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      /*
        THE BARE BODY, not `{status, body}`: `stubFetch` JSON-stringifies whatever a handler
        returns AS the response body. Wrapping it made `res.patient` undefined, the success path
        threw, and the photo upload after registration silently never ran — which is exactly the
        bug this test exists to catch, arriving first in the test's own scaffolding.
      */
      return {
        patient: {
          id: "p-new", uhid: "U00210140", name: "Asha Devi", phone: null,
          dob: "1990-01-01", addressLine: null,
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

async function openDesk(): Promise<void> {
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
}

async function holdPatient(): Promise<void> {
  await openDesk();
  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Ramesh");
  await waitFor(() => expect(screen.getByRole("button", { name: /this is them/i })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /this is them/i }));
  await waitFor(() => expect(screen.getByPlaceholderText(/seene mein dard/)).toBeInTheDocument());
}

afterEach(() => { setToken(null); });

describe("FD-14: the left column stops narrating the flow and starts carrying the patient", () => {
  it("the flow is a strip of dots, not a paragraph of stage names", async () => {
    mount();
    await holdPatient();

    // the affordance survives — every stage is still reachable from the column
    const strip = screen.getByTestId("flow-strip");
    expect(strip).toBeInTheDocument();
    expect(screen.getByTestId("flow-dot-register")).toBeInTheDocument();
    expect(screen.getByTestId("flow-dot-appointment")).toBeInTheDocument();
    expect(screen.getByTestId("flow-dot-bill")).toBeInTheDocument();

    // …and the lane jargon the owner objected to is gone from the column
    expect(strip.textContent).not.toMatch(/F1|F2|F3/);
  });

  it("a dot still navigates — the words went, the jump did not", async () => {
    mount();
    await holdPatient();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("flow-dot-bill"));
    await waitFor(() => expect(screen.getByText(/Nothing to bill yet/)).toBeInTheDocument());
  });

  /*
    The number that changes what the clerk says out loud BEFORE quoting today's figure. It lived
    only on `/billing/dues`, so finding it meant leaving the patient.
  */
  it("shows what the patient already owes, and says so when nothing is carried forward", async () => {
    mount({ dues: [{ outstandingPaise: 45_000 }, { outstandingPaise: 5_000 }] });
    await holdPatient();
    await waitFor(() => expect(screen.getByTestId("account-outstanding")).toHaveTextContent("500"));
    expect(screen.getByText(/travels onto this one/)).toBeInTheDocument();
  });

  it("a clear account renders zero as a fact rather than vanishing", async () => {
    mount({ dues: [] });
    await holdPatient();
    await waitFor(() => expect(screen.getByTestId("account-outstanding")).toBeInTheDocument());
    expect(screen.getByText("Nothing carried forward.")).toBeInTheDocument();
  });
});

describe("FD-14: the photo", () => {
  it("base64Of strips the data-URL preamble and leaves a bare payload", () => {
    expect(base64Of("data:image/jpeg;base64,QUJD")).toBe("QUJD");
    expect(base64Of("QUJD")).toBe("QUJD"); // already bare
  });

  it("offers upload and hides the camera when the machine has none", async () => {
    mount();
    await holdPatient();
    expect(screen.getByTestId("photo-upload")).toBeInTheDocument();
    // jsdom exposes no mediaDevices, which is also a real desktop with no webcam
    expect(screen.queryByTestId("photo-camera")).not.toBeInTheDocument();
  });

  it("a chosen file is downscaled, previewed and PUT against the patient in hand", async () => {
    stubCanvas();
    const photoPuts: { id: string; body: string }[] = [];
    mount({ photoPuts });
    await holdPatient();

    const user = userEvent.setup({ delay: null });
    const file = new File([new Uint8Array([1, 2, 3])], "face.jpg", { type: "image/jpeg" });
    await user.upload(screen.getByTestId("photo-file"), file);

    await waitFor(() => expect(screen.getByTestId("photo-preview")).toBeInTheDocument());
    await waitFor(() => expect(photoPuts).toHaveLength(1));
    expect(photoPuts[0]!.id).toBe("p-1");
    // the bare base64 travels, never the data URL preamble
    expect(JSON.parse(photoPuts[0]!.body)).toEqual({ imageBase64: "QUJD" });
  });

  /**
   * THE ORDER THAT MATTERS. During enrolment there is no patient to attach a face to — the UHID is
   * what registration is on its way to allocating — so the picture is HELD and uploaded the instant
   * the row exists. Posting it any earlier is posting it against nobody.
   */
  it("during enrolment the face is held, then uploaded against the UHID the moment it exists", async () => {
    stubCanvas();
    const photoPuts: { id: string; body: string }[] = [];
    const registered: { body: unknown }[] = [];
    mount({ photoPuts, registered });
    await openDesk();

    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByRole("button", { name: /new walk-in/i }));
    await waitFor(() => expect(screen.getByTestId("reg-name")).toBeInTheDocument());

    const file = new File([new Uint8Array([1, 2, 3])], "face.jpg", { type: "image/jpeg" });
    await user.upload(screen.getByTestId("photo-file"), file);
    await waitFor(() => expect(screen.getByTestId("photo-preview")).toBeInTheDocument());

    // nothing has been posted yet, because there is nobody to post it against
    expect(photoPuts).toHaveLength(0);

    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.click(screen.getByTestId("reg-submit"));

    await waitFor(() => expect(registered.length, "POST /patients never fired").toBe(1));
    await waitFor(() => expect(photoPuts.length, "photo never PUT after registration").toBe(1));
    expect(photoPuts[0]!.id).toBe("p-new");
  });
});

describe("FD-14: the schemes rail at billing", () => {
  const CARD = {
    instanceId: "m-1", planId: "pl-1", planTitle: "Sanjeevani Gold", cardCode: "C-1",
    status: "active", origin: "counter", verified: true, usable: true,
    validFrom: "2026-01-01", validTo: "2027-01-01", queuePerk: false,
    benefits: [{ benefitKey: "opd_discount", title: "20% off OPD consultation" }],
  };
  const EXPIRED = {
    ...CARD, instanceId: "m-2", planTitle: "Old Plan", status: "expired", usable: false,
    validTo: "2026-03-02T00:00:00.000Z",
  };

  /*
    A VISIT FIRST. `StageBill` returns "nothing to bill yet" before it draws anything when there is
    no encounter, and that is correct — so the rail is asserted on a real bill, which is the only
    state a clerk ever sees it in.
  */
  async function toBill(): Promise<void> {
    await holdPatient();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("propose-assign"));
    await waitFor(() => expect(screen.getByTestId("schemes-rail")).toBeInTheDocument());
  }

  it("renders the rail with the artboard's instruction, even with nothing on file", async () => {
    mount();
    await toBill();
    expect(screen.getByText("attach before you take the money")).toBeInTheDocument();
    expect(screen.getByTestId("schemes-none")).toBeInTheDocument();
    expect(screen.getByText(/do not stack/)).toBeInTheDocument();
  });

  it("shows a usable card with its benefit", async () => {
    mount({ memberships: [CARD] });
    await toBill();
    const card = await screen.findByTestId("scheme-card-m-1");
    expect(card).toHaveTextContent("Sanjeevani Gold");
    expect(card).toHaveTextContent("20% off OPD consultation");
  });

  /*
    A card that cannot be used TODAY is SHOWN saying so, never hidden. "Expired 2026-03-02" is
    something a clerk can tell the patient; a card that silently vanished is reported as a bug by
    the patient holding it.
  */
  it("a card that cannot be used says why, from the fields the server actually sends", async () => {
    mount({ memberships: [EXPIRED] });
    await toBill();
    const card = await screen.findByTestId("scheme-card-m-2");
    expect(card).toHaveTextContent("expired");
    expect(card).toHaveTextContent("2026-03-02");
  });

  it("a coupon that cannot be used carries the server's reason verbatim", async () => {
    mount({ coupons: [{ code: "DIWALI50", unusableReason: "already redeemed on 2 March" }] });
    await toBill();
expect(await screen.findByTestId("scheme-coupon-DIWALI50")).toHaveTextContent("already redeemed on 2 March");
  });
});
