import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../../lib/auth";
import { setToken } from "../../lib/api";
import { router } from "../../router";
import { stubFetch } from "../../test-utils";
import "../../lib/i18n";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-26 — THE THREE SEATS, DRIVEN THROUGH THE REAL ROUTER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This file REPLACES `screens/registration.test.tsx` (14 tests) and `screens/appointment.test.tsx`
 * (33), which went with the screens they guarded. It does not re-express all 47: most of what they
 * asserted — the duplicate gate, the guardian rule, the routing proposal, the slot board, the day's
 * book — is now Desk One's markup and is already guarded by the ten suites under this directory,
 * which the seats mount unchanged. Re-asserting it here would be a second copy of the tests to
 * match the second copy of the screens that was just deleted.
 *
 * WHAT IS NOT COVERED ANYWHERE ELSE, AND IS THEREFORE WHAT THIS FILE IS: the WIRING. `model.test.ts`
 * proves `stageForSeat` as a function, and `routing-rules.test.tsx` exists in this directory because
 * this lane has already been bitten once by exactly that gap — `walk-in-routing.ts` had passing unit
 * tests throughout the entire period the feature did not exist for a single user, because nothing
 * imported it. "Is it wired" is the only question a pure test cannot answer.
 *
 * Every test below drives `router` at a real path.
 */

const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
  administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: false,
  district: "Kanpur Nagar", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["name"],
};

