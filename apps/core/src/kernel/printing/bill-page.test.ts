import { BILL_PAGE_MM, billPage, thermalPage } from "./render";

/** Owner, 2026-10-02: "the invoice bill should be in 4 x 6 inch print page. I will be using dot matrix printer." */
describe("the 4 × 6 inch bill page", () => {
  it("is an explicit 101.6 × 152.4 mm sheet whose @page rule comes after the roll's, and escapes its title", () => {
    const doc = billPage("Bill <1>", "<p>x</p>", ".x { color: red; }");
    expect(doc.page).toEqual({ widthMm: 101.6, heightMm: 152.4 });
    expect(BILL_PAGE_MM).toEqual({ widthMm: 101.6, heightMm: 152.4 });
    expect(doc.html).toContain("<title>Bill &lt;1&gt;</title>");
    expect(doc.html.lastIndexOf("@page { size: 4in 6in; margin: 0; }")).toBeGreaterThan(doc.html.indexOf("@page { size: 72mm auto; margin: 0; }"));
    expect(doc.html).toContain("break-inside: avoid");
  });

  it("leaves the thermal roll as it was: 72 mm, continuous", () => {
    expect(thermalPage("t", "b").page).toEqual({ widthMm: 72, heightMm: null });
  });
});
