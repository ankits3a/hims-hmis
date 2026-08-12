import { newId, newEventId } from "../src/ids";

describe("ids", () => {
  it("newId returns a 26-char ULID", () => {
    expect(newId()).toHaveLength(26);
    expect(newId()).not.toBe(newId());
  });
  it("newEventId is still exported and ULID-shaped", () => {
    expect(newEventId()).toHaveLength(26);
  });
});
