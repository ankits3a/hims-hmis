import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * ═══ THE DOCUMENT ROOT NOBODY HAS CREATED — A WARNING AT BOOT, AND WHY ═══
 *
 * `DOCUMENT_STORE_PATH` defaults to `/var/lib/hmis/documents` and is set on no deployment. Until an
 * operator creates it and gives the service user write access, **every capture at `/opd/slips`
 * fails `unwritable`** — and the only place that is observable today is the desk, one slip at a
 * time, after a patient has already handed over the paper.
 *
 * ═══ IT PROBES A WRITE, NOT A STAT ═══
 *
 * A directory that exists is not a directory this process can write to — the failure this is for is
 * usually ownership, not absence. So the probe does exactly what `DiskDocumentStore.put` does
 * (`mkdir -p`, write, remove) and therefore answers the question actually being asked: *will a
 * capture land?* A stat would answer a neighbouring one, and answer it wrong on the common case.
 *
 * Creating the root here is not a new class of host mutation: `put` already calls
 * `mkdir(..., { recursive: true })` on the first capture. All this changes is WHEN the operator
 * finds out — at deploy, in the log, rather than at the counter with a patient waiting.
 *
 * ═══ IT WARNS AND DOES NOT REFUSE ═══
 *
 * Per the rule settled with the membership check (PR #160): a refusal is for a CODE defect that can
 * never be correct and is caught in CI; a warning is for a DATA state an operator can legitimately
 * be halfway through. An uncreated directory is exactly that, and there is **no safety edge** — a
 * refused capture is visible to the desk immediately and the paper is still in the operator's hand.
 * Refusing to boot would take the whole hospital's API down because one optional desk cannot file a
 * photograph.
 *
 * It is silent on every correct path — a deployment whose root exists and is writable prints
 * nothing — which is what makes the one noisy case worth reading.
 */
export function documentRootUnwritable(root: string, detail: string): string {
  return `DOCUMENT_STORE_PATH is not writable: ${root} (${detail}). Every slip photographed at `
    + `/opd/slips will be refused with "unwritable" until this is fixed. Create the directory and `
    + `give the API's user write access (mkdir -p ${root} && chown <api-user> ${root}), or set `
    + `DOCUMENT_STORE_PATH to a path that already has it.`;
}

/** Where the warning goes. `console` in the API; a recorder in the assertions. */
export type BootLog = { warn(message: string): void };

/**
 * Returns true when it warned, so a test can assert the SILENCE as readily as the noise — three of
 * the membership check's four rows assert silence, and that is what makes its one loud case
 * credible.
 */
export async function warnIfDocumentRootUnwritable(root: string, log: BootLog): Promise<boolean> {
  const full = resolve(root);
  const probe = join(full, `.hmis-write-probe-${String(process.pid)}`);
  try {
    await mkdir(full, { recursive: true });
    await writeFile(probe, "");
    return false;
  } catch (e) {
    log.warn(documentRootUnwritable(full, e instanceof Error ? e.message : String(e)));
    return true;
  } finally {
    /* The probe must not survive a crash between write and cleanup, and removing one that was never
       created must be a no-op — `force` is both of those. */
    await rm(probe, { force: true }).catch(() => undefined);
  }
}
