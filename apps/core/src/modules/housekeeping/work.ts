import { and, desc, eq } from "drizzle-orm";
import { BED_CLEAN_KINDS, HK_IN_HOUSE, HOUSEKEEPING_KIND_LIST, HOUSEKEEPING_REFUSALS, finishWorkInput, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { hkChecklists, hkWork } from "../../kernel/db/schema";
import { TaskError, TaskKindRefusal, completeTask, getTask, rejectionsOf } from "../tasks";
import { HousekeepingRefusal } from "./errors";
import { ancestry, areaOfPlace } from "./places";
import { parse, readQrToken, staffFacts } from "./setup";
import type { Actor, HkWorkForm, HkWorkView, HousekeepingKind, TaskProof } from "@hmis/contracts";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Db, Tx } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";
import type { Exec } from "./places";

/**
 * HK-1 (#973) — THE PROOF OF WORK. A housekeeping task at a place that is (or lies inside) an area is finished only with:
 * the door QR of that area or one holding it, scanned by the signed-in attendant; an answer to every item of the area's
 * checklist; and one photo for a bed or a toilet. `finishWork` records the attempt (with the company the person works for,
 * as a snapshot) and completes the task in ONE transaction; the kinds' `beforeDone` (`hkBeforeDone`) refuses any other
 * completion of such a task, so the generic `/tasks/:id/done` door cannot skip the proof. A task at a place with no area
 * (a bed clean raised before its ward was set up) keeps the old tap. A failed check reopens the task; the rework is a new
 * attempt, numbered from the task's rejections.
 */
const PHOTO_PREFIX = "housekeeping/";
export const photoKeyPrefix = (taskId: string): string => `${PHOTO_PREFIX}${taskId}/`;
const isHkKind = (kind: string): boolean => HOUSEKEEPING_KIND_LIST.includes(kind as HousekeepingKind);
const isBedClean = (kind: string): boolean => BED_CLEAN_KINDS.includes(kind as HousekeepingKind);

async function attemptOf(exec: Exec, taskId: string): Promise<number> {
  return ((await rejectionsOf(exec, [taskId])).get(taskId)?.count ?? 0) + 1;
}

async function hkTask(exec: Exec, taskId: string): Promise<TaskRow> {
  const task = await getTask(exec, taskId);
  if (task === null || !isHkKind(task.kind)) throw new HousekeepingRefusal("not_a_clean", { taskId });
  return task;
}

/** Store the photo of a cleaned place (never a patient) for the attendant holding the task. Returns its key. */
export async function storeWorkPhoto(
  db: Db, store: DocumentStore, actor: Actor, input: { taskId: string; mime: string; bytes: Buffer },
): Promise<{ photoKey: string }> {
  const task = await hkTask(db, input.taskId);
  if (task.assigneeId !== actor.id) throw new TaskError("not_yours", { taskId: task.id });
  if (!["image/jpeg", "image/png", "image/webp"].includes(input.mime) || input.bytes.length === 0 || input.bytes.length > 5 * 1024 * 1024) {
    throw new HousekeepingRefusal("bad_input", { issues: ["photo: a JPEG, PNG or WebP image up to 5 MB"] });
  }
  const ext = input.mime === "image/png" ? "png" : input.mime === "image/webp" ? "webp" : "jpg";
  const photoKey = `${photoKeyPrefix(task.id)}${newId()}.${ext}`;
  await store.put(photoKey, input.bytes);
  return { photoKey };
}

/** What the phone shows before finishing: the checklist of the task's area and whether a photo is needed. */
export async function workForm(db: Db, taskId: string): Promise<HkWorkForm> {
  const task = await hkTask(db, taskId);
  const lastReason = (await rejectionsOf(db, [taskId])).get(taskId)?.lastReason ?? null;
  const at = await areaOfPlace(db, task.placeResourceId);
  if (at === null) return { taskId, needsWork: false, areaName: null, items: [], photoNeeded: false, lastReason };
  const items = at.area.checklistId === null ? []
    : (await db.select({ items: hkChecklists.items }).from(hkChecklists).where(eq(hkChecklists.id, at.area.checklistId)))[0]?.items ?? [];
  const areaPlace = at.chain.find((p) => p.id === at.area.resourceId);
  return { taskId, needsWork: true, areaName: areaPlace?.name ?? null, items, photoNeeded: at.area.photoNeeded || isBedClean(task.kind), lastReason };
}

