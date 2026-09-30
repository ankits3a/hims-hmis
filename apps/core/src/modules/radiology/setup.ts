import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { approvals } from "../../kernel/db/schema/approvals";
import { users } from "../../kernel/db/schema/auth";
import { imagingDefinitions, IMAGING_DEFINITION_KIND_VALUES } from "../../kernel/db/schema/radiology";
import { resources } from "../../kernel/db/schema/resources";
import { listGstCategories, listPriceList, listServices } from "../tariff";
import type { Db } from "../../kernel/db/client";
import type { ImagingDefinitionKind } from "../../kernel/db/schema/radiology";

/**
 * PLAN 18-S RS4 — **THE SETUP STATION'S READS: rooms, books and prices.** Nothing here writes.
 *
 * ═══ THE RULED SERVICES (owner delegation, 28 Sep — plan 18-S ruling 1) ═══
 *
 * Four services whose PRICES the ruling fixed, unlike the twenty study types whose prices are the
 * owner's own list. `seed:radiology` creates the four ROWS (category `investigation`, ruling 2); it
 * does NOT put a price on them, because a price becomes chargeable only through a tariff revision —
 * drafted, approved by the owner, activated — and a seed that activated one would collapse that
 * governance into a script. The ruled price is carried here so the Prices view can show the
 * difference between "ruled" and "in the active tariff", and the go-live runbook tells the owner to
 * enter them in the next revision.
 *
 * **X-ray's one included film is a desk/bill rule, not a service**: the first film for an X-ray is
 * not billed (`RAD-FILM` is added for extra sheets, and for CT/MRI/USG on request). Nothing in the
 * bill enforces it yet — recorded in the plan for the phase that builds the film counter.
 */
export const RADIOLOGY_RULED_SERVICES = [
  { code: "RAD-FILM", name: "Imaging film, per sheet", ruledPricePaise: 25_000 },
  { code: "RAD-CD", name: "Imaging CD", ruledPricePaise: 30_000 },
  { code: "RAD-2ND-XR-US", name: "Outside second-opinion read — X-ray or ultrasound", ruledPricePaise: 60_000 },
  { code: "RAD-2ND-CT-MR", name: "Outside second-opinion read — CT or MRI", ruledPricePaise: 150_000 },
] as const;

/** Ruling 2 — the tariff category every imaging (and laboratory) service carries. */
export const INVESTIGATION_GST_CATEGORY = "investigation";

export type SetupRoomRow = { id: string; code: string; name: string };

/** Rooms a machine may hang in: every `room` resource still in service. */
export async function setupRooms(db: Db): Promise<SetupRoomRow[]> {
  return db.select({ id: resources.id, code: resources.code, name: resources.name })
    .from(resources)
    .where(and(eq(resources.kind, "room"), ne(resources.status, "retired")))
    .orderBy(asc(resources.code));
}

export type BookVersionRow = {
  definitionId: string;
  version: number;
  status: "active" | "draft";
  draftedBy: string | null;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
  /** The publish approval: filed at draft, decided by the medical superintendent. */
  approvalId: string | null;
  approvalStatus: string | null;
  approvedBy: string | null;
  /** True for a version the seed activated (owner ruling 2026-08-31): `approval_id` is NULL. */
  seeded: boolean;
};

export type BookRow = {
  kind: ImagingDefinitionKind;
  active: BookVersionRow | null;
  /** Drafts waiting for approval or publish, newest first. */
  drafts: BookVersionRow[];
};

/**
 * Each governed book: its active version with who drafted, approved and published it, and the
 * drafts still in flight with their approval's state. **Names, not ids** — the reader is a person
 * deciding whether to chase the medical superintendent.
 *
 * A draft's approval is found by SUBJECT (`imaging_definition` + the draft id), which is exactly
 * what `publishDefinition` checks; the active row's by its stored `approval_id`.
 */