function mount(at: string, extra: Record<string, unknown> = {}): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: {
        hospital: ["opd.visits.open", "patients.register", "opd.appointments.manage", "billing.invoice.issue"],
        scoped: { department: {}, floor: {} },
      },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [PATIENT] },
    "GET /api/patients/p-1": {
      patient: {
        id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", alias: null,
        administrativeGender: "male", dob: "1984-01-01", phone: "9100000000", addressLine: "12 Mall Road",
      },
    },
    "GET /api/patients/abha/capability": { configured: false, canRecord: true, canCreate: false, canVerify: false, reason: "t" },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [{ id: "d-1", name: "Cardiology", code: "CARD" }] },
    "GET /api/opd/queues/summary": { items: [] },
    "GET /api/opd/continuity": { anchor: null },
    "GET /api/opd/doctors": { items: [] },
    "GET /api/opd/appointments": { items: [] },
    "GET /api/billing/session/current": { session: null },
    "GET /api/me/desk": { stats: [] },
    "GET /api/membership/recognition": { card: null, coupons: [] },
    ...extra,
  });
  setToken("t-1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: [at] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** Search, then take the top hit — the two acts the find stage exists for. */
async function hold(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Ramesh");
  await waitFor(() => expect(screen.getAllByText("U00110012").length).toBeGreaterThan(0), { timeout: 3000 });
  await user.keyboard("{Enter}");
}

/** The router is a module singleton, so every test must navigate rather than trust the history. */
async function go(to: string): Promise<void> {
  await act(async () => { await router.navigate({ to: to as "/counter" }); });
}

beforeEach(() => {
  try { sessionStorage.clear(); } catch { /* a harness with no storage is still a valid harness */ }
});

describe("FD-26 · a seat IS Desk One", () => {
  it("all three routes mount the desk, and each says which chair it is", async () => {
    mount("/registration");
    for (const [path, seat] of [["/registration", "registration"], ["/appointment", "appointment"]] as const) {
      await go(path);
      await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
      expect(screen.getByTestId("desk-one")).toHaveAttribute("data-seat", seat);
    }
    /*
      `/billing` is the ruled exception: the cashier keeps its own body inside the seat frame, so it
      mounts `SeatShell` rather than the desk. It still carries `data-seat`, which is the attribute
      the global F4 handler reads.
    */
    await go("/billing");
    await waitFor(() => expect(screen.getByTestId("seat-shell")).toBeInTheDocument());
    expect(screen.getByTestId("seat-shell")).toHaveAttribute("data-seat", "billing");
  });

  it("`/counter` is NOT a seat — it keeps the sentence, not the three buttons", async () => {
    mount("/counter");
    await go("/counter");
    await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
    expect(screen.getByTestId("desk-one")).toHaveAttribute("data-seat", "counter");
    /*
      THE GUARD ON THE OWNER'S "DO NOT INTERFERE WITH DESK ONE". Every desk-one suite mounts
      `<DeskOne />` with no prop, so all of them stay green whatever the seat arms do — including if
      a branch were written the wrong way round. This asserts the counter arm directly.
    */
    expect(screen.queryByTestId("seat-to-registration")).not.toBeInTheDocument();
    expect(screen.getByText(/Registration · Appointment · Billing/)).toBeInTheDocument();
  });

  it("a seat draws ONE step in the flow strip; the counter still draws three", async () => {
    mount("/counter");
    await go("/counter");
    await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
    const user = userEvent.setup({ delay: null });
    await hold(user);
    await waitFor(() => expect(screen.getByTestId("flow-strip")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getAllByTestId(/^flow-dot-/)).toHaveLength(3);

    await go("/registration");
    await waitFor(() => expect(screen.getByTestId("desk-one")).toHaveAttribute("data-seat", "registration"));
    await hold(user);
    await waitFor(() => expect(screen.getByTestId("flow-strip")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getAllByTestId(/^flow-dot-/)).toHaveLength(1);
    expect(screen.getByTestId("flow-dot-register")).toBeInTheDocument();
  });
});

describe("FD-26 · how a clerk leaves a screen that owns the viewport", () => {
  it("the seat switcher is in the header, names all three, and marks the one you are on", async () => {
    mount("/appointment");
    await go("/appointment");
    await waitFor(() => expect(screen.getByTestId("seat-to-appointment")).toBeInTheDocument());
    expect(screen.getByTestId("seat-to-registration")).toHaveTextContent("Registration");
    expect(screen.getByTestId("seat-to-billing")).toHaveTextContent("Billing");
    /*
      `aria-current="page"` and nothing else: a clerk who cannot see the lit pill must still be told
      which chair they are in, and this is the one seat control a screen reader can read.
    */
    expect(screen.getByTestId("seat-to-appointment")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("seat-to-registration")).not.toHaveAttribute("aria-current");
  });

  it("clicking a sibling chair navigates there", async () => {
    mount("/registration");
    await go("/registration");
    await waitFor(() => expect(screen.getByTestId("seat-to-appointment")).toBeInTheDocument());
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("seat-to-appointment"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/appointment"));
  });

  /*
    THE SHELL RENDERS NOTHING UNDER A SEAT, and this is the FD-11 defect by name rather than a
    preference: `.d1` is `position: fixed; inset: 0`, so without `staticData.fullViewport` the app
    header and every nav link sit UNDERNEATH it — invisible, unclickable, and still in the tab order.
    A keyboard user tabs into a menu they cannot see. `shell-nav.test.tsx` pins the same property for
    `/counter`; this is the three seats inheriting it.
  */
  it("no app chrome renders beneath a seat — not hidden, absent", async () => {
    mount("/registration");
    await go("/registration");
    await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });
});

describe("FD-26 · the patient survives the walk between chairs", () => {
  it("holding somebody on one seat puts their ID — and only their ID — into the carrier", async () => {
    mount("/appointment");
    await go("/appointment");
    await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
    const user = userEvent.setup({ delay: null });
    await hold(user);

    await waitFor(() => expect(sessionStorage.getItem("hmis.inHand")).not.toBeNull(), { timeout: 3000 });
    const held = JSON.parse(sessionStorage.getItem("hmis.inHand") ?? "{}") as Record<string, unknown>;
    expect(held.patientId).toBe("p-1");
    /*
      NEVER A NAME. `lib/patient-in-hand.tsx`'s ruling, asserted here because this is the first
      writer added since it was made: a cached name outlives a merge and the record does not, so a
      label carried between screens is how a wrong-patient event becomes invisible.
    */
    expect(JSON.stringify(held)).not.toContain("Ramesh");
  });

  it("`/counter` writes NOTHING to the carrier — one clerk, one mount, no walk to survive", async () => {
    mount("/counter");
    await go("/counter");
    await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
    const user = userEvent.setup({ delay: null });
    await hold(user);
    await waitFor(() => expect(screen.getByTestId("flow-strip")).toBeInTheDocument());
    expect(sessionStorage.getItem("hmis.inHand")).toBeNull();
  });

  it("arriving at a seat with somebody in the carrier seats them without a second search", async () => {
    sessionStorage.setItem("hmis.inHand", JSON.stringify({ patientId: "p-1", encounterId: null }));
    mount("/appointment");
    await go("/appointment");
    await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
    /* The dossier fills from the id alone — no search box was touched. */
    await waitFor(() => expect(screen.getByText("Ramesh Kumar")).toBeInTheDocument(), { timeout: 3000 });
    /* The dossier prints age, sex and UHID as one mono line, so match the line rather than the id. */
    expect(screen.getByText(/U00110012/)).toBeInTheDocument();
  });
});

describe("FD-26 · the booking chair keeps what only it could do", () => {
  /*
    The rebooking rail is the one capability FD-25's `/appointment` had that Desk One's stage did
    not, and the reason that screen was allowed to exist: `listNeedsRebooking(true)` is the only
    caller anywhere of the audited, PHI-logged `contact=true` opt-in. It was ported rather than
    deleted with the screen — and it is asserted HERE because a component that renders on no route
    is the shape of defect this whole file exists to catch.
  */
  it("the rebooking rail is on the booking chair's future tab, and lists who to ring", async () => {
    mount("/appointment", {
      "GET /api/opd/appointments": {
        items: [{
          id: "a-9", patientId: "p-1", doctorId: "doc-1", serviceDate: "2999-01-01",
          slotStart: "2999-01-01T04:30:00.000Z", status: "needs_rebooking",
          patient: { name: "Ramesh Kumar", alias: null, phone: "9100000000" },
        }],
      },
    });
    await go("/appointment");
    await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
    const user = userEvent.setup({ delay: null });
    await hold(user);
    await waitFor(() => expect(screen.getByText("future appointment")).toBeInTheDocument(), { timeout: 3000 });
    await user.click(screen.getByText("future appointment"));

    const rail = await screen.findByTestId("rebooking-rail", undefined, { timeout: 3000 });
    /* The NUMBER is the point of the rail — a name without one is not a call anybody can make. */
    expect(within(rail).getByText("9100000000")).toBeInTheDocument();
  });

  it("and it is NOT on the counter — a list of other people to telephone is not counter work", async () => {
    mount("/counter", {
      "GET /api/opd/appointments": {
        items: [{
          id: "a-9", patientId: "p-1", doctorId: "doc-1", serviceDate: "2999-01-01",
          slotStart: "2999-01-01T04:30:00.000Z", status: "needs_rebooking",
          patient: { name: "Ramesh Kumar", alias: null, phone: "9100000000" },
        }],
      },
    });
    await go("/counter");
    await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
    const user = userEvent.setup({ delay: null });
    await hold(user);
    await waitFor(() => expect(screen.getByText("future appointment")).toBeInTheDocument(), { timeout: 3000 });
    await user.click(screen.getByText("future appointment"));
    await waitFor(() => expect(screen.getByTestId("book-department")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByTestId("rebooking-rail")).not.toBeInTheDocument();
  });
});
