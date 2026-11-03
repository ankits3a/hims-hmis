import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test-utils";
import { ChangeDoctorAction } from "./change-doctor";

const api = vi.hoisted(() => ({
  fetchChangeDoctorOptions: vi.fn(), changeVisitDoctor: vi.fn(),
  fetchChangeDepartmentOptions: vi.fn(), moveDepartmentFromVitals: vi.fn(), printMovedTokenSlip: vi.fn(),
  opdErrorMessage: (e: unknown) => String(e),
}));
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

  describe("with the Department picker (spec #1031)", () => {
    beforeEach(() => {
      api.fetchChangeDepartmentOptions.mockImplementation((_e: string, departmentId?: string) => Promise.resolve({
        currentDepartmentId: "ortho",
        departments: [{ id: "ortho", name: "Orthopaedics" }, { id: "med", name: "General Medicine" }],
        doctors: departmentId === "med" ? [{ id: "dm", displayName: "Dr Med" }] : [{ id: "d2", displayName: "Dr Two" }],
      }));
    });
    const fill = async (user: ReturnType<typeof userEvent.setup>, dept: string, doctor: string, name: string) => {
      await user.click(screen.getByTestId("change-doctor-open"));
      await screen.findByRole("option", { name: "General Medicine" });
      await user.selectOptions(screen.getByTestId("change-doctor-department"), dept);
      await screen.findByRole("option", { name });
      await user.selectOptions(screen.getByTestId("change-doctor-doctor"), doctor);
      await user.selectOptions(screen.getByTestId("change-doctor-reason"), "patientAsked");
      await user.click(screen.getByTestId("change-doctor-consent"));
      await user.click(screen.getByTestId("change-doctor-confirm"));
    };

    it("the visit's own department is still a change of doctor, not a move", async () => {
      api.moveDepartmentFromVitals.mockClear();
      const onDone = vi.fn();
      renderWithProviders(<ChangeDoctorAction encounterId="e1" canMoveDepartment onDone={onDone} />);
      await fill(userEvent.setup(), "ortho", "d2", "Dr Two");
      await waitFor(() => { expect(onDone).toHaveBeenCalledWith("Dr Two"); });
      expect(api.changeVisitDoctor).toHaveBeenCalledWith("e1", { toDoctorId: "d2", consented: true, reason: "Patient asked" });
      expect(api.moveDepartmentFromVitals).not.toHaveBeenCalled();
    });

    it("with the hospital's print setting on, the new token slip can be printed, once", async () => {
      api.moveDepartmentFromVitals.mockResolvedValue({ encounterId: "e2", tokenNo: 12, departmentName: "General Medicine", doctorName: "Dr Med", printSlip: true });
      api.printMovedTokenSlip.mockResolvedValue({ queued: true });
      const onDone = vi.fn();
      renderWithProviders(<ChangeDoctorAction encounterId="e1" canMoveDepartment onDone={onDone} />);
      const user = userEvent.setup();
      await fill(user, "med", "dm", "Dr Med");
      await user.click(await screen.findByTestId("change-department-print"));
      await waitFor(() => { expect(screen.getByTestId("change-department-print")).toBeDisabled(); });
      expect(api.printMovedTokenSlip).toHaveBeenCalledWith("e2");
      expect(onDone).not.toHaveBeenCalled(); // the token stays on screen until Done
      await user.click(screen.getByTestId("change-department-close"));
      expect(onDone).toHaveBeenCalledWith("Dr Med", expect.objectContaining({ encounterId: "e2", tokenNo: 12 }));
    });
  });
});
