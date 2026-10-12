import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import hi from "../locales/hi.json";
import { sayParams } from "./use-copilot";

/**
 * #676 — "I did not understand" names only what the asker may use. The server sends the intents as
 * codes (`can`); the web says each in the asker's language. The codes are read from the server's
 * `HELP_INTENTS` source (as `copilot-keys.test.ts` reads the contract), so a new one without words fails here.
 */
const HELP_INTENTS: string[] = [
  ...(readFileSync(join(__dirname, "../../../core/src/kernel/copilot/catalog.ts"), "utf8")
    .match(/HELP_INTENTS[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g),
].map((m) => m[1] ?? "");

type Tree = Record<string, unknown>;
const lookup = (tree: Tree) => (key: string, opts?: Record<string, unknown>): string => {
  const v = key.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);
  return typeof v === "string" ? v : String(opts?.defaultValue ?? key);
};

describe("#676 — the did-not-understand help names only what the asker may use", () => {
  it("has words for every help intent, in English and Hindi", () => {
    expect(HELP_INTENTS).toEqual(["visit_status", "queue_depth", "patient_dues", "my_day_report"]);
    for (const c of HELP_INTENTS) {
      expect([c, typeof (en.copilot.can as Record<string, string>)[c]]).toEqual([c, "string"]);
      expect([c, typeof (hi.copilot.can as Record<string, string>)[c]]).toEqual([c, "string"]);
    }
  });

  it("says the server's list and nothing else", () => {
    const t = lookup(en as Tree);
    expect(sayParams("copilot.answer.notUnderstoodCan", { can: "visit_status,queue_depth,my_day_report" }, t, "en"))
      .toEqual({ can: "whether a patient has been seen, how the queues look or for your day report" });
    expect(sayParams("copilot.answer.notUnderstoodCan", { can: "my_day_report" }, t, "en")).toEqual({ can: "for your day report" });
    expect(sayParams("copilot.answer.notUnderstoodCan", { can: "queue_depth,patient_dues" }, lookup(hi as Tree), "hi"))
      .toEqual({ can: "लाइन कितनी है या मरीज़ का कितना बाकी है" });
  });

  it("the bare sentence offers nothing", () => {
    expect(en.copilot.answer.notUnderstood).toBe("I did not understand that.");
    expect(en.copilot.answer.notUnderstood).not.toMatch(/owes/);
  });
});
