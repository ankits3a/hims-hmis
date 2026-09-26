import { eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { controlledStockRegister, items, resources, users } from "../../kernel/db/schema";
import { updateResource } from "../../kernel/resources/registry";
import { medicinesByIds, ndpsClassByMedicine } from "../formulary";
import { TRANSIT_STORE_CODE } from "./config";
import { MaterialsError } from "./errors";
import { MATERIALS_RESOURCE_KINDS } from "./kinds";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P6 — THE CONTROLLED-DRUG CABINET, AT THE LEDGER (brief 2026-09-26, §3) ═══
 *
 * NDPS narcotic and psychotropic drugs and Schedule X drugs are kept in a CONTROLLED store — a `store`
 * resource whose attributes carry `controlled: true` (`PHARM-NDPS`, seeded by `seed:pharmacy`) — under
 * lock and key (D&C Rules r.65(9)) and under two keys (the hospital's double lock). Three rules, all
 * asked HERE, inside `postMovements`, because that is the one writer every path shares (a GRN, a
 * transfer, a dispense, a return, a destruction, a count's adjustment):
 *
 *   1. **Two people.** A movement at a controlled store carries `custody`: the holder is the acting user,
 *      the witness is `custody.witnessId` — another ACTIVE user. None, or the same person, is refused
 *      before anything is written. (Who MAY hold or witness is the calling act's grant — the pharmacy's
 *      `pharmacy.ndps.custody` / `.witness`, checked with the witness's own PIN before it gets here.)
 *   2. **The cabinet or nowhere.** Stock of an item stored as `narcotic` may not ENTER any store but a
 *      controlled one (or `IN-TRANSIT`, between two signatures): a GRN or a receipt onto an open shelf
 *      is refused, so there is no controlled stock outside the register.
 *   3. **The register.** Every movement at a controlled store writes one `controlled_stock_register`
 *      row in the same transaction, with the balance after it read under the ledger's lock — so the
 *      register cannot drift from the stock it records (the balance view proves it, `controlled-check.ts`).
 */
export const CONTROLLED_ATTRIBUTE = "controlled";

/** Whether a store is the controlled-drug cabinet. */
export function isControlledStore(store: { attributes: unknown }): boolean {
  const a = store.attributes as Record<string, unknown> | null;
  return a !== null && typeof a === "object" && a[CONTROLLED_ATTRIBUTE] === true;
}

/** Marks a store as (or no longer as) a controlled cabinet. The setter MERGES, keeping every other attribute. */
export async function setStoreControlled(tx: Tx, actor: Actor, storeId: string, controlled: boolean): Promise<void> {
  const [store] = await tx.select().from(resources).where(eq(resources.id, storeId));
  if (store === undefined || store.kind !== "store") throw new MaterialsError("unknown_store", `resource ${storeId} is not a store`);
  await updateResource(tx, actor, MATERIALS_RESOURCE_KINDS, storeId, {
    attributes: { ...(store.attributes as Record<string, unknown>), [CONTROLLED_ATTRIBUTE]: controlled },
  });
}

/**
 * What the second key and the register need, supplied by the act that moves the stock. Everything but
 * `witnessId` is a PARTICULAR the register copies as it stands today (a name, an address, a number).
 */
export type Custody = {
  witnessId: string;
  /** Further witnesses who are users (each active, none the holder or the witness). */
  extraWitnessIds?: readonly string[];
  /** Present, and not users of this system: destruction's officer nominated by the Controller of Drugs. */
  officers?: readonly { name: string; role: string }[];
  holderRegNo?: string | null;
  counterparty?: string | null;
  counterpartyAddress?: string | null;
  counterpartyLicence?: string | null;
  documentRef?: string | null;
  documentDate?: string | null;
  rxRef?: string | null;
  patientId?: string | null;
  prescriberName?: string | null;
  prescriberRegNo?: string | null;
  retainedDocumentId?: string | null;
  collectedBy?: string | null;
  collectedIdProof?: string | null;
  note?: string | null;
};

type Movement = { resourceId: string; batchId: string; qtyDelta: number; reason: string; occurredAt: Date; custody?: Custody };
type Batch = { id: string; itemId: string; batchNo: string; expiryDate: string | null };
type ItemFacts = { id: string; name: string; baseUom: string; storageClass: string; formularyMedicineId: string | null };

/** What `postMovements` needs after the checks: which movements write a register row, and the names they copy. */
export type CustodyPlan = {
  controlled: boolean[];
  itemsById: Map<string, ItemFacts>;
  names: Map<string, string>;
  classes: Map<string, { scheduleFlag: string | null; ndpsClass: string | null }>;
};

const EMPTY: Omit<CustodyPlan, "controlled"> = { itemsById: new Map(), names: new Map(), classes: new Map() };

/**
 * Rules 1 and 2, asked before any row is written. Costs one read of the stores for every call, one of
 * the items when stock enters an open store, and the names and classes only when a controlled store is
 * touched — the counter's ordinary `consume` pays for one small read.
 */
export async function planCustody(tx: Tx, actor: Actor, inputs: readonly Movement[], batches: ReadonlyMap<string, Batch>): Promise<CustodyPlan> {
  const storeIds = [...new Set(inputs.map((m) => m.resourceId))];
  const stores = await tx.select({ id: resources.id, code: resources.code, name: resources.name, attributes: resources.attributes })
    .from(resources).where(inArray(resources.id, storeIds));
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const controlled = inputs.map((m) => {
    const s = storeById.get(m.resourceId);
    return s !== undefined && isControlledStore(s);
  });
  const entering = inputs.map((m, i) => !controlled[i] && m.qtyDelta > 0
    && (storeById.get(m.resourceId)?.code ?? "").toLowerCase() !== TRANSIT_STORE_CODE.toLowerCase());
  if (!controlled.some(Boolean) && !entering.some(Boolean)) return { controlled, ...EMPTY };

  const itemIds = [...new Set(inputs.filter((_, i) => controlled[i] || entering[i]).map((m) => batches.get(m.batchId)?.itemId ?? ""))].filter((x) => x !== "");
  const itemRows = itemIds.length === 0 ? [] : await tx.select({
    id: items.id, name: items.name, baseUom: items.baseUom, storageClass: items.storageClass, formularyMedicineId: items.formularyMedicineId,
  }).from(items).where(inArray(items.id, itemIds));
  const itemsById = new Map(itemRows.map((r) => [r.id, r]));

  // Rule 2 — the cabinet or nowhere.
  for (const [i, m] of inputs.entries()) {
    if (!entering[i]) continue;
    const item = itemsById.get(batches.get(m.batchId)?.itemId ?? "");
    if (item?.storageClass === "narcotic") {
      const store = storeById.get(m.resourceId);
      throw new MaterialsError(
        "controlled_outside_custody",
        `${item.name} is kept in the controlled-drug cabinet — it cannot be taken into ${store?.name ?? m.resourceId} (${store?.code ?? ""}); receive it into the cabinet, under two keys`,
        { itemId: item.id, storeResourceId: m.resourceId },
      );
    }
  }
  if (!controlled.some(Boolean)) return { controlled, ...EMPTY, itemsById };

  // The cabinet is "reserved solely for" these drugs (D&C Rules r.65(12)): nothing else goes in.
  for (const [i, m] of inputs.entries()) {
    if (!controlled[i] || m.qtyDelta <= 0) continue;
    const item = itemsById.get(batches.get(m.batchId)?.itemId ?? "");
    if (item !== undefined && item.storageClass !== "narcotic") {
      const store = storeById.get(m.resourceId);
      throw new MaterialsError(
        "not_a_controlled_item",
        `${store?.name ?? "the cabinet"} (${store?.code ?? m.resourceId}) is reserved for controlled drugs (D&C Rules r.65(12)) — ${item.name} is stored as ${item.storageClass}, not narcotic`,
        { itemId: item.id, storeResourceId: m.resourceId, storageClass: item.storageClass },
      );
    }
  }

  // Rule 1 — two people, both real, never one.
  if (actor.type !== "user") {
    throw new MaterialsError("custody_required", "only a person may move stock in the controlled-drug cabinet — a system actor cannot hold its key");
  }
  const people = new Set<string>([actor.id]);
  for (const [i, m] of inputs.entries()) {
    if (!controlled[i]) continue;
    const store = storeById.get(m.resourceId);
    const c = m.custody;
    if (c === undefined || c.witnessId.trim() === "") {
      throw new MaterialsError(
        "custody_required",
        `${store?.name ?? "this store"} (${store?.code ?? m.resourceId}) is the controlled-drug cabinet — every movement into or out of it is made by two people; name the witness`,
        { storeResourceId: m.resourceId },
      );
    }
    const extra = c.extraWitnessIds ?? [];
    const all = [c.witnessId, ...extra];
    if (all.includes(actor.id) || new Set(all).size !== all.length) {
      throw new MaterialsError("custody_same_person", "the holder and each witness must be different people — one person cannot be two keys", { storeResourceId: m.resourceId });
    }
    for (const u of all) people.add(u);
  }
  const userRows = await tx.select({ id: users.id, fullName: users.fullName, active: users.active }).from(users).where(inArray(users.id, [...people]));
  const known = new Map(userRows.map((u) => [u.id, u]));
  for (const id of people) {
    const u = known.get(id);
    if (u === undefined || !u.active) {
      throw new MaterialsError("custody_witness_unknown", `${id === actor.id ? "the holder" : "a witness"} is not an active member of staff`, { userId: id });
    }
  }
  const names = new Map(userRows.map((u) => [u.id, u.fullName]));

  const medicineIds = [...new Set(itemRows.map((r) => r.formularyMedicineId).filter((x): x is string => x !== null))];
  const [medicines, ndps] = await Promise.all([medicinesByIds(tx, medicineIds), ndpsClassByMedicine(tx, medicineIds)]);
  const classes = new Map(medicineIds.map((id) => [id, { scheduleFlag: medicines.get(id)?.scheduleFlag ?? null, ndpsClass: ndps.get(id) ?? null }]));
  return { controlled, itemsById, names, classes };
}

/** Rule 3 — the register row for one movement at a controlled store, written after its ledger row. */
export async function writeRegisterRow(
  tx: Tx, actor: Actor, plan: CustodyPlan, m: Movement, batch: Batch,
  result: { ledgerEntryId: string; balanceAfter: number },
): Promise<void> {
  const c = m.custody!;
  const item = plan.itemsById.get(batch.itemId);
  if (item === undefined) throw new Error(`controlled register: item ${batch.itemId} was not read by the plan`);
  const cls = item.formularyMedicineId === null ? undefined : plan.classes.get(item.formularyMedicineId);
  const clean = (s: string | null | undefined): string | null => (s === undefined || s === null || s.trim() === "" ? null : s.trim());
  await tx.insert(controlledStockRegister).values({
    id: newId(), ledgerEntryId: result.ledgerEntryId, storeResourceId: m.resourceId, itemId: item.id, batchId: batch.id,
    medicineId: item.formularyMedicineId, drugName: item.name, batchNo: batch.batchNo, expiryDate: batch.expiryDate,
    ndpsClass: cls?.ndpsClass ?? null, scheduleFlag: cls?.scheduleFlag ?? null,
    movement: m.reason, direction: m.qtyDelta > 0 ? "in" : "out", qtyBase: Math.abs(m.qtyDelta), unit: item.baseUom,
    balanceAfter: result.balanceAfter, occurredAt: m.occurredAt,
    holderId: actor.id, holderName: plan.names.get(actor.id) ?? actor.id,
    witnessId: c.witnessId, witnessName: plan.names.get(c.witnessId) ?? c.witnessId,
    holderRegNo: clean(c.holderRegNo),
    extraWitnesses: [
      ...(c.extraWitnessIds ?? []).map((u) => ({ userId: u as string | null, name: plan.names.get(u) ?? u, role: "witness" })),
      ...(c.officers ?? []).map((o) => ({ userId: null, name: o.name.trim(), role: o.role.trim() })),
    ],
    counterparty: clean(c.counterparty), counterpartyAddress: clean(c.counterpartyAddress), counterpartyLicence: clean(c.counterpartyLicence),
    documentRef: clean(c.documentRef), documentDate: clean(c.documentDate), rxRef: clean(c.rxRef),
    patientId: clean(c.patientId), prescriberName: clean(c.prescriberName), prescriberRegNo: clean(c.prescriberRegNo),
    retainedDocumentId: clean(c.retainedDocumentId), collectedBy: clean(c.collectedBy), collectedIdProof: clean(c.collectedIdProof),
    note: clean(c.note),
  });
}
