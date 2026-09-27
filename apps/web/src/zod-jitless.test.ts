import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * WASA M-01 — THE CSP HAS NO 'unsafe-eval', SO NOTHING IN THE APP MAY EVALUATE A STRING.
 *
 * zod v4 compiles a fast path for every object schema with `new Function(...)`, and decides whether
 * it may when the schema is CONSTRUCTED — at module load, for every top-level schema. Under
 * `script-src 'self'` that probe is a CSP violation on every page load (measured: the production
 * build reported `script-src … eval` from the first screen). `z.config({ jitless: true })` turns the
 * compiler off; it must run before any other module builds a schema, so it is `main.tsx`'s first import.
 */
describe("M-01 — zod never evaluates a string as code", () => {
  it("main.tsx makes ./zod-jitless its FIRST import, ahead of every module that builds a schema", () => {
    const src = readFileSync(resolve(__dirname, "main.tsx"), "utf8");
    const firstImport = src.split("\n").find((l) => l.startsWith("import "));
    expect(firstImport?.replace(/\s*\/\/.*$/, "")).toBe('import "./zod-jitless";');
  });

  it("with it loaded, building and parsing an object schema never constructs a Function", async () => {
    await import("./zod-jitless");
    const { z } = await import("zod");
    const spy = vi.spyOn(globalThis, "Function");
    try {
      const schema = z.object({ name: z.string(), age: z.number().optional() });
      expect(schema.parse({ name: "Asha", age: 34 })).toEqual({ name: "Asha", age: 34 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
