import { envModuleSwitch } from "./switch";
import type { ModuleManifest } from "./manifest";
import type { ModuleSwitch } from "./switch";

const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export class ModuleRegistry {
  private modules = new Map<string, ModuleManifest>();
  private subs = new Map<string, { consumer: string; moduleKey: string }[]>();

  /** Decision 0085 — `isOn` says which manifests are live (default: `HMIS_MODULES_ON`); tests pass `switchOf([...])`. */
  constructor(private readonly isOn: ModuleSwitch = envModuleSwitch) {}

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

  /**
   * Decision 0085 — the manifests whose module is ON. Every collector that puts a module in front of a person or
   * feeds it events (menu, desk, search, copilot, order kinds, the subscription bus) reads this; `all()` stays the
   * whole catalogue for what must exist whatever the switch says (permissions, resource kinds).
   */
  live(): ModuleManifest[] {
    return this.all().filter((m) => this.isOn(m.key));
  }

  /** Decision 0085 — the permissions only OFF modules declare (a string a live module also declares is not here). */
  darkPermissions(): ReadonlySet<string> {
    const live = new Set(this.live().flatMap((m) => m.permissions));
    return new Set(this.all().filter((m) => !this.isOn(m.key)).flatMap((m) => m.permissions).filter((p) => !live.has(p)));
  }

  subscriptionsFor(eventName: string): { consumer: string; moduleKey: string }[] {
    return this.subs.get(eventName) ?? [];
  }

  allPermissions(): string[] {
    return [...new Set(this.all().flatMap((m) => m.permissions))];
  }
}
