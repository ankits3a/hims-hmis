import { mkdtemp, chmod, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentRootUnwritable, warnIfDocumentRootUnwritable } from "./boot-check";

/**
 * ═══ THE CHECK THAT TELLS AN OPERATOR AT DEPLOY WHAT THEY WOULD OTHERWISE LEARN AT THE COUNTER ═══
 *
 * `DOCUMENT_STORE_PATH` is set on no deployment and defaults to a path that exists nowhere. These
 * rows exist because the failure it guards is silent everywhere except the one desk trying to file
 * a slip, with a patient standing there.
 *
 * Three of the four assert SILENCE. A boot warning that fires on correct deployments is one every
 * operator learns to scroll past, and then the real one is scrolled past too.
 */
describe("the document root boot check", () => {
  const made: string[] = [];
  const recorder = (): { warn(m: string): void; messages: string[] } => {
    const messages: string[] = [];
    return { warn: (m) => { messages.push(m); }, messages };
  };

  afterEach(async () => {
    for (const d of made.splice(0)) {
      await chmod(d, 0o700).catch(() => undefined);
      await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("B1: says NOTHING when the root exists and takes a write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hmis-docroot-"));
    made.push(dir);
    const log = recorder();
    expect(await warnIfDocumentRootUnwritable(dir, log)).toBe(false);
    expect(log.messages).toEqual([]);
  });

  it("B2: says NOTHING when the root is absent but creatable — that is the first capture's own path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hmis-docroot-"));
    made.push(parent);
    const log = recorder();
    /* `put` calls mkdir(recursive) on every write, so a creatable root is a WORKING root. A check
       that warned here would be noise on every fresh, correct deployment. */
    expect(await warnIfDocumentRootUnwritable(join(parent, "documents"), log)).toBe(false);
    expect(log.messages).toEqual([]);
  });

  it("B3: WARNS when the root cannot be written, and names the path and the remedy", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hmis-docroot-"));
    made.push(parent);
    const root = join(parent, "documents");
    const log = recorder();
    /*
      ═══ THE FIXTURE IS A FILE IN THE WAY, NOT A PERMISSION BIT ═══

      First written as `chmod(parent, 0o500)`, which proved nothing: **this suite runs as root, and
      root bypasses the permission check**, so mkdir succeeded and the check correctly said
      nothing. A uid-dependent fixture is a row that means different things on this box and on CI.
      A regular file where the directory must go is refused for every user alike — and it is a real
      misconfiguration shape besides.
    */
    await writeFile(root, "not a directory");

    expect(await warnIfDocumentRootUnwritable(root, log)).toBe(true);
    expect(log.messages).toHaveLength(1);
    /* The operator must be able to act on it without reading the source: the path, what breaks,
       and the command. A warning that only says "misconfigured" sends them to a developer. */
    expect(log.messages[0]).toContain(root);
    expect(log.messages[0]).toContain("/opd/slips");
    expect(log.messages[0]).toContain("chown");
  });

  it("B6: a root that EXISTS but will not take a write still warns — the probe is a write, not a stat", async () => {
    /*
      ═══ THE ROW THAT MAKES "IT PROBES A WRITE" MEAN SOMETHING ═══

      Added after a mutation SURVIVED: deleting the write probe and leaving only `mkdir` kept all
      five earlier rows green, because B3's fixture (a file in the way) fails at mkdir. So nothing
      pinned the check's whole reason for existing — the production case is a root that exists and
      is owned by somebody else, where mkdir succeeds and the write is refused.

      That case cannot be built as root, which is what this suite runs as. Occupying the probe path
      with a DIRECTORY reaches the same branch for every user: mkdir(root) succeeds, writeFile is
      refused EISDIR. It stands in for foreign ownership, and it is honest that it is a stand-in.
    */
    const dir = await mkdtemp(join(tmpdir(), "hmis-docroot-"));
    made.push(dir);
    await mkdir(join(dir, `.hmis-write-probe-${String(process.pid)}`));
    const log = recorder();

    expect(await warnIfDocumentRootUnwritable(dir, log)).toBe(true);
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0]).toContain(dir);
  });

  it("B4: leaves no probe file behind on the path that succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hmis-docroot-"));
    made.push(dir);
    await warnIfDocumentRootUnwritable(dir, recorder());
    /* A stray dotfile in the document root would be swept, backed up and restored for ever. */
    expect(await readdir(dir)).toEqual([]);
  });

  it("B5: the message is one string, so it cannot half-print", () => {
    const m = documentRootUnwritable("/var/lib/hmis/documents", "EACCES");
    expect(m).toContain("/var/lib/hmis/documents");
    expect(m).toContain("EACCES");
    expect(m.split("\n")).toHaveLength(1);
  });
});
