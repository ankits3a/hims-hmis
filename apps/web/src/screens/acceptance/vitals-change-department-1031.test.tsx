import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test-utils";
import { ChangeDoctorAction } from "../../components/change-doctor";

/**
 * ACCEPTANCE — issue #1031, spec docs/specs/1031-vitals-change-department.md (owner APPROVED 2026-11-03):
 * the web half. The vitals bay's "Change doctor" sheet gains a Department picker; a move to another
 * department ends with the new token shown large for staff to write on the old slip.
 */
const api = vi.hoisted(() => ({
  fetchChangeDoctorOptions: vi.fn(),
  changeVisitDoctor: vi.fn(),
  fetchChangeDepartmentOptions: vi.fn(),
  moveDepartmentFromVitals: vi.fn(),
  printMovedTokenSlip: vi.fn(),
  opdErrorMessage: (e: unknown) => String(e),
}));
vi.mock("../../lib/opd-api", () => api);

describe("#1031 — change department from the vitals screen (web)", () => {
  it("spec #1031 D8: after the move, the screen shows the new token number", async () => {
    api.fetchChangeDepartmentOptions.mockImplementation((_e: string, departmentId?: string) => Promise.resolve({
      currentDepartmentId: "ortho",
      departments: [{ id: "ortho", name: "Orthopaedics" }, { id: "med", name: "General Medicine" }],
      doctors: departmentId === "med" ? [{ id: "dm", displayName: "Dr Med" }] : [{ id: "d2", displayName: "Dr Two" }],
    }));
    api.moveDepartmentFromVitals.mockResolvedValue({ encounterId: "e2", tokenNo: 47, departmentName: "General Medicine", doctorName: "Dr Med", printSlip: false });
    renderWithProviders(<ChangeDoctorAction encounterId="e1" canMoveDepartment onDone={() => undefined} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("change-doctor-open"));
    await screen.findByRole("option", { name: "General Medicine" });
    await user.selectOptions(screen.getByTestId("change-doctor-department"), "med");
    await screen.findByRole("option", { name: "Dr Med" });
    await user.selectOptions(screen.getByTestId("change-doctor-doctor"), "dm");
    await user.selectOptions(screen.getByTestId("change-doctor-reason"), "patientAsked");
    await user.click(screen.getByTestId("change-doctor-consent"));
    await user.click(screen.getByTestId("change-doctor-confirm"));
    await waitFor(() => { expect(screen.getByTestId("change-department-token").textContent).toContain("47"); });
    expect(api.moveDepartmentFromVitals).toHaveBeenCalledWith("e1", { departmentId: "med", doctorId: "dm", consented: true, reason: "Patient asked" });
    expect(screen.queryByTestId("change-department-print")).toBeNull();
  });
});
