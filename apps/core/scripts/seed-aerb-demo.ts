import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { listResourcesOfKind } from "../src/kernel/resources/read";
import {
  AERB_UNLICENSABLE_MODALITIES, aerbPickers, appointPerson, appointments, fileLicence, mayManage,
  unlicensedDevices,
} from "../src/modules/aerb";
import { assertSyntheticDataAllowed } from "./synthetic-door";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * PHASE 11i T5 — `seed:aerb-demo`: FOUR `DEMO` CERTIFICATES, behind the synthetic-data door.
 *
 * ═══ WHY A DEMO LICENCE EXISTS AT ALL ═══
 *
 * 18c's §0 is the one behaviour-changing step in the catch-up deploy: from migration `0060`
 * onward, starting an ionising acquisition on a device with no active licence is refused
 * `device_not_licensed`. The rehearsal that matters is not watching the refusal — that is easy to
 * arrange and proves only that a guard exists. It is watching `GET /aerb/licences/gaps` go from
 * non-empty to **EMPTY**, because that is the act radiology performs on production during the
 * declared window, and the only evidence that it CAN be performed.
 *
 * ═══ EVERY NUMBER CARRIES `DEMO`, AND THAT IS ENFORCED HERE RATHER THAN REMEMBERED ═══
 *
 * An AERB licence register is a statutory document an inspector reads. A synthetic row in it is
 * not a test fixture, it is a false statement to a regulator — so the licence numbers this script
 * writes say `DEMO` in the number itself, where anybody reading the register sees it, and the
 * script asserts that before it writes rather than trusting the literals below.
 *
 * ═══ IT MINTS NO CREDENTIAL, INVENTS NO PERSON, AND DOES NOT WIDEN THE REGISTER'S GUARD ═══
 *
 * `seed-lab-demo`'s rule, and the same reason: the RSO is a real human with an AERB approval
 * number. Two consequences, and the second is the one worth stating.
 *
 * It FINDS a user rather than creating one, and on a database with nobody it says so and stops.
 *
 * And it ACTS AS that user. `fileLicence` and `appointPerson` both call `requireManage`, which
 * asks `hasPermission(actor, "aerb.registers.manage", "hospital")` — so a synthetic
 * `seed-aerb-demo` identity would be refused, exactly as it should be: a statutory register that
 * accepted a writer holding no permission would be a register with no control on it. The seed
 * adopts the guard's vocabulary instead of widening it, which is `seed:lab`'s rule one module
 * over, and the candidate is chosen BY ASKING `mayManage` rather than by guessing at a role name.
 */
const DEMO_MARK = "DEMO";

