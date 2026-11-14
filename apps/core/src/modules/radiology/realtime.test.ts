import { orderPlaced } from "../../kernel/orders/events";
import { RADIOLOGY_EVENTS } from "./events";
import { RadiologyRealtimeRegistrar } from "./radiology.module";
import {
  IMAGING_FLOOR_TOPIC, IMAGING_READ_TOPIC, IMAGING_RELEASE_TOPIC, RADIOLOGY_REALTIME_NAMES, RADIOLOGY_TOPIC_SPACES,
  radiologyTopicRouter, radiologyTopicsFor,
} from "./realtime";
import type { RealtimeGateway, TopicRouter, TopicSpace } from "../../kernel/realtime/gateway";

/**
 * #1083 — the imaging router's census. The acceptance file (`acceptance/imaging-live-lists-1083*`) pins
 * the four approved checks; this pins what keeps the router honest as names are added: no name it cannot
 * route (17b F43's lesson, `lab/realtime.ts`), no topic outside a registered space, no payload that
 * carries a person or a finding, and the module's registrar actually handing both to the gateway.
 */
const payloadOf = (name: string): Record<string, unknown> =>
  name === orderPlaced.name ? { kind: "imaging", orderId: "O1", itemIds: ["I1"] } : { studyId: "S1", reportId: "R1" };

describe("the imaging lists' live topics (#1083)", () => {
  it("every routed name is a declared event and produces at least one topic", () => {
    const declared = new Set<string>([...RADIOLOGY_EVENTS.map((e) => e.name), orderPlaced.name]);
    for (const name of RADIOLOGY_REALTIME_NAMES) {
      expect({ name, declared: declared.has(name) }).toEqual({ name, declared: true });
      expect({ name, empty: radiologyTopicsFor({ name, payload: payloadOf(name) }).length === 0 }).toEqual({ name, empty: false });
    }
  });

  it("every topic it returns lies in a space it registers, and each of the three lists is reachable", () => {
    const prefixes = new Set(RADIOLOGY_TOPIC_SPACES.map((s) => s.prefix));
    const seen = new Set<string>();
    for (const name of RADIOLOGY_REALTIME_NAMES) {
      for (const topic of radiologyTopicsFor({ name, payload: payloadOf(name) })) {
        expect(prefixes.has(topic.split(":")[0]!)).toBe(true);
        seen.add(topic);
      }
    }
    expect([...seen].sort()).toEqual([IMAGING_FLOOR_TOPIC, IMAGING_READ_TOPIC, IMAGING_RELEASE_TOPIC].sort());
    expect(RADIOLOGY_TOPIC_SPACES).toEqual([{ prefix: "imaging", permission: "radiology.worklist.read" }]);
  });

  it("an order.placed with no kind, or another department's, wakes nothing", () => {
    expect(radiologyTopicsFor({ name: orderPlaced.name, payload: { orderId: "O1" } })).toEqual([]);
    expect(radiologyTopicsFor({ name: orderPlaced.name, payload: null })).toEqual([]);
    expect(radiologyTopicsFor({ name: orderPlaced.name, payload: { kind: "pharmacy" } })).toEqual([]);
  });

  it("no routed radiology payload carries a person's name, a phone or a finding", () => {
    for (const name of RADIOLOGY_REALTIME_NAMES) {
      const def = RADIOLOGY_EVENTS.find((e) => e.name === name);
      if (def === undefined) continue; // order.placed: the kernel's envelope, ids and a kind
      const keys = Object.keys((def.payloadSchema as unknown as { shape: Record<string, unknown> }).shape);
      expect({ name, leaks: keys.filter((k) => /name|phone|mobile|finding|impression|readback|text|value/i.test(k)) })
        .toEqual({ name, leaks: [] });
    }
  });

  it("the module's registrar registers the space and the router with the gateway", () => {
    const spaces: TopicSpace[] = [];
    const routers: TopicRouter[] = [];
    const gateway = {
      registerTopicSpace: (s: TopicSpace) => { spaces.push(s); },
      registerRouter: (r: TopicRouter) => { routers.push(r); },
    } as unknown as RealtimeGateway;
    new RadiologyRealtimeRegistrar(gateway).onModuleInit();
    expect(spaces).toEqual(RADIOLOGY_TOPIC_SPACES);
    expect(routers).toEqual([radiologyTopicRouter]);
  });
});
