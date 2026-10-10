import { consultationCompleted, paperPrescriptionTranscribed } from "../opd";
import { ORDERING_FREE_TESTS_CONSUMER } from "./auto-order";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * ORDERING (owner 2026-10-10, decision 0065) — the one door every doctor's screen orders tests
 * through, the outside-test catalogue, and the free-test automatic order. No permission of its own:
 * it rides `tariff.read`, `tariff.services.manage` and `orders.place` (see the controller).
 *
 * The two subscriptions and `workerConsumers`' `ordering.free_tests` entry land in ONE commit — a
 * declaration with no handler is a boot error.
 */
export const orderingManifest: ModuleManifest = {
  key: "ordering",
  title: "Test ordering",
  menu: [{ label: "Outside tests", path: "/ordering/outside-tests", permission: "tariff.services.manage" }],
  permissions: [],
  subscriptions: [
    { event: consultationCompleted.name, consumer: ORDERING_FREE_TESTS_CONSUMER },
    { event: paperPrescriptionTranscribed.name, consumer: ORDERING_FREE_TESTS_CONSUMER },
  ],
};
