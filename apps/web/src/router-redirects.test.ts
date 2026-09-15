import { createMemoryHistory } from "@tanstack/react-router";
import { setToken } from "./lib/api";
import { router } from "./router";

/**
 * PHASE 11i T9 — the three paths production is serving today, forwarded for one release.
 *
 * The catch-up deploy deletes `/counter/seat`, `/counter/seat/figures` and `/opd/vitals/bay` in one
 * step. Those are on the desk PCs' bookmark bars, and the morning after a deploy a clerk clicks the
 * bookmark they click every morning. Without these three that is a blank screen with no message,
 * which reads as "the new version is broken".
 *
 * IT LOADS THE ROUTER AND NEVER RENDERS A SCREEN. `router.load()` runs the `beforeLoad` chain and
 * follows the redirect, which is the whole of what is under test; mounting `/counter` would drag
 * Desk One and its fetches into a suite of 90 files that share one timeout budget, to assert
 * something no pixel is involved in.
 */
async function loadAt(path: string): Promise<void> {
  setToken("t-1"); // authedRoute's own beforeLoad redirects to /login without one
  router.update({ history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
}

describe("the three deleted front-desk paths forward for one release (11i T9)", () => {
  afterAll(() => { setToken(null); });

  it("forwards /counter/seat to /counter", async () => {
    await loadAt("/counter/seat");
    expect(router.state.location.pathname).toBe("/counter");
  });

  it("forwards /counter/seat/figures to /counter/figures", async () => {
    await loadAt("/counter/seat/figures");
    expect(router.state.location.pathname).toBe("/counter/figures");
  });

  it("forwards /opd/vitals/bay to /opd/vitals", async () => {
    await loadAt("/opd/vitals/bay");
    expect(router.state.location.pathname).toBe("/opd/vitals");
  });

  it("CARRIES THE QUERY STRING — a bookmark that lands without its patient is worse than a 404", async () => {
    // A clerk's bookmark to the seat with a patient in it is the case this exists for: arriving at
    // a bare `/counter` loses the person and the clerk has to work out what they lost.
    await loadAt("/counter/seat?patient=U00110012&stage=register");
    expect(router.state.location.pathname).toBe("/counter");
    expect(router.state.location.search).toEqual({ patient: "U00110012", stage: "register" });
  });

  it("leaves a path that was never deleted alone", async () => {
    // Non-vacuity: the assertions above would all pass against a router that redirected everything.
    await loadAt("/counter/figures");
    expect(router.state.location.pathname).toBe("/counter/figures");
  });
});
