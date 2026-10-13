import { consultQueue } from "./reads";
import type { DeskCard, DeskProviderCtx } from "../../kernel/desk/types";

/** DECIDED: a therapeutic-diet consult waiting longer than 24 hours is hot (NABH: assessment within 24 h). */
export const DIET_CONSULT_HOT_MINUTES = 24 * 60;

export async function dietConsultsCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const queue = await consultQueue(ctx.db, ctx.reader, ctx.now);
  if (queue.length === 0) return [];
  return [{
    key: "diet.consults", band: "now", titleKey: "desk.dietConsults.title",
    rows: queue.slice(0, 5).map((c) => ({
      id: c.id, badge: "!", title: c.patient.name,
      // Review #767 rule: a sealed patient's desk row names no bed.
      subtitle: [c.patient.uhid, c.patient.sealed ? "" : c.bedCode ?? "", c.reason, `waiting ${String(Math.floor(c.waitMinutes / 60))} h`].filter((s) => s !== "").join(" · "),
      action: "Open", href: "/diet/consults", severity: c.waitMinutes >= DIET_CONSULT_HOT_MINUTES ? "hot" : "warn",
    })),
  }];
}
