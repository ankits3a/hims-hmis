import { screen } from "@testing-library/react";
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
    // `MED-7`, not `7`: since FD-20 the series is per DEPARTMENT, so MED-7 and PED-7 exist at the
    // same moment and a bare number beside a prefixed slip sends a patient to the wrong door.
    expect(screen.getByTestId("token-no")).toHaveTextContent("MED-7");
    expect(screen.getByTestId("visit-no")).toHaveTextContent("V2608180001");
    expect(screen.getByText("HMS0000001234")).toBeInTheDocument();

    const card = container.querySelector("[data-testid='token-card']");
    expect(card).not.toBeNull();
    expect(card?.querySelector("svg")).not.toBeNull();
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

  /**
   * ═══ FD-24 T6 — THIS ASSERTED THE OPPOSITE, AND IS INVERTED DELIBERATELY ═══
   *
   * This card used to BE the printed slip: `.print-doc` plus a `window.print()` button, on the
   * global A5 page. Owner ruling R1 made printing server-side, and checking a patient in now queues
   * a real 72 mm slip inside the visit's own transaction. Leaving the browser path would put TWO
   * DIFFERENT TOKEN SLIPS in circulation for one patient — an A5 one reading `7` and a thermal one
   * reading `MED-7` — and a clerk handing over whichever appeared first.
   *
   * So the property that must now hold is the absence of the old one, asserted on the CLASS and on
   * the button, because a component that merely stopped rendering the button while keeping
   * `.print-doc` would still hijack the page on any other screen's `window.print()`.
   */
  it("FD-24 T6: it is a screen card, not a document — no .print-doc, no print button", () => {
    const { container } = renderWithProviders(<TokenSlip {...PROPS} />);

    expect(container.querySelector(".print-doc")).toBeNull();
    expect(screen.queryByRole("button", { name: /print/i })).toBeNull();
    // …and it is still the confirmation the clerk reads aloud
    expect(screen.getByTestId("token-card")).toBeInTheDocument();
    expect(screen.getByTestId("token-no")).toHaveTextContent("MED-7");
  });
});
