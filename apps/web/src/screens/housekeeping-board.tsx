import { useTranslation } from "react-i18next";
import { TERMINAL_CLEAN_KIND, cleanRefusal, fetchHousekeepingBoard, verifyCleanApi } from "../lib/housekeeping-api";
import { TasksBoard } from "./tasks-board";
import type { TaskCard } from "@hmis/contracts";

/**
 * ═══ E1.4 HOUSEKEEPING (issue #721) — THE HOUSEKEEPING SUPERVISOR'S BOARD (16:9, 1920 × 1080) ═══
 *
 * The task board over housekeeping's kinds only: open cleans by floor, late first, each with its clock in words;
 * a terminal clean says so in words ("Terminal clean", flagged "Supervisor checks"), not by colour alone; the cleaned beds waiting
 * for a check carry a Check button (a terminal clean is the supervisor's alone — the server refuses anyone else
 * with the rule and the fix, shown here as the server says it). Workers and their load on the right.
 */
export function HousekeepingBoard(): React.ReactElement {
  const { t } = useTranslation();
  const flag = (c: TaskCard): string | null => (c.kind === TERMINAL_CLEAN_KIND ? t("housekeeping.terminal") : null);
  const onVerify = async (c: TaskCard): Promise<string | null> => {
    try {
      await verifyCleanApi(c.id, c.version);
      return null;
    } catch (e) {
      const r = cleanRefusal(e);
      return r === null ? t("tasks.refusal.failed") : `${r.message} ${r.fix}`.trim();
    }
  };
  return (
    <TasksBoard
      titleKey="housekeeping.title" queryKey={["housekeeping", "board"]} fetchBoard={fetchHousekeepingBoard}
      testId="housekeeping-board" rowFlag={flag} onVerify={onVerify}
    />
  );
}