export async function setupBooks(db: Db): Promise<BookRow[]> {
  const rows = await db.select().from(imagingDefinitions)
    .where(inArray(imagingDefinitions.status, ["active", "draft"]))
    .orderBy(desc(imagingDefinitions.version));
  const ids = rows.map((r) => r.id);
  const approvalRows = ids.length === 0 ? [] : await db.select({
    id: approvals.id, subjectId: approvals.subjectId, status: approvals.status, decidedBy: approvals.decidedBy,
  }).from(approvals).where(and(eq(approvals.subjectType, "imaging_definition"), inArray(approvals.subjectId, ids)))
    .orderBy(desc(approvals.id));
  const approvalBySubject = new Map<string, (typeof approvalRows)[number]>();
  for (const a of approvalRows) if (!approvalBySubject.has(a.subjectId)) approvalBySubject.set(a.subjectId, a);

  const peopleIds = new Set<string>();
  for (const r of rows) {
    peopleIds.add(r.draftedBy);
    if (r.publishedBy) peopleIds.add(r.publishedBy);
  }
  for (const a of approvalRows) if (a.decidedBy) peopleIds.add(a.decidedBy);
  const people = peopleIds.size === 0 ? [] : await db.select({ id: users.id, fullName: users.fullName })
    .from(users).where(inArray(users.id, [...peopleIds]));
  const nameOf = new Map(people.map((p) => [p.id, p.fullName] as const));
  /** A script identity (`seed:radiology`) has no user row and is shown as itself. */
  const who = (id: string | null): string | null => (id === null ? null : nameOf.get(id) ?? id);

  const toVersion = (r: (typeof rows)[number]): BookVersionRow => {
    const approval = r.approvalId !== null
      ? approvalRows.find((a) => a.id === r.approvalId) ?? null
      : approvalBySubject.get(r.id) ?? null;
    return {
      definitionId: r.id,
      version: r.version,
      status: r.status as "active" | "draft",
      draftedBy: who(r.draftedBy),
      createdAt: r.createdAt.toISOString(),
      publishedBy: who(r.publishedBy),
      publishedAt: r.publishedAt?.toISOString() ?? null,
      approvalId: approval?.id ?? r.approvalId,
      approvalStatus: approval?.status ?? null,
      approvedBy: who(approval?.decidedBy ?? null),
      seeded: r.status === "active" && r.approvalId === null,
    };
  };

  return IMAGING_DEFINITION_KIND_VALUES.map((kind) => {
    const mine = rows.filter((r) => r.kind === kind);
    const active = mine.find((r) => r.status === "active");
    return {
      kind,
      active: active ? toVersion(active) : null,
      drafts: mine.filter((r) => r.status === "draft").map(toVersion),
    };
  });
}

export type SetupPriceRow = {
  serviceId: string;
  code: string;
  name: string;
  category: string;
  active: boolean;
  /** The service's GST category row; null when `gst_config` has no row for it (a pricing refusal). */
  gst: { sacCode: string; exempt: boolean; rateBps: number } | null;
  /** The ACTIVE tariff version's price; null when the service is not in it. */
  pricePaise: number | null;
  /** The owner-delegation ruling's price for the four ruled services; null for everything else. */
  ruledPricePaise: number | null;
};

/** Every `RAD-` service with its GST category and its active price. Read-only (T4 Prices). */
export async function setupPrices(db: Db, at: Date = new Date()): Promise<SetupPriceRow[]> {
  const radServices = (await listServices(db)).filter((s) => s.code.startsWith("RAD-"));
  const gst = new Map((await listGstCategories(db)).map((c) => [c.category, c] as const));
  const price = new Map((await listPriceList(db, at)).map((p) => [p.serviceId, p.pricePaise] as const));
  const ruled = new Map<string, number>(RADIOLOGY_RULED_SERVICES.map((r) => [r.code, r.ruledPricePaise]));
  return radServices
    .map((s) => {
      const g = gst.get(s.category);
      return {
        serviceId: s.id,
        code: s.code,
        name: s.name,
        category: s.category,
        active: s.active,
        gst: g ? { sacCode: g.sacCode, exempt: g.exempt, rateBps: g.rateBps } : null,
        pricePaise: price.get(s.id) ?? null,
        ruledPricePaise: ruled.get(s.code) ?? null,
      };
    })
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
