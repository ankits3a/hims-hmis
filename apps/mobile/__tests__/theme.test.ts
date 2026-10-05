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
