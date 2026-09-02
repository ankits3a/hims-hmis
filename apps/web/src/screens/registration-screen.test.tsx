import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { AuthProvider } from "../lib/auth";
import { PatientInHandProvider } from "../lib/patient-in-hand";
import { renderWithProviders, stubFetch } from "../test-utils";
import { RegistrationScreen } from "./registration-screen";

// The C-18 dialog navigates with TanStack Router's useNavigate, which throws outside a
// <RouterProvider>. A component test mounts no router, so the module is mocked down to
// the single hook this screen consumes.
const navigate = vi.hoisted(() => vi.fn());
const routeSearch = vi.hoisted(() => ({ current: {} as { new?: boolean } }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => routeSearch.current,
}));

const HIT = {
  id: "p-1",
  uhid: "HMS0000001234",
  name: "Asha Devi",
  phone: "9876543210",
  sex: "female",
  dob: "1990-04-02",
  isConfidential: false,
  hasPhoto: true,
};

const SEARCH_PLACEHOLDER = /Phone number, UHID, or name/;

function fetchCalls(): { url: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    url: String(input),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : "",
  }));
}

async function openNewPatientForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "New patient (F2)" }));
  await screen.findByRole("heading", { name: "New patient" });
}

describe("RegistrationScreen", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    navigate.mockClear();
    routeSearch.current = {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("F2 (?new=true, keyboard.tsx): landing here from elsewhere in the app opens the new-patient form directly", async () => {
    routeSearch.current = { new: true };
    renderWithProviders(<RegistrationScreen />);

    expect(await screen.findByRole("heading", { name: "New patient" })).toBeInTheDocument();
    // The flag is one-shot: consuming it clears the URL via a replace-navigate so a later F2
    // press (undefined -> true again) can retrigger the form instead of being a same-value no-op.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/registration", search: {}, replace: true }),
    );
  });

  it("F2 pressed again while already on the search view still opens the form (search.new: undefined -> true)", async () => {
    // Built by hand (rather than renderWithProviders) so `rerender` can replay the SAME wrapped
    // component tree onto the SAME instance — the bug this covers is specifically the
    // already-mounted case, where the mount-time useState initializer never re-runs and only a
    // live effect can react to the new search value.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderTree = (): React.ReactElement => (
      <QueryClientProvider client={qc}>
        {/* FD-7 T3 — `PatientInHandProvider` added: the card stage now takes the new patient IN HAND
            before handing over to `/appointment`, and every authed screen renders inside this
            provider in production (`router.tsx`'s Shell). The hand-built tree has to mirror that,
            exactly as `renderWithProviders` does — a screen that passed its own suite while throwing
            in the app is the trap 07b T1 wrote that provider's docstring about. */}
        <AuthProvider>
          <PatientInHandProvider>
            <RegistrationScreen />
          </PatientInHandProvider>
        </AuthProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(renderTree());
    expect(screen.queryByRole("heading", { name: "New patient" })).toBeNull();

    // Simulates keyboard.tsx's navigate({ to: "/registration", search: { new: true } }) landing
    // while RegistrationScreen is already mounted — this is exactly the bug reported ("F2 does
    // nothing on this page").
    routeSearch.current = { new: true };
    rerender(renderTree());

    expect(await screen.findByRole("heading", { name: "New patient" })).toBeInTheDocument();
  });

  it("search-first: typed digits fire GET /patients/search and the hit renders as a row", async () => {
    stubFetch({
      "GET /api/patients/search": { items: [HIT] },
      "GET /api/patients/p-1/photo": { mimeType: "image/jpeg", imageBase64: "QUFB" },
    });
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();

    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "98765");

    expect(await screen.findByText("Asha Devi")).toBeInTheDocument();
    expect(screen.getByText(/HMS0000001234/)).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchCalls().some((c) => c.url === "/api/patients/search?q=98765")).toBe(true),
    );
  });

  it("C-18: choosing a hit opens the attach dialog with the stored photo large and both choices", async () => {
    stubFetch({
      "GET /api/patients/search": { items: [HIT] },
      "GET /api/patients/p-1/photo": { mimeType: "image/jpeg", imageBase64: "QUFB" },
    });
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();

    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "98765");
    await user.click(await screen.findByRole("button", { name: /Asha Devi/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Is this the same person?")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Yes — open this record" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "No — register new" })).toBeInTheDocument();
    // The photo is the whole point of the prompt: it must be the stored one, fetched as
    // base64 JSON and inlined (an <img> cannot carry a bearer token).
    await waitFor(() =>
      expect(dialog.querySelector('img[src="data:image/jpeg;base64,QUFB"]')).not.toBeNull(),
    );
  });

  it("C-18: 'No — register new' switches to the form with the searched phone prefilled", async () => {
    stubFetch({
      "GET /api/patients/search": { items: [HIT] },
      "GET /api/patients/p-1/photo": { mimeType: "image/jpeg", imageBase64: "QUFB" },
    });
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();

    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "98765");
    await user.click(await screen.findByRole("button", { name: /Asha Devi/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "No — register new" }));

    expect(await screen.findByRole("heading", { name: "New patient" })).toBeInTheDocument();
    expect(screen.getByLabelText("Mobile number")).toHaveValue("9876543210");
  });

  it("D-31: age under 18 reveals a REQUIRED guardian section and blocks submit without it", async () => {
    stubFetch({
      "POST /api/patients": { patient: { id: "p-new" }, guardianId: "g-1" },
      "GET /api/patients/p-new/qr": {
        payload: "1.p-new.3.6f2a9c", uhid: "HMS0000009998", name: "Bal Kumar", sex: "unknown", dob: null,
      },
    });
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();
    await openNewPatientForm(user);

    // Teeth: every other field of this fixture is valid on its own (name filled, sex/language
    // defaulted, no dob/age conflict), so with the minority rule absent it WOULD pass zod and
    // POST. Only the D-31 mirror can stop it.
    await user.type(screen.getByLabelText("Full name"), "Bal Kumar");
    expect(screen.queryByLabelText("Guardian name")).toBeNull();

    await user.type(screen.getByLabelText("Age (years)"), "10");
    expect(await screen.findByLabelText("Guardian name")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Register (Alt+S)" }));

    await waitFor(() =>
      expect(screen.getAllByRole("alert").map((a) => a.textContent)).toContain(
        "A guardian is required for minors",
      ),
    );
    expect(fetchCalls().some((c) => c.method === "POST")).toBe(false);

    // Teeth, decisively: the identical fixture posts the instant a guardian is supplied. Nothing
    // else in it was invalid, so only the D-31 rule can have been what blocked the submit.
    await user.type(screen.getByLabelText("Guardian name"), "Sunita Kumar");
    await user.click(screen.getByRole("button", { name: "Register (Alt+S)" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "POST")).toBe(true));
    const posted = fetchCalls().find((c) => c.method === "POST" && c.url === "/api/patients");
    const body = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
    expect(body.ageYears).toBe(10);
    expect(body.guardian).toEqual({ name: "Sunita Kumar", relationship: "father" });
  });

  it("D9: the promotional opt-in checkbox is unchecked by default and posts false when left alone", async () => {
    stubFetch({
      "POST /api/patients": { patient: { id: "p-new" }, guardianId: null },
      "GET /api/patients/p-new/qr": {
        payload: "1.p-new.3.6f2a9c", uhid: "HMS0000009997", name: "Leela Bai", sex: "unknown", dob: null,
      },
    });
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();
    await openNewPatientForm(user);

    const optIn = screen.getByLabelText("Promotional messages: opted in") as HTMLInputElement;
    expect(optIn.checked).toBe(false);

    await user.type(screen.getByLabelText("Full name"), "Leela Bai");
    await user.click(screen.getByRole("button", { name: "Register (Alt+S)" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "POST" && c.url === "/api/patients")).toBe(true));
    const posted = fetchCalls().find((c) => c.method === "POST" && c.url === "/api/patients")!;
    const body = JSON.parse(posted.body) as Record<string, unknown>;
    expect(body.promotionalOptIn).toBe(false);
  });

  it("D9: checking the promotional opt-in box posts promotionalOptIn: true", async () => {
    stubFetch({
      "POST /api/patients": { patient: { id: "p-new" }, guardianId: null },
      "GET /api/patients/p-new/qr": {
        payload: "1.p-new.3.6f2a9c", uhid: "HMS0000009996", name: "Meena Rao", sex: "unknown", dob: null,
      },
    });
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();
    await openNewPatientForm(user);

    await user.type(screen.getByLabelText("Full name"), "Meena Rao");
    await user.click(screen.getByLabelText("Promotional messages: opted in"));
    await user.click(screen.getByRole("button", { name: "Register (Alt+S)" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "POST" && c.url === "/api/patients")).toBe(true));
    const posted = fetchCalls().find((c) => c.method === "POST" && c.url === "/api/patients")!;
    const body = JSON.parse(posted.body) as Record<string, unknown>;
    expect(body.promotionalOptIn).toBe(true);
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     FD-7 T3 — REGISTRATION ENDS AT THE UHID, AND HANDS OVER
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  /** The stubs a registration needs to reach the card, plus whatever `auth/me` should answer. */
  function stubThroughToCard(me: unknown): void {
    stubFetch({
      "GET /api/auth/me": me,
      "GET /api/patients/search": { items: [] },
      "POST /api/patients": { patient: { id: "p-new" }, guardianId: null },
      "GET /api/patients/p-new/qr": {
        payload: "1.p-new.3.6f2a9c", uhid: "HMS0000009999", name: "Ravi Sharma", sex: "male", dob: "1988-02-11",
      },
    });
  }

  async function registerRavi(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await openNewPatientForm(user);
    await user.type(screen.getByLabelText("Full name"), "Ravi Sharma");
    await user.type(screen.getByLabelText("Mobile number"), "9876500011");
    await user.type(screen.getByLabelText("Age (years)"), "37");
    await user.click(screen.getByRole("button", { name: "Register (Alt+S)" }));
    await screen.findByText("HMS0000009999");
  }

  const CAN_BOOK = { actor: { type: "user", id: "u-1" }, permissions: { hospital: ["patients.register", "opd.appointments.manage"], scoped: { department: {}, floor: {} } } };
  const CANNOT_BOOK = { actor: { type: "user", id: "u-2" }, permissions: { hospital: ["patients.register"], scoped: { department: {}, floor: {} } } };

  /**
   * THE OWNER'S CORRECTION, ASSERTED. The registration form must not carry the appointment: no
   * doctor, no complaint, and no button that opens a visit. This is the kill for the approved
   * artboard's own shape — it drew "A doctor, by name" and "Or what brings them in" INSIDE this form
   * under one button reading "Register and open the visit".
   */
  it("the registration form carries NO doctor field, NO complaint field and opens NO visit", async () => {
    stubThroughToCard(CAN_BOOK);
    setToken("t");
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();
    await openNewPatientForm(user);

    expect(screen.queryByLabelText(/doctor/i)).toBeNull();
    expect(screen.queryByLabelText(/complaint/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /open the visit|walk-?in/i })).toBeNull();
    expect(fetchCalls().some((c) => c.url.includes("/opd/walk-in") || c.url.includes("/opd/visits"))).toBe(false);
  });

  /**
   * THE HAND-OVER, and the reason `takePatient` is not optional: `/appointment` is a rendering of the
   * patient in hand, so navigating without it lands the clerk on a seat with an empty search box and
   * the patient they just created nowhere in sight.
   */
  it("a clerk who may book is handed over to /appointment with the new patient IN HAND", async () => {
    stubThroughToCard(CAN_BOOK);
    setToken("t");
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();
    await registerRavi(user);

    await user.click(screen.getByTestId("reg-to-appointment"));
    expect(navigate).toHaveBeenCalledWith({ to: "/appointment" });
    expect(JSON.parse(sessionStorage.getItem("hmis.inHand") ?? "{}"))
      .toEqual({ patientId: "p-new", encounterId: null });
  });

  /** D2 — the door is composed by PERMISSION. A clerk who may not book gets the card and is done. */
  it("a clerk who may NOT book gets the card and no hand-over door", async () => {
    stubThroughToCard(CANNOT_BOOK);
    setToken("t");
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();
    await registerRavi(user);

    expect(screen.queryByTestId("reg-to-appointment")).toBeNull();
    expect(screen.getByTestId("reg-done")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalledWith({ to: "/appointment" });
  });

  it("a valid submit posts /patients and advances to the printed card view", async () => {
    stubFetch({
      "POST /api/patients": { patient: { id: "p-new" }, guardianId: null },
      "GET /api/patients/p-new/qr": {
        payload: "1.p-new.3.6f2a9c",
        uhid: "HMS0000009999",
        name: "Ravi Sharma",
        sex: "male",
        dob: "1988-02-11",
      },
    });
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();
    await openNewPatientForm(user);

    await user.type(screen.getByLabelText("Full name"), "Ravi Sharma");
    await user.type(screen.getByLabelText("Mobile number"), "9876500011");
    await user.type(screen.getByLabelText("Age (years)"), "37");
    await user.click(screen.getByRole("button", { name: "Register (Alt+S)" }));

    expect(await screen.findByText("HMS0000009999")).toBeInTheDocument();
    expect(document.querySelector(".qr-card svg")).not.toBeNull();

    const posted = fetchCalls().find((c) => c.method === "POST" && c.url === "/api/patients");
    expect(posted).toBeDefined();
    const body = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
    expect(body.name).toBe("Ravi Sharma");
    expect(body.phone).toBe("9876500011");
    expect(body.ageYears).toBe(37); // the preprocess ran: a number, not the raw input string
    // DD5 — and the field that orphans a record is not in the body, because it is not on the form.
    expect(body).not.toHaveProperty("isConfidential");
  });

  /**
   * PLAN 11g / T-D6, DD5 — the control that produced a patient nobody could find.
   *
   * Ticking it in production returned a clean 201 and a fresh UHID, and thereafter every user got
   * an empty search and a 404 on the direct fetch, because `patients.confidential.read` is granted
   * to NO role. The feature is not wrong; the grant is missing, and it is an owner ruling
   * (`seed-roles.ts:270`). Until it lands the desk must not offer the click.
   */
  it("DD5: the confidential checkbox and its alias field are off the desk while no role can read such a record", async () => {
    stubFetch({});
    renderWithProviders(<RegistrationScreen />);
    const user = userEvent.setup();
    await openNewPatientForm(user);

    // The neighbouring boxes are still there, so this asserts the ONE control is gone rather than
    // that the form failed to render.
    expect(screen.getByLabelText("Sensitive context (seals guardian messages)")).toBeInTheDocument();
    expect(screen.getByLabelText("Promotional messages: opted in")).toBeInTheDocument();
    expect(screen.queryByLabelText("Confidential record (VIP/staff)")).toBeNull();
    expect(screen.queryByLabelText("Public alias")).toBeNull();
  });
});
