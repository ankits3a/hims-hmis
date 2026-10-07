import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VisitCard } from "./visit-card";
import { renderWithProviders, stubFetch } from "../../test-utils";
import { setToken } from "../../lib/api";
import { todayIst } from "../../lib/opd-api";
import type { WireTimelineItem } from "../../lib/opd-api";

/**
 * ═══ OWNER 2026-10-07 — THE GUARDIAN CAME WITH THE REPORTS, AT THE FRONT DESK ═══
 *
 * The visit card offers "Patient not present — guardian with reports" on TODAY's REVISIT or RENEWAL
 * that is still waiting for vitals, and on nothing else (never a new visit). An unpaid renewal is
 * offered it and the refusal asks for billing (owner 2026-10-07). After the confirm it says what happened.
 */
const today = todayIst();
const item = (over: Partial<WireTimelineItem>): WireTimelineItem => ({
  encounterId: "e-9", visitNo: "V9", serviceDate: today, openedAt: new Date().toISOString(), status: "registered", visitType: "revisit",
  doctorId: "doc-1", doctorName: "Dr. Verma", departmentId: "d-1", departmentName: "Orthopaedics",
  diagnosis: null, icd10Code: null, prescriptionLineCount: 0, dangerFlagged: false, ...over,
});
const encounter = (over: Record<string, unknown>) => ({
  id: "e-9", visitNo: "V9", patientId: "p-1", serviceDate: today, status: "registered", visitType: "revisit", ...over,
});

function mount(detail: Record<string, unknown>, posted: unknown[]): void {
  let current = detail;
  stubFetch({
    "GET /api/auth/me": { actor: { type: "user", id: "u1" }, permissions: { hospital: ["opd.visits.open", "opd.visits.read"], scoped: { department: {}, floor: {} } } },
    "GET /api/opd/departments": { items: [{ id: "d-1", name: "Orthopaedics", code: "ORT", active: true }] },
    "GET /api/opd/queues/summary": { items: [] },
    "GET /api/print/jobs": { jobs: [] },
    "GET /api/billing/invoices": { items: [] },
    "GET /api/opd/visits/e-9": () => current,
    "POST /api/opd/visits/e-9/patient-absent": (init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      const patientAbsent = { relation: "mother", name: null, by: "u1", at: new Date().toISOString() };
      current = { ...current, encounter: encounter({ status: "waiting" }), patientAbsent };
      return { alreadyMarked: false, patientAbsent };
    },
  });
  setToken("t-1");
}

afterEach(() => { setToken(null); });

describe("Desk One's visit card — guardian with reports", () => {
  it("today's registered revisit offers it; confirm posts, and the card then says the patient is absent", async () => {
    const posted: unknown[] = [];
    mount({ encounter: encounter({}), patientAbsent: null, queueEntries: [], vitals: [], prescriptions: [] }, posted);
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<VisitCard encounterId="e-9" when={today} visit={item({})} />);
    const card = await screen.findByTestId("visit-card");
    await user.click(await within(card).findByTestId("visit-card-absent-open"));
    await user.selectOptions(within(card).getByTestId("visit-card-absent-relation"), "mother");
    await user.click(within(card).getByTestId("visit-card-absent-confirm"));
    await waitFor(() => expect(posted).toEqual([{ relation: "mother", name: null }]));
    expect(await within(card).findByTestId("visit-card-absent-notice"))
      .toHaveTextContent("Patient absent — guardian (Mother) brought reports. Vitals not taken.");
    expect(within(card).queryByTestId("visit-card-absent-open")).not.toBeInTheDocument();
  });

  it("a NEW visit does not offer it", async () => {
    mount({ encounter: encounter({ visitType: "new" }), patientAbsent: null, queueEntries: [], vitals: [], prescriptions: [] }, []);
    renderWithProviders(<VisitCard encounterId="e-9" when={today} visit={item({ visitType: "new" })} />);
    const card = await screen.findByTestId("visit-card");
    await waitFor(() => expect(within(card).getByTestId("visit-card-status")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(within(card).queryByTestId("visit-card-absent-open")).not.toBeInTheDocument();
  });

  it("a revisit already past the bay does not offer it", async () => {
    mount({ encounter: encounter({ status: "waiting" }), patientAbsent: null, queueEntries: [], vitals: [], prescriptions: [] }, []);
    renderWithProviders(<VisitCard encounterId="e-9" when={today} visit={item({ status: "waiting" })} />);
    const card = await screen.findByTestId("visit-card");
    await new Promise((r) => setTimeout(r, 50));
    expect(within(card).queryByTestId("visit-card-absent-open")).not.toBeInTheDocument();
  });

  it("today's registered RENEWAL offers it too; unpaid, the confirm is refused with the billing-first message", async () => {
    const posted: unknown[] = [];
    mount({ encounter: encounter({ visitType: "renewal" }), patientAbsent: null, queueEntries: [], vitals: [], prescriptions: [] }, []);
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const base = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/patient-absent")) {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ statusCode: 409, code: "consult_gate_refused", message: "this visit has not been billed yet — take the fee at the counter first" }), { status: 409 });
      }
      return base(input, init);
    });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<VisitCard encounterId="e-9" when={today} visit={item({ visitType: "renewal" })} />);
    const card = await screen.findByTestId("visit-card");
    await user.click(await within(card).findByTestId("visit-card-absent-open"));
    await user.selectOptions(within(card).getByTestId("visit-card-absent-relation"), "father");
    await user.click(within(card).getByTestId("visit-card-absent-confirm"));
    await waitFor(() => expect(posted).toEqual([{ relation: "father", name: null }]));
    expect(await within(card).findByTestId("visit-card-absent-error"))
      .toHaveTextContent("This visit has not been billed yet — take the fee at the counter first.");
    expect(within(card).queryByTestId("visit-card-absent-notice")).not.toBeInTheDocument();
  });
});
