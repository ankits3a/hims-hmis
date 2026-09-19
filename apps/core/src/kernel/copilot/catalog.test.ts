import { collectCopilotTools, runTool } from "./catalog";
import { CopilotError } from "./types";
import type { CopilotToolCtx, CopilotToolDecl } from "./types";
import type { ModuleManifest } from "../modules/manifest";
import type { ModuleRegistry } from "../modules/loader";

/**
 * FD-COPILOT T4 — THE CATALOG, AND THE TWO REFUSALS IT MAKES AT BOOT.
 *
 * `collectDeskProviders` refuses a duplicate key and a permission no manifest declares, and its
 * comment gives the reason this copies verbatim: a thing gated on a string nothing declares is a
 * thing no role can ever reach, and it would sit in the catalog looking implemented forever. The
 * copilot wants both refusals and one more of its own — two modules cannot both claim an intent,
 * because the router picks an intent and the runner has to know which tool that means.
 */
const tool = (over: Partial<CopilotToolDecl> = {}): CopilotToolDecl => ({
  intent: "queue_depth",
  permission: "opd.queue.read",
  needsSubject: false,
  run: () => Promise.resolve({ key: "copilot.answer.queueShortest", params: { count: 3 } }),
  ...over,
});

const manifest = (key: string, tools: CopilotToolDecl[], permissions: string[]): ModuleManifest => ({
  key,
  title: key,
  menu: [],
  permissions,
  subscriptions: [],
  copilotTools: tools,
});

const registryOf = (manifests: ModuleManifest[]): ModuleRegistry => ({
  all: () => manifests,
  allPermissions: () => [...new Set(manifests.flatMap((m) => m.permissions))],
} as unknown as ModuleRegistry);

describe("collectCopilotTools", () => {
  it("collects what the manifests declare", () => {
    const reg = registryOf([manifest("opd", [tool()], ["opd.queue.read"])]);
    expect(collectCopilotTools(reg)).toHaveLength(1);
  });

  it("is happy with no copilot tools at all — every existing manifest stays valid", () => {
    const bare: ModuleManifest = { key: "lab", title: "Lab", menu: [], permissions: [], subscriptions: [] };
    expect(collectCopilotTools(registryOf([bare]))).toHaveLength(0);
  });

  it("refuses at boot when two modules claim one intent", () => {
    // The router answers with an intent. If two tools claim it, "which one runs" has no answer.
    const reg = registryOf([
      manifest("opd", [tool()], ["opd.queue.read"]),
      manifest("billing", [tool()], ["opd.queue.read"]),
    ]);
    expect(() => collectCopilotTools(reg)).toThrow(CopilotError);
    expect(() => collectCopilotTools(reg)).toThrow(/queue_depth/);
  });

  it("refuses at boot on a permission no manifest declares", () => {
    const reg = registryOf([manifest("opd", [tool({ permission: "opd.invented" })], ["opd.queue.read"])]);
    expect(() => collectCopilotTools(reg)).toThrow(/opd\.invented/);
  });

  it("allows a null permission — the structurally self-scoped case", () => {
    // `GET /me/report` has no @RequirePermission because loadReport takes no userId. See the type.
    const reg = registryOf([manifest("opd", [tool({ permission: null })], [])]);
    expect(collectCopilotTools(reg)).toHaveLength(1);
  });

  it("checks kernel-owned tools in the same pass as the modules'", () => {
    // Two lists checked separately is how a collision gets through, so there is only one pass.
    const reg = registryOf([manifest("opd", [tool()], ["opd.queue.read"])]);
    expect(() => collectCopilotTools(reg, [tool()])).toThrow(/queue_depth/);
  });
});

/**
 * ═══ THE RUNNER — EVERY REFUSAL IS A SENTENCE, NEVER A STACK TRACE ═══
 *
 * This is a counter. A clerk who asks a question and gets a 500 learns the box is broken; a clerk
 * who is told "you do not have access to that" or "which patient?" learns something they can act
 * on. So the runner has no failure mode that reaches the operator as an error.
 */
const ctx = (over: Partial<CopilotToolCtx> = {}): CopilotToolCtx => ({
  db: {} as CopilotToolCtx["db"],
  actor: { type: "user", id: "u1" } as CopilotToolCtx["actor"],
  subject: null,
  serviceDate: "2026-09-17",
  question: "",
  ...over,
});

describe("runTool", () => {
  it("runs the tool when the asking user holds the permission", async () => {
    const out = await runTool(tool(), ctx(), () => Promise.resolve(true));
    expect(out.key).toBe("copilot.answer.queueShortest");
  });

  it("refuses — and does NOT run the tool — when they do not", async () => {
    /*
      Checked BEFORE the tool runs, exactly as `loadDesk` gates a card. Run-then-filter would do the
      work and read the data for an answer the person may not see, which is the whole point of
      having a permission at all.
    */
    let ran = false;
    const t = tool({ run: () => { ran = true; return Promise.resolve({ key: "copilot.answer.failed", params: {} }); } });
    const out = await runTool(t, ctx(), () => Promise.resolve(false));
    expect(out.key).toBe("copilot.answer.notPermitted");
    expect(ran).toBe(false);
  });

  it("asks which patient when the tool needs one and the question named none", async () => {
    const out = await runTool(tool({ needsSubject: true }), ctx({ subject: null }), () => Promise.resolve(true));
    expect(out.key).toBe("copilot.answer.needSubject");
  });

  it("runs a subject tool when the question did name somebody", async () => {
    const t = tool({
      intent: "visit_status",
      needsSubject: true,
      run: (c) => Promise.resolve({ key: "copilot.answer.visitSeen", params: { who: c.subject ?? "" } }),
    });
    const out = await runTool(t, ctx({ subject: "U00110012" }), () => Promise.resolve(true));
    expect(out.params.who).toBe("U00110012");
  });

  it("runs a null-permission tool without asking anything of the permission check", async () => {
    let asked = false;
    const t = tool({ permission: null });
    const out = await runTool(t, ctx(), () => { asked = true; return Promise.resolve(false); });
    expect(out.key).toBe("copilot.answer.queueShortest");
    expect(asked).toBe(false);
  });

  it("turns a throwing tool into a sentence rather than a 500", async () => {
    const t = tool({ run: () => Promise.reject(new Error("column does not exist")) });
    const out = await runTool(t, ctx(), () => Promise.resolve(true));
    expect(out.key).toBe("copilot.answer.failed");
  });

  it("never leaks the underlying error text to the operator", async () => {
    // A database error names columns and tables. That is a disclosure and it is also useless to a clerk.
    const t = tool({ run: () => Promise.reject(new Error("relation patients_secret does not exist")) });
    const out = await runTool(t, ctx(), () => Promise.resolve(true));
    expect(JSON.stringify(out)).not.toContain("patients_secret");
  });
});
