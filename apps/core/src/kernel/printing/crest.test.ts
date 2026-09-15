import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREST_PNG_DATA_URI } from "./crest";

/**
 * Two facts about the crest that nothing else would notice going wrong.
 *
 * The first is that the constant and the committed PNG are the same bytes. They are two copies of
 * one asset — a base64 blob nobody will ever diff, and an image beside the artboard that a designer
 * will one day replace. Replacing either alone is silent: the sheet keeps rendering, with the old
 * crest or a broken one, and no other test looks at an image.
 *
 * The second is the `"72mm"` landmine. `render.test.ts` asserts the prescription's HTML contains no
 * `72mm` anywhere — that is how it proves an A4 sheet did not inherit the thermal page size — and
 * this 22,456-character blob is now inside that HTML. Base64 draws from a 64-character alphabet, so
 * a four-character run has about a 1-in-16-million chance per position and roughly 3.4 % over a blob
 * this size. It does not collide today. A re-crop or a re-compression re-rolls it, and the failure
 * would arrive as a page-geometry test failing for a reason no reader would guess.
 */
describe("FD-29: the inlined crest", () => {
  const png = readFileSync(join(__dirname, "../../../../../docs/design/2026-08-29-opd-counter-flow-v2/crk-logo-244.png"));

  it("is exactly the committed PNG, so the two copies cannot drift apart", () => {
    expect(CREST_PNG_DATA_URI).toBe(`data:image/png;base64,${png.toString("base64")}`);
  });

  it("is the 244 x 222 derivative, not the 717 px master and not the older 240 px copy", () => {
    // PNG IHDR: an 8-byte signature, then the length+type of the first chunk, then width and height.
    expect(png.readUInt32BE(16)).toBe(244);
    expect(png.readUInt32BE(20)).toBe(222);
    // Under 20 kB. The master inlines to 570 kB, and a claim may carry fifty documents.
    expect(png.byteLength).toBeLessThan(20_000);
  });

  it("carries no run that would trip the prescription's `not.toContain(\"72mm\")` page-size guard", () => {
    expect(CREST_PNG_DATA_URI).not.toContain("72mm");
  });
});
