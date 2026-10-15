import { MAX_PAGES, landedUnheard, moveById, paperOf } from "../src/slips/pages";

describe("several pages of one slip — the strip's rules", () => {
  it("takes six pages at most", () => {
    expect(MAX_PAGES).toBe(6);
  });

  it("the slip speaks for the page that closed the visit, not the ones after it", () => {
    expect(paperOf(["marked", "already_marked", "already_marked"])).toBe("marked");
    expect(paperOf([null, "already_marked"])).toBe("already_marked");
    expect(paperOf(["not_permitted", "not_permitted"])).toBe("not_permitted");
    expect(paperOf(["failed", "marked"])).toBe("marked");
    expect(paperOf([null, null])).toBeNull();
  });

  it("an unheard page landed only when the server holds one more than was answered for", () => {
    expect(landedUnheard(0, 1, 1)).toBe(false); // page 1 answered, page 2 unheard, server has 1 → send it
    expect(landedUnheard(0, 1, 2)).toBe(true); //  server has 2 → it is there
    expect(landedUnheard(3, 0, 3)).toBe(false); // three on file before this slip
    expect(landedUnheard(3, 0, 4)).toBe(true);
  });

  it("moves a page one place and never off the strip", () => {
    const p = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(moveById(p, 3, -1).map((x) => x.id)).toEqual([1, 3, 2]);
    expect(moveById(p, 1, 1).map((x) => x.id)).toEqual([2, 1, 3]);
    expect(moveById(p, 1, -1).map((x) => x.id)).toEqual([1, 2, 3]);
    expect(moveById(p, 3, 1).map((x) => x.id)).toEqual([1, 2, 3]);
    expect(moveById(p, 9, 1).map((x) => x.id)).toEqual([1, 2, 3]);
  });
});
