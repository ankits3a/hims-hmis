import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, stubFetch } from "../test-utils";
import { PatientPicker } from "./patient-picker";

const HIT = {
  id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", phone: "9876500000", sex: "female",
  dob: "1990-04-02T00:00:00.000Z", isConfidential: false, hasPhoto: false,
};

describe("PatientPicker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("typing digits fires GET /patients/search and a click calls onPick with the hit", async () => {
    stubFetch({ "GET /patients/search": { items: [HIT] } });
    const onPick = vi.fn();
    renderWithProviders(<PatientPicker onPick={onPick} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Search"), "98765");

    const row = await screen.findByRole("button", { name: /Asha Devi/ });
    await user.click(row);

    expect(onPick).toHaveBeenCalledWith({ id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", sex: "female", dob: "1990-04-02T00:00:00.000Z" });
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith("/patients/search?q=98765"))).toBe(true),
    );
  });

  it("pasting a QR payload posts /patients/qr/verify and picks on ok:true, shows the bad-scan message on ok:false", async () => {
    stubFetch({
      "POST /patients/qr/verify": (init?: RequestInit) => {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { payload: string };
        return body.payload === "GOOD-QR"
          ? { ok: true, patient: { id: "p-2", uhid: "HMS0000005678", name: "Ravi Kumar", sex: "male", dob: null } }
          : { ok: false, reason: "malformed" };
      },
    });
    const onPick = vi.fn();
    renderWithProviders(<PatientPicker onPick={onPick} />);
    const scanBox = screen.getByLabelText("Scan QR");

    fireEvent.paste(scanBox, { clipboardData: { getData: () => "GOOD-QR" } as unknown as DataTransfer });
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith({ id: "p-2", uhid: "HMS0000005678", name: "Ravi Kumar", sex: "male", dob: null }),
    );

    fireEvent.paste(scanBox, { clipboardData: { getData: () => "BAD-QR" } as unknown as DataTransfer });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read that QR code");
    expect(onPick).toHaveBeenCalledTimes(1); // the bad scan must not also call onPick
  });
});
