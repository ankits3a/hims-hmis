import type { EventDef } from "./envelope";

export class EventRegistry {
  private defs = new Map<string, EventDef>();

  register(def: EventDef): void {
    if (this.defs.has(def.name)) {
      throw new Error(`duplicate event registration: ${def.name}`);
    }
    this.defs.set(def.name, def);
  }

  get(name: string): EventDef | undefined {
    return this.defs.get(name);
  }

  names(): string[] {
    return [...this.defs.keys()];
  }
}
