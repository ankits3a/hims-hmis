import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { RegistrationDesk } from "./registration-desk";

// The C-18 dialog navigates with TanStack Router's useNavigate, which throws outside a
// <RouterProvider>. A component test mounts no router, so the module is mocked down to
// the single hook this screen consumes.
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

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

describe("RegistrationDesk", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    navigate.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("search-first: typed digits fire GET /patients/search and the hit renders as a row", async () => {
    stubFetch({
      "GET /patients/search": { items: [HIT] },
      "GET /patients/p-1/photo": { mimeType: "image/jpeg", imageBase64: "QUFB" },
    });
    renderWithProviders(<RegistrationDesk />);
    const user = userEvent.setup();

    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "98765");

    expect(await screen.findByText("Asha Devi")).toBeInTheDocument();
    expect(screen.getByText(/HMS0000001234/)).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchCalls().some((c) => c.url === "/patients/search?q=98765")).toBe(true),
    );
  });

  it("C-18: choosing a hit opens the attach dialog with the stored photo large and both choices", async () => {
    stubFetch({
      "GET /patients/search": { items: [HIT] },
      "GET /patients/p-1/photo": { mimeType: "image/jpeg", imageBase64: "QUFB" },
    });
    renderWithProviders(<RegistrationDesk />);
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
      "GET /patients/search": { items: [HIT] },
      "GET /patients/p-1/photo": { mimeType: "image/jpeg", imageBase64: "QUFB" },
    });
    renderWithProviders(<RegistrationDesk />);
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
      "POST /patients": { patient: { id: "p-new" }, guardianId: "g-1" },
      "GET /patients/p-new/qr": {
        payload: "1.p-new.3.6f2a9c", uhid: "HMS0000009998", name: "Bal Kumar", sex: "unknown", dob: null,
      },
    });
    renderWithProviders(<RegistrationDesk />);
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
    const posted = fetchCalls().find((c) => c.method === "POST" && c.url === "/patients");
    const body = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
    expect(body.ageYears).toBe(10);
    expect(body.guardian).toEqual({ name: "Sunita Kumar", relationship: "father" });
  });

  it("D9: the promotional opt-in checkbox is unchecked by default and posts false when left alone", async () => {
    stubFetch({
      "POST /patients": { patient: { id: "p-new" }, guardianId: null },
      "GET /patients/p-new/qr": {
        payload: "1.p-new.3.6f2a9c", uhid: "HMS0000009997", name: "Leela Bai", sex: "unknown", dob: null,
      },
    });
    renderWithProviders(<RegistrationDesk />);
    const user = userEvent.setup();
    await openNewPatientForm(user);

    const optIn = screen.getByLabelText("Promotional messages: opted in") as HTMLInputElement;
    expect(optIn.checked).toBe(false);

    await user.type(screen.getByLabelText("Full name"), "Leela Bai");
    await user.click(screen.getByRole("button", { name: "Register (Alt+S)" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "POST" && c.url === "/patients")).toBe(true));
    const posted = fetchCalls().find((c) => c.method === "POST" && c.url === "/patients")!;
    const body = JSON.parse(posted.body) as Record<string, unknown>;
    expect(body.promotionalOptIn).toBe(false);
  });

  it("D9: checking the promotional opt-in box posts promotionalOptIn: true", async () => {
    stubFetch({
      "POST /patients": { patient: { id: "p-new" }, guardianId: null },
      "GET /patients/p-new/qr": {
        payload: "1.p-new.3.6f2a9c", uhid: "HMS0000009996", name: "Meena Rao", sex: "unknown", dob: null,
      },
    });
    renderWithProviders(<RegistrationDesk />);
    const user = userEvent.setup();
    await openNewPatientForm(user);

    await user.type(screen.getByLabelText("Full name"), "Meena Rao");
    await user.click(screen.getByLabelText("Promotional messages: opted in"));
    await user.click(screen.getByRole("button", { name: "Register (Alt+S)" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "POST" && c.url === "/patients")).toBe(true));
    const posted = fetchCalls().find((c) => c.method === "POST" && c.url === "/patients")!;
    const body = JSON.parse(posted.body) as Record<string, unknown>;
    expect(body.promotionalOptIn).toBe(true);
  });

  it("a valid submit posts /patients and advances to the printed card view", async () => {
    stubFetch({
      "POST /patients": { patient: { id: "p-new" }, guardianId: null },
      "GET /patients/p-new/qr": {
        payload: "1.p-new.3.6f2a9c",
        uhid: "HMS0000009999",
        name: "Ravi Sharma",
        sex: "male",
        dob: "1988-02-11",
      },
    });
    renderWithProviders(<RegistrationDesk />);
    const user = userEvent.setup();
    await openNewPatientForm(user);

    await user.type(screen.getByLabelText("Full name"), "Ravi Sharma");
    await user.type(screen.getByLabelText("Mobile number"), "9876500011");
    await user.type(screen.getByLabelText("Age (years)"), "37");
    await user.click(screen.getByRole("button", { name: "Register (Alt+S)" }));

    expect(await screen.findByText("HMS0000009999")).toBeInTheDocument();
    expect(document.querySelector(".qr-card svg")).not.toBeNull();

    const posted = fetchCalls().find((c) => c.method === "POST" && c.url === "/patients");
    expect(posted).toBeDefined();
    const body = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
    expect(body.name).toBe("Ravi Sharma");
    expect(body.phone).toBe("9876500011");
    expect(body.ageYears).toBe(37); // the preprocess ran: a number, not the raw input string
  });
});
