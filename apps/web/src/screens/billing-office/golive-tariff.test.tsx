import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders, renderWithRouter } from "../../test-utils";
import { BillingOffice } from "../billing-office";
import { TariffVersionActions } from "./tariff-version-actions";
import { IpdSwitchOn } from "./ipd-switch-on";
import type { WireOfficeVersion } from "./tariff-version-actions";

/** GO-LIVE SCREENS — submit / activate a tariff version and switch on priced IPD services. Every figure is fake. */
const v = (over: Partial<WireOfficeVersion>): WireOfficeVersion => ({
  id: "v3", versionNo: 3, status: "draft", notes: "UAT SAMPLE — not hospital rates", createdBy: "seed-ipd-stage", createdByName: null,
  submittedBy: null, submittedByName: null, approvalStatus: null, ...over,
});

function mock(perms: string[], versions: WireOfficeVersion[], me = "u-owner"): { posts: { path: string; body: unknown }[] } {
  const posts: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "");
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: me }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (init?.method === "POST") {
      posts.push({ path, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return json(path.endsWith("/switch-on") ? { switchedOn: ["IPD_ROOM_GENERAL"], alreadyOn: [], versionNo: 3 } : { ok: true });
    }
    if (path === "/tariff/versions") return json({ items: versions });
    if (path === "/tariff/services") return json({ items: [
      { id: "s1", code: "IPD_ROOM_GENERAL", name: "Room rent — General ward", active: false },
      { id: "s2", code: "IPD_RMO_GENERAL", name: "RMO — General ward", active: false },
      { id: "s3", code: "OPD-CONSULT-NEW", name: "Consult", active: true },
    ] });
    if (path === "/tariff/ipd-rate-card") return json({
      version: { versionId: "v3", versionNo: 3, status: "activated" }, ready: 0, missing: 1,
      classes: [{ bedClass: "general", label: "General ward", missing: [], cells: [
        { component: "room", required: true, serviceCode: "IPD_ROOM_GENERAL", pricePaise: 100000, state: "priced" },
        { component: "rmo", required: false, serviceCode: "IPD_RMO_GENERAL", pricePaise: null, state: "no_price" },
      ] }],
    });
    return new Response("{}", { status: 404 });
  }));
  return { posts };
}

describe("tariff version actions", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("a draft shows who drafted it and submits for approval", async () => {
    const { posts } = mock(["tariff.read", "tariff.versions.draft"], [v({})], "u-bm");
    renderWithProviders(<TariffVersionActions />);
    expect(await screen.findByTestId("tariff-version-3")).toHaveTextContent("Drafted by seed-ipd-stage");
    await userEvent.click(screen.getByTestId("tariff-version-3-submit"));
    await waitFor(() => expect(posts).toEqual([{ path: "/tariff/versions/v3/submit", body: {} }]));
  });

  it("an approved version activates from the chosen date", async () => {
    const { posts } = mock(["tariff.read", "tariff.versions.activate"],
      [v({ status: "submitted", submittedBy: "u-bm", submittedByName: "Billing manager", approvalStatus: "granted" })]);
    renderWithProviders(<TariffVersionActions />);
    expect(await screen.findByTestId("tariff-version-3")).toHaveTextContent("submitted by Billing manager");
    await userEvent.click(screen.getByTestId("tariff-version-3-activate"));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/tariff/versions/v3/activate"]));
    expect(typeof (posts[0]!.body as { effectiveFrom: string }).effectiveFrom).toBe("string");
  });

  it("Activate is disabled, with the reason, for the person who submitted it", async () => {
    mock(["tariff.read", "tariff.versions.activate"], [v({ status: "submitted", submittedBy: "u-owner", approvalStatus: "granted" })]);
    renderWithProviders(<TariffVersionActions />);
    expect(await screen.findByTestId("tariff-version-3-activate")).toBeDisabled();
    expect(screen.getByTestId("tariff-version-3-blocked")).toHaveTextContent("You submitted this version");
  });

  it("a submitted version waiting for the owner offers no Activate", async () => {
    mock(["tariff.read", "tariff.versions.activate"], [v({ status: "submitted", submittedBy: "u-bm", approvalStatus: "pending" })]);
    renderWithProviders(<TariffVersionActions />);
    expect(await screen.findByTestId("tariff-version-3-waiting")).toHaveTextContent("Waiting for the owner");
    expect(screen.queryByTestId("tariff-version-3-activate")).toBeNull();
  });
});

