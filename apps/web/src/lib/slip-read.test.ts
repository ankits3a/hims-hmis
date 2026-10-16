import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #659 — jsQR (~130 kB minified) is needed only when the slip desk photographs a sheet and the browser
 * has no BarcodeDetector. The web app ships as one chunk, so a static import puts it on every user's
 * first load; it is loaded on demand instead.
 */
describe("slip-read: jsQR is loaded on demand", () => {
  it("has no static import of jsqr, and imports it dynamically", () => {
    const src = readFileSync(join(__dirname, "slip-read.ts"), "utf8");
    expect(src).not.toMatch(/^import [^;]*from "jsqr";?$/m);
    expect(src).toMatch(/import\("jsqr"\)/);
  });
});
