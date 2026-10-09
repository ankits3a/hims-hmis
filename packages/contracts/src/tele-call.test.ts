import { telePhoneOf } from "./tele-call";

describe("telePhoneOf — an Indian mobile number as ten digits", () => {
  it("drops spaces, hyphens and one prefix (+91, 91 or a trunk 0)", () => {
    expect(telePhoneOf("+91 98765 43021")).toBe("9876543021");
    expect(telePhoneOf("9876543021")).toBe("9876543021");
    expect(telePhoneOf(" 98765-43021 ")).toBe("9876543021");
    expect(telePhoneOf("09876543021")).toBe("9876543021");
    expect(telePhoneOf("919876543021")).toBe("9876543021");
    expect(telePhoneOf("+91-0-98765 43021")).toBe("9876543021");
  });
  it("answers null for anything else", () => {
    for (const bad of [null, undefined, "", "  ", "12345", "5876543021", "98765430211", "987654302", "+1 9876543021", "98765x43021"]) {
      expect(telePhoneOf(bad)).toBeNull();
    }
  });
});
