import { runTaskAndWasteClocks } from "./jobs";
import type { Db } from "../db/client";

/** PR #749 review 5 — the task clock and the waste storage clock share a tick; a failure in either never stops or masks the other. */
describe("the shared task + waste clock tick", () => {
  const db = {} as Db;
  const now = new Date(Date.UTC(2030, 0, 1));

  it("a failing task sweep still runs the waste clock, and the failure is still reported", async () => {
    const ran: string[] = [];
    await expect(runTaskAndWasteClocks(db, now, {
      sweepTasks: async () => { ran.push("tasks"); throw new Error("tasks down"); },
      sweepBmwStorage: async () => { ran.push("bmw"); return { warning: 0, alert: 0, noticesRaised: 0, unnotified: 0 }; },
    })).rejects.toThrow("tasks down");
    expect(ran).toEqual(["tasks", "bmw"]);
  });

  it("a failing waste clock does not hide behind a healthy task sweep", async () => {
    await expect(runTaskAndWasteClocks(db, now, {
      sweepTasks: async () => ({ returned: 0, redispatched: 0, dispatched: 0, escalated: 0, failed: 0 }),
      sweepBmwStorage: async () => { throw new Error("bmw down"); },
    })).rejects.toThrow("bmw down");
  });

  it("both failing: both run, the first failure is thrown", async () => {
    const ran: string[] = [];
    await expect(runTaskAndWasteClocks(db, now, {
      sweepTasks: async () => { ran.push("tasks"); throw new Error("tasks down"); },
      sweepBmwStorage: async () => { ran.push("bmw"); throw new Error("bmw down"); },
    })).rejects.toThrow("tasks down");
    expect(ran).toEqual(["tasks", "bmw"]);
  });

  it("E4.4 DIET — the meal clock rides the tick: a failing task sweep still builds the due meal lists", async () => {
    const ran: string[] = [];
    await expect(runTaskAndWasteClocks(db, now, {
      sweepTasks: async () => { ran.push("tasks"); throw new Error("tasks down"); },
      sweepBmwStorage: async () => { ran.push("bmw"); return { warning: 0, alert: 0, noticesRaised: 0, unnotified: 0 }; },
      buildDueLists: async () => { ran.push("diet"); return 0; },
    })).rejects.toThrow("tasks down");
    expect(ran).toEqual(["tasks", "bmw", "diet"]);
    await expect(runTaskAndWasteClocks(db, now, {
      sweepTasks: async () => ({ returned: 0, redispatched: 0, dispatched: 0, escalated: 0, failed: 0 }),
      sweepBmwStorage: async () => ({ warning: 0, alert: 0, noticesRaised: 0, unnotified: 0 }),
      buildDueLists: async () => { throw new Error("kitchen down"); },
    })).rejects.toThrow("kitchen down");
  });
});
