import { collectBag, generateBag, storeBag } from "../../src/modules/bmw";
import { W1, actorOf, seedTaskHospital } from "./tasks";
import type { BmwCategory } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { TaskHospital } from "./tasks";

/**
 * E1.7 BIO-MEDICAL WASTE — the task fixture's small hospital (three support staff, two services supervisors, a floor
 * with two rooms) is the BMW fixture too: support staff carry waste, services supervisors are the BMW supervisors.
 * Every instant is the caller's; the fixture reads no clock.
 */
export { SUP1, SUP2, W1, W2, actorOf, clockNow, minutes } from "./tasks";
export type BmwHospital = TaskHospital;

export const seedBmwHospital = (db: Db, t0: Date): Promise<BmwHospital> => seedTaskHospital(db, t0);

export const hours = (t0: Date, h: number): Date => new Date(t0.getTime() + h * 3_600_000);

/** Generate a bag at `at`, weigh and collect it a minute later, store it with `central` grams two minutes later. */
export async function bagInStore(
  db: Db, place: string, category: BmwCategory, deptGrams: number, at: Date, central = deptGrams, cytotoxic = false,
): Promise<string> {
  const { bag } = await generateBag(db, actorOf(W1), { category, cytotoxic, placeResourceId: place }, at);
  await collectBag(db, actorOf(W1), { barcode: bag.barcode, grams: deptGrams }, new Date(at.getTime() + 60_000));
  await storeBag(db, actorOf(W1), { barcode: bag.barcode, grams: central }, new Date(at.getTime() + 120_000));
  return bag.barcode;
}
