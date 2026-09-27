import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { AbdmVerifyPanel, compareOnScreen } from "./abdm-verify";

/**
 * ABDM S1 — the "Verify with ABDM" panel on a patient's record: the four steps, the comparison that
 * is shown and never written, the server's mismatch refusal turned into something the clerk can act
 * on, and an expired handle turned into "start again" rather than a dead end.
 */
type Route = { status?: number; body: unknown } | ((init?: RequestInit) => { status?: number; body: unknown });

function stub(routes: Record<string, Route>, seen: { key: string; body: unknown }[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    seen.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const r = routes[key];
    if (r === undefined) return new Response("{}", { status: 404 });
    const { status = 200, body } = typeof r === "function" ? r(init) : r;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
}

const PROFILE = {
  abhaNumber: "91-2345-6789-0123", abhaAddress: "sunita@sbx", name: "Sunita Sharma", gender: "female",
  yearOfBirth: 1986, monthOfBirth: 3, dayOfBirth: 14, dob: "1986-03-14", mobile: "******3210",
  addressLine: null, district: null, stateName: null, pincode: null,
};
const flow = (over: Record<string, unknown>) => ({
  transactionId: "opaque-9", purpose: "verify", stage: "otp_sent", kind: "abha_number", otpMethod: "aadhaar_otp",
  expiresAt: "2026-09-25T10:15:00.000Z", message: "OTP sent to Aadhaar-linked mobile ******1234", profile: null, comparison: null, isNew: null,
  resend: { availableAt: "2000-01-01T00:00:00.000Z", left: 2 }, resendNeedsAadhaar: false, accounts: null, demographicsToApply: null,
  linkedElsewhere: null, mobileVerification: null, addressSuggestions: null, ...over,
});

beforeEach(() => { setToken("t-1"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

describe("AbdmVerifyPanel — on a patient's record", () => {
  it("walks identifier → OTP → profile with the SERVER's comparison → link, and ABDM's details must be ACCEPTED", async () => {
    const seen: { key: string; body: unknown }[] = [];
    const comparison = [
      { field: "name", abdm: "Sunita Sharma", hospital: "Sunita Verma", result: "differs" },
      { field: "dob", abdm: "1986-03-14", hospital: "1986-03-14", result: "same" },
      { field: "gender", abdm: "female", hospital: "female", result: "same" },
      { field: "mobile", abdm: "******3210", hospital: "9876543210", result: "same" },
    ];
    stub({
      "POST /api/abdm/abha/verify": { status: 201, body: flow({}) },
      "POST /api/abdm/abha/transactions/opaque-9/otp": { body: flow({ stage: "authenticated", message: null, resend: null, profile: PROFILE, comparison, demographicsToApply: [{ field: "name", from: "Sunita Verma", to: "Sunita Sharma" }] }) },
      "POST /api/abdm/abha/transactions/opaque-9/link": { body: { patientId: "p-1", changed: ["abhaVerificationStatus"], comparison } },
    }, seen);
    const linked = vi.fn();
    renderWithProviders(<AbdmVerifyPanel mode="verify" patientId="p-1" initialIdentifier="91-2345-6789-0123" onLinked={linked} onClose={() => undefined} />);
    const user = userEvent.setup({ delay: null });

    expect(screen.getByTestId("abdm-identifier")).toHaveValue("91-2345-6789-0123");
    expect(screen.getByTestId("abdm-method-aadhaar")).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByTestId("abdm-send-otp"));
    expect(await screen.findByTestId("abdm-otp-message")).toHaveTextContent("******1234");
    expect(seen.find((s) => s.key === "POST /api/abdm/abha/verify")?.body).toEqual({ identifier: "91-2345-6789-0123", method: "aadhaar_otp", patientId: "p-1" });

    // six digits or the button stays shut
    await user.type(screen.getByTestId("abdm-otp"), "3141");
    expect(screen.getByTestId("abdm-verify-otp")).toBeDisabled();
    await user.type(screen.getByTestId("abdm-otp"), "59");
    await user.click(screen.getByTestId("abdm-verify-otp"));

    await waitFor(() => expect(screen.getByTestId("abdm-compare-name")).toHaveAttribute("data-result", "differs"));
    expect(screen.getByTestId("abdm-profile-number")).toHaveTextContent("91-2345-6789-0123");
    // what the link will take is SHOWN before it is taken
    expect(screen.getByTestId("abdm-will-update")).toHaveTextContent("Sunita Verma → Sunita Sharma");
    expect(screen.getByTestId("abdm-link")).toBeDisabled();
    await user.click(screen.getByTestId("abdm-accept"));
    await user.click(screen.getByTestId("abdm-link"));
    await waitFor(() => expect(screen.getByTestId("abdm-linked")).toBeInTheDocument());
    expect(seen.find((s) => s.key === "POST /api/abdm/abha/transactions/opaque-9/link")?.body).toEqual({ patientId: "p-1", acceptAbdmDemographics: true });
    expect(linked).toHaveBeenCalledWith(["abhaVerificationStatus"]);
  });

  it("a 409 abha_profile_mismatch from the server shows its comparison instead of a dead end", async () => {
    const seen: { key: string; body: unknown }[] = [];
    let links = 0;
    stub({
      "POST /api/abdm/abha/verify": { status: 201, body: flow({}) },
      "POST /api/abdm/abha/transactions/opaque-9/otp": { body: flow({ stage: "authenticated", profile: PROFILE, comparison: null }) },
      "POST /api/abdm/abha/transactions/opaque-9/link": () => {
        links += 1;
        return links === 1
          ? { status: 409, body: { statusCode: 409, code: "abha_profile_mismatch", message: "abha_profile_mismatch: differ", detail: { comparison: [{ field: "gender", abdm: "female", hospital: "male", result: "differs" }], demographicsToApply: [{ field: "gender", from: "male", to: "female" }] } } }
          : { body: { patientId: "p-1", changed: [], comparison: [] } };
      },
    }, seen);
    renderWithProviders(<AbdmVerifyPanel mode="verify" patientId="p-1" initialIdentifier="sunita@sbx" onClose={() => undefined} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("abdm-send-otp"));
    await user.type(await screen.findByTestId("abdm-otp"), "314159");
    await user.click(screen.getByTestId("abdm-verify-otp"));
    await user.click(await screen.findByTestId("abdm-link"));
    await waitFor(() => expect(screen.getByTestId("abdm-compare-gender")).toHaveAttribute("data-result", "differs"));
    expect(screen.getByTestId("abdm-error")).toBeInTheDocument();
    expect(screen.getByTestId("abdm-will-update")).toHaveTextContent("male → female");
    await user.click(screen.getByTestId("abdm-accept"));
    await user.click(screen.getByTestId("abdm-link"));
    await waitFor(() => expect(screen.getByTestId("abdm-linked")).toBeInTheDocument());
  });

  it("an expired handle sends the clerk back to the start with the reason", async () => {
    stub({
      "POST /api/abdm/abha/verify": { status: 201, body: flow({}) },
      "POST /api/abdm/abha/transactions/opaque-9/otp": { status: 410, body: { statusCode: 410, code: "abdm_transaction_expired", message: "abdm_transaction_expired: expired" } },
    }, []);
    renderWithProviders(<AbdmVerifyPanel mode="verify" patientId="p-1" initialIdentifier="91-2345-6789-0123" onClose={() => undefined} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("abdm-send-otp"));
    await user.type(await screen.findByTestId("abdm-otp"), "314159");
    await user.click(screen.getByTestId("abdm-verify-otp"));
    await waitFor(() => expect(screen.getByTestId("abdm-error")).toHaveTextContent(/expired/i));
    expect(screen.getByTestId("abdm-identifier")).toBeInTheDocument();
  });

  it("create: the Aadhaar number leaves the component's state the moment its one request is sent", async () => {
    const seen: { key: string; body: unknown }[] = [];
    stub({ "POST /api/abdm/abha/create": { status: 201, body: flow({ purpose: "create", kind: "aadhaar_enrolment" }) } }, seen);
    renderWithProviders(<AbdmVerifyPanel mode="create" onClose={() => undefined} />);
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByTestId("abdm-aadhaar"), "9876 5432 1098");
    await user.click(screen.getByTestId("abdm-consent"));
    await user.click(screen.getByTestId("abdm-send-otp"));
    await screen.findByTestId("abdm-otp");
    expect(seen.find((s) => s.key === "POST /api/abdm/abha/create")?.body).toEqual({ aadhaar: "9876 5432 1098", patientConsented: true, patientId: null });
    expect(document.body.innerHTML).not.toMatch(/9876 5432 1098|987654321098/);
    // the mobile the ABHA should carry is asked alongside the OTP
    expect(screen.getByTestId("abdm-mobile")).toBeInTheDocument();
  });
});

describe("AbdmVerifyPanel — the FT additions", () => {
  it("RESEND: counts down, then re-sends, and says so when none are left (CRT_ABHA_106)", async () => {
    const seen: { key: string; body: unknown }[] = [];
    const inFuture = new Date(Date.now() + 42_000).toISOString();
    stub({
      "POST /api/abdm/abha/verify": { status: 201, body: flow({ resend: { availableAt: inFuture, left: 2 } }) },
      "POST /api/abdm/abha/transactions/opaque-9/resend": { body: flow({ resend: { availableAt: "2000-01-01T00:00:00.000Z", left: 0 } }) },
    }, seen);
    renderWithProviders(<AbdmVerifyPanel mode="verify" patientId="p-1" initialIdentifier="91-2345-6789-0123" onClose={() => undefined} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("abdm-send-otp"));
    const resend = await screen.findByTestId("abdm-resend");
    // the server's `availableAt` drives the countdown; until it passes, nothing can be re-sent
    expect(resend).toBeDisabled();
    expect(resend).toHaveTextContent(/Re-send in 4\d s/);
    expect(seen.some((s) => s.key.endsWith("/resend"))).toBe(false);
  });

  it("RESEND enabled after the wait posts, and with none left the button says so", async () => {
    const seen: { key: string; body: unknown }[] = [];
    stub({
      "POST /api/abdm/abha/verify": { status: 201, body: flow({}) },
      "POST /api/abdm/abha/transactions/opaque-9/resend": { body: flow({ resend: { availableAt: "2000-01-01T00:00:00.000Z", left: 0 } }) },
    }, seen);
    renderWithProviders(<AbdmVerifyPanel mode="verify" patientId="p-1" initialIdentifier="91-2345-6789-0123" onClose={() => undefined} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("abdm-send-otp"));
    const resend = await screen.findByTestId("abdm-resend");
    expect(resend).toHaveTextContent("Re-send OTP · 2 left");
    await user.click(resend);
    await waitFor(() => expect(seen.some((s) => s.key === "POST /api/abdm/abha/transactions/opaque-9/resend")).toBe(true));
    expect(seen.find((s) => s.key === "POST /api/abdm/abha/transactions/opaque-9/resend")?.body).toEqual({});
    await waitFor(() => expect(screen.getByTestId("abdm-resend")).toBeDisabled());
    expect(screen.getByTestId("abdm-resend")).toHaveTextContent(/No more re-sends/);
  });

  it("FIND BY MOBILE: the ABHAs ABDM found are listed and one is chosen (VRFY_ABHA_303)", async () => {
    const seen: { key: string; body: unknown }[] = [];
    stub({
      "POST /api/abdm/abha/verify": { status: 201, body: flow({ kind: "mobile", otpMethod: "mobile_otp" }) },
      "POST /api/abdm/abha/transactions/opaque-9/otp": { body: flow({ kind: "mobile", stage: "choose_account", resend: null, accounts: [
        { abhaNumber: "91-1111-2222-3333", abhaAddress: "second@sbx", name: "Second Person" },
        { abhaNumber: "91-4444-5555-6666", abhaAddress: "third@sbx", name: "Third Person" },
      ] }) },
      "POST /api/abdm/abha/transactions/opaque-9/account": { body: flow({ kind: "mobile", stage: "authenticated", resend: null, profile: { ...PROFILE, abhaNumber: "91-4444-5555-6666", name: "Third Person" }, linkedElsewhere: { uhid: "U00110012" } }) },
    }, seen);
    renderWithProviders(<AbdmVerifyPanel mode="verify" patientId="p-1" initialIdentifier="9876543210" onClose={() => undefined} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("abdm-send-otp"));
    await user.type(await screen.findByTestId("abdm-otp"), "314159");
    await user.click(screen.getByTestId("abdm-verify-otp"));
    expect(await screen.findByTestId("abdm-accounts")).toHaveTextContent("Second Person");
    await user.click(screen.getByTestId("abdm-choose-91-4444-5555-6666"));
    expect(seen.find((s) => s.key === "POST /api/abdm/abha/transactions/opaque-9/account")?.body).toEqual({ abhaNumber: "91-4444-5555-6666" });
    // ONE ABHA, ONE PATIENT: already on UHID U00110012 — said, and the link is not offered
    expect(await screen.findByTestId("abdm-linked-elsewhere")).toHaveTextContent("UHID U00110012");
    expect(screen.getByTestId("abdm-link")).toBeDisabled();
  });

  it("the Aadhaar box SAYS an invalid number is invalid (CRT_ABHA_104) without repeating it", async () => {
    stub({}, []);
    renderWithProviders(<AbdmVerifyPanel mode="find_aadhaar" onClose={() => undefined} />);
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByTestId("abdm-aadhaar"), "12345");
    expect(screen.getByTestId("abdm-aadhaar-invalid")).toHaveTextContent("Aadhaar Number is not valid");
    expect(screen.getByTestId("abdm-aadhaar-invalid")).not.toHaveTextContent("12345");
    expect(screen.getByTestId("abdm-send-otp")).toBeDisabled();
  });

  it("CREATE: a different mobile is confirmed by OTP (CRT_ABHA_109), and an address is suggested and made (CRT_ABHA_112)", async () => {
    const seen: { key: string; body: unknown }[] = [];
    const created = { purpose: "create", kind: "aadhaar_enrolment", stage: "authenticated", resend: null, isNew: true, profile: { ...PROFILE, abhaAddress: "new.person1@sbx" } };
    stub({
      "POST /api/abdm/abha/create": { status: 201, body: flow({ purpose: "create", kind: "aadhaar_enrolment", resendNeedsAadhaar: true }) },
      "POST /api/abdm/abha/transactions/opaque-9/otp": { body: flow({ ...created, mobileVerification: "required" }) },
      "POST /api/abdm/abha/transactions/opaque-9/mobile/otp": { body: flow({ ...created, mobileVerification: "otp_sent" }) },
      "POST /api/abdm/abha/transactions/opaque-9/mobile/verify": { body: flow({ ...created, mobileVerification: "verified" }) },
      "GET /api/abdm/abha/transactions/opaque-9/address-suggestions": { body: flow({ ...created, mobileVerification: "verified", addressSuggestions: ["kamla.devi1979", "kamladevi_79"] }) },
      "POST /api/abdm/abha/transactions/opaque-9/address": { body: flow({ ...created, mobileVerification: "verified", profile: { ...PROFILE, abhaAddress: "kamla.devi1979@sbx" } }) },
    }, seen);
    renderWithProviders(<AbdmVerifyPanel mode="create" onClose={() => undefined} />);
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByTestId("abdm-aadhaar"), "987654321098");
    await user.click(screen.getByTestId("abdm-consent"));
    await user.click(screen.getByTestId("abdm-send-otp"));
    await user.type(await screen.findByTestId("abdm-otp"), "314159");
    await user.type(screen.getByTestId("abdm-mobile"), "9000011111");
    await user.click(screen.getByTestId("abdm-verify-otp"));
    expect(await screen.findByTestId("abdm-mobile-check")).toHaveTextContent("9000011111");
    await user.click(screen.getByTestId("abdm-mobile-send"));
    await user.type(await screen.findByTestId("abdm-mobile-otp"), "271828");
    await user.click(screen.getByTestId("abdm-mobile-verify"));
    expect(await screen.findByTestId("abdm-mobile-verified")).toBeInTheDocument();
    expect(seen.find((s) => s.key === "POST /api/abdm/abha/transactions/opaque-9/mobile/verify")?.body).toEqual({ otp: "271828" });
    await user.click(screen.getByTestId("abdm-address-suggest"));
    await user.click(await screen.findByTestId("abdm-address-pick-kamla.devi1979"));
    await waitFor(() => expect(screen.getByTestId("abdm-profile-address")).toHaveTextContent("kamla.devi1979@sbx"));
    expect(seen.find((s) => s.key === "POST /api/abdm/abha/transactions/opaque-9/address")?.body).toEqual({ abhaAddress: "kamla.devi1979" });
    expect(document.body.innerHTML).not.toMatch(/987654321098/);
  });

  it("DOWNLOAD: the card is fetched as a file from the download route (CRT_ABHA_114)", async () => {
    const seen: { key: string; body: unknown }[] = [];
    stub({
      "POST /api/abdm/abha/verify": { status: 201, body: flow({}) },
      "POST /api/abdm/abha/transactions/opaque-9/otp": { body: flow({ stage: "authenticated", resend: null, profile: PROFILE }) },
      "GET /api/abdm/abha/transactions/opaque-9/card/download": { body: {} },
    }, seen);
    const createObjectURL = vi.fn(() => "blob:card");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    renderWithProviders(<AbdmVerifyPanel mode="verify" patientId="p-1" initialIdentifier="91-2345-6789-0123" onClose={() => undefined} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("abdm-send-otp"));
    await user.type(await screen.findByTestId("abdm-otp"), "314159");
    await user.click(screen.getByTestId("abdm-verify-otp"));
    await user.click(await screen.findByTestId("abdm-card-download"));
    await waitFor(() => expect(seen.some((s) => s.key === "GET /api/abdm/abha/transactions/opaque-9/card/download")).toBe(true));
  });
});

describe("compareOnScreen — the counter's unsaved form", () => {
  it("compares a year to a year when the form holds only an age, and a masked mobile on its visible digits", () => {
    const c = compareOnScreen(
      { ...PROFILE, gender: "female" } as Parameters<typeof compareOnScreen>[0],
      { name: "SUNITA sharma", dob: "1986", gender: "female", phone: "9876543210" },
    );
    expect(c.map((x) => [x.field, x.result])).toEqual([["name", "same"], ["dob", "same"], ["gender", "same"], ["mobile", "same"]]);
  });
});
