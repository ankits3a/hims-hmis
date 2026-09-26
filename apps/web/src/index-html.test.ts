import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WASA L-09 — `index.html` is the one file every visitor, and every scanner, downloads first, and
 * vite ships its HTML comments verbatim. It carried the FD-23 close-review notes, which already
 * live where they belong (`src/styles/plex.css`'s header). Internal notes go in source files the
 * build strips, never in the page itself.
 */
describe("index.html (WASA L-09)", () => {
  it("carries no HTML comment into the shipped page", () => {
    const html = readFileSync(resolve(__dirname, "..", "index.html"), "utf8");
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain("<!--");
  });
});
