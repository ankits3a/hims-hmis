import { screen, waitFor } from "@testing-library/react";
import { EnvironmentBanner } from "./environment-banner";
import { renderWithProviders, stubFetch } from "../test-utils";

/**
 * PHASE 11i T3 (§2b row 22) — a receptionist registers a real patient on UAT because both tabs
 * look the same.
 *
 * The banner is the only thing that distinguishes them, so the assertions are about what a person
 * SEES and where it sits, not about a string arriving over a wire. The two that matter most are
 * the negative one — production, where the key is unset, must look exactly as it does today — and
 * the pointer-events one, because FD-11 found the shell alive and tabbable under Desk One and a
 * warning that swallows a click on the screen it is warning about is that defect wearing a label.
 */
describe("the environment banner (11i T3)", () => {
  beforeEach(() => {
    document.head.querySelectorAll("link[rel='icon']").forEach((l) => { l.remove(); });
    document.title = "HMIS";
  });

  it("renders NOTHING when the API reports no environment — production's appearance", async () => {
    stubFetch({ "GET /api/health": { status: "ok", db: "ok", worker: "ok", environment: null } });
    renderWithProviders(<EnvironmentBanner />);
    await waitFor(() => { expect(document.title).toBe("HMIS"); });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.head.querySelector("link[rel='icon']")).toBeNull();
  });

  it("renders the label, and the sentence a trainee needs, when the API reports one", async () => {
    stubFetch({ "GET /api/health": { status: "ok", db: "ok", worker: "ok", environment: "UAT" } });
    renderWithProviders(<EnvironmentBanner />);

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("UAT");
    // The warning is the point, not the label: "UAT" means nothing to a receptionist on day one.
    expect(banner).toHaveTextContent(/do not enter a real patient/i);
  });

  it("cannot take a click from the screen it warns about, and sits above Desk One", async () => {
    stubFetch({ "GET /api/health": { status: "ok", db: "ok", worker: "ok", environment: "UAT" } });
    renderWithProviders(<EnvironmentBanner />);
    const banner = await screen.findByRole("status");
    // jsdom does not apply the stylesheet, so the CLASS is the contract and styles.css is where
    // the rules live — asserted there by name below rather than computed here from nothing.
    expect(banner).toHaveClass("env-banner");
  });

  it("swaps the tab's icon and title, because a tab is all you see of a window you are not in", async () => {
    stubFetch({ "GET /api/health": { status: "ok", db: "ok", worker: "ok", environment: "UAT" } });
    renderWithProviders(<EnvironmentBanner />);
    await screen.findByRole("status");

    await waitFor(() => {
      const icon = document.head.querySelector<HTMLLinkElement>("link[rel='icon']");
      expect(icon).not.toBeNull();
      expect(icon!.href).toMatch(/^data:image\/svg\+xml,/);
      // the letter that makes it recognisable at 16px, and the banner's own colour
      expect(decodeURIComponent(icon!.href)).toContain(">U<");
      expect(decodeURIComponent(icon!.href)).toContain("#b45309");
    });
    expect(document.title).toBe("UAT · HMIS");
  });

  it("renders nothing when /health cannot be reached — a blip must not invent an environment", async () => {
    stubFetch({}); // every route 404s
    renderWithProviders(<EnvironmentBanner />);
    await waitFor(() => { expect(screen.queryByRole("status")).not.toBeInTheDocument(); });
  });
});

/**
 * The stylesheet half of the contract above. jsdom applies no CSS, so these two rules — the ones
 * that decide whether the banner can steal a click and whether Desk One covers it — are asserted
 * against the file that carries them.
 */
describe("the banner's two load-bearing style rules (11i T3)", () => {
  it("is pointer-events: none and above Desk One's stacking context", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const rule = /\.env-banner \{([\s\S]*?)\}/.exec(css);
    if (rule?.[1] === undefined) throw new Error("styles.css: no `.env-banner {}` rule — this parser is stale");
    const body = rule[1];
    expect(body).toMatch(/pointer-events:\s*none/);
    expect(body).toMatch(/position:\s*fixed/);
    const z = /z-index:\s*(\d+)/.exec(body);
    if (z?.[1] === undefined) throw new Error("styles.css: `.env-banner` has no z-index");
    // `.d1` is 40 and its command palette is 60 (desk-one.css); anything at or below either is a
    // banner Desk One covers, on the seat where a trainee is most likely to type a real name.
    expect(Number(z[1])).toBeGreaterThan(60);
  });
});
