import type { ModuleManifest } from "./manifest";

const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export class ModuleRegistry {
  private modules = new Map<string, ModuleManifest>();
  private subs = new Map<string, { consumer: string; moduleKey: string }[]>();

  install(m: ModuleManifest): void {
    if (this.modules.has(m.key)) throw new Error(`duplicate module key: ${m.key}`);
    for (const s of m.subscriptions) {
      if (!NAME_RE.test(s.event)) throw new Error(`invalid event name in subscription: ${s.event}`);
    }
    this.modules.set(m.key, m);
    for (const s of m.subscriptions) {
      const list = this.subs.get(s.event) ?? [];
      list.push({ consumer: s.consumer, moduleKey: m.key });
      this.subs.set(s.event, list);
    }
  }

  all(): ModuleManifest[] {
    return [...this.modules.values()];
  }

  subscriptionsFor(eventName: string): { consumer: string; moduleKey: string }[] {
    return this.subs.get(eventName) ?? [];
  }

  allPermissions(): string[] {
    return [...new Set(this.all().flatMap((m) => m.permissions))];
  }
}
