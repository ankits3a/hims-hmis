import { radiologyManifest } from "../manifest";

/**
 * ACCEPTANCE — issue #1087, spec docs/specs/1087-imaging-fewer-stations.md (owner APPROVED 2026-11-14), the
 * server half (D5): the module's menu no longer offers the worklist, the diary or the portable round. Their
 * addresses still answer in the browser (they forward to the Desk, Rooms and Reading); what leaves is the
 * door in the menu.
 */
describe("spec #1087 — imaging: fewer stations per seat (manifest)", () => {
  it("spec #1087 D5: the manifest menu lists neither worklist, diary nor portable", () => {
    const paths = (radiologyManifest.menu ?? []).map((m) => m.path);
    // Non-vacuous: the menu is read, and the hall display keeps its entry (the kiosk role needs a door).
    expect(paths).toContain("/radiology/reception");
    expect(paths).toContain("/radiology/display");
    expect(paths.filter((p) => ["/radiology/worklist", "/radiology/diary", "/radiology/portable"].includes(p))).toEqual([]);
  });
});
