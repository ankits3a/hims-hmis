import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { EyeSections, fmtPower } from "./opd-eye-sections";
import type { WireVisitSections } from "./opd-eye-sections";

/** Board `Ophthal` (approved 2026-09-23): the eye OPD's consult sections, each eye its own column. */
const EYE: WireVisitSections = {
  profile: "ophthalmology",
  sections: [
    { key: "eye.vision", version: 1, kind: "eye-grid" }, { key: "eye.iop", version: 1, kind: "eye-grid" },
    { key: "eye.slit_lamp", version: 1, kind: "eye-grid" }, { key: "eye.glasses_rx", version: 1, kind: "lens-grid" },
  ],
  records: {
    "eye.vision": { body: { vaUnaided: { od: "6/36", os: "6/9" } }, at: "2026-09-24T04:50:00.000Z", authorId: "u-1", sectionVersion: 1, recordId: "r-1" },
  },
};

function puts(path: string): Record<string, unknown>[] {
  return vi.mocked(fetch).mock.calls
    .filter(([u, init]) => String(u).split("?")[0] === path && init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

describe("EyeSections — the ophthalmology consult sections", () => {
  beforeEach(() => { setToken("t"); });

  it("draws the four sections with what is on record, right eye first", async () => {
    stubFetch({ "GET /api/opd/visits/enc-1/sections": EYE });
    renderWithProviders(<EyeSections encounterId="enc-1" leaseBody={() => ({ leaseToken: "tab-1" })} readOnly={false} />);
    expect(await screen.findByTestId("eye-vision-vaUnaided-od")).toHaveValue("6/36");
    expect(screen.getByTestId("eye-vision-vaUnaided-os")).toHaveValue("6/9");
    expect(screen.getByTestId("eye-iop")).toBeInTheDocument();
    expect(screen.getByTestId("eye-slit")).toBeInTheDocument();
    expect(screen.getByTestId("eye-glasses")).toBeInTheDocument();
    expect(screen.getByLabelText("VA unaided · Right eye (OD)")).toBeInTheDocument();
    expect(screen.getByTestId("eye-vision-status")).toHaveTextContent(/Saved 10:20/);
  });

  it("leaving a section saves it once, with the lease; leaving it unchanged saves nothing", async () => {
    stubFetch({
      "GET /api/opd/visits/enc-1/sections": EYE,
      "PUT /api/opd/visits/enc-1/sections/eye.slit_lamp": { record: { recordId: "r-2", at: "2026-09-24T05:00:00.000Z" } },
    });
    const user = userEvent.setup();
    renderWithProviders(<><EyeSections encounterId="enc-1" leaseBody={() => ({ leaseToken: "tab-1" })} readOnly={false} /><button type="button">elsewhere</button></>);
    const lens = await screen.findByTestId("eye-slit-lens-od");
    await user.click(lens); await user.click(screen.getByText("elsewhere"));
    expect(puts("/api/opd/visits/enc-1/sections/eye.slit_lamp")).toHaveLength(0);
    await user.type(lens, "NS grade 3");
    await user.click(screen.getByText("elsewhere"));
    await waitFor(() => { expect(puts("/api/opd/visits/enc-1/sections/eye.slit_lamp")).toHaveLength(1); });
    const sent = puts("/api/opd/visits/enc-1/sections/eye.slit_lamp")[0]!;
    expect(sent.leaseToken).toBe("tab-1");
    expect((sent.body as Record<string, { od: string; os: string }>).lens).toEqual({ od: "NS grade 3", os: "" });
  });

  it("Copy OD → OS fills the left eye from the right and saves", async () => {
    stubFetch({
      "GET /api/opd/visits/enc-1/sections": EYE,
      "PUT /api/opd/visits/enc-1/sections/eye.vision": { record: { recordId: "r-3", at: "2026-09-24T05:00:00.000Z" } },
    });
    const user = userEvent.setup();
    renderWithProviders(<EyeSections encounterId="enc-1" leaseBody={() => ({})} readOnly={false} />);
    await screen.findByTestId("eye-vision-vaUnaided-od");
    await user.click(screen.getByTestId("eye-vision-copy"));
    expect(screen.getByTestId("eye-vision-vaUnaided-os")).toHaveValue("6/36");
    await waitFor(() => { expect(puts("/api/opd/visits/enc-1/sections/eye.vision")).toHaveLength(1); });
  });

  it("the glasses grid sends dioptres as numbers and shows them signed, as an optometrist writes them", async () => {
    stubFetch({
      "GET /api/opd/visits/enc-1/sections": EYE,
      "PUT /api/opd/visits/enc-1/sections/eye.glasses_rx": { record: { recordId: "r-4", at: "2026-09-24T05:00:00.000Z" } },
    });
    const user = userEvent.setup();
    renderWithProviders(<EyeSections encounterId="enc-1" leaseBody={() => ({})} readOnly={false} />);
    const sph = await screen.findByTestId("eye-glasses-od-sph");
    await user.type(sph, "-1.25"); await user.tab();
    await waitFor(() => { expect(puts("/api/opd/visits/enc-1/sections/eye.glasses_rx").length).toBeGreaterThan(0); });
    const body = puts("/api/opd/visits/enc-1/sections/eye.glasses_rx").at(-1)!.body as { od: { sph: number } };
    expect(body.od.sph).toBe(-1.25);
    expect(fmtPower(-1.25)).toBe("−1.25");
    expect(fmtPower(2.5)).toBe("+2.50");
    expect(fmtPower(0)).toBe("0.00");
  });

  it("a department without a profile draws nothing", async () => {
    stubFetch({ "GET /api/opd/visits/enc-1/sections": { profile: null, sections: [], records: {} } });
    const { container } = renderWithProviders(<div data-testid="host"><EyeSections encounterId="enc-1" leaseBody={() => ({})} readOnly={false} /></div>);
    await waitFor(() => { expect(vi.mocked(fetch)).toHaveBeenCalled(); });
    expect(within(container as HTMLElement).queryByTestId("eye-sections")).toBeNull();
  });
});
