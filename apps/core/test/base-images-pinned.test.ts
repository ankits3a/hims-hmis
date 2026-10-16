import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The shipped images are built FROM base images pinned by digest, so a rebuild cannot silently pull a different
 * image under the same tag. Refreshing a pin is a deliberate change (see the comment above each FROM).
 */
const ROOT = resolve(__dirname, "..", "..", "..");
const files = ["Dockerfile", "docker/prod/db.Dockerfile"];

describe("base images are pinned by digest", () => {
  for (const f of files) {
    it(`${f}: every external FROM names a sha256 digest`, () => {
      const froms = readFileSync(resolve(ROOT, f), "utf8").split("\n")
        .map((l) => /^FROM\s+(\S+)/.exec(l.trim())?.[1])
        .filter((x): x is string => x !== undefined);
      expect(froms.length).toBeGreaterThan(0);
      // A stage built on an earlier stage (`FROM base AS deps`) is internal; every image from a registry carries a digest.
      const external = froms.filter((x) => x.includes(":") || x.includes("/"));
      expect(external.length).toBeGreaterThan(0);
      for (const img of external) expect([img, /@sha256:[0-9a-f]{64}$/.test(img)]).toEqual([img, true]);
    });
  }
});
