import { readFileSync } from "fs";
import { join } from "path";
import { color, cssName } from "../src/theme";

// The phone's palette IS the web's paper-pine palette. Read the shipped CSS, not a restatement.
const css = readFileSync(join(__dirname, "../../web/src/styles/paper-pine.css"), "utf8");

function cssValue(name: string): string {
  const m = css.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"));
  if (m === null || m[1] === undefined) throw new Error(`${name} is not in paper-pine.css`);
  return m[1].trim().toLowerCase().replace(/\s+/g, " ");
}

describe("theme", () => {
  it("names every token the web file defines for it", () => {
    expect(Object.keys(color).sort()).toEqual(Object.keys(cssName).sort());
  });
  it.each(Object.keys(color) as (keyof typeof color)[])("%s matches paper-pine.css", (k) => {
    expect(color[k].toLowerCase().replace(/\s+/g, " ")).toBe(cssValue(cssName[k]));
  });
});

/**
 * IBM Plex is applied by `src/text.tsx` — React Native has no app-wide default face. A screen that
 * imports `Text` or `TextInput` straight from the framework is drawn in the system's face and looks
 * like a different product; this reads every source file and fails on the first one.
 */
describe("typeface", () => {
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
  const files = [...walk(join(__dirname, "../src")), ...walk(join(__dirname, "../app"))].filter((f) => !f.endsWith("/src/text.tsx"));

  it("finds the screens", () => {
    expect(files.length).toBeGreaterThan(20);
  });
  it("no screen takes Text or TextInput from react-native", () => {
    const stray = files.filter((f) => {
      const m = /import \{([^}]*)\} from "react-native";/.exec(readFileSync(f, "utf8"));
      return m !== null && m[1]!.split(",").map((n) => n.trim()).some((n) => n === "Text" || n === "TextInput");
    });
    expect(stray).toEqual([]);
  });
});