function istDate(offsetMonths: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

export type AerbDemoReport = {
  rsoUserId: string;
  appointed: string[];
  alreadyAppointed: string[];
  filed: string[];
  skipped: string[];
  gapsBefore: number;
  gapsAfter: number;
};

export async function seedAerbDemo(db: Db): Promise<AerbDemoReport> {
  const today = istDate(0);
  const gapsBefore = (await unlicensedDevices(db, today)).length;

  /**
   * A real human on this box who ACTUALLY HOLDS the register's permission — asked through
   * `mayManage`, the module's own predicate, rather than guessed from a role name. A role called
   * `radiologist` may or may not carry `aerb.registers.manage` on any given deployment; the
   * question this script needs answered is the one the write itself will ask.
   */
  const candidates = (await aerbPickers(db)).users;
  const able: string[] = [];
  for (const u of candidates) {
    if (await mayManage(db, { type: "user", id: u.userId })) able.push(u.userId);
    if (able.length >= 2) break;
  }
  const rsoUserId = able[0];
  if (rsoUserId === undefined) {
    throw new Error(
      "seed:aerb-demo: no active user on this database holds `aerb.registers.manage` at hospital\n" +
        "  scope. The RSO is a person, not a row this script may invent — grant the permission to a\n" +
        "  real login at /admin/users first. (Nothing here mints a credential.)",
    );
  }
  const actingAs: Actor = { type: "user", id: rsoUserId };

  /**
   * IDEMPOTENT, and it was not: `aerb_persons_user_role_active_ux` refuses a second ACTIVE
   * appointment of the same person to the same role, so a second run died on a unique constraint
   * — found by running it twice, which is the only way that class of defect is ever found. The
   * live appointments are read through the module's own `appointments()`, never a select here.
   */
  const live = await appointments(db, { onDate: today });
  const heldRoles = new Set(live.map((a) => a.personRole));
  const appointed: string[] = [];
  const alreadyAppointed: string[] = [];

  if (heldRoles.has("rso")) {
    alreadyAppointed.push("rso");
  } else {
    await withTx(db, (tx: Tx) =>
      appointPerson(tx, actingAs, {
        userId: rsoUserId,
        personRole: "rso",
        approvalRef: `AERB/${DEMO_MARK}/RSO/2026/01`,
        qualification: `${DEMO_MARK} appointment — synthetic, for rehearsal only`,
        validFrom: istDate(-1),
      }),
    );
    appointed.push("rso");
  }
  // The physicist only if a SECOND person exists. One human wearing both appointments is a
  // separation of duties that does not exist, and writing it into the register would be modelling
  // a control this deployment does not have.
  const physicistUserId = able[1];
  if (heldRoles.has("physicist")) {
    alreadyAppointed.push("physicist");
  } else if (physicistUserId !== undefined) {
    await withTx(db, (tx: Tx) =>
      appointPerson(tx, actingAs, {
        userId: physicistUserId,
        personRole: "physicist",
        approvalRef: `AERB/${DEMO_MARK}/MP/2026/07`,
        qualification: `${DEMO_MARK} appointment — synthetic, for rehearsal only`,
        validFrom: istDate(-1),
      }),
    );
    appointed.push("physicist");
  }

  /**
   * ONE CERTIFICATE PER DEVICE THAT HAS NONE — derived, never a hard-coded list of machine codes.
   *
   * The first draft named `CT-1`, `FL-1`, `XR-1`, `MG-1` because the AERB demo bench happens to
   * use those codes. On any other box that list files nothing and reports success. What this seed
   * is FOR is watching `GET /aerb/licences/gaps` go empty, so the right input is the gaps list
   * itself: `unlicensedDevices` already answers "the devices that emit and have no paper", which
   * is the same question the runbook's step asks radiology to close.
   */
  const gaps = await unlicensedDevices(db, today);
  const devices = await listResourcesOfKind(db, "device");
  const filed: string[] = [];
  const skipped: string[] = [];
  let n = 0;
  for (const gap of gaps) {
    n += 1;
    const device = devices.find((d) => d.id === gap.deviceResourceId);
    const modality = (device === undefined ? gap.modality : String(device.attributes?.modality ?? "")).toLowerCase();
    if (AERB_UNLICENSABLE_MODALITIES.includes(modality)) {
      // Belt and braces: `unlicensedDevices` already excludes these, and a seed that FILED one
      // would be inventing a certificate for a machine no regulator licenses.
      skipped.push(`${gap.code} (${modality} emits nothing ionising and never appears on a licence)`);
      continue;
    }
    const licenceNo = `AERB/${DEMO_MARK}/${gap.code.toUpperCase().replace(/[^A-Z0-9]/g, "")}/${new Date().getUTCFullYear()}/${String(n).padStart(4, "0")}`;
    // ASSERTED, not trusted: a licence number without DEMO in it is a false statement in a
    // statutory register, and a template string is exactly the kind of thing an edit quietly loses.
    if (!licenceNo.includes(DEMO_MARK)) throw new Error(`refusing to file ${licenceNo}: it does not carry ${DEMO_MARK}`);
    await withTx(db, (tx: Tx) =>
      fileLicence(tx, actingAs, {
        deviceResourceId: gap.deviceResourceId,
        licenceType: modality === "ct" ? "licence" : "registration",
        licenceNo,
        eloraRef: `ELORA-${DEMO_MARK}-${String(n).padStart(5, "0")}`,
        validFrom: istDate(-1),
        // The FIRST one expires inside the compliance calendar's window on purpose, so the
        // rehearsal shows a renewal row rather than a wall of green.
        validTo: istDate(n === 1 ? 1 : 12),
        rsoUserId,
        remarks: `${DEMO_MARK} certificate written by seed:aerb-demo — never a real filing`,
      }),
    );
    filed.push(licenceNo);
  }

  return {
    rsoUserId, appointed, alreadyAppointed, filed, skipped, gapsBefore,
    gapsAfter: (await unlicensedDevices(db, today)).length,
  };
}

async function main(): Promise<void> {
  assertSyntheticDataAllowed("seed:aerb-demo");
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const report = await seedAerbDemo(db);
    console.log(JSON.stringify({ seed: "aerb-demo", ...report }));
    if (report.gapsAfter > 0) {
      console.log(
        `NOTE ${report.gapsAfter} ionising device(s) still have no licence — 18c §0 refuses ` +
          "acquisition on those. That is the register telling the truth, not a failure of this seed.",
      );
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e); process.exit(1); });
}
