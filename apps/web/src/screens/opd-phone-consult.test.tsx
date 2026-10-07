import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpdSets, PhoneConsultAdmin } from "./opd-phone-consult";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";

/**
 * ═══ THE PHONE CONSULT'S TWO WEB SURFACES (decisions 0048 and 0049) ═══
 *
 *   · a starter set is READ IN FULL before it is signed, only its unit head is offered the
 *     signature, and a doctor's own set is offered to the department with the same lines;
 *   · the owner's panel has TWO switches (voice, suggestions), says the honest sentence about a
 *     spoken name, and shows counts — never a transcript.
 */
const LINE = { drug: "Paracetamol 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", medicineId: "m-para" };
const set = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "s1", scope: "doctor", name: "Viral fever", departmentId: null, departmentName: null,
  body: { lines: [LINE], tests: [{ serviceId: "svc-cbc", code: "CBC", name: "Complete blood count" }], advice: "Plenty of fluids", reviewDays: 5 },
  mine: true, signed: false, signedByName: null, signedAt: null, maySign: false, ...over,
});
const calls = (method: string, url: string): { body: string }[] =>
  vi.mocked(fetch).mock.calls.filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0] === url)
    .map(([, init]) => ({ body: typeof init?.body === "string" ? init.body : "" }));
const ME = { actor: { type: "user", id: "u-d" }, permissions: { hospital: ["opd.consult", "opd.masters.manage", "opd.masters.read"], scoped: { department: {}, floor: {} } } };
const STATUS = { enabled: true, suggestionsEnabled: true, model: "gpt-4o-transcribe", dailyMinutesCap: 120, configured: true, maxSeconds: 60, usedSecondsToday: 300, why: null };
const METER = {
  status: STATUS, days: [{ day: "2026-10-07", minutes: 5, notes: 9 }],
  doctors: [{ userId: "u-9", name: "Dr Chandan Kumar", weekStart: "2026-10-05", notes: 9, minutes: 5, changedShare: 0.12 }],
  signals: { suggestions: [{ source: "voice", accepted: 4, dismissed: 2, manual: 0 }], misses: [{ kind: "medicine", term: "zerodol sp", times: 3, lastAt: "2026-10-07T05:00:00.000Z" }] },
};
const LASA = { items: [{ id: "lasa_std_01", nameA: "hydralazine", nameB: "hydroxyzine", active: true, reviewed: false, reviewedAt: null }] };

describe("the phone consult on the web", () => {
  beforeEach(() => { setToken("t"); });

  it("a set is written out line by line; its author offers it to the department with exactly those lines", async () => {
    stubFetch({
      "GET /api/auth/me": ME,
      "GET /api/opd/rx-sets": { items: [set({})], headOf: [], departmentId: "dep-1" },
      "POST /api/opd/rx-sets": { setId: "s9" },
    });
    renderWithProviders(<OpdSets />);
    const card = await screen.findByTestId("set-s1");
    expect(within(card).getByText("Paracetamol 500 mg Tablet · 1 tab · TDS · 5 days · after food")).toBeInTheDocument();
    expect(within(card).getByText(/Complete blood count/)).toBeInTheDocument();
    expect(screen.getByTestId("sets-no-starters")).toBeInTheDocument();
    expect(screen.queryByTestId("set-sign-s1")).toBeNull(); // a doctor's own set needs nobody's signature
    await userEvent.click(screen.getByTestId("set-offer-s1"));
    await waitFor(() => expect(calls("POST", "/api/opd/rx-sets")).toHaveLength(1));
    expect(JSON.parse(calls("POST", "/api/opd/rx-sets")[0]!.body)).toEqual({ scope: "department", departmentId: "dep-1", name: "Viral fever", body: set({}).body });
  });

  it("an unsigned starter says who can see it; only the unit head is offered the signature", async () => {
    const starter = set({ id: "d1", scope: "department", departmentId: "dep-1", departmentName: "General Medicine", mine: true });
    stubFetch({ "GET /api/auth/me": ME, "GET /api/opd/rx-sets": { items: [starter], headOf: [], departmentId: "dep-1" } });
    const first = renderWithProviders(<OpdSets />);
    expect(await screen.findByTestId("set-state-d1")).toHaveTextContent("not signed — only you and the unit head see this");
    expect(screen.queryByTestId("set-sign-d1")).toBeNull();
    first.unmount();

    stubFetch({
      "GET /api/auth/me": ME,
      "GET /api/opd/rx-sets": { items: [{ ...starter, mine: false, maySign: true }], headOf: ["dep-1"], departmentId: "dep-1" },
      "POST /api/opd/rx-sets/d1/sign": { ok: true },
    });
    renderWithProviders(<OpdSets />);
    await userEvent.click(await screen.findByTestId("set-sign-d1"));
    await waitFor(() => expect(calls("POST", "/api/opd/rx-sets/d1/sign")).toHaveLength(1));
  });

  it("the owner's panel: two switches, the honest sentence about a spoken name, counts and words — and a pair to confirm", async () => {
    stubFetch({
      "GET /api/auth/me": ME,
      "GET /api/opd/consult/voice/meter": METER,
      "GET /api/opd/consult/lasa": LASA,
      "PUT /api/opd/consult/voice/settings": STATUS,
      "PUT /api/opd/consult/lasa/lasa_std_01": { ok: true },
    });
    renderWithProviders(<PhoneConsultAdmin />);
    expect(await screen.findByTestId("voice-state")).toHaveTextContent("Voice is on.");
    const honest = screen.getByTestId("voice-honest");
    expect(honest).toHaveTextContent("No name, UHID, phone or address is sent as data.");
    expect(honest).toHaveTextContent("A name the doctor speaks travels in the audio to OpenAI");
    expect(screen.getByTestId("phone-consult-admin")).not.toHaveTextContent(/no (patient )?name (ever )?leaves/i);
    expect(screen.getByText("Dr Chandan Kumar")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("zerodol sp")).toBeInTheDocument();
    expect(screen.getByText("awaiting pharmacist")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("suggestions-enabled"));
    await waitFor(() => expect(calls("PUT", "/api/opd/consult/voice/settings")).toHaveLength(1));
    expect(JSON.parse(calls("PUT", "/api/opd/consult/voice/settings")[0]!.body)).toEqual({ suggestionsEnabled: false });
    await userEvent.click(screen.getByTestId("voice-enabled"));
    await waitFor(() => expect(calls("PUT", "/api/opd/consult/voice/settings")).toHaveLength(2));
    expect(JSON.parse(calls("PUT", "/api/opd/consult/voice/settings")[1]!.body)).toEqual({ enabled: false });
    await userEvent.click(screen.getByTestId("lasa-confirm-lasa_std_01"));
    await waitFor(() => expect(calls("PUT", "/api/opd/consult/lasa/lasa_std_01")).toHaveLength(1));
  });

  it("with no key on the server the panel says so in words", async () => {
    stubFetch({
      "GET /api/auth/me": ME,
      "GET /api/opd/consult/voice/meter": { ...METER, status: { ...STATUS, configured: false, why: "not_configured" }, days: [], doctors: [], signals: { suggestions: [], misses: [] } },
      "GET /api/opd/consult/lasa": { items: [] },
    });
    renderWithProviders(<PhoneConsultAdmin />);
    expect(await screen.findByTestId("voice-state")).toHaveTextContent("Voice is off: the OpenAI key file is not on the server.");
    expect(screen.getByTestId("voice-no-use")).toBeInTheDocument();
  });
});
