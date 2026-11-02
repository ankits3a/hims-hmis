import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test-utils";
import { ChangeDoctorAction } from "./change-doctor";

const api = vi.hoisted(() => ({ fetchChangeDoctorOptions: vi.fn(), changeVisitDoctor: vi.fn(), opdErrorMessage: (e: unknown) => String(e) }));
vi.mock("../lib/opd-api", () => api);

describe("ChangeDoctorAction (spec #1025)", () => {
  beforeEach(() => {
    api.fetchChangeDoctorOptions.mockResolvedValue({ items: [{ id: "d2", displayName: "Dr Two" }] });
    api.changeVisitDoctor.mockResolvedValue({ toSessionId: "s2" });
  });

  it("sends the doctor only once a reason and the patient's agreement are given", async () => {
    const onDone = vi.fn();
    renderWithProviders(<ChangeDoctorAction encounterId="e1" onDone={onDone} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("change-doctor-open"));
    await screen.findByRole("option", { name: "Dr Two" });
    await user.selectOptions(screen.getByTestId("change-doctor-doctor"), "d2");
    await user.selectOptions(screen.getByTestId("change-doctor-reason"), "patientAsked");
    expect(screen.getByTestId("change-doctor-confirm")).toBeDisabled();
    await user.click(screen.getByTestId("change-doctor-consent"));
    await user.click(screen.getByTestId("change-doctor-confirm"));
    await waitFor(() => { expect(onDone).toHaveBeenCalledWith("Dr Two"); });
    expect(api.changeVisitDoctor).toHaveBeenCalledWith("e1", { toDoctorId: "d2", consented: true, reason: "Patient asked" });
  });
});
