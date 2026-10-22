/**
 * SPEC #934 D13 — run the CONFIGURED slip reader over the repo's synthetic slip set and print value-level
 * and code-level accuracy and the share of wrong values that carried a check.
 *
 *   node dist/scripts/lab-slip-eval.js                 # the configured provider (HMIS_GEMINI_KEY_FILE, else HMIS_OPENROUTER_KEY_FILE)
 *   node dist/scripts/lab-slip-eval.js --render <dir>  # write each synthetic slip as a PNG, to print and photograph
 *   node dist/scripts/lab-slip-eval.js --set <dir>     # another folder of synthetic truth files
 *
 * It sends the synthetic images to an outside API, so it refuses without HMIS_EVAL_NETWORK=1 (the
 * alias eval's rule). Exit 0 when the production gate holds, 1 when it does not, 2 when it cannot run.
 * The third condition — #934 records that the key is on a paid-tier, no-training account — is a
 * person's to check; this prints it as a reminder, never as a pass.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/kernel/config";
import { loadSlipEvalSet, productionGate, renderSlipPng, scoreSlipEval, SLIP_EVAL_DIR } from "../src/modules/lab/slip-eval";
import { slipReaderFromConfig } from "../src/modules/lab/slip-reader";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
};

async function main(): Promise<number> {
  const set = loadSlipEvalSet(arg("--set") ?? SLIP_EVAL_DIR);
  const render = arg("--render");
  if (render !== null) {
    mkdirSync(render, { recursive: true });
    for (const s of set) writeFileSync(join(render, `${s.id}.png`), renderSlipPng(s));
    process.stdout.write(`wrote ${String(set.length)} synthetic slips to ${render}\n`);
    return 0;
  }
  if (process.env.HMIS_EVAL_NETWORK !== "1") {
    process.stderr.write("refusing: this sends the synthetic slips to the configured provider. Set HMIS_EVAL_NETWORK=1 to run it.\n");
    return 2;
  }
  const cfg = loadConfig();
  const reader = slipReaderFromConfig(cfg.labSlip);
  if (reader === null) {
    process.stderr.write("no readable HMIS_GEMINI_KEY_FILE or HMIS_OPENROUTER_KEY_FILE — reading is off, nothing measured\n");
    return 2;
  }
  process.stdout.write(`lab slip eval — ${reader.provider} ${reader.model}, ${String(set.length)} synthetic slips (${String(set.filter((s) => s.jpeg !== null).length)} photographed)\n`);
  const m = await scoreSlipEval(set, reader);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  process.stdout.write([
    `rows                       ${String(m.rows)}`,
    `value accuracy             ${pct(m.valueAccuracy)}`,
    `value accuracy, clear      ${pct(m.clearValueAccuracy)}   (gate: ≥ 98%)`,
    `code accuracy              ${pct(m.codeAccuracy)}`,
    `wrong values               ${String(m.wrongValues)}`,
    `wrong values with a check  ${m.wrongWithCheckShare === null ? "— (none wrong)" : pct(m.wrongWithCheckShare)}   (gate: 100%)`,
    `unreadable replies         ${String(m.unreadable)}`,
    "",
  ].join("\n"));
  for (const s of m.perSlip) {
    for (const w of s.wrong) process.stdout.write(`  ${s.id} ${w.code}: printed ${w.truth ?? "∅"}, read ${w.read ?? "∅"}${w.checked ? " (checked)" : "  ← NO CHECK"}\n`);
  }
  const gate = productionGate(m);
  process.stdout.write(gate.ok ? "\nGATE: the eval's two conditions hold.\n" : `\nGATE: NOT MET — ${gate.reasons.join("; ")}\n`);
  process.stdout.write("Also required before production: #934 records that this key is on a paid-tier, no-training account.\n");
  return gate.ok ? 0 : 1;
}

main().then((code) => process.exit(code), (e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(2);
});
