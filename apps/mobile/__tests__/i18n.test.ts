import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";
import webEn from "../../web/src/locales/en.json";
import webHi from "../../web/src/locales/hi.json";
import { translate } from "../src/i18n";

function leaves(o: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (o !== null && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix === "" ? k : `${prefix}.${k}`;
      if (typeof v === "string") out.set(key, v);
      else for (const [kk, vv] of leaves(v, key)) out.set(kk, vv);
    }
  }
  return out;
}

describe("i18n", () => {
  const e = leaves(en), h = leaves(hi);

  it("has every English key in Hindi and nothing extra", () => {
    expect([...h.keys()].sort()).toEqual([...e.keys()].sort());
  });

  it("says the same as the web counter for every key the web also has", () => {
    const we = leaves(webEn), wh = leaves(webHi);
    for (const [k, v] of e) if (we.has(k)) expect([k, v]).toEqual([k, we.get(k)]);
    for (const [k, v] of h) if (wh.has(k)) expect([k, v]).toEqual([k, wh.get(k)]);
  });

  it("fills {{vars}} and falls back to the key", () => {
    expect(translate("en", "mobile.signedInAs", { name: "asha.devi" })).toBe("Signed in as asha.devi");
    expect(translate("hi", "nope.missing")).toBe("nope.missing");
  });
});
