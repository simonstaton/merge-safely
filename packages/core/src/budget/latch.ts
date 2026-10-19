/**
 * Edge-triggered budget alerts (design 7.6). Each (ceiling, threshold) pair fires once when the fraction crosses
 * the threshold upward and re-arms only after the fraction drops back below it, so a ceiling held at 101% does not
 * page every tick. State is plain JSON so the App can persist it between ticks and restarts.
 */

export interface AlertEvent {
  /** Ceiling key, e.g. "per-change", "window", or a caller-chosen key such as "per-seat:hunter:security:1". */
  ceiling: string;
  threshold: number;
  fraction: number;
}

export interface AlertLatchState {
  version: 1;
  thresholds: number[];
  /** ceiling -> thresholds currently fired (latched). */
  fired: Record<string, number[]>;
}

export class AlertLatch {
  private readonly thresholds: number[];
  private readonly fired = new Map<string, Set<number>>();

  constructor(thresholds: number[] = [0.5, 0.8, 1.0]) {
    this.thresholds = [...new Set(thresholds.filter((t) => Number.isFinite(t) && t >= 0))].sort((a, b) => a - b);
  }

  /** Feed the latest fraction for a ceiling; returns the alerts that fire on this observation, lowest first. */
  observe(ceiling: string, fraction: number): AlertEvent[] {
    if (!Number.isFinite(fraction)) return [];
    let set = this.fired.get(ceiling);
    if (!set) {
      set = new Set();
      this.fired.set(ceiling, set);
    }
    const events: AlertEvent[] = [];
    for (const t of this.thresholds) {
      if (fraction >= t) {
        if (!set.has(t)) {
          set.add(t);
          events.push({ ceiling, threshold: t, fraction });
        }
      } else {
        set.delete(t);
      }
    }
    if (set.size === 0) this.fired.delete(ceiling);
    return events;
  }

  /** Forget the latch for one ceiling (e.g. after the user resets the ledger). */
  reset(ceiling?: string): void {
    if (ceiling === undefined) this.fired.clear();
    else this.fired.delete(ceiling);
  }

  toJSON(): AlertLatchState {
    const fired: Record<string, number[]> = {};
    for (const [k, v] of [...this.fired.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      fired[k] = [...v].sort((a, b) => a - b);
    }
    return { version: 1, thresholds: [...this.thresholds], fired };
  }

  /**
   * Restore persisted state. Pass the current policy thresholds to override the stored ones; latched thresholds
   * that no longer exist are dropped. Malformed input yields an empty latch rather than throwing.
   */
  static fromJSON(state: unknown, thresholds?: number[]): AlertLatch {
    const s = isState(state) ? state : undefined;
    const latch = new AlertLatch(thresholds ?? s?.thresholds);
    if (!s) return latch;
    const allowed = new Set(latch.thresholds);
    for (const [k, v] of Object.entries(s.fired)) {
      const kept = v.filter((t) => allowed.has(t));
      if (kept.length > 0) latch.fired.set(k, new Set(kept));
    }
    return latch;
  }
}

function isNumArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number");
}

function isState(v: unknown): v is AlertLatchState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !isNumArray(o.thresholds)) return false;
  if (typeof o.fired !== "object" || o.fired === null) return false;
  return Object.values(o.fired as Record<string, unknown>).every(isNumArray);
}
