import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { ChangeDoctorSheet } from "../src/vitals/change-doctor";

/** Spec #1031 — the phone bay's Department row on the Change doctor sheet. */
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const wrap = async (node: React.ReactElement) =>
  await render(<SafeAreaProvider initialMetrics={METRICS}><I18nProvider>{node}</I18nProvider></SafeAreaProvider>);

function stubApi(printSlip: boolean) {
  return {
    changeDoctorOptions: jest.fn(),
    changeDoctor: jest.fn().mockResolvedValue({ toSessionId: "s2" }),
    changeDepartmentOptions: jest.fn((_e: string, departmentId?: string) => Promise.resolve({
      currentDepartmentId: "ortho",
      departments: [{ id: "ortho", name: "Orthopaedics" }, { id: "med", name: "General Medicine" }],
      doctors: departmentId === "med" ? [{ id: "dm", displayName: "Dr Med" }] : [{ id: "d2", displayName: "Dr Two" }],
    })),
    moveDepartment: jest.fn().mockResolvedValue({ encounterId: "e2", tokenNo: 47, departmentName: "General Medicine", doctorName: "Dr Med", printSlip }),
    printMovedToken: jest.fn().mockResolvedValue({ queued: true }),
  };
}

describe("phone bay — change department (spec #1031)", () => {
  it("another department moves the visit and shows the new token until Done; no print without the setting", async () => {
    const api = stubApi(false);
    const onMoved = jest.fn();
    await wrap(<ChangeDoctorSheet api={api} encounterId="e1" canMoveDepartment onDone={jest.fn()} onMoved={onMoved} onClose={jest.fn()} />);
    await fireEvent.press(await screen.findByTestId("change-doctor-department-change"));
    await fireEvent.press(screen.getByTestId("change-doctor-department-med"));
    await fireEvent.press(await screen.findByTestId("change-doctor-doctor-dm"));
    await fireEvent.press(screen.getByTestId("change-doctor-reason-patientAsked"));
    await fireEvent.press(screen.getByTestId("change-doctor-consent"));
    await fireEvent.press(screen.getByTestId("change-doctor-confirm"));
    expect(await screen.findByTestId("change-department-token")).toHaveTextContent("47");
    expect(api.moveDepartment).toHaveBeenCalledWith("e1", { departmentId: "med", doctorId: "dm", consented: true, reason: "Patient asked" });
    expect(screen.queryByTestId("change-department-print")).toBeNull();
    expect(onMoved).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("change-department-close"));
    expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ encounterId: "e2", tokenNo: 47 }));
  });

  it("the visit's own department is a change of doctor, not a move", async () => {
    const api = stubApi(true);
    const onDone = jest.fn();
    await wrap(<ChangeDoctorSheet api={api} encounterId="e1" canMoveDepartment onDone={onDone} onClose={jest.fn()} />);
    await fireEvent.press(await screen.findByTestId("change-doctor-doctor-d2"));
    await fireEvent.press(screen.getByTestId("change-doctor-reason-patientAsked"));
    await fireEvent.press(screen.getByTestId("change-doctor-consent"));
    await fireEvent.press(screen.getByTestId("change-doctor-confirm"));
    await waitFor(() => { expect(onDone).toHaveBeenCalledWith("Dr Two"); });
    expect(api.moveDepartment).not.toHaveBeenCalled();
  });

  it("numbered steps tick as they are done, and the sheet names the next missing step", async () => {
    const api = stubApi(false);
    await wrap(<ChangeDoctorSheet api={api} encounterId="e1" canMoveDepartment onDone={jest.fn()} onClose={jest.fn()} />);
    await fireEvent.press(await screen.findByTestId("change-doctor-department-change"));
    await fireEvent.press(screen.getByTestId("change-doctor-department-med"));
    expect(await screen.findByTestId("change-doctor-step-doctor")).toHaveTextContent(/^2Doctor · General Medicine$/);
    expect(screen.getByTestId("change-doctor-department-chosen")).toHaveTextContent("General Medicine");
    expect(screen.queryByTestId("change-doctor-department-ortho")).toBeNull();
    expect(screen.getByTestId("change-doctor-next")).toHaveTextContent("Next: pick a doctor");
    await fireEvent.press(await screen.findByTestId("change-doctor-doctor-dm"));
    expect(screen.getByTestId("change-doctor-step-doctor")).toHaveTextContent(/^✓Doctor/);
    expect(screen.getByTestId("change-doctor-next")).toHaveTextContent("Next: pick a reason");
    await fireEvent.press(screen.getByTestId("change-doctor-reason-other"));
    expect(screen.getByTestId("change-doctor-next")).toHaveTextContent("Next: tick Patient agreed");
    expect(screen.getByTestId("change-doctor-consent")).toHaveTextContent(/Patient agreed to this change/);
    expect(screen.getByTestId("change-doctor-consent").props.accessibilityState).toEqual({ checked: false });
    await fireEvent.press(screen.getByTestId("change-doctor-consent"));
    expect(screen.getByTestId("change-doctor-consent").props.accessibilityState).toEqual({ checked: true });
    expect(screen.queryByTestId("change-doctor-next")).toBeNull();
    expect(screen.getByTestId("change-doctor-confirm")).toBeEnabled();
  });
});
