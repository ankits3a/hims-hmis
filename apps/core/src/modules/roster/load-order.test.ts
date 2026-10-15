/**
 * The roster must not put billing on tariff's load path.
 *
 * tariff → kernel/workflow → modules/roster is an edge the kernel needs (escalation recipients,
 * duty managers). When roster's print files imported `kernel/printing/render` for values, roster's
 * load reached billing, and billing reads `DISCOUNT_CATEGORIES` from tariff at load time — while
 * tariff was still half-loaded. Any suite whose first import was tariff (partners, billing
 * cash-math, check-config-present, membership …) died with "Cannot convert undefined or null to
 * object" before a single test ran (CI on #484, 2026-10-04). Each entry point below is loaded in
 * a fresh module registry, first, exactly as such a suite would.
 */
describe("module load order", () => {
  it.each([
    ["tariff", "../tariff"],
    ["billing", "../billing"],
    ["roster", "./index"],
  ])("%s loads first, in a fresh registry, without a half-loaded cycle", async (_name, path) => {
    await jest.isolateModulesAsync(async () => {
      await expect(import(path)).resolves.toBeDefined();
    });
  });
});
