import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { TestPicker } from "../components/test-picker";
import { advisableTests } from "../lib/ordering-api";
import { OutsideTests } from "./outside-tests";
import type { WireOutsideTest } from "../lib/ordering-api";

/**
 * DECISION 0065 (owner 2026-10-10) — ECG, echo and the like are done outside until the hospital has
 * the facility: an admin list, a doctor's test box that finds them, and a picker that names who does
 * each test.
 */
function row(code: string, nameEn: string, over: Partial<WireOutsideTest> = {}): WireOutsideTest {
  return { serviceId: `OUTSVC-${code}`, code, nameEn, site: "outside", department: null, active: true, updatedAt: "2026-10-10T10:00:00.000Z", ...over };
}

function mock(perms: string[]): { puts: unknown[] } {
  let rows = [row("ECG", "ECG (12-lead)"), row("ECHO", "2D echocardiography")];
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u-admin" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/ordering/outside-tests" && (init?.method ?? "GET") === "GET") return json({ items: rows });
    if (path === "/ordering/outside-tests" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { code: string; nameEn: string; site: "outside" | "in_hospital"; department: string | null; active: boolean };
      puts.push(body);
      const saved = row(body.code, body.nameEn, { site: body.site, department: body.department, active: body.active });
      rows = [...rows.filter((r) => r.code !== body.code), saved];
      return json(saved);
    }
    if (path === "/tariff/price-list") return json({ items: [{ serviceId: "LABSVC-CBC", code: "LAB-CBC", name: "Complete blood count", category: "investigation", pricePaise: 30000 }] });
    if (path === "/ordering/tests") {
      return json({ items: query.includes("ec") ? [
        { serviceId: "OUTSVC-ECG", code: "ECG", name: "ECG (12-lead)", department: "outside", departmentName: null },
        { serviceId: "RADSVC-ECHO", code: "USG-ECHO", name: "Echo-guided USG", department: "imaging", departmentName: null },
      ] : [] });
    }
    return new Response("{}", { status: 404 });
  }));
  return { puts };
}

describe("outside tests (decision 0065)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("lists the outside tests and adds one; moving a test in-hospital needs its department", async () => {
    const { puts } = mock(["tariff.read", "tariff.services.manage"]);
    renderWithProviders(<OutsideTests />);
    expect(await screen.findByTestId("outside-test-ECG")).toHaveTextContent("ECG (12-lead)");
    const form = screen.getByTestId("outside-test-form");
    await userEvent.type(within(form).getByLabelText("Code"), "pft");
    await userEvent.type(within(form).getByLabelText("Name"), "Pulmonary function test");
    await userEvent.click(within(form).getByRole("button", { name: "Add test" }));
    await waitFor(() => expect(puts).toEqual([{ code: "PFT", nameEn: "Pulmonary function test", site: "outside", department: null, active: true }]));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved — Pulmonary function test.");

    await userEvent.click(within(screen.getByTestId("outside-test-ECG")).getByRole("button", { name: "Edit" }));
    await userEvent.selectOptions(within(form).getByLabelText("Done"), "in_hospital");
    const save = within(form).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await userEvent.type(within(form).getByLabelText("Department"), "Cardiology");
    await userEvent.click(save);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ code: "ECG", nameEn: "ECG (12-lead)", site: "in_hospital", department: "Cardiology", active: true });
    expect(await screen.findByTestId("outside-test-ECG")).toHaveTextContent("In hospital · Cardiology");
  });

  it("a reader without tariff.services.manage sees the list and no form", async () => {
    mock(["tariff.read"]);
    renderWithProviders(<OutsideTests />);
    expect(await screen.findByTestId("outside-test-ECHO")).toBeInTheDocument();
    expect(screen.queryByTestId("outside-test-form")).not.toBeInTheDocument();
  });

  it("the doctor's test list is the price list plus the outside tests, the outside ones marked and unpriced", async () => {
    mock(["tariff.read"]);
    const { items } = await advisableTests();
    expect(items.map((i) => [i.name, i.pricePaise, i.outside === true])).toEqual([
      ["2D echocardiography", 0, true], ["Complete blood count", 30000, false], ["ECG (12-lead)", 0, true],
    ]);
  });

  it("the picker names who does each test", async () => {
    mock(["tariff.read"]);
    const picked: string[] = [];
    renderWithProviders(<TestPicker picked={[]} onPick={(r) => picked.push(r.serviceId)} />);
    await userEvent.type(screen.getByRole("textbox"), "ec");
    expect(await screen.findByTestId("test-picker-dept-OUTSVC-ECG")).toHaveTextContent("Outside");
    expect(screen.getByTestId("test-picker-dept-RADSVC-ECHO")).toHaveTextContent("Imaging");
    await userEvent.click(screen.getByRole("button", { name: /ECG \(12-lead\)/ }));
    expect(picked).toEqual(["OUTSVC-ECG"]);
  });
});
