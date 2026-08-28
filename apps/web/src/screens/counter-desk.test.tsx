import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CounterDesk } from "./counter-desk";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";

type Reply = { status: number; body: unknown };
type Handler = Reply | ((callIndex: number) => Reply);

/**
 * `stubFetch` answers 200 to everything, so it cannot produce the 409 the duplicate warning is —
 * the `billing-counter.test.tsx` precedent for a direct, status-aware stub.
 */
function mockRoutes(handlers: Record<string, Handler>): void {
  const counts: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      counts[key] = (counts[key] ?? 0) + 1;
      const reply = typeof handler === "function" ? handler(counts[key]! - 1) : handler;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status, headers: { "Content-Type": "application/json" },
      });
    }),
  );
}
const ok = (body: unknown): Reply => ({ status: 200, body });

/**
 * PLAN 07b T3 — THE COUNTER.
 *
 * The measured cost of the simplest walk-in was three route changes, three searches for the same
 * person and a hand-typed visit id. These assertions defend the four properties that make this one
 * screen worth having rather than a fourth place to search from.
 */
const DEPARTMENTS = [{ id: "dep-1", code: "MED", name: "General medicine", active: true }];
const SUMMARY = [{
  doctor: { id: "doc-1", displayName: "Dr Meera Rao", departmentId: "dep-1", active: true },
  sessionId: "sess-1", status: "in", waitingCount: 3, waitingVitalsCount: 0,
  nowServing: 4, scheduledToday: true, roomCode: "12",
}];
const SEARCH_HIT = { id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", sex: "female", dob: null };
const WALK_IN = {
  tokenNo: 11, sessionId: "sess-1", roomId: "room-1", visitType: "new", doctorScheduledToday: true,
  patientId: "p-1", registered: false,
  encounter: { id: "enc-1", visitNo: "V2608180011", patientId: "p-1" },
};
const CHARGEABLE_QUOTE = {
  encounterId: "enc-1", visitType: "new", free: false, feeServiceId: "svc-1",
  draft: {
    lines: [{ lineId: "fee", serviceId: "svc-1", qty: 1 }],
    totals: { netPayablePaise: 30000 },
  },
};

function base(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/auth/me": ok({ actor: { type: "user", id: "u-1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }),
    "GET /api/opd/departments": ok({ items: DEPARTMENTS }),
    "GET /api/opd/queues/summary": ok({ items: SUMMARY }),
    "GET /api/patients/search": ok({ items: [SEARCH_HIT] }),
    "POST /api/opd/walk-in": ok(WALK_IN),
    "GET /api/billing/sessions/current": ok({ session: { id: "s-1", status: "open" } }),
    "GET /api/patients/p-1/qr": ok({ payload: "pt1.abc", uhid: "HMS0000001234", name: "Asha Devi", sex: "female", dob: null }),
    ...extra,
  };
}

async function pickPatientAndDoctor(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Search"), "98765");
  await user.click(await screen.findByRole("button", { name: /Asha Devi/ }));
  await user.selectOptions(await screen.findByTestId("department"), "dep-1");
  await user.selectOptions(await screen.findByTestId("doctor"), "doc-1");
}