export async function finishWork(db: Db, key: Buffer, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TaskRow> {
  const input = parse(finishWorkInput, raw);
  return withTx(db, async (tx) => {
    const task = await hkTask(tx, input.taskId);
    const scanned = await readQrToken(tx, key, input.scan);
    const chain = task.placeResourceId === null ? [] : await ancestry(tx, task.placeResourceId);
    if (!chain.some((p) => p.id === scanned.resourceId)) throw new HousekeepingRefusal("wrong_place", { taskId: task.id, areaId: scanned.id });
    // The checklist and the photo rule are the task's own area's (the nearest), whichever holding area's QR was scanned.
    const own = (await areaOfPlace(tx, task.placeResourceId))!.area;
    const checklist = own.checklistId === null ? null
      : (await tx.select().from(hkChecklists).where(eq(hkChecklists.id, own.checklistId)))[0] ?? null;
    const answered = new Set(input.answers.map((a) => a.itemId));
    if (checklist !== null && checklist.items.some((i) => !answered.has(i.id))) {
      throw new HousekeepingRefusal("checklist_incomplete", { taskId: task.id });
    }
    if ((own.photoNeeded || isBedClean(task.kind)) && input.photoKey === undefined) throw new HousekeepingRefusal("photo_missing", { taskId: task.id });
    if (input.photoKey !== undefined && !input.photoKey.startsWith(photoKeyPrefix(task.id))) {
      throw new HousekeepingRefusal("bad_input", { issues: ["photoKey: not this task's photo"] });
    }
    const facts = (await staffFacts(tx, [actor.id])).get(actor.id);
    await tx.insert(hkWork).values({
      taskId: task.id, attempt: await attemptOf(tx, task.id), doneBy: actor.id, company: facts?.company ?? HK_IN_HOUSE,
      contractorId: facts?.contractorId ?? null, scanAreaId: scanned.id, qrVersion: scanned.qrVersion, scannedAt: now,
      checklistId: checklist?.id ?? null, answers: input.answers.filter((a) => checklist?.items.some((i) => i.id === a.itemId) ?? false),
      photoKey: input.photoKey ?? null,
    });
    const proof: TaskProof | undefined = task.proofNeeded === "scan" ? { kind: "scan", code: scanned.id }
      : task.proofNeeded === "tap" ? { kind: "tap" } : undefined;
    return completeTask(tx, actor, { taskId: task.id, ...(proof === undefined ? {} : { proof }) }, now);
  });
}

/**
 * Every housekeeping kind's `beforeDone`: a task inside an area completes only with this attempt's work recorded by the
 * person completing it (written by `finishWork` in the same transaction).
 */
export async function hkBeforeDone(tx: Tx, task: TaskRow, _proof: TaskProof | undefined, actor: Actor): Promise<void> {
  if ((await areaOfPlace(tx, task.placeResourceId)) === null) return;
  const attempt = await attemptOf(tx, task.id);
  const row = await tx.select({ doneBy: hkWork.doneBy }).from(hkWork).where(and(eq(hkWork.taskId, task.id), eq(hkWork.attempt, attempt)));
  if (row[0]?.doneBy !== actor.id) {
    const r = HOUSEKEEPING_REFUSALS.work_missing;
    throw new TaskKindRefusal("work_missing", r.sentence, r.fix, 409, { taskId: task.id });
  }
}

/** The newest attempt's record: who, for which company, what was scanned and answered. */
export async function workOf(db: Db, taskId: string): Promise<HkWorkView | null> {
  const r = (await db.select().from(hkWork).where(eq(hkWork.taskId, taskId)).orderBy(desc(hkWork.attempt)).limit(1))[0];
  if (r === undefined) return null;
  return {
    taskId: r.taskId, attempt: r.attempt, doneBy: r.doneBy, company: r.company, scannedAt: r.scannedAt.toISOString(),
    scanAreaId: r.scanAreaId, answers: r.answers, photoKey: r.photoKey,
  };
}

