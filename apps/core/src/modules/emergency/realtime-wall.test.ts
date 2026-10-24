import { ER_BOARD_TOPIC, ER_WALL_TOPIC } from "@hmis/contracts";
import { ER_REALTIME_NAMES, erTopicsFor } from "./realtime";

/**
 * ER review (2026-10-15) — the realtime gateway sends an event's whole payload to every subscriber of its topic. The
 * wall display (a kiosk holding only `er.board.wall`) must therefore receive NO event: a payload carries patient ids, the
 * arrival mode (police) and, in later lanes, clinical and medico-legal words. The wall refetches its sanitised board on
 * a short timer instead.
 */
describe("ER realtime — nothing reaches the wall topic", () => {
  it("routes every board event to the full board's topic only", () => {
    for (const name of ER_REALTIME_NAMES) {
      const topics = erTopicsFor({ name });
      expect([name, topics.includes(ER_WALL_TOPIC)]).toEqual([name, false]);
      expect(topics).toContain(ER_BOARD_TOPIC);
    }
  });
});