describe("CounterDesk (07b T3)", () => {
  beforeEach(() => { sessionStorage.clear(); setToken("test-token"); });

  /**
   * A1 — THE WHOLE POINT. One search, no route change, and the visit is open. Before this the same
   * journey cost three searches across three screens.
   */
  it("A1: a returning walk-in is found once and the visit opens on this screen", async () => {
    mockRoutes(base({ "GET /api/billing/visits/enc-1/fee-quote": ok(CHARGEABLE_QUOTE) }));
    renderWithProviders(<CounterDesk />);
    const user = userEvent.setup();

    await pickPatientAndDoctor(user);
    await user.click(screen.getByTestId("open-visit"));

    expect(await screen.findByTestId("token")).toHaveTextContent("11");
    expect(screen.getByTestId("visit-no")).toHaveTextContent("V2608180011");
    // the patient is in hand, so nothing downstream has to find them again
    expect(JSON.parse(sessionStorage.getItem("hmis.inHand") ?? "{}"))
      .toMatchObject({ patientId: "p-1", encounterId: "enc-1" });
  });

  /**
   * A2 — DD2's three exits, named. A free revisit and a paid visit look nothing alike to the
   * patient, and a screen that says the same thing for both leaves the clerk to guess.
   */
  it("A2: a FREE revisit says so and offers no payment step", async () => {
    mockRoutes(base({
      "GET /api/billing/visits/enc-1/fee-quote": ok({ encounterId: "enc-1", visitType: "revisit", free: true, feeServiceId: null, draft: null }),
    }));
    renderWithProviders(<CounterDesk />);
    const user = userEvent.setup();
    await pickPatientAndDoctor(user);
    await user.click(screen.getByTestId("open-visit"));

    expect(await screen.findByTestId("exit-free")).toBeInTheDocument();
    expect(screen.queryByTestId("collect")).toBeNull();
    expect(screen.queryByTestId("settle")).toBeNull();
  });

  it("A2b: a chargeable visit collects, then names the settled exit", async () => {
    mockRoutes(base({
      "GET /api/billing/visits/enc-1/fee-quote": ok(CHARGEABLE_QUOTE),
      "POST /api/billing/invoices": ok({
        invoiceId: "inv-1", invoiceNo: "INV-1", totals: { netPayablePaise: 30000 },
        receiptId: "r-1", receiptNo: "R-1", allocatedPaise: 30000, unallocatedPaise: 0,
        creditExtended: false, settlement: { state: "settled", outstandingPaise: 0 }, warnings: [],
      }),
    }));
    renderWithProviders(<CounterDesk />);
    const user = userEvent.setup();
    await pickPatientAndDoctor(user);
    await user.click(screen.getByTestId("open-visit"));

    await screen.findByTestId("collect");
    await user.click(screen.getByTestId("settle"));
    expect(await screen.findByTestId("exit-settled")).toBeInTheDocument();
  });

  /**
   * A3 — the duplicate warning reaches the clerk as NAMES, not a refusal code, and the override is
   * one button. DD8: it is a warning a human may overrule, never a gate.
   */
  it("A3: a near-match is shown with its candidates and can be overridden", async () => {
    mockRoutes(base({
      "GET /api/billing/visits/enc-1/fee-quote": ok(CHARGEABLE_QUOTE),
      "POST /api/opd/walk-in": (i) => (i === 0
        ? {
          status: 409,
          body: {
            statusCode: 409, code: "duplicate_suspected", message: "1 match",
            detail: { candidates: [{ id: "p-9", uhid: "HMS0000009999", name: "Asha Devi" }] },
          },
        }
        : ok(WALK_IN)),
    }));
    renderWithProviders(<CounterDesk />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("register-new"));
    await user.type(screen.getByTestId("new-name"), "Asha Devi");
    await user.selectOptions(await screen.findByTestId("department"), "dep-1");
    await user.selectOptions(await screen.findByTestId("doctor"), "doc-1");
    await user.click(screen.getByTestId("open-visit"));

    const warning = await screen.findByTestId("duplicate-warning");
    expect(warning).toHaveTextContent("HMS0000009999");
    await user.click(screen.getByTestId("register-anyway"));
    await waitFor(() => { expect(screen.getByTestId("token")).toBeInTheDocument(); });
  });

  /**
   * A4 — the counter ENDS AT PAYMENT (owner ruling R-1). Vitals are dedicated staff's work, and a
   * counter that could record them would quietly become the place they get recorded badly.
   */
  it("A4: the screen never posts vitals and never moves the encounter past waiting_vitals", async () => {
    // A FREE revisit is used so the walk-in reaches one of DD2's exits without a payment step; the
    // handoff deliberately does NOT appear before an exit is reached, because R-2 is that nobody
    // passes the counter unbilled and a "send to vitals" line before payment would contradict it.
    mockRoutes(base({
      "GET /api/billing/visits/enc-1/fee-quote": ok({ encounterId: "enc-1", visitType: "revisit", free: true, feeServiceId: null, draft: null }),
    }));
    renderWithProviders(<CounterDesk />);
    const user = userEvent.setup();
    await pickPatientAndDoctor(user);
    await user.click(screen.getByTestId("open-visit"));
    await screen.findByTestId("token");

    const urls = vi.mocked(fetch).mock.calls.map(([i]) => String(i));
    expect(urls.filter((u) => u.includes("/vitals"))).toEqual([]);
    expect(urls.filter((u) => u.includes("/consult"))).toEqual([]);
    // and the handoff is a sentence, not a control
    expect(screen.getByTestId("handoff")).toBeInTheDocument();
  });

  /**
   * PLAN 07b T9 — ONE PIECE OF PAPER. `.print-doc` is positioned `fixed` at the origin, so a token
   * slip and an invoice mounted as siblings OVERPRINT each other rather than making two pages. The
   * count assertion is the one that would catch a later author mounting a second printable.
   */
  describe("the printed slip (T9)", () => {
    it("prints exactly ONE document, carrying both the token and the fee", async () => {
      mockRoutes(base({
        "GET /api/billing/visits/enc-1/fee-quote": ok(CHARGEABLE_QUOTE),
        "POST /api/billing/invoices": ok({
          invoiceId: "inv-1", invoiceNo: "INV-1", totals: { netPayablePaise: 30000 },
          receiptId: "r-1", receiptNo: "R-1", allocatedPaise: 30000, unallocatedPaise: 0,
          creditExtended: false, settlement: { state: "settled", outstandingPaise: 0 }, warnings: [],
        }),
      }));
      const { container } = renderWithProviders(<CounterDesk />);
      const user = userEvent.setup();
      await pickPatientAndDoctor(user);
      await user.click(screen.getByTestId("open-visit"));
      await screen.findByTestId("collect");
      await user.click(screen.getByTestId("settle"));

      await screen.findByTestId("slip-fee");
      expect(container.querySelectorAll(".print-doc")).toHaveLength(1);
      expect(screen.getByTestId("slip-token")).toHaveTextContent("11");
      expect(screen.getByTestId("slip-visit-no")).toHaveTextContent("V2608180011");
    });

    it("a free follow-up prints no fee section — a printed zero invites the question it answers", async () => {
      mockRoutes(base({
        "GET /api/billing/visits/enc-1/fee-quote": ok({ encounterId: "enc-1", visitType: "revisit", free: true, feeServiceId: null, draft: null }),
      }));
      const { container } = renderWithProviders(<CounterDesk />);
      const user = userEvent.setup();
      await pickPatientAndDoctor(user);
      await user.click(screen.getByTestId("open-visit"));

      await screen.findByTestId("slip-free");
      expect(screen.queryByTestId("slip-fee")).toBeNull();
      expect(container.querySelectorAll(".print-doc")).toHaveLength(1);
    });
  });

  /**
   * PLAN 07b T4 / DD5 — the drawer is checked ON MOUNT. Before this the clerk found out at the
   * payment step, having already registered the patient and opened the visit: a half-done walk-in
   * caused purely by the order the checks happened in.
   */
  describe("the drawer precondition (T4)", () => {
    it("a closed drawer blocks the walk-in before any work is done", async () => {
      mockRoutes(base({ "GET /api/billing/sessions/current": ok({ session: null }) }));
      renderWithProviders(<CounterDesk />);
      const user = userEvent.setup();
      expect(await screen.findByTestId("drawer-closed")).toBeInTheDocument();
      await pickPatientAndDoctor(user);
      expect(screen.getByTestId("open-visit")).toBeDisabled();
    });

    it("a LOCKED drawer says what is needed and by whom, rather than answering with a refusal code", async () => {
      mockRoutes(base({ "GET /api/billing/sessions/current": ok({ session: { id: "s-1", status: "closing" } }) }));
      renderWithProviders(<CounterDesk />);
      expect(await screen.findByTestId("drawer-locked")).toHaveTextContent(/variance approval/i);
    });

    it("an open drawer shows no blocker at all", async () => {
      mockRoutes(base());
      renderWithProviders(<CounterDesk />);
      await screen.findByTestId("band-find");
      expect(screen.queryByTestId("drawer-blocker")).toBeNull();
    });
  });
});
