import { test } from "node:test";
import assert from "node:assert/strict";
import { violations } from "./acceptance-guard.mjs";

test("adding a new acceptance test is allowed", () => {
  assert.deepEqual(violations("A\tapps/core/test/acceptance/guardian/renewal.test.ts\n"), []);
});
test("editing an approved check is caught", () => {
  assert.deepEqual(violations("M\tapps/core/test/acceptance/guardian/renewal.test.ts"), ["M apps/core/test/acceptance/guardian/renewal.test.ts"]);
});
test("deleting or renaming an approved check is caught", () => {
  assert.equal(violations("D\tapps/web/src/acceptance/bay.test.tsx").length, 1);
  assert.equal(violations("R087\tapps/core/test/acceptance/a.test.ts\tapps/core/test/other/a.test.ts").length, 1);
});
test("files outside acceptance folders are ignored, including look-alike names", () => {
  assert.deepEqual(violations("M\tapps/core/src/modules/opd/vitals.ts\nM\tapps/core/test/acceptance-notes.md\nD\tdocs/x.md"), []);
});
