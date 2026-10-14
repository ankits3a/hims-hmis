import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "../test-utils";
import { AttendantMessagesCard } from "./ipd-attendant-card";
import type { IpdAttendantMessages } from "@hmis/contracts";

/*
  #761 — the admission's daily-totals card on the interim bill. Synthetic values only; the shape is the contract's
  (`packages/contracts/src/ipd/bill-desk.ts`).
*/

const api = vi.hoisted(() => ({ getAttendantMessages: vi.fn(), recordAttendantConsent: vi.fn(), stopAttendantMessages: vi.fn() }));
vi.mock("../lib/ipd-attendant-api", () => api);

const ADM = "01FAKE00000000000000000001";
const card = (over: Partial<IpdAttendantMessages> = {}): IpdAttendantMessages => ({
  admissionId: ADM, attendant: { kind: "deposit_payer", phoneMasked: "******5678" }, consent: null, viaFamilyLink: false, stoppedAt: null,
  state: "no_consent", words: "Not sent: no consent recorded",
  sending: { on: false, channels: [], missing: ["IPD_BILL_DESK_PHONE"], sendHourIst: 9 },
  last: { admissionId: ADM, admissionNo: "IP30-000041", billDate: "2030-01-01", status: "not_sent", words: "Not sent: template not configured" },
  canManage: true, ...over,
});

describe("AttendantMessagesCard", () => {
  beforeEach(() => { api.getAttendantMessages.mockReset(); api.recordAttendantConsent.mockReset(); api.stopAttendantMessages.mockReset(); });

  it("shows who it goes to (masked), the state and the last day's line in words, and records consent", async () => {
    api.getAttendantMessages.mockResolvedValue(card());
    api.recordAttendantConsent.mockResolvedValue(card({ state: "not_configured", words: "Not sent: template not configured", consent: { consentedBy: "Synthetic Kin", relation: "spouse", method: "verbal", at: "2030-01-01T05:00:00.000Z" } }));
    renderWithRouter(<AttendantMessagesCard admissionId={ADM} />);
    const region = await screen.findByRole("region", { name: "Daily totals message" });
    expect(within(region).getByText("******5678")).toBeInTheDocument();
    expect(within(region).getByText("Not sent: no consent recorded")).toBeInTheDocument();
    expect(within(region).getByText(/Not sent: template not configured/)).toBeInTheDocument();
    fireEvent.change(within(region).getByLabelText("Consent given by"), { target: { value: "Synthetic Kin" } });
    fireEvent.change(within(region).getByLabelText("Relation"), { target: { value: "spouse" } });
    fireEvent.click(within(region).getByRole("button", { name: "Record consent" }));
    await waitFor(() => expect(api.recordAttendantConsent).toHaveBeenCalledWith(ADM, { consent: { consentedBy: "Synthetic Kin", relation: "spouse", method: "verbal" } }));
    expect(await within(region).findByText("Not sent: template not configured", { selector: ".ipdam-state" })).toBeInTheDocument();
  });

  it("a number changed since consent says so and offers Record consent again, beside the earlier consent", async () => {
    api.getAttendantMessages.mockResolvedValue(card({
      state: "number_changed", words: "Consent needed again (number changed)",
      consent: { consentedBy: "Synthetic Kin", relation: "spouse", method: "verbal", at: "2030-01-01T05:00:00.000Z" },
    }));
    renderWithRouter(<AttendantMessagesCard admissionId={ADM} />);
    const region = await screen.findByRole("region", { name: "Daily totals message" });
    expect(within(region).getByText("Consent needed again (number changed)")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Record consent" })).toBeInTheDocument();
  });

  it("stops messages on the attendant's word; a reader without the permission sees no buttons", async () => {
    api.getAttendantMessages.mockResolvedValueOnce(card({ state: "will_send", words: "Daily totals go to the attendant at 09:00", consent: { consentedBy: "Synthetic Kin", relation: "spouse", method: "verbal", at: "2030-01-01T05:00:00.000Z" } }));
    api.stopAttendantMessages.mockResolvedValue(card({ state: "stopped", words: "Not sent: messages stopped", stoppedAt: "2030-01-01T06:00:00.000Z" }));
    const { unmount } = renderWithRouter(<AttendantMessagesCard admissionId={ADM} />);
    const region = await screen.findByRole("region", { name: "Daily totals message" });
    fireEvent.click(within(region).getByRole("button", { name: "Stop messages" }));
    await waitFor(() => expect(api.stopAttendantMessages).toHaveBeenCalledWith(ADM));
    expect(await within(region).findByText("Not sent: messages stopped", { selector: ".ipdam-state" })).toBeInTheDocument();
    unmount();
    api.getAttendantMessages.mockResolvedValueOnce(card({ canManage: false }));
    renderWithRouter(<AttendantMessagesCard admissionId={ADM} />);
    const ro = await screen.findByRole("region", { name: "Daily totals message" });
    expect(within(ro).queryByRole("button")).toBeNull();
  });
});
