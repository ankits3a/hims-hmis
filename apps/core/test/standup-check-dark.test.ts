import { switchOf } from "../src/kernel/modules/switch";
import { STANDUP_ROWS, censusModuleNames } from "../scripts/standup-check";

/**
 * Decision 0085 invariant 1, dark by default — `deploy.sh` runs `standup-check all` on production, where
 * `HMIS_MODULES_ON` is empty. A department whose module is dark is not on that census: production's deploy log prints
 * no IPD row while `ipd` is off. Asked by name (`standup-check ipd`, the rehearsal on staging), it still answers.
 */
describe("decision 0085 — the census leaves a dark department out of `all`", () => {
  it("ipd off (production): `all` has no ipd; every other department stays", () => {
    const names = censusModuleNames("all", switchOf([]));
    expect(names).not.toContain("ipd");
    expect(names).toEqual(Object.keys(STANDUP_ROWS).filter((k) => k !== "ipd"));
  });

  it("ipd on: `all` carries ipd again", () => {
    expect(censusModuleNames("all", switchOf(["ipd"]))).toEqual(Object.keys(STANDUP_ROWS));
  });

  it("asked by name, a dark department still answers", () => {
    expect(censusModuleNames("ipd", switchOf([]))).toEqual(["ipd"]);
  });
});
