import { describe, expect, it } from "vitest";
// The contracts SOURCE by path — the server's one copy — not the package entry (see eye-line.ts).
import * as server from "../../../../packages/contracts/src/eye-codes";
import * as web from "./eye-codes";

const CASES: [string | null, boolean][] = [
  ["H25.1", true], ["H59.0", true], ["H00.0", true], ["H10.9", true], ["h25.1", true], [" H40 ", true],
  ["H60.0", false], ["H66.9", false], ["H95.8", false],
  ["E11.3", true], ["E11.35", true], ["E10.3", true], ["E14.39", true], ["E11.2", false], ["E11", false], ["E15.3", false],
  ["J06.9", false], ["", false], [null, false], ["H", false], ["H5", false],
];

describe("isEyeCode — which ICD-10 codes ask which eye", () => {
  it("chapter VII (H00–H59) and diabetes with ophthalmic complications are eye codes; the ear is not", () => {
    for (const [code, want] of CASES) {
      expect({ code, got: server.isEyeCode(code) }).toEqual({ code, got: want });
      expect({ code, got: web.isEyeCode(code) }).toEqual({ code, got: want });
    }
  });
});