describe("switch on IPD services", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("lists switched-off IPD services; the unpriced one cannot be ticked; Switch on N sends the ticked ids", async () => {
    const { posts } = mock(["tariff.read", "tariff.services.manage"], []);
    renderWithProviders(<IpdSwitchOn />);
    expect(await screen.findByTestId("ipd-switch-on-IPD_RMO_GENERAL")).toHaveTextContent("No price in force");
    expect(screen.getByRole("checkbox", { name: "IPD_RMO_GENERAL" })).toBeDisabled();
    expect(screen.queryByTestId("ipd-switch-on-OPD-CONSULT-NEW")).toBeNull();
    await userEvent.click(screen.getByTestId("ipd-switch-on-all"));
    expect(screen.getByTestId("ipd-switch-on-go")).toHaveTextContent("Switch on 1 service");
    await userEvent.click(screen.getByTestId("ipd-switch-on-go"));
    await waitFor(() => expect(posts).toEqual([{ path: "/tariff/services/switch-on", body: { serviceIds: ["s1"] } }]));
    expect(await screen.findByTestId("ipd-switch-on-done")).toHaveTextContent("1 service switched on.");
  });

  it("is absent for a person without tariff.services.manage", async () => {
    mock(["tariff.read"], []);
    const { container } = renderWithProviders(<IpdSwitchOn />);
    await waitFor(() => expect(container.querySelector("[data-testid=ipd-switch-on]")).toBeNull());
  });
});

/**
 * Decision 0085 invariant 1, dark by default — the tariff version actions and the IPD switch-on are IPD go-live
 * screens. With `ipd` off (production) neither is on the back office's Prices page and neither asks for anything.
 */
describe("decision 0085 — the go-live tariff screens on the Prices page", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  function office(on: string[]): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = raw.replace(/^.*\/api/, "");
      calls.push(path);
      const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      const perms = ["billing.reports.read", "tariff.read", "tariff.versions.draft", "tariff.versions.activate", "tariff.services.manage"];
      if (path === "/auth/me") return json({ actor: { type: "user", id: "u-owner" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } }, modules: { dark: ["ipd"], on } });
      if (path === "/billing/office/needs") return json({ rows: [], money: { toPayCount: 0, toPayPaise: 0, shortPaise: 0 } });
      if (path === "/billing/consult-prices") return json({
        rows: [
          { branch: "new", serviceId: "s-new", code: "OPD-CONSULT-NEW", activePaise: 10000 },
          { branch: "renewal", serviceId: "s-ren", code: "OPD-CONSULT-RENEWAL", activePaise: 10000 },
          { branch: "revisit", serviceId: "s-rev", code: "OPD-CONSULT-REVISIT", activePaise: null },
        ],
        activeVersionNo: 6, pending: null,
      });
      if (path === "/tariff/versions") return json({ items: [v({})] });
      if (path === "/tariff/services") return json({ items: [] });
      return new Response("{}", { status: 404 });
    }));
    return { calls };
  }

  it("ipd off: no version actions, no switch-on, and neither asks for anything", async () => {
    const { calls } = office([]);
    renderWithRouter(<BillingOffice />, "/billing/office?view=prices");
    expect(await screen.findByTestId("office-page-prices")).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("/billing/consult-prices"));
    // Absence is waited for, not glanced at: the section would draw a tick after the page does.
    await expect(screen.findByTestId("tariff-version-actions", {}, { timeout: 600 })).rejects.toThrow();
    expect(screen.queryByTestId("ipd-switch-on")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.startsWith("/tariff/"))).toEqual([]);
  });

  it("ipd on: the version actions are on the page", async () => {
    office(["ipd"]);
    renderWithRouter(<BillingOffice />, "/billing/office?view=prices");
    expect(await screen.findByTestId("tariff-version-actions")).toBeInTheDocument();
  });
});
