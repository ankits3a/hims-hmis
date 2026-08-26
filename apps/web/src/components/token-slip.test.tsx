import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { TokenSlip } from "./token-slip";

const PROPS = {
  tokenNo: 7,
  visitNo: "V2608180001",
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
    expect(screen.getByTestId("visit-no")).toHaveTextContent("V2608180001");
    expect(screen.getByText("HMS0000001234")).toBeInTheDocument();

    const doc = container.querySelector(".print-doc");
    expect(doc).not.toBeNull();
    expect(doc?.querySelector("svg")).not.toBeNull();
  });

  it("prints the visit number WITH a spelled-month date, never the bare id", async () => {
    // The number encodes its date as YYMMDD, which an Indian desk reading DD-MM-YY would take for
    // 18-Aug-2020. This pairing is the agreed resolution, so it is asserted rather than assumed —
    // and it is asserted on ONE element, because two would let a layout change split them apart.
    renderWithProviders(<TokenSlip {...PROPS} />);
    const line = screen.getByTestId("visit-no");
    expect(line).toHaveTextContent("V2608180001");
    expect(line).toHaveTextContent("18-Aug-2026");
    expect(screen.queryByText("2026-08-18")).toBeNull(); // the raw ISO date does not reach paper
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
