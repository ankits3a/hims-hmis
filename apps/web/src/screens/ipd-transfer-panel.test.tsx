import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { TransferPanel } from "./ipd-transfer-panel";
import type { IpdTransferOptions } from "@hmis/contracts";

/*
  E3.1 (#729) — the Transfer panel in the Beds drawer. Synthetic fixture shaped by the contract.
*/

const api = vi.hoisted(() => ({ getTransferOptions: vi.fn(), startTransfer: vi.fn(), changeClass: vi.fn(), cancelTransfer: vi.fn(), swapBeds: vi.fn() }));
vi.mock("../lib/ipd-transfer-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-transfer-api")>();
  return { ...real, ...api };
});

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
function options(over: Partial<IpdTransferOptions> = {}): IpdTransferOptions {
  return {
    admissionId: id(1), admissionNo: "IP26-000001", state: "admitted",
    patient: { name: "Test Patient", uhid: "UH-FAKE-1", ageSex: "M 45", initials: "TP" },
    bed: { id: id(2), code: "F05-MED-B01", class: "general", wardName: "5A Medicine" }, billedClass: "general",
    pendingClassChange: null, openTransfer: null,
    targets: [
      { bedId: id(3), code: "F06-SUR-B01", wardName: "6A Surgery", class: "general", icu: false, reasons: ["Any gender"] },
      { bedId: id(4), code: "F06-SUR-B02", wardName: "6A Surgery", class: "general", icu: false, reasons: ["Any gender"] },
    ],
    swapWith: [{ admissionId: id(9), bedId: id(8), bedCode: "F05-MED-B02", wardName: "5A Medicine", initials: "AB", class: "general" }],
    classes: ["semi_private", "private", "deluxe", "suite"],
    ...over,
  };
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.getTransferOptions.mockResolvedValue(options());
  api.startTransfer.mockResolvedValue({ transferId: id(7), escalatesAt: new Date().toISOString() });
  api.changeClass.mockResolvedValue({ effectiveFrom: new Date(Date.now() + 5 * 86_400_000).toISOString() });
});

describe("Transfer panel (E3.1)", () => {
  it("starts a transfer to a rule-valid bed with all four SBAR fields", async () => {
    const user = userEvent.setup();
    renderWithRouter(<TransferPanel admissionId={id(1)} mayTransfer mayClass onDone={() => {}} />);
    await user.click(await screen.findByTestId("ipd-transfer-start"));
    const send = screen.getByRole("button", { name: "Send handover" });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /F06-SUR-B02/ }));
    for (const l of ["Situation", "Background", "Assessment", "Recommendation"]) await user.type(screen.getByLabelText(l), `synthetic ${l}`);
    expect(send).toBeEnabled();
    await user.click(send);
    expect(api.startTransfer).toHaveBeenCalledWith({
      admissionId: id(1), toBedId: id(4), reason: "bed_management",
      handover: { situation: "synthetic Situation", background: "synthetic Background", assessment: "synthetic Assessment", recommendation: "synthetic Recommendation" },
    });
    expect(await screen.findByText(/Handover sent/)).toBeInTheDocument();
  });

  it("a bed just taken offers the next free beds as buttons", async () => {
    const user = userEvent.setup();
    api.startTransfer.mockRejectedValue(new ApiError(409, {
      statusCode: 409, code: "bed_not_available", message: "x", rule: "The bed is not free.", fix: "Pick another bed", bedRule: "Bed is reserved",
      detail: { nextBeds: [{ bedId: id(5), code: "F06-SUR-B05" }] },
    }));
    renderWithRouter(<TransferPanel admissionId={id(1)} mayTransfer mayClass onDone={() => {}} />);
    await user.click(await screen.findByTestId("ipd-transfer-start"));
    await user.click(screen.getByRole("radio", { name: /F06-SUR-B01/ }));
    for (const l of ["Situation", "Background", "Assessment", "Recommendation"]) await user.type(screen.getByLabelText(l), "x");
    await user.click(screen.getByRole("button", { name: "Send handover" }));
    const alert = await screen.findByTestId("ipd-transfer-refusal");
    expect(alert).toHaveTextContent("Bed is reserved");
    expect(within(alert).getByRole("button", { name: "F06-SUR-B05" })).toBeInTheDocument();
  });

  it("an upgrade needs the room-rent cap tick and a witnessed paper consent", async () => {
    const user = userEvent.setup();
    renderWithRouter(<TransferPanel admissionId={id(1)} mayTransfer={false} mayClass onDone={() => {}} />);
    expect(await screen.findByRole("button", { name: "Change class" })).toBeInTheDocument();
    expect(screen.queryByTestId("ipd-transfer-start")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change class" }));
    const record = screen.getByRole("button", { name: "Record class change" });
    await user.type(screen.getByLabelText("Witness name"), "Test Witness");
    expect(record).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(record).toBeEnabled();
    await user.click(record);
    expect(api.changeClass).toHaveBeenCalledWith({
      admissionId: id(1), toClass: "semi_private", consent: { signedBy: "patient", method: "paper", witnessName: "Test Witness" }, roomRentCapAcknowledged: true,
    });
    expect(await screen.findByText(/Class change recorded · takes effect/)).toBeInTheDocument();
  });

  it("an open transfer shows where it waits and can be cancelled", async () => {
    const user = userEvent.setup();
    api.getTransferOptions.mockResolvedValue(options({ state: "transferring", openTransfer: { transferId: id(7), toBedCode: "F06-SUR-B01", startedAt: new Date().toISOString() } }));
    api.cancelTransfer.mockResolvedValue({});
    renderWithRouter(<TransferPanel admissionId={id(1)} mayTransfer mayClass onDone={() => {}} />);
    expect(await screen.findByTestId("ipd-transfer-waiting")).toHaveTextContent("Waiting for acceptance at F06-SUR-B01");
    await user.click(screen.getByRole("button", { name: "Cancel transfer" }));
    await user.click(screen.getAllByRole("button", { name: "Cancel transfer" }).at(-1)!);
    expect(api.cancelTransfer).toHaveBeenCalledWith(id(7), "patient_deteriorated");
  });
});
