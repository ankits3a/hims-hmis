import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { WardPicker, floorOf, groupByFloor, keepLastWard, readLastWard, wardLabel } from "./ward-picker";

/*
  IPD walk 2026-10-14 — sixty ward chips across a 390 px phone, two of them both called "Twin-sharing rooms". One picker
  for every ward screen: a select grouped by floor, each ward "name · code", the last pick remembered per user.
*/
const WARDS = [
  { id: "w3", code: "F03-SPVT", name: "Twin-sharing rooms" },
  { id: "w0", code: "F00-DC", name: "Day care" },
  { id: "w4", code: "F04-SPVT", name: "Twin-sharing rooms" },
  { id: "wx", code: "ANNEX-1", name: "Annex ward" },
  { id: "w1", code: "F01-CCU", name: "Coronary care unit" },
];

describe("ward picker", () => {
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("reads the floor off the code and groups ground first, unknown last", () => {
    expect(floorOf("F03-SPVT")).toBe(3);
    expect(floorOf("F00-DC")).toBe(0);
    expect(floorOf("ANNEX-1")).toBeNull();
    expect(groupByFloor(WARDS).map((g) => g.floor)).toEqual([0, 1, 3, 4, null]);
  });

  it("is one select, grouped by floor, where two wards of the same name are told apart by code", async () => {
    const onChange = vi.fn();
    renderWithProviders(<WardPicker wards={WARDS} value="w1" onChange={onChange} />);
    const select = screen.getByTestId<HTMLSelectElement>("ward-picker");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    const groups = select.querySelectorAll("optgroup");
    expect([...groups].map((g) => g.label)).toEqual(["Ground floor", "Floor 1", "Floor 3", "Floor 4", "Other"]);
    expect(within(select).getByRole("option", { name: "Twin-sharing rooms · F03-SPVT" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Twin-sharing rooms · F04-SPVT" })).toBeInTheDocument();
    expect(wardLabel(WARDS[0]!)).toBe("Twin-sharing rooms · F03-SPVT");
    expect(select.value).toBe("w1");
    await userEvent.selectOptions(select, "w4");
    expect(onChange).toHaveBeenCalledWith("w4");
  });

  it("shows 'Pick your ward' when nothing is chosen", () => {
    renderWithProviders(<WardPicker wards={WARDS} value={null} onChange={() => {}} />);
    const select = screen.getByTestId<HTMLSelectElement>("ward-picker");
    expect(select.value).toBe("");
    expect(within(select).getByRole("option", { name: "Pick your ward" })).toBeDisabled();
  });

  it("remembers the last ward per user, and a browser that refuses storage costs nothing but the memory", () => {
    keepLastWard("nurse.a", "w3");
    keepLastWard("nurse.b", "w4");
    expect(readLastWard("nurse.a")).toBe("w3");
    expect(readLastWard("nurse.b")).toBe("w4");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("SecurityError"); });
    expect(readLastWard("nurse.a")).toBeNull();
    expect(() => keepLastWard("nurse.a", "w1")).not.toThrow();
  });
});
