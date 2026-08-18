import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { TokenSlip } from "./token-slip";

const PROPS = {
  tokenNo: 7,
  roomCode: "12",
  doctorName: "Dr Meera Rao",
  departmentCode: "MED",
  departmentName: "General medicine",
  serviceDate: "2026-08-18",
  patient: { uhid: "HMS0000001234", name: "Asha Devi" },
  qrPayload: "1.p-1.HMS0000001234.3.6f2a9c",
  visitType: "new",
};

describe("TokenSlip", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the hospital name, department, doctor, room, a large token number, date, UHID and the QR as an SVG", () => {
    const { container } = renderWithProviders(<TokenSlip {...PROPS} />);

    expect(screen.getByText("Hospital (name pending — roadmap item #5)")).toBeInTheDocument();
    expect(screen.getByText("MED · General medicine")).toBeInTheDocument();
    expect(screen.getByText("Dr Meera Rao")).toBeInTheDocument();
    expect(screen.getByText("Room: 12")).toBeInTheDocument();
    expect(screen.getByTestId("token-no")).toHaveTextContent("7");
    expect(screen.getByText("2026-08-18")).toBeInTheDocument();
    expect(screen.getByText("HMS0000001234")).toBeInTheDocument();

    const doc = container.querySelector(".print-doc");
    expect(doc).not.toBeNull();
    expect(doc?.querySelector("svg")).not.toBeNull();
  });

  it("print isolation: the root carries .print-doc and the .no-print button calls window.print", async () => {
    const printSpy = vi.fn();
    vi.stubGlobal("print", printSpy);
    const { container } = renderWithProviders(<TokenSlip {...PROPS} />);
    const user = userEvent.setup();

    // K43: an absence/presence assertion on the CLASS, not merely on the element existing.
    expect(container.querySelector(".print-doc")).not.toBeNull();

    const button = screen.getByRole("button", { name: "Print slip" });
    expect(button).toHaveClass("no-print");

    await user.click(button);

    expect(printSpy).toHaveBeenCalledTimes(1);
  });
});
