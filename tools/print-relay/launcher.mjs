/**
 * HMIS Print — the launcher. The ONE file an update never replaces.
 *
 * `program.mjs` downloads a newer version into `<home>/app-next/` and writes `READY` last. On the
 * next start this file checks every staged file against the hashes in `READY`, keeps the running
 * version as `app-prev/`, swaps the new files in, and only then imports the program. If the new
 * program will not even load, the previous one is put back and started instead — a bad update must
 * cost one restart, never a counter that cannot print.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED = ["program.mjs", "relay.mjs", "platform.mjs", "VERSION"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Returns "applied" | "none" | "refused: <why>". Never throws: a refused update leaves the program as it was. */
export async function applyStagedUpdate({ appDir, nextDir }) {
  let ready;
  try { ready = JSON.parse(await readFile(join(nextDir, "READY"), "utf8")); } catch { return "none"; }
  try {
    const names = Object.keys(ready.files ?? {});
    for (const r of REQUIRED) if (!names.includes(r)) return await refuse(nextDir, `the update has no ${r}`);
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return await refuse(nextDir, `bad file name ${name}`);
      const got = sha256(await readFile(join(nextDir, name)));
      if (got !== ready.files[name]) return await refuse(nextDir, `${name} does not match its hash`);
    }
    const staged = (await readFile(join(nextDir, "VERSION"), "utf8")).trim();
    if (staged !== ready.version) return await refuse(nextDir, "VERSION is not the version READY names");
    const prev = join(dirname(appDir), "app-prev");
    await rm(prev, { recursive: true, force: true });
    await cp(appDir, prev, { recursive: true });
    for (const name of names) await writeFile(join(appDir, name), await readFile(join(nextDir, name)));
    await rm(nextDir, { recursive: true, force: true });
    return "applied";
  } catch (e) {
    return await refuse(nextDir, String(e));
  }
}

async function refuse(nextDir, why) {
  await rm(nextDir, { recursive: true, force: true }).catch(() => undefined);
  return `refused: ${why}`;
}

/** Puts `app-prev/` back over `app/`. Used when a freshly applied update will not load. */
export async function rollBack(appDir) {
  const prev = join(dirname(appDir), "app-prev");
  const names = await readdir(prev);
  await mkdir(appDir, { recursive: true });
  for (const name of names) await writeFile(join(appDir, name), await readFile(join(prev, name)));
}

export async function start(argv, { root = dirname(fileURLToPath(import.meta.url)), env = process.env, log = (m) => { console.log(m); } } = {}) {
  const appDir = join(root, "app");
  const { adapter } = await import(pathToFileURL(join(appDir, "platform.mjs")).href);
  const hi = argv.indexOf("--home");
  const home = hi >= 0 && argv[hi + 1] !== undefined ? argv[hi + 1] : adapter(undefined, env).home();
  const outcome = await applyStagedUpdate({ appDir, nextDir: join(home, "app-next") });
  if (outcome !== "none") log(`update: ${outcome}`);
  let program;
  try {
    // The query string defeats the module cache: after a swap this is a different program.
    program = await import(`${pathToFileURL(join(appDir, "program.mjs")).href}?v=${String(Date.now())}`);
  } catch (e) {
    if (outcome !== "applied") throw e;
    log(`the new version would not start (${String(e).slice(0, 200)}) — going back to the previous one`);
    await rollBack(appDir);
    program = await import(`${pathToFileURL(join(appDir, "program.mjs")).href}?v=${String(Date.now())}b`);
  }
  await program.main(argv, env);
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  start(process.argv.slice(2)).catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; });
}
