import en from "../locales/en.json";
import hi from "../locales/hi.json";

function keyPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix === "" ? k : `${prefix}.${k}`),
  );
}

it("hi.json mirrors en.json key-for-key — a missing key would silently fall back to English", () => {
  expect(keyPaths(hi).sort()).toEqual(keyPaths(en).sort());
});
