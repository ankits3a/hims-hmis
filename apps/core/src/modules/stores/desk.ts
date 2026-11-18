import { noDeskCards } from "../../kernel/desk/types";
import type { DeskProvider } from "../../kernel/desk/types";

/** STORES S2a (#1112) — RED-FIRST STUBS: the three Now cards. */
export const storesApproveDesk: DeskProvider = { key: "stores.approve", permission: "stores.shelf.read", load: noDeskCards };
export const storesPickDesk: DeskProvider = { key: "stores.pick", permission: "stores.shelf.read", load: noDeskCards };
export const storesReceiveDesk: DeskProvider = { key: "stores.receive", permission: "stores.shelf.read", load: noDeskCards };
