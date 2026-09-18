import { istDayString as istDay } from "../approvals/cumulative";
import { loadReport } from "../desk/registry";
import type { CopilotAnswer, CopilotToolDecl } from "./types";
import type { DeskProvider } from "../desk/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — THE TOOLS THE KERNEL ITSELF OWNS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Almost every copilot tool belongs to the module whose data it reads, and ships with it. This file
 * is for the exceptions: answers composed from EVERY module at once, which no single module could
 * declare. There is one today.
 *
 * ═══ "GENERATE THE DAY REPORT" — THE OWNER'S OWN EXAMPLE, AND THE FIRST THING THAT *DOES* ═══
 *
 * Owner, 2026-09-17: *"If the user ask to generate the day report, it should do it and give it to
 * the user."* That is the sentence that separates a copilot from a status bar. The dock has had an
 * `action` prop — "the one thing the bar may offer to *do*" — since FD-25, and nothing in the
 * application has ever passed it. This tool is the first thing on the other side of it.
 *
 * It composes the caller's OWN day, and that scope is structural rather than checked. `loadReport`
 * takes no `userId` and there is no argument by which it could answer about anybody else (07c DD4),
 * so `permission` here is `null` — see `CopilotToolDecl.permission` for why that is a real category
 * and not an escape hatch. A supervisor reading across staff is a different route behind
 * `staff.reports.read`, and if the copilot ever offers that, it is a different tool with that
 * permission on it.
 */
export function kernelCopilotTools(providers: DeskProvider[]): CopilotToolDecl[] {
  return [
    {
      intent: "my_day_report",
      permission: null,
      needsSubject: false,
      async run(ctx): Promise<CopilotAnswer> {
        const now = new Date();
        const { sections } = await loadReport(providers, {
          db: ctx.db,
          /*
            `actor` FILTERS and `reader` ALIASES, and they are the same person here because the
            subject of this report is the person asking for it. `desk/types.ts` explains at length
            why collapsing the two fields would leak a sealed patient's name into a supervisor's
            drill; setting them equal is what every self-scoped caller does, and this is one.
          */
          actor: ctx.actor,
          reader: ctx.actor,
          date: ctx.serviceDate,
          now,
        });

        /*
          PROVISIONAL IS THE SERVER'S, and it is repeated here rather than inferred by the dock for
          the reason `desk.controller.ts` gives: the screen, the print and the CSV are three
          renderings of one model, and a flag computed in each is three chances to disagree. A day
          that has not closed is not a report anybody should file, and the answer must say so.
        */
        const provisional = ctx.serviceDate >= istDay(now);

        if (sections.length === 0) {
          return {
            key: "copilot.answer.dayReportEmpty",
            params: { date: ctx.serviceDate },
          };
        }

        return {
          key: provisional ? "copilot.answer.dayReportProvisional" : "copilot.answer.dayReport",
          params: { date: ctx.serviceDate, sections: sections.length },
          /*
            THE REPORT ITSELF, not a sentence about it. "Give it to the user" means the rows arrive,
            and the dock renders them and offers the export the desk already has at
            `GET /me/report.csv` — which appends its own `report.exported` event, so a file leaving
            the building stays an act with a name on it whether a clerk or the copilot asked for it.
          */
          payload: { date: ctx.serviceDate, provisional, sections },
        };
      },
    },
  ];
}
