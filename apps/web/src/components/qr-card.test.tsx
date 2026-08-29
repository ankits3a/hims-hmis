import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { QrCard } from "./qr-card";

const DATA = {
  payload: "1.p-1.3.6f2a9c",
  uhid: "HMS0000001234",
  name: "Asha Devi",
  administrativeGender: "female",
  dob: "1990-04-02T00:00:00.000Z",
};

describe("QrCard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the UHID, the demographics line and the signed payload as an SVG QR", () => {
    const { container } = renderWithProviders(<QrCard data={DATA} />);

    expect(screen.getByText("HMS0000001234")).toBeInTheDocument();
    expect(screen.getByText("Asha Devi")).toBeInTheDocument();
    // Teeth on the dob slice: the fixture is a full ISO timestamp, so a card that printed
    // data.dob raw would not match.
    expect(screen.getByText("Sex: female · DOB: 1990-04-02")).toBeInTheDocument();

    const card = container.querySelector(".qr-card");
    expect(card).not.toBeNull();
    expect(card?.querySelector("svg")).not.toBeNull();
  });

  it("print isolation: the card carries .qr-card, the print button .no-print, and the button calls window.print", async () => {
    const printSpy = vi.fn();
    vi.stubGlobal("print", printSpy);
    const { container } = renderWithProviders(<QrCard data={DATA} />);
    const user = userEvent.setup();

    const button = screen.getByRole("button", { name: "Print card" });
    expect(button).toHaveClass("no-print");
    expect(container.querySelector(".qr-card")).not.toBeNull();

    await user.click(button);

    expect(printSpy).toHaveBeenCalledTimes(1);
  });
});
